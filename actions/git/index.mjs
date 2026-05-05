import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function gitStatus(repoRoot) {
  const result = await runGit(repoRoot, ['status', '--short', '--untracked-files=all']);
  return result.stdout.trimEnd();
}

export async function gitDiff(repoRoot, filePaths = null) {
  const args = ['diff', 'HEAD', '--', ...(filePaths?.length ? filePaths : ['.'])];
  const result = await runGit(repoRoot, args);
  return result.stdout.trim();
}

export async function gitRecentCommits(repoRoot, maxCount = 12) {
  const result = await runGit(repoRoot, [
    'log',
    `--max-count=${maxCount}`,
    '--pretty=format:%h %s',
  ]);
  return result.stdout.trim();
}

export async function createWorktreeSnapshot(repoRoot) {
  const status = await gitStatus(repoRoot);
  const files = new Map();

  for (const entry of parseGitStatus(status)) {
    const reviewText =
      entry.status === '??'
        ? await syntheticUntrackedDiff(repoRoot, entry.path)
        : await gitDiff(repoRoot, [entry.path]);

    files.set(entry.path, {
      ...entry,
      reviewText,
      hash: hashText(reviewText),
    });
  }

  return {
    status,
    files,
  };
}

export async function createReviewPackage(
  repoRoot,
  baselineSnapshot,
  { includeCurrentWhenNoDelta = false, ignoreWhenNoDelta = [] } = {},
) {
  const currentSnapshot = await createWorktreeSnapshot(repoRoot);
  const changedEntries = [];

  for (const [filePath, current] of currentSnapshot.files.entries()) {
    const baseline = baselineSnapshot?.files?.get(filePath);

    if (!baseline || baseline.hash !== current.hash || baseline.status !== current.status) {
      changedEntries.push(current);
    }
  }

  for (const [filePath, baseline] of baselineSnapshot?.files ?? []) {
    if (!currentSnapshot.files.has(filePath)) {
      changedEntries.push({
        status: '--',
        path: filePath,
        reviewText: `Pre-existing dirty file was removed from the dirty worktree during this scope: ${filePath}`,
        hash: baseline.hash,
      });
    }
  }

  if (changedEntries.length === 0 && includeCurrentWhenNoDelta) {
    changedEntries.push(
      ...[...currentSnapshot.files.values()].filter(
        (entry) => !ignoreWhenNoDelta.some((prefix) => entry.path.startsWith(prefix)),
      ),
    );
  }

  return {
    gitStatus: formatGitStatusEntries(changedEntries),
    gitDiff: changedEntries
      .map((entry) => entry.reviewText)
      .filter(Boolean)
      .join('\n\n')
      .trim(),
    changedFiles: changedEntries.map((entry) => entry.path),
    baselineStatus: baselineSnapshot?.status ?? '',
    currentStatus: currentSnapshot.status,
  };
}

export async function commitAll(repoRoot, message) {
  const status = await gitStatus(repoRoot);

  if (!status) {
    return { committed: false, reason: 'No changes to commit.' };
  }

  await runGit(repoRoot, ['add', '-A']);

  const staged = await runGit(repoRoot, ['diff', '--cached', '--name-only']);
  if (!staged.stdout.trim()) {
    return { committed: false, reason: 'No staged changes to commit.' };
  }

  await runGit(repoRoot, ['commit', '-m', message]);

  return { committed: true, commitHash: await gitHead(repoRoot) };
}

export function scopeCommitMessage(scope, prdPath) {
  return `agent: complete ${scope.id} - ${scope.title}\n\nPRD: ${prdPath}`;
}

export async function gitHead(repoRoot) {
  const result = await runGit(repoRoot, ['rev-parse', 'HEAD']);
  return result.stdout.trim();
}

export async function applyCommitToCheckout(repoRoot, commitHash) {
  const status = await gitStatus(repoRoot);

  if (status) {
    return {
      applied: false,
      reason: 'Parent checkout has uncommitted changes.',
      status,
    };
  }

  const conflictMarkers = await scanConflictMarkersInCommit(repoRoot, commitHash);

  if (conflictMarkers) {
    return {
      applied: false,
      conflictMarkers: true,
      reason: `Scope commit ${commitHash} contains conflict markers.`,
      output: conflictMarkers,
    };
  }

  const result = await runGit(repoRoot, ['cherry-pick', commitHash], { rejectOnFailure: false });

  if (result.exitCode === 0) {
    return {
      applied: true,
      commitHash: await gitHead(repoRoot),
    };
  }

  const conflictStatus = await gitStatus(repoRoot);
  const abortResult = await runGit(repoRoot, ['cherry-pick', '--abort'], {
    rejectOnFailure: false,
  });

  return {
    applied: false,
    conflict: true,
    reason: `git cherry-pick ${commitHash} failed with ${result.exitCode}`,
    output: `${result.stdout}\n${result.stderr}`.trim(),
    status: conflictStatus,
    aborted: abortResult.exitCode === 0,
    abortOutput: `${abortResult.stdout}\n${abortResult.stderr}`.trim(),
    postAbortStatus: await gitStatus(repoRoot),
  };
}

export async function scanConflictMarkersInCommit(repoRoot, commitHash) {
  const result = await runGit(
    repoRoot,
    ['grep', '-n', '-E', '^(<<<<<<<|=======|>>>>>>>)', commitHash, '--', '.'],
    { rejectOnFailure: false },
  );

  if (result.exitCode === 1) {
    return '';
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `git grep conflict-marker scan failed with ${result.exitCode}\n${result.stderr || result.stdout}`,
    );
  }

  return result.stdout.trim();
}

export function parseGitStatus(statusText) {
  return String(statusText)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim() || line.slice(0, 2);
      const filePath = line.slice(3).trim();

      return {
        status,
        path: filePath || line,
      };
    });
}

function formatGitStatusEntries(entries) {
  return entries
    .map((entry) => `${entry.status.padEnd(2)} ${entry.path}`)
    .join('\n')
    .trim();
}

async function syntheticUntrackedDiff(repoRoot, filePath) {
  const absolutePath = path.join(repoRoot, filePath);
  const fileStat = await stat(absolutePath);

  if (!fileStat.isFile()) {
    return `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@\n+<untracked non-file omitted>`;
  }

  const content = await readFile(absolutePath, 'utf8');
  const lines = content.split('\n');
  const maxLines = 500;
  const visibleLines = lines.slice(0, maxLines);
  const omitted = lines.length > visibleLines.length;

  return [
    `diff --git a/${filePath} b/${filePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${filePath}`,
    '@@',
    ...visibleLines.map((line) => `+${line}`),
    omitted ? `+<${lines.length - visibleLines.length} lines omitted from untracked file>` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function runGit(repoRoot, args, { rejectOnFailure = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve({ exitCode, stdout, stderr });
        return;
      }

      if (!rejectOnFailure) {
        resolve({ exitCode, stdout, stderr });
        return;
      }

      reject(new Error(`git ${args.join(' ')} failed with ${exitCode}\n${stderr || stdout}`));
    });
  });
}
