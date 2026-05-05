// @vitest-environment node

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractRelevantPrdSnippets, writeScopeContext } from '../actions/context/index.mjs';

describe('scope context action', () => {
  it('extracts PRD snippets related to the active scope criteria', () => {
    const markdown = `# PRD

## Summary
Use the editor.

## Scope A
US-001 unrelated work.

## Scope B
US-004 task sidebar store boundary.
Move task commands to the store.
`;

    const snippets = extractRelevantPrdSnippets(markdown, {
      id: 'scope-6',
      title: 'Task sidebar store boundary',
      acceptanceCriteria: ['US-004'],
    });

    expect(snippets).toContain('US-004 task sidebar store boundary');
    expect(snippets).not.toContain('US-001 unrelated work');
  });

  it('writes harness controls and repo instructions into scope context', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-context-'));
    const prdPath = path.join(repoRoot, 'docs/prds/example.md');
    const contextDir = path.join(repoRoot, '.agent/example/context');
    await writeFile(path.join(repoRoot, 'AGENTS.md'), '# Root Instructions\n\nKeep modules small.');
    await mkdir(path.dirname(prdPath), { recursive: true });
    await writeFile(prdPath, '# PRD\n\n## Scope\nUS-004 task sidebar store boundary.');

    const contextPath = await writeScopeContext({
      repoRoot,
      prdPath,
      relativePrdPath: 'docs/prds/example.md',
      planPath: '.agent/example/plan.yaml',
      planDir: path.join(repoRoot, '.agent/example'),
      contextDir,
      plan: {
        scopes: [],
        harness: {
          controls: {
            computationalGuides: ['Type checker'],
            inferentialGuides: ['Scope context bundle'],
            computationalSensors: ['Focused quality gates'],
            inferentialSensors: ['Scope review'],
          },
          controlNotes: ['Keep removable.'],
        },
      },
      scope: {
        id: 'scope-1',
        title: 'Task sidebar store boundary',
        acceptanceCriteria: ['US-004'],
        qualityGates: [],
        ownedFiles: ['src/tasks/**'],
      },
      qualityGates: ['yarn types'],
      baselineStatus: '',
    });
    const context = await readFile(contextPath, 'utf8');

    expect(context).toContain('## Harness Controls For This Scope');
    expect(context).toContain('- Type checker');
    expect(context).toContain('## Doer vs Judge Boundaries');
    expect(context).toContain('The runner owns YAML plan state');
    expect(context).toContain('### AGENTS.md');
    expect(context).toContain('Keep modules small.');
  });
});
