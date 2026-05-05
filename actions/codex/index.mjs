import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const codexArgs = ['-m', 'gpt-5.4', '-c', 'model_reasoning_effort="medium"'];
const progressIntervalMs = 15000;

export async function runCodexScope({
  repoRoot,
  prompt,
  logsDir,
  scopeId,
  verboseJson = false,
  signal,
  getProgressSnapshot = null,
  log = console.log,
}) {
  await mkdir(logsDir, { recursive: true });

  const slug = scopeId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonLogPath = path.join(logsDir, `${timestamp}-${slug}.jsonl`);
  const lastMessagePath = path.join(logsDir, `${timestamp}-${slug}-last-message.txt`);
  const args = [
    'exec',
    '--json',
    '-C',
    repoRoot,
    '--output-last-message',
    lastMessagePath,
    ...codexArgs,
    '-',
  ];
  const relativeJsonLogPath = path.relative(repoRoot, jsonLogPath);
  const relativeLastMessagePath = path.relative(repoRoot, lastMessagePath);

  const commandText = `codex ${args.slice(0, -1).join(' ')} -`;
  const startedAt = Date.now();
  if (log.codexStart) {
    log.codexStart({
      scopeId,
      command: commandText,
      jsonLogPath: relativeJsonLogPath,
      lastMessagePath: relativeLastMessagePath,
    });
  } else {
    log(`[codex] start: ${commandText}`);
    log(`[codex] jsonl: ${relativeJsonLogPath}`);
    log(`[codex] last message: ${relativeLastMessagePath}`);
  }

  let lastProgressSnapshot = getProgressSnapshot ? await getProgressSnapshot() : null;

  const result = await new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
    });
    let stdoutBuffer = '';
    let rawJson = '';
    let stderr = '';
    let eventCount = 0;
    let lastEventType = 'none';
    let lastActivity = 'starting session';
    let stderrBuffer = '';
    let progressSnapshotInFlight = false;
    const progressTimer = setInterval(async () => {
      const elapsed = formatDuration(Date.now() - startedAt);
      if (log.codexHeartbeat) {
        log.codexHeartbeat({
          elapsed,
          lastActivity,
        });
      } else {
        log(
          `[codex] waiting for response ${elapsed}; last=${lastActivity}; log=${relativeJsonLogPath}`,
        );
      }

      if (!getProgressSnapshot || progressSnapshotInFlight) {
        return;
      }

      progressSnapshotInFlight = true;
      try {
        const nextSnapshot = await getProgressSnapshot();
        if (nextSnapshot !== lastProgressSnapshot) {
          const changeSummary = summarizeWorktreeChanges(nextSnapshot);
          if (changeSummary) {
            if (log.codexFilesChanged) {
              log.codexFilesChanged(changeSummary);
            } else {
              log(`[codex] ${changeSummary.summary}`);
            }
          }
          lastProgressSnapshot = nextSnapshot;
        }
      } finally {
        progressSnapshotInFlight = false;
      }
    }, progressIntervalMs);

    child.stdin.end(prompt);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      rawJson += chunk;
      stdoutBuffer += chunk;

      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const eventType = readEventType(line);
        if (eventType) {
          eventCount += 1;
          lastEventType = eventType;
        }
        if (verboseJson) {
          log(`[codex:json] ${line}`);
        }
        const activity = printCodexEvent(line, log);
        if (activity) {
          lastActivity = activity;
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      stderrBuffer += chunk;

      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() ?? '';

      for (const line of lines) {
        printCodexStderr(line, log, { verboseJson });
      }
    });
    child.on('error', (error) => {
      clearInterval(progressTimer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      clearInterval(progressTimer);
      if (stdoutBuffer.trim()) {
        const eventType = readEventType(stdoutBuffer);
        if (eventType) {
          eventCount += 1;
          lastEventType = eventType;
        }
        if (verboseJson) {
          log(`[codex:json] ${stdoutBuffer}`);
        }
        const activity = printCodexEvent(stdoutBuffer, log);
        if (activity) {
          lastActivity = activity;
        }
      }

      if (stderrBuffer.trim()) {
        printCodexStderr(stderrBuffer, log, { verboseJson });
      }

      resolve({
        exitCode: exitCode ?? 1,
        rawJson,
        stderr,
        eventCount,
        lastEventType,
      });
    });
  });

  await writeFile(jsonLogPath, result.rawJson);
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startedAt;
  const usage = summarizeCodexUsage(result.rawJson);
  await appendHarnessMetric(path.join(path.dirname(logsDir), 'harness-metrics.jsonl'), {
    timestamp: completedAt,
    scopeId,
    phase: scopeId,
    exitCode: result.exitCode,
    durationMs,
    eventCount: result.eventCount,
    lastEventType: result.lastEventType,
    usage,
    reviewVerdict: null,
    repairAttempts: null,
    qualityGates: [],
    jsonLogPath: relativeJsonLogPath,
    lastMessagePath: relativeLastMessagePath,
  });
  if (log.codexExit) {
    log.codexExit({
      exitCode: result.exitCode,
      eventCount: result.eventCount,
      lastEventType: result.lastEventType,
      jsonLogPath: relativeJsonLogPath,
    });
  } else {
    log(
      `[codex] exit ${result.exitCode}; events=${result.eventCount}; last=${result.lastEventType}; log=${relativeJsonLogPath}`,
    );
  }

  return {
    ...result,
    jsonLogPath,
    lastMessagePath,
  };
}

