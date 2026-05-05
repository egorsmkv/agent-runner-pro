// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { applyPlanReviewResult, parsePlanReview } from '../actions/plan-review/index.mjs';

const basePlan = {
  version: 1,
  prdPath: 'docs/prds/example.md',
  status: 'not_complete',
  activeScopeId: null,
  lastCompletedScopeId: 'scope-1',
  finalAcceptanceStatus: 'not_complete',
  qualityGates: { focused: ['yarn types'], final: ['yarn types'] },
  scopes: [
    {
      id: 'scope-1',
      title: 'Initial scope',
      status: 'complete',
      acceptanceCriteria: ['US-001'],
      qualityGates: ['yarn types'],
      temporaryFollowUps: [
        'Temporary adapter remains.',
        'Temporary adapter remains.',
        'Resolved old bridge removed.',
      ],
      progress: [
        'one',
        'two',
        'three',
        'four',
        'Scope review pass: ok',
        'Focused quality gates passed: yarn types.',
      ],
      repairAttempts: 0,
    },
  ],
  lastRunAt: null,
  currentBlocker: null,
};

describe('plan review action', () => {
  it('parses structured plan review YAML', () => {
    const review = parsePlanReview(`\`\`\`yaml
verdict: needs_plan_update
summary: Missing cleanup scope.
missingScopes:
  - title: Cleanup temp adapters
    reason: Final PRD requires no temp adapters.
    acceptanceCriteria:
      - Remove temporary adapters.
    qualityGates:
      - yarn types
    dependsOn:
      - scope-1
    parallelGroup: batch-2
    ownedFiles:
      - src/example/**
reopenScopes:
  - scopeId: scope-1
    reason: Completion claim is stale.
scopeUpdates:
  - scopeId: scope-1
    reason: Add missing gate.
    addQualityGates:
      - yarn lint
    addDependsOn:
      - scope-0
    setParallelGroup: batch-1
    addOwnedFiles:
      - src/initial/**
cleanup:
  compactProgress: true
  progressKeepLast: 3
  removeResolvedTemporaryFollowUps: true
finalAcceptanceRisks:
  - Verify final architecture.
\`\`\``);

    expect(review.verdict).toBe('needs_plan_update');
    expect(review.missingScopes[0].title).toBe('Cleanup temp adapters');
    expect(review.missingScopes[0].parallelGroup).toBe('batch-2');
    expect(review.reopenScopes[0].scopeId).toBe('scope-1');
    expect(review.scopeUpdates[0].addQualityGates).toEqual(['yarn lint']);
    expect(review.scopeUpdates[0].addDependsOn).toEqual(['scope-0']);
    expect(review.cleanup.progressKeepLast).toBe(3);
  });

  it('applies conservative updates and cleanup to the YAML plan', async () => {
    const writes = [];
    const nextPlan = await applyPlanReviewResult({
      plan: basePlan,
      planPath: '/tmp/unused-plan.yaml',
      review: {
        verdict: 'needs_plan_update',
        summary: 'Need more coverage.',
        missingScopes: [
          {
            title: 'Cleanup temp adapters',
            reason: 'Final PRD requires it.',
            acceptanceCriteria: ['Remove temporary adapters.'],
            qualityGates: ['yarn types'],
            dependsOn: ['scope-1'],
            parallelGroup: 'batch-2',
            ownedFiles: ['src/example/**'],
          },
        ],
        reopenScopes: [{ scopeId: 'scope-1', reason: 'Stale completion claim.' }],
        scopeUpdates: [
          {
            scopeId: 'scope-1',
            reason: 'Add missing lint gate.',
            addAcceptanceCriteria: [],
            addQualityGates: ['yarn lint'],
            addDependsOn: ['scope-0'],
            setParallelGroup: 'batch-1',
            addOwnedFiles: ['src/initial/**'],
            addTemporaryFollowUps: ['New temporary cleanup.'],
            removeTemporaryFollowUps: ['Temporary adapter remains.'],
          },
        ],
        cleanup: {
          compactProgress: true,
          progressKeepLast: 3,
          removeResolvedTemporaryFollowUps: true,
        },
        finalAcceptanceRisks: [],
      },
      writePlanFile: async (_path, plan) => writes.push(plan),
    });

    expect(nextPlan.scopes[0].status).toBe('needs_repair');
    expect(nextPlan.scopes[0].qualityGates).toEqual(['yarn types', 'yarn lint']);
    expect(nextPlan.scopes[0].dependsOn).toEqual(['scope-0']);
    expect(nextPlan.scopes[0].parallelGroup).toBe('batch-1');
    expect(nextPlan.scopes[0].ownedFiles).toEqual(['src/initial/**']);
    expect(nextPlan.scopes[0].temporaryFollowUps).toEqual(['New temporary cleanup.']);
    expect(nextPlan.scopes[0].progress.length).toBeLessThanOrEqual(4);
    expect(nextPlan.scopes[1]).toMatchObject({
      id: 'scope-2',
      title: 'Cleanup temp adapters',
      status: 'not_started',
      dependsOn: ['scope-1'],
      parallelGroup: 'batch-2',
      ownedFiles: ['src/example/**'],
    });
    expect(writes).toHaveLength(1);
  });

  it('keeps final acceptance risks from becoming executable scopes', async () => {
    const nextPlan = await applyPlanReviewResult({
      plan: basePlan,
      planPath: '/tmp/unused-plan.yaml',
      review: {
        verdict: 'needs_plan_update',
        summary: 'Risks need attention but no concrete scope was provided.',
        missingScopes: [],
        reopenScopes: [],
        scopeUpdates: [],
        cleanup: {
          compactProgress: false,
          progressKeepLast: 8,
          removeResolvedTemporaryFollowUps: true,
        },
        finalAcceptanceRisks: ['Final verification is still too broad.'],
      },
      writePlanFile: async () => {},
    });

    expect(nextPlan.scopes).toHaveLength(1);
    expect(nextPlan.scopes.some((scope) => scope.title === 'Final acceptance risk cleanup')).toBe(
      false,
    );
  });
});
