// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { createReporter, formatKnownMessage } from '../actions/reporter/index.mjs';

describe('agent terminal reporter', () => {
  it('formats known message prefixes without timestamps', () => {
    expect(formatKnownMessage('[agent] PRD: Example')).toBe('agent PRD: Example');
    expect(formatKnownMessage('[gate] pass: yarn types (1.2s)')).toBe('pass  yarn types (1.2s)');
    expect(formatKnownMessage('[gate] skip: targeted tests (not a shell command)')).toBe(
      'skip  targeted tests (not a shell command)',
    );
    expect(formatKnownMessage('[codex:stage] turn started')).toBe('   | stage     turn started');
  });

  it('prints section fields and nested codex session details', () => {
    const lines = [];
    const reporter = createReporter({
      stream: {
        isTTY: false,
        write: (value) => lines.push(value.trimEnd()),
      },
      useColor: false,
    });

    reporter.section('Agent Run', [['file', 'docs/prds/example.md']]);
    reporter.codexStart({
      scopeId: 'plan-generation',
      command: 'codex exec --json --output-last-message /tmp/last.txt -',
      jsonLogPath: '.agent/example/log.jsonl',
      lastMessagePath: '.agent/example/last.txt',
    });
    reporter.codexHeartbeat({
      elapsed: '15s',
      lastActivity: 'turn started',
    });
    reporter.codexFilesChanged({
      summary: 'changed 2 files',
      files: [
        { status: 'M', path: 'src/a.ts' },
        { status: '??', path: 'scripts/agent/index.mjs' },
      ],
    });

    expect(lines).toContain('== Agent Run ==');
    expect(lines).toContain('   file         docs/prds/example.md');
    expect(lines).toContain('   codex plan-generation');
    expect(lines).toContain('   ... waiting for Codex 15s turn started');
    expect(lines).toContain('   files changed 2 files');
    expect(lines).toContain('   | M   src/a.ts');
    expect(lines).toContain('   | ??  scripts/agent/index.mjs');
  });
});
