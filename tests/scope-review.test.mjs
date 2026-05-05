// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  applyScopeReviewResult,
  decideScopeReview,
  parseScopeReview,
  reviewFromDecision,
} from '../actions/scope-review/index.mjs';

const basePlan = {
  version: 1,
  prdPath: 'docs/prds/example.md',
  status: 'not_complete',
  activeScopeId: 'scope-1',
  lastCompletedScopeId: null,
  finalAcceptanceStatus: 'not_complete',
  qualityGates: { focused: ['yarn types'], final: ['yarn types'] },
  scopes: [
    {
      id: 'scope-1',
      title: 'Example',
      status: 'in_progress',
      acceptanceCriteria: ['US-001'],
      qualityGates: ['yarn types'],
      temporaryFollowUps: [],
      verificationEvidence: [],
      progress: [],
      repairAttempts: 0,
    },
  ],
  lastRunAt: null,
  currentBlocker: null,
};

describe('scope review action', () => {
  it('parses fenced YAML review output', () => {
    const review = parseScopeReview(`\`\`\`yaml
verdict: repair
summary: Missing tests.
findings:
  - severity: high
    message: Add focused coverage.
    file: src/example.ts
relatedFiles:
  - src/example.ts
missingWork:
  - Add tests.
temporaryFollowUps:
  - Temporary adapter remains.
verificationEvidence:
  - yarn types passed.
\`\`\``);

    expect(review.verdict).toBe('repair');
    expect(review.findings[0].message).toBe('Add focused coverage.');
    expect(review.temporaryFollowUps).toEqual(['Temporary adapter remains.']);
    expect(review.verificationEvidence).toEqual(['yarn types passed.']);
  });

  it('turns malformed YAML review output into repair when tolerant', () => {
    const review = parseScopeReview(
      'verdict: repair\nsummary: App context issue.\nfindings:\n  - severity: high\n    message: Pending `updateAppContext` leaves bootstrap: null state resident.',
      { tolerant: true },
    );

    expect(review.verdict).toBe('repair');
    expect(review.summary).toContain('Review output was not valid YAML');
    expect(review.findings[0].message).toContain('Review parser failed');
    expect(review.missingWork[0]).toContain('App context issue');
  });

  it('marks non-pass reviews as needs repair and records temporary follow-ups', async () => {
    const writes = [];
    const nextPlan = await applyScopeReviewResult({
      plan: basePlan,
      planPath: '/tmp/unused-plan.yaml',
      scopeId: 'scope-1',
      review: {
        verdict: 'repair',
        summary: 'Missing tests.',
        findings: [],
        relatedFiles: [],
        missingWork: ['Add tests.'],
        temporaryFollowUps: ['Temporary adapter remains.'],
        verificationEvidence: ['yarn types failed before review.'],
      },
      writePlanFile: async (_path, plan) => writes.push(plan),
    });

    expect(nextPlan.scopes[0].status).toBe('needs_repair');
    expect(nextPlan.scopes[0].temporaryFollowUps).toEqual(['Temporary adapter remains.']);
    expect(nextPlan.scopes[0].verificationEvidence).toEqual(['yarn types failed before review.']);
    expect(nextPlan.scopes[0].progress[0]).toContain('Scope review repair: Missing tests.');
    expect(writes).toHaveLength(1);
  });

  it('classifies review mode from actual diff state', () => {
    expect(decideScopeReview({ gitStatus: '', gitDiff: '' })).toMatchObject({
      mode: 'auto-repair',
    });
    expect(
      decideScopeReview({
        gitStatus: '',
        gitDiff: '',
        repairFailure: { command: 'scope review (repair)', exitCode: 1 },
      }),
    ).toMatchObject({
      mode: 'skip',
    });
    expect(
      decideScopeReview({
        gitStatus: ' M docs/prds/example.md',
        gitDiff: 'diff',
        previousGitDiff: '',
      }),
    ).toMatchObject({
      mode: 'light',
      changedFiles: ['docs/prds/example.md'],
    });
    expect(
      decideScopeReview({
        gitStatus: ' M src/example.ts',
        gitDiff: 'diff',
        previousGitDiff: '',
      }),
    ).toMatchObject({
      mode: 'full',
      changedFiles: ['src/example.ts'],
    });
    expect(
      decideScopeReview({
        gitStatus: ' M src/example.ts',
        gitDiff: 'same',
        previousGitDiff: 'same',
        repairFailure: { command: 'yarn types', exitCode: 2 },
      }),
    ).toMatchObject({
      mode: 'skip',
    });
  });

  it('converts automatic review decisions into review results', () => {
    expect(
      reviewFromDecision({
        mode: 'skip',
        reason: 'No diff change.',
        changedFiles: ['src/example.ts'],
      }),
    ).toMatchObject({
      verdict: 'pass',
      relatedFiles: ['src/example.ts'],
    });
    expect(
      reviewFromDecision({
        mode: 'auto-repair',
        reason: 'No changes.',
        changedFiles: [],
      }),
    ).toMatchObject({
      verdict: 'repair',
      missingWork: ['No changes.'],
    });
    expect(reviewFromDecision({ mode: 'full' })).toBeNull();
  });
});
