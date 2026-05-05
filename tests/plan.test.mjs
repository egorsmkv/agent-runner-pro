// @vitest-environment node

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendPlanScopeProgress,
  extractPlanFromText,
  hasOpenTemporaryFollowUps,
  isExecutablePlanScope,
  normalizePlan,
  readPlan,
  repairPlanStringArrayItems,
  repairTimestampProgressItems,
  selectParallelPlanScopes,
  selectNextPlanScope,
  updatePlanScope,
} from '../actions/plan/index.mjs';
import { buildPlanPrompt } from '../utils/prompts.mjs';

const planYaml = `version: 1
prdPath: docs/prds/example.md
status: not_complete
activeScopeId: null
lastCompletedScopeId: null
finalAcceptanceStatus: not_complete
qualityGates:
  focused:
    - yarn types
  final:
    - yarn types
    - yarn lint
scopes:
  - id: scope-1
    title: First
    status: complete
    acceptanceCriteria:
      - US-001
    qualityGates:
      - yarn types
    temporaryFollowUps: []
    progress: []
    repairAttempts: 0
  - id: scope-2
    title: Second
    status: not_started
    acceptanceCriteria:
      - US-002
    qualityGates:
      - yarn types
    temporaryFollowUps: []
    progress: []
    repairAttempts: 0
lastRunAt: null
currentBlocker: null
`;

