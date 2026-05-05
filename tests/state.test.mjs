// @vitest-environment node

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createRunState,
  readRecoverableRunnerState,
  readRunnerState,
  resolveStatePaths,
  updateRunState,
  writeRunnerState,
} from '../actions/state/index.mjs';

describe('agent state helpers', () => {
  it('resolves repo-local state paths', () => {
    const paths = resolveStatePaths('/repo', '/repo/docs/prds/example.md');

    expect(paths.stateDir).toBe(path.join('/repo', '.agent'));
    expect(paths.logsDir).toBe(path.join('/repo', '.agent', 'logs'));
    expect(paths.statePath).toBe(path.join('/repo', '.agent', 'state.json'));
    expect(paths.relativePrdPath).toBe(path.join('docs', 'prds', 'example.md'));
  });

  it('preserves prior completed scope when creating a new run state', () => {
    const state = createRunState({
      prdPath: 'docs/prds/example.md',
      activeScopeId: 'Scope 2',
      previousState: {
        lastCompletedScopeId: 'Scope 1',
        lastCodexOutputFile: '.agent/logs/last.txt',
        lastQualityGateResults: [{ command: 'yarn types', exitCode: 0 }],
      },
    });

    expect(state.activeScopeId).toBe('Scope 2');
    expect(state.lastCompletedScopeId).toBe('Scope 1');
    expect(state.interrupted).toBe(false);
  });

  it('updates state timestamps with patches', () => {
    const state = createRunState({ prdPath: 'docs/prds/example.md' });
    const updated = updateRunState(state, { interrupted: true });

    expect(updated.interrupted).toBe(true);
    expect(updated.version).toBe(1);
    expect(updated.updatedAt).toBeTypeOf('string');
  });

  it('treats empty or corrupt state files as missing state', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-state-'));
    const statePath = path.join(tempDir, 'state.json');

    await writeFile(statePath, '');
    await expect(readRunnerState(statePath)).resolves.toBeNull();

    await writeFile(statePath, '{');
    await expect(readRunnerState(statePath)).resolves.toBeNull();
  });

  it('writes state through an atomic temp file replacement', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-state-'));
    const statePath = path.join(tempDir, 'state.json');
    const state = createRunState({ prdPath: 'docs/prds/example.md' });

    await writeRunnerState(statePath, state);

    await expect(readRunnerState(statePath)).resolves.toMatchObject({
      prdPath: 'docs/prds/example.md',
    });
    await expect(readFile(statePath, 'utf8')).resolves.toContain('"version": 1');
  });

  it('recovers resume state from the newest plan when state json is corrupt', async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-state-'));
    const stateDir = path.join(repoRoot, '.agent');
    const runDir = path.join(repoRoot, '.agent', 'example-prd');

    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'state.json'), '');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, 'plan.yaml'),
      [
        'version: 1',
        'prdPath: "docs/prds/example.md"',
        'status: "not_complete"',
        'activeScopeId: "scope-2"',
        'lastCompletedScopeId: "scope-1"',
        'finalAcceptanceStatus: "not_complete"',
        'qualityGates:',
        '  focused: []',
        '  final: []',
        'scopes:',
        '  - id: "scope-1"',
        '    title: "Example"',
        '    status: "complete"',
        '    acceptanceCriteria: []',
        '    qualityGates: []',
        '    temporaryFollowUps: []',
        '    progress: []',
        '    repairAttempts: 0',
        'currentBlocker: null',
        '',
      ].join('\n'),
    );

    await expect(readRecoverableRunnerState(repoRoot)).resolves.toMatchObject({
      prdPath: 'docs/prds/example.md',
      activeScopeId: 'scope-2',
      lastCompletedScopeId: 'scope-1',
    });
  });
});
