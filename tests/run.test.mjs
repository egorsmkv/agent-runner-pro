// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { selectParallelPlanScopes } from '../actions/plan/index.mjs';
import {
  runBoundedParallelQueue,
  shouldEscalateScopeReviewRepair,
  shouldStopScopeReviewRepair,
} from '../actions/run/index.mjs';

describe('agent run action', () => {
  it('does not stop aligned repair loops only because attempts are high', () => {
    expect(
      shouldStopScopeReviewRepair({
        attempts: 12,
        changedFiles: ['src/example.ts'],
        verdict: 'repair',
      }),
    ).toBe(false);
  });

  it('escalates repeated aligned repair loops to plan review', () => {
    expect(
      shouldEscalateScopeReviewRepair({
        attempts: 4,
        changedFiles: ['src/example.ts'],
        verdict: 'repair',
      }),
    ).toBe(true);
  });

  it('does not escalate no-progress or unrelated loops as plan updates', () => {
    expect(
      shouldEscalateScopeReviewRepair({
        attempts: 7,
        changedFiles: [],
        verdict: 'repair',
      }),
    ).toBe(false);
    expect(
      shouldEscalateScopeReviewRepair({
        attempts: 7,
        changedFiles: ['src/example.ts'],
        verdict: 'unrelated',
      }),
    ).toBe(false);
  });

  it('stops repeated no-progress repair loops', () => {
    expect(
      shouldStopScopeReviewRepair({
        attempts: 7,
        changedFiles: [],
        verdict: 'repair',
      }),
    ).toBe(true);
  });

  it('stops repeated unrelated repair loops', () => {
    expect(
      shouldStopScopeReviewRepair({
        attempts: 7,
        changedFiles: ['scripts/agent/index.mjs'],
        verdict: 'unrelated',
      }),
    ).toBe(true);
  });

  it('keeps worker slots full and schedules newly ready scopes after task completion', async () => {
    const plan = createPlan([
      createScope({ id: 'scope-1' }),
      createScope({ id: 'scope-2' }),
      createScope({ id: 'scope-3', dependsOn: ['scope-2'] }),
      createScope({ id: 'scope-4', dependsOn: ['scope-1'] }),
    ]);
    const controls = new Map(plan.scopes.map((scope) => [scope.id, createDeferred()]));
    const started = [];
    const completed = [];
    const events = [];

    const runPromise = runBoundedParallelQueue({
      limit: 2,
      getReadyItems: async ({ limit, runningIds, scheduledIds }) =>
        selectParallelPlanScopes(plan, {
          limit,
          excludeScopeIds: scheduledIds,
          runningScopes: scopesById(plan, runningIds),
        }),
      onItemStarted: async (scope) => {
        started.push(scope.id);
        events.push(`start:${scope.id}`);
        scope.status = 'in_progress';
      },
      runItem: async (scope) => {
        await controls.get(scope.id).promise;

        return {
          scope,
          exitCode: 0,
          gateResults: [],
          commitResult: { committed: true, commitHash: scope.id },
        };
      },
      onItemCompleted: async ({ item }) => {
        events.push(`merge:${item.id}`);
        completed.push(item.id);
        item.status = 'complete';
      },
    });

    await waitFor(() => started.length === 2);
    expect(started).toEqual(['scope-1', 'scope-2']);

    controls.get('scope-2').resolve();
    await waitFor(() => started.includes('scope-3'));
    expect(started).toEqual(['scope-1', 'scope-2', 'scope-3']);
    expect(events).toEqual(['start:scope-1', 'start:scope-2', 'merge:scope-2', 'start:scope-3']);

    controls.get('scope-3').resolve();
    await waitFor(() => completed.includes('scope-3'));
    expect(started).not.toContain('scope-4');

    controls.get('scope-1').resolve();
    await waitFor(() => started.includes('scope-4'));
    expect(started).toEqual(['scope-1', 'scope-2', 'scope-3', 'scope-4']);
    expect(events).toEqual([
      'start:scope-1',
      'start:scope-2',
      'merge:scope-2',
      'start:scope-3',
      'merge:scope-3',
      'merge:scope-1',
      'start:scope-4',
    ]);

    controls.get('scope-4').resolve();
    const result = await runPromise;

    expect(result.maxRunning).toBe(2);
    expect(completed).toEqual(['scope-2', 'scope-3', 'scope-1', 'scope-4']);
    expect(plan.scopes.map((scope) => scope.status)).toEqual([
      'complete',
      'complete',
      'complete',
      'complete',
    ]);
  });
});

function createPlan(scopes) {
  return {
    version: 1,
    prdPath: 'docs/prds/example.md',
    status: 'not_complete',
    activeScopeId: null,
    lastCompletedScopeId: null,
    finalAcceptanceStatus: 'not_complete',
    qualityGates: { focused: [], final: [] },
    scopes,
    lastRunAt: null,
    currentBlocker: null,
  };
}

function createScope({ id, dependsOn = [], ownedFiles = [] }) {
  return {
    id,
    title: id,
    status: 'not_started',
    acceptanceCriteria: [],
    qualityGates: [],
    dependsOn,
    parallelGroup: 'batch-1',
    ownedFiles,
    temporaryFollowUps: [],
    progress: [],
    repairAttempts: 0,
  };
}

function scopesById(plan, ids) {
  return [...ids].map((id) => plan.scopes.find((scope) => scope.id === id)).filter(Boolean);
}

function createDeferred() {
  let resolve;

  const promise = new Promise((resolver) => {
    resolve = resolver;
  });

  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error('Timed out waiting for condition.');
}