export function summarizeCodexUsage(rawJson) {
  const totals = {};

  for (const line of String(rawJson ?? '').split('\n')) {
    if (!line.trim()) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const usage = event.usage ?? event.msg?.usage;
    if (!usage || typeof usage !== 'object') {
      continue;
    }

    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        totals[key] = (totals[key] ?? 0) + value;
      }
    }
  }

  return totals;
}

async function appendHarnessMetric(metricsPath, metric) {
  await mkdir(path.dirname(metricsPath), { recursive: true });
  await appendFile(metricsPath, `${JSON.stringify(metric)}\n`);
}

export function readEventType(line) {
  try {
    const event = JSON.parse(line.trim());
    return event.type ?? event.event ?? event.msg?.type ?? event.item?.type ?? null;
  } catch {
    return null;
  }
}

function printCodexEvent(line, log) {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  try {
    const event = JSON.parse(trimmed);
    const message = formatCodexEventMessage(event);

    if (message) {
      if (log.codexEvent) {
        log.codexEvent(message);
      } else {
        log(message);
      }
      return codexActivityLabel(event, message);
    }
  } catch {
    log(trimmed);
  }

  return null;
}

export function formatCodexEventMessage(event) {
  const type = event.type ?? event.event ?? event.msg?.type;
  const item = event.item ?? event.msg?.item;

  if (type === 'agent_message' || type === 'message') {
    const text = event.message ?? event.text ?? event.msg?.message ?? contentText(event.content);
    return text ? `[codex] ${oneLine(text)}` : null;
  }

  if (type === 'agent_reasoning' || type === 'reasoning') {
    const text = event.text ?? event.summary ?? event.msg?.text ?? contentText(event.content);
    return text ? `[codex:think] ${oneLine(text)}` : null;
  }

  if (type === 'response_item' && item) {
    return responseItemMessage(item);
  }

  if ((type === 'item.completed' || type === 'item.started') && item) {
    return itemMessage(type, item);
  }

  if (type === 'turn.completed') {
    return turnCompletedMessage(event.usage ?? event.msg?.usage);
  }

  if (type === 'exec_command_begin' || type === 'exec_command') {
    const command = event.command ?? event.cmd ?? event.msg?.command ?? item?.command;
    return command ? `[codex:cmd] ${command}` : null;
  }

  if (type === 'exec_command_end') {
    const exitCode = event.exit_code ?? event.exitCode ?? event.msg?.exit_code;
    return `[codex:cmd] exit ${exitCode ?? 'unknown'}`;
  }

  if (type === 'task_complete' || type === 'turn_complete') {
    return '[codex] turn complete';
  }

  if (typeof type === 'string' && /error|failed|failure/i.test(type)) {
    const text = event.message ?? event.error ?? event.msg?.message ?? event.msg?.error;
    return `[codex:error] ${oneLine(text ?? type)}`;
  }

  if (typeof type === 'string' && /turn|task|session|conversation|thread/i.test(type)) {
    return `[codex:stage] ${type.replaceAll('.', ' ')}`;
  }

  return null;
}