describe('agent YAML plan helpers', () => {
  it('extracts a plan from fenced YAML', () => {
    const plan = extractPlanFromText(`Here is the plan:\n\n\`\`\`yaml\n${planYaml}\`\`\``);

    expect(plan.scopes).toHaveLength(2);
    expect(selectNextPlanScope(plan)?.id).toBe('scope-2');
  });

  it('continues the active in-progress scope before older repair scopes', () => {
    const plan = normalizePlan({
      ...extractPlanFromText(planYaml),
      activeScopeId: 'scope-2',
      scopes: [
        {
          id: 'scope-1',
          title: 'First',
          status: 'needs_repair',
        },
        {
          id: 'scope-2',
          title: 'Second',
          status: 'in_progress',
        },
      ],
    });

    expect(selectNextPlanScope(plan)?.id).toBe('scope-2');
  });

  it('defaults older plans without harness controls or verification evidence', () => {
    const plan = normalizePlan(extractPlanFromText(planYaml));

    expect(plan.harness).toEqual({
      controls: {
        computationalGuides: [],
        inferentialGuides: [],
        computationalSensors: [],
        inferentialSensors: [],
      },
      controlNotes: [],
    });
    expect(plan.scopes[0].verificationEvidence).toEqual([]);
  });

  it('normalizes newer harness controls and scope verification evidence', () => {
    const plan = normalizePlan({
      ...extractPlanFromText(planYaml),
      harness: {
        controls: {
          computationalGuides: ['yarn types'],
          inferentialGuides: ['Scope context bundle'],
          computationalSensors: ['Focused gates'],
          inferentialSensors: ['Scope review'],
        },
        controlNotes: ['Build to delete.'],
      },
      scopes: [
        {
          id: 'scope-1',
          title: 'First',
          status: 'complete',
          verificationEvidence: ['yarn types passed', 'yarn types passed'],
        },
      ],
    });

    expect(plan.harness.controls.computationalGuides).toEqual(['yarn types']);
    expect(plan.harness.controls.inferentialSensors).toEqual(['Scope review']);
    expect(plan.harness.controlNotes).toEqual(['Build to delete.']);
    expect(plan.scopes[0].verificationEvidence).toEqual(['yarn types passed']);
  });

  it('waits for dependency completion before selecting a parallel-ready scope', () => {
    const plan = normalizePlan({
      ...extractPlanFromText(planYaml),
      scopes: [
        {
          id: 'scope-1',
          title: 'First',
          status: 'not_started',
          parallelGroup: 'batch-1',
        },
        {
          id: 'scope-2',
          title: 'Second',
          status: 'not_started',
          dependsOn: ['scope-1'],
          parallelGroup: 'batch-2',
          ownedFiles: ['src/example/**'],
        },
      ],
    });

    expect(plan.scopes[1].dependsOn).toEqual(['scope-1']);
    expect(plan.scopes[1].parallelGroup).toBe('batch-2');
    expect(plan.scopes[1].ownedFiles).toEqual(['src/example/**']);
    expect(selectNextPlanScope(plan)?.id).toBe('scope-1');
  });

  it('selects non-overlapping dependency-ready scopes for a parallel batch', () => {
    const plan = normalizePlan({
      ...extractPlanFromText(planYaml),
      scopes: [
        {
          id: 'scope-1',
          title: 'First',
          status: 'complete',
        },
        {
          id: 'scope-2',
          title: 'Second',
          status: 'not_started',
          dependsOn: ['scope-1'],
          parallelGroup: 'batch-1',
          ownedFiles: ['src/a/**'],
        },
        {
          id: 'scope-3',
          title: 'Third',
          status: 'not_started',
          dependsOn: ['scope-1'],
          parallelGroup: 'batch-1',
          ownedFiles: ['src/b/**'],
        },
        {
          id: 'scope-4',
          title: 'Overlapping',
          status: 'not_started',
          dependsOn: ['scope-1'],
          parallelGroup: 'batch-1',
          ownedFiles: ['src/a/file.ts'],
        },
      ],
    });

    expect(selectParallelPlanScopes(plan, { limit: 3 }).map((scope) => scope.id)).toEqual([
      'scope-2',
      'scope-3',
    ]);
  });

  it('skips non-executable plan hygiene scopes when selecting work', () => {
    const plan = normalizePlan({
      ...extractPlanFromText(planYaml),
      activeScopeId: 'scope-1',
      scopes: [
        {
          id: 'scope-1',
          title: 'Final acceptance risk cleanup',
          status: 'in_progress',
          acceptanceCriteria: [
            'This scope is non-executable plan hygiene only and must not receive implementation work.',
          ],
          temporaryFollowUps: ['Do not execute `scope-1`; use concrete owning scopes instead.'],
        },
        {
          id: 'scope-2',
          title: 'Concrete work',
          status: 'in_progress',
          ownedFiles: ['src/concrete/**'],
        },
      ],
    });

    expect(isExecutablePlanScope(plan.scopes[0])).toBe(false);
    expect(selectNextPlanScope(plan)?.id).toBe('scope-2');
    expect(selectParallelPlanScopes(plan, { limit: 2 }).map((scope) => scope.id)).toEqual([
      'scope-2',
    ]);
  });

  it('updates scope status and progress', () => {
    let plan = normalizePlan(extractPlanFromText(planYaml));

    plan = updatePlanScope(plan, 'scope-2', { status: 'in_progress' });
    plan = appendPlanScopeProgress(plan, 'scope-2', 'Started.');

    expect(plan.scopes[1].status).toBe('in_progress');
    expect(plan.scopes[1].progress[0]).toContain('Started.');
  });

  it('detects unresolved temporary follow-ups', () => {
    const plan = normalizePlan({
      ...extractPlanFromText(planYaml),
      scopes: [
        {
          id: 'scope-1',
          title: 'First',
          status: 'complete',
          temporaryFollowUps: ['Remove temporary adapter.'],
        },
      ],
    });

    expect(hasOpenTemporaryFollowUps(plan)).toBe(true);
  });

  it('cleans noisy progress and duplicate temporary follow-ups while normalizing', () => {
    const plan = normalizePlan({
      ...extractPlanFromText(planYaml),
      scopes: [
        {
          id: 'scope-1',
          title: 'First',
          status: 'in_progress',
          temporaryFollowUps: ['Remove adapter.', 'Remove adapter.'],
          progress: [
            '[object Object]',
            { timestamp: '2026-04-30T00:00:00Z', message: 'Structured progress.' },
            { summary: 'Summary progress.' },
          ],
        },
      ],
    });

    expect(plan.scopes[0].temporaryFollowUps).toEqual(['Remove adapter.']);
    expect(plan.scopes[0].progress).toEqual([
      '2026-04-30T00:00:00Z - Structured progress.',
      'Summary progress.',
    ]);
  });

  it('caps old progress entries', () => {
    const plan = normalizePlan({
      ...extractPlanFromText(planYaml),
      scopes: [
        {
          id: 'scope-1',
          title: 'First',
          status: 'in_progress',
          progress: Array.from({ length: 25 }, (_item, index) => `progress ${index + 1}`),
        },
      ],
    });

    expect(plan.scopes[0].progress).toHaveLength(20);
    expect(plan.scopes[0].progress[0]).toBe('progress 6');
  });

  it('repairs unquoted timestamp progress entries that contain YAML key syntax', async () => {
    const brokenYaml = planYaml.replace(
      '    progress: []',
      `    progress:
      - 2026-04-30T12:00:00Z - Verification pass re-confirmed the tree
        as-is: \`yarn types\` passed`,
    );
    const tempDir = await mkdtemp(path.join(tmpdir(), 'agent-plan-'));
    const planPath = path.join(tempDir, 'plan.yaml');
    await writeFile(planPath, brokenYaml);

    const plan = await readPlan(planPath);
    const repairedYaml = await readFile(planPath, 'utf8');

    expect(plan.scopes[0].progress[0]).toContain('as-is: `yarn types` passed');
    expect(repairedYaml).toContain('progress:');
    expect(repairedYaml).toContain('as-is: `yarn types` passed');
    expect(repairTimestampProgressItems(brokenYaml)).toContain('- >-');
  });

  it('extracts generated plan criteria with unquoted colons as strings', () => {
    const brokenYaml = planYaml.replace(
      '      - US-001',
      '      - US-001: Parse common RSS and Atom fields into a stable item shape: title, link, date',
    );

    const plan = extractPlanFromText(`\`\`\`yaml\n${brokenYaml}\`\`\``);

    expect(plan.scopes[0].acceptanceCriteria).toEqual([
      'US-001: Parse common RSS and Atom fields into a stable item shape: title, link, date',
    ]);
    expect(repairPlanStringArrayItems(brokenYaml)).toContain(
      '"US-001: Parse common RSS and Atom fields into a stable item shape: title, link, date"',
    );
  });

  it('rewrites existing plans whose unquoted string-array items parsed as mappings', async () => {
    const brokenYaml = planYaml.replace(
      '      - US-001',
      '      - US-001: Return clear validation errors',
    );
    const tempDir = await mkdtemp(path.join(tmpdir(), 'agent-plan-'));
    const planPath = path.join(tempDir, 'plan.yaml');
    await writeFile(planPath, brokenYaml);

    const plan = await readPlan(planPath);
    const repairedYaml = await readFile(planPath, 'utf8');

    expect(plan.scopes[0].acceptanceCriteria).toEqual([
      'US-001: Return clear validation errors',
    ]);
    expect(repairedYaml).toContain('"US-001: Return clear validation errors"');
  });

  it('builds a planning prompt that asks for YAML only', async () => {
    const prompt = await buildPlanPrompt({
      prdPath: 'docs/prds/example.md',
      markdown: '# PRD: Example',
    });

    expect(prompt).toContain('Return YAML only');
    expect(prompt).toContain('scopes:');
    expect(prompt).toContain('# PRD: Example');
    expect(prompt).not.toContain('@@previousPlanYaml@@');
  });
});
