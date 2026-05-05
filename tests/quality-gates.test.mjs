// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  isRunnableQualityGate,
  runQualityGate,
  splitQualityGates,
  summarizeOutput,
} from '../actions/quality-gates/index.mjs';

describe('quality gate output summaries', () => {
  it('keeps the last lines when output is long', () => {
    const output = Array.from({ length: 5 }, (_item, index) => `line ${index + 1}`).join('\n');

    expect(summarizeOutput(output, 2)).toBe('line 4\nline 5');
  });

  it('drops blank lines', () => {
    expect(summarizeOutput('\nfirst\n\nsecond\n')).toBe('first\nsecond');
  });

  it('detects runnable shell quality gates', () => {
    expect(isRunnableQualityGate('yarn types')).toBe(true);
    expect(isRunnableQualityGate('targeted WorkflowEditorStore and session tests')).toBe(false);
  });

  it('splits runnable and manual quality gates', () => {
    expect(splitQualityGates(['yarn types', 'targeted WorkflowEditorStore tests'])).toEqual({
      runnable: ['yarn types'],
      manual: ['targeted WorkflowEditorStore tests'],
    });
  });

  it('skips descriptive gates instead of running them in the shell', async () => {
    const lines = [];
    const result = await runQualityGate('targeted WorkflowEditorStore tests', {
      cwd: process.cwd(),
      log: (line) => lines.push(line),
    });

    expect(result.skipped).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(lines[0]).toContain('[gate] skip: targeted WorkflowEditorStore tests');
  });

  it('treats clean rg audits as passing gates', async () => {
    const lines = [];
    const result = await runQualityGate(
      'rg "definitely-not-present-agent-test-pattern" actions',
      {
        cwd: process.cwd(),
        log: (line) => lines.push(line),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.outputSummary).toContain('No matches found');
    expect(lines[1]).toContain('no matches');
  });

  it('falls back to a node search when rg is unavailable', async () => {
    const lines = [];
    const result = await runQualityGate(
      'rg "definitely-not-present-agent-test-pattern" actions',
      {
        cwd: process.cwd(),
        env: { PATH: '' },
        log: (line) => lines.push(line),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.outputSummary).toContain('No matches found');
    expect(lines[1]).toContain('no matches');
  });
});