function printCodexStderr(line, log, { verboseJson = false } = {}) {
  const trimmed = line.trim();

  if (!trimmed) {
    return;
  }

  if (!verboseJson && isBenignCodexDiagnostic(trimmed)) {
    return;
  }

  const message = `[codex:warn] ${oneLine(cleanCodexDiagnostic(trimmed))}`;
  if (log.codexEvent) {
    log.codexEvent(message);
  } else {
    log(message);
  }
}

function responseItemMessage(item) {
  if (item.type === 'message') {
    const text = contentText(item.content) ?? item.text;
    return text ? `[codex] ${oneLine(text)}` : '[codex] message';
  }

  if (item.type === 'reasoning') {
    const text = contentText(item.summary) ?? item.text;
    return text ? `[codex] ${oneLine(text)}` : '[codex] reasoning';
  }

  if (item.type === 'function_call') {
    return `[codex:tool] ${item.name ?? 'function_call'}`;
  }

  if (item.type === 'function_call_output') {
    return '[codex:tool] output received';
  }

  return item.type ? `[codex] ${item.type}` : null;
}

function itemMessage(type, item) {
  if (item.type === 'agent_message') {
    const text = item.text ?? contentText(item.content);
    return text ? `[codex] ${oneLine(text)}` : '[codex] message completed';
  }

  if (item.type === 'reasoning') {
    const text = item.text ?? contentText(item.summary) ?? contentText(item.content);
    return text ? `[codex:think] ${oneLine(text)}` : `[codex:think] reasoning`;
  }

  if (item.type === 'function_call') {
    return `[codex:tool] ${item.name ?? 'function_call'}`;
  }

  if (item.type === 'command_execution') {
    return commandExecutionMessage(type, item);
  }

  return null;
}

function commandExecutionMessage(type, item) {
  const command = item.command ?? item.cmd ?? item.arguments?.cmd ?? item.arguments?.command;
  const status = item.status ?? item.state;
  const exitCode = item.exit_code ?? item.exitCode;

  if (command) {
    return `[codex:cmd] ${oneLine(command)}`;
  }

  if (exitCode != null) {
    return `[codex:cmd] exit ${exitCode}`;
  }

  if (status && status !== 'in_progress' && status !== 'completed') {
    return `[codex:cmd] ${status}`;
  }

  return null;
}

function turnCompletedMessage(usage) {
  if (!usage || typeof usage !== 'object') {
    return '[codex:done] turn completed';
  }

  const input = usage.input_tokens ?? usage.inputTokens;
  const cached = usage.cached_input_tokens ?? usage.cachedInputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  const reasoning = usage.reasoning_output_tokens ?? usage.reasoningOutputTokens;
  const parts = [
    input != null ? `input ${input}` : null,
    cached != null ? `cached ${cached}` : null,
    output != null ? `output ${output}` : null,
    reasoning != null ? `reasoning ${reasoning}` : null,
  ].filter(Boolean);

  return `[codex:done] turn completed${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

function codexActivityLabel(event, message) {
  const type = event.type ?? event.event ?? event.msg?.type;

  if (type === 'turn.started') {
    return 'turn started';
  }

  if (type === 'thread.started') {
    return 'thread started';
  }

  if (type === 'turn.completed') {
    return 'turn completed';
  }

  if (type === 'item.completed') {
    return message.includes('[codex:done]') ? 'turn completed' : 'received item';
  }

  return type ? String(type).replaceAll('.', ' ') : 'received event';
}

function cleanCodexDiagnostic(line) {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, '');
}

export function isBenignCodexDiagnostic(line) {
  return /ERROR\s+codex_core::session:\s+failed to record rollout items:\s+thread\s+\S+\s+not found/.test(
    line,
  );
}

export function summarizeWorktreeChanges(statusText, maxFiles = 6) {
  const files = parseGitStatus(statusText);

  if (files.length === 0) {
    return null;
  }

  const visibleFiles = files.slice(0, maxFiles);
  const remaining = files.length - visibleFiles.length;
  const summary = `changed ${files.length} file${files.length === 1 ? '' : 's'}${remaining > 0 ? ` (+${remaining} more)` : ''}`;

  return {
    summary,
    files: visibleFiles,
  };
}

function parseGitStatus(statusText) {
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

function contentText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      return part?.text ?? part?.content ?? '';
    })
    .filter(Boolean)
    .join(' ');
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function formatDuration(durationMs) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${Math.round(durationMs / 1000)}s`;
}
