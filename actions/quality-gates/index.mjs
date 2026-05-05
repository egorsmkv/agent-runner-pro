import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { delimiter } from 'node:path';
import path from 'node:path';

export async function runQualityGate(command, { cwd, signal, env, log = console.log }) {
  if (!isRunnableQualityGate(command)) {
    log(`[gate] skip: ${command} (not a shell command)`);
    return {
      command,
      exitCode: 0,
      durationMs: 0,
      outputSummary: 'Skipped: descriptive quality gate, not a shell command.',
      skipped: true,
    };
  }

  const startedAt = Date.now();
  log(`[gate] start: ${command}`);

  const result = (await shouldUseRipgrepFallback(command, env))
    ? await runRipgrepFallback(command, { cwd })
    : await runShellCommand(command, { cwd, signal, env });
  const resolvedResult = isMissingRipgrep(command, result)
    ? await runRipgrepFallback(command, { cwd })
    : result;
  const durationMs = Date.now() - startedAt;
  const summary = summarizeOutput(`${resolvedResult.stdout}\n${resolvedResult.stderr}`);
  const passedAsNegativeSearch = isCleanRgAudit(command, resolvedResult);
  const exitCode = passedAsNegativeSearch ? 0 : resolvedResult.exitCode;

  if (exitCode === 0) {
    log(
      passedAsNegativeSearch
        ? `[gate] pass: ${command} (no matches, ${formatDuration(durationMs)})`
        : `[gate] pass: ${command} (${formatDuration(durationMs)})`,
    );
  } else {
    log(
      `[gate] fail: ${command} exited ${resolvedResult.exitCode} (${formatDuration(durationMs)})`,
    );
    if (summary) {
      log(summary);
    }
  }

  return {
    command,
    exitCode,
    durationMs,
    outputSummary:
      passedAsNegativeSearch && !summary
        ? 'No matches found; treated as passing rg audit.'
        : summary,
  };
}

export function isRunnableQualityGate(command) {
  const value = String(command ?? '').trim();

  if (!value) {
    return false;
  }

  return /^(yarn|npm|pnpm|bun|npx|node|vitest|playwright|tsc|eslint|prettier|rg|grep|find|git|bash|sh)\b/.test(
    value,
  );
}

export async function runQualityGates(commands, options) {
  const results = [];

  for (const command of commands) {
    const result = await runQualityGate(command, options);
    results.push(result);

    if (result.exitCode !== 0) {
      break;
    }
  }

  return results;
}

export function splitQualityGates(commands) {
  const runnable = [];
  const manual = [];

  for (const command of commands) {
    if (isRunnableQualityGate(command)) {
      runnable.push(command);
    } else {
      manual.push(command);
    }
  }

  return { runnable, manual };
}

function runShellCommand(command, { cwd, signal, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

function isCleanRgAudit(command, result) {
  return (
    String(command ?? '')
      .trim()
      .startsWith('rg ') &&
    result.exitCode === 1 &&
    !result.stdout.trim() &&
    !result.stderr.trim()
  );
}

function isMissingRipgrep(command, result) {
  return (
    String(command ?? '')
      .trim()
      .startsWith('rg ') && result.exitCode === 127
  );
}

async function shouldUseRipgrepFallback(command, env) {
  return (
    String(command ?? '')
      .trim()
      .startsWith('rg ') && !(await hasExecutableOnPath('rg', env))
  );
}

async function hasExecutableOnPath(binaryName, env) {
  const pathValue = env?.PATH ?? process.env.PATH ?? '';

  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    try {
      await access(path.join(directory, binaryName), constants.X_OK);
      return true;
    } catch {
      // Keep looking through PATH.
    }
  }

  return false;
}

async function runRipgrepFallback(command, { cwd }) {
  const args = splitShellWords(command).slice(1);
  const fixedString = args.includes('-F') || args.includes('--fixed-strings');
  const paths = [];
  const globExclusions = [];
  let pattern = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '-F' || arg === '--fixed-strings' || arg === '-n') {
      continue;
    }

    if (arg === '--glob') {
      const glob = args[index + 1];
      index += 1;
      if (glob?.startsWith('!')) {
        globExclusions.push(glob.slice(1));
      }
      continue;
    }

    if (arg.startsWith('--glob=')) {
      const glob = arg.slice('--glob='.length);
      if (glob.startsWith('!')) {
        globExclusions.push(glob.slice(1));
      }
      continue;
    }

    if (arg.startsWith('-')) {
      continue;
    }

    if (pattern === null) {
      pattern = arg;
      continue;
    }

    paths.push(arg);
  }

  if (!pattern) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: 'rg fallback could not determine a search pattern.',
    };
  }

  const matcher = fixedString
    ? (line) => line.includes(pattern)
    : (line) => new RegExp(pattern).test(line);
  const matches = [];

  for (const searchPath of paths.length ? paths : ['.']) {
    await collectMatches(path.resolve(cwd, searchPath), cwd, matcher, globExclusions, matches);
  }

  return {
    exitCode: matches.length > 0 ? 0 : 1,
    stdout: matches.join('\n'),
    stderr: '',
  };
}

async function collectMatches(absolutePath, cwd, matcher, globExclusions, matches) {
  let entries;

  try {
    entries = await readdir(absolutePath, { withFileTypes: true });
  } catch {
    await collectFileMatches(absolutePath, cwd, matcher, globExclusions, matches);
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(absolutePath, entry.name);
    const relativePath = path.relative(cwd, entryPath);

    if (isIgnoredPath(relativePath, globExclusions)) {
      continue;
    }

    if (entry.isDirectory()) {
      await collectMatches(entryPath, cwd, matcher, globExclusions, matches);
      continue;
    }

    if (entry.isFile()) {
      await collectFileMatches(entryPath, cwd, matcher, globExclusions, matches);
    }
  }
}

async function collectFileMatches(absolutePath, cwd, matcher, globExclusions, matches) {
  const relativePath = path.relative(cwd, absolutePath);

  if (isIgnoredPath(relativePath, globExclusions)) {
    return;
  }

  let contents;

  try {
    contents = await readFile(absolutePath, 'utf8');
  } catch {
    return;
  }

  contents.split('\n').forEach((line, index) => {
    if (matcher(line)) {
      matches.push(`${relativePath}:${index + 1}:${line}`);
    }
  });
}

function isIgnoredPath(relativePath, globExclusions) {
  return globExclusions.some((glob) => {
    const normalizedGlob = glob.replaceAll('\\', '/');
    const normalizedPath = relativePath.replaceAll(path.sep, '/');

    if (normalizedGlob.startsWith('**/')) {
      return normalizedPath.endsWith(normalizedGlob.slice(3));
    }

    return normalizedPath === normalizedGlob || normalizedPath.startsWith(`${normalizedGlob}/`);
  });
}

function splitShellWords(command) {
  const words = [];
  let current = '';
  let quote = null;

  for (const char of String(command ?? '')) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    words.push(current);
  }

  return words;
}

export function summarizeOutput(output, maxLines = 40) {
  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);

  if (lines.length <= maxLines) {
    return lines.join('\n');
  }

  return lines.slice(-maxLines).join('\n');
}

function formatDuration(durationMs) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}
