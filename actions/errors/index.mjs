import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function errorLogPath(repoRoot) {
  return path.join(repoRoot, '.agent', 'error.log');
}

export async function appendAgentErrorLog({ repoRoot, command, error, phase = 'crash' }) {
  const logPath = errorLogPath(repoRoot);
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(
    logPath,
    [
      `## ${new Date().toISOString()} ${phase}`,
      `command: ${command}`,
      '',
      error?.stack ?? String(error),
      '',
    ].join('\n'),
  );

  return logPath;
}

export function isInterruptError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}
