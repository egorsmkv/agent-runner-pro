const colorCodes = {
  dim: ['\x1b[2m', '\x1b[22m'],
  cyan: ['\x1b[36m', '\x1b[39m'],
  green: ['\x1b[32m', '\x1b[39m'],
  yellow: ['\x1b[33m', '\x1b[39m'],
  red: ['\x1b[31m', '\x1b[39m'],
  gray: ['\x1b[90m', '\x1b[39m'],
  bold: ['\x1b[1m', '\x1b[22m'],
};

export function createReporter({ stream = process.stdout, useColor = stream.isTTY } = {}) {
  const color = (name, value) => {
    if (!useColor || !colorCodes[name]) {
      return String(value);
    }

    const [open, close] = colorCodes[name];
    return `${open}${value}${close}`;
  };

  const write = (line = '') => {
    stream.write(`${line}\n`);
  };

  const reporter = (message) => {
    write(formatKnownMessage(message, color));
  };

  reporter.section = (title, fields = []) => {
    write('');
    write(`${color('cyan', '==')} ${color('bold', title)} ${color('cyan', '==')}`);
    for (const [label, value] of fields) {
      reporter.field(label, value);
    }
  };

  reporter.stage = (title, fields = []) => {
    write('');
    write(`${color('cyan', '--')} ${color('bold', title)}`);
    for (const [label, value] of fields) {
      reporter.field(label, value);
    }
  };

  reporter.field = (label, value) => {
    write(`   ${color('gray', label.padEnd(12))} ${value}`);
  };

  reporter.codexStart = ({ scopeId, command, jsonLogPath, lastMessagePath }) => {
    write('');
    write(`   ${color('cyan', 'codex')} ${color('bold', scopeId)}`);
    write(`   ${color('gray', 'cmd'.padEnd(12))} ${shortCommand(command)}`);
    write(`   ${color('gray', 'jsonl'.padEnd(12))} ${jsonLogPath}`);
    write(`   ${color('gray', 'last'.padEnd(12))} ${lastMessagePath}`);
  };

  reporter.codexEvent = (message) => {
    const { label, text } = parseCodexMessage(message);
    write(`   ${color('gray', '|')} ${color(labelColor(label), label.padEnd(9))} ${text}`);
  };

  reporter.codexHeartbeat = ({ elapsed, lastActivity }) => {
    write(
      `   ${color('yellow', '...')} waiting for Codex ${elapsed} ${color('gray', lastActivity)}`,
    );
  };

  reporter.codexFilesChanged = ({ summary, files }) => {
    write(`   ${color('yellow', 'files')} ${summary}`);
    for (const file of files) {
      write(`   ${color('gray', '|')} ${color('yellow', file.status.padEnd(3))} ${file.path}`);
    }
  };

  reporter.codexExit = ({ exitCode, eventCount, lastEventType, jsonLogPath }) => {
    const marker = exitCode === 0 ? color('green', 'ok') : color('red', 'fail');
    write(
      `   ${marker} codex exit ${exitCode}; events=${eventCount}; last=${lastEventType}; log=${jsonLogPath}`,
    );
  };

  return reporter;
}

export function formatKnownMessage(message, color = (_name, value) => String(value)) {
  const value = String(message);

  if (value.startsWith('[agent]')) {
    return `${color('cyan', 'agent')} ${value.replace(/^\[agent\]\s*/, '')}`;
  }

  if (value.startsWith('[git]')) {
    return `${color('gray', 'git')}   ${value.replace(/^\[git\]\s*/, '')}`;
  }

  if (value.startsWith('[gate] pass:')) {
    return `${color('green', 'pass')}  ${value.replace(/^\[gate\]\s*pass:\s*/, '')}`;
  }

  if (value.startsWith('[gate] fail:')) {
    return `${color('red', 'fail')}  ${value.replace(/^\[gate\]\s*fail:\s*/, '')}`;
  }

  if (value.startsWith('[gate] start:')) {
    return `${color('yellow', 'gate')}  ${value.replace(/^\[gate\]\s*start:\s*/, '')}`;
  }

  if (value.startsWith('[gate] skip:')) {
    return `${color('gray', 'skip')}  ${value.replace(/^\[gate\]\s*skip:\s*/, '')}`;
  }

  if (value.startsWith('[codex')) {
    const { label, text } = parseCodexMessage(value);
    return `   ${color('gray', '|')} ${color(labelColor(label), label.padEnd(9))} ${text}`;
  }

  return value;
}

function shortCommand(command) {
  return command.replace(/\s+--output-last-message\s+\S+/g, ' --output-last-message <file>');
}

function parseCodexMessage(message) {
  const match = String(message).match(/^\[codex(?::([^\]]+))?\]\s*(.*)$/);

  if (!match) {
    return { label: 'codex', text: String(message) };
  }

  return {
    label: match[1] ?? 'codex',
    text: match[2],
  };
}

function labelColor(label) {
  if (label === 'error') {
    return 'red';
  }

  if (label === 'warn') {
    return 'yellow';
  }

  if (label === 'done') {
    return 'green';
  }

  if (label === 'think') {
    return 'yellow';
  }

  if (label === 'cmd' || label === 'tool') {
    return 'cyan';
  }

  return 'gray';
}
