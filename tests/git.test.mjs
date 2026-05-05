// @vitest-environment node

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  applyCommitToCheckout,
  commitAll,
  createReviewPackage,
  createWorktreeSnapshot,
  scanConflictMarkersInCommit,
  scopeCommitMessage,
} from '../actions/git/index.mjs';

const execFileAsync = promisify(execFile);

describe('agent git helpers', () => {
  it('builds a scope completion commit message', () => {
    expect(
      scopeCommitMessage(
        {
          id: 'scope-2',
          title: 'Quality Gates',
        },
        'docs/prds/example.md',
      ),
    ).toBe('agent: complete scope-2 - Quality Gates\n\nPRD: docs/prds/example.md');
  });

  it('commits a scope and applies it to a clean parent checkout', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-git-'));
    await execFileAsync('git', ['init'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, '.gitignore'), '.agent/\n');
    await writeFile(path.join(repoRoot, 'README.md'), 'initial\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    const worktreeRoot = path.join(repoRoot, '.agent', 'worktrees', 'example');
    await execFileAsync('git', ['worktree', 'add', '-b', 'agent/example', worktreeRoot, 'HEAD'], {
      cwd: repoRoot,
    });
    await writeFile(path.join(worktreeRoot, 'README.md'), 'changed\n');

    const commitResult = await commitAll(worktreeRoot, 'agent: complete scope-1');
    const applyResult = await applyCommitToCheckout(repoRoot, commitResult.commitHash);

    expect(commitResult.committed).toBe(true);
    expect(applyResult.applied).toBe(true);
    expect(await readFile(path.join(repoRoot, 'README.md'), 'utf8')).toBe('changed\n');
  });

  it('aborts a failed parent cherry-pick so the checkout is reusable', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-git-'));
    await execFileAsync('git', ['init'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, '.gitignore'), '.agent/\n');
    await writeFile(path.join(repoRoot, 'README.md'), 'base\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    const worktreeRoot = path.join(repoRoot, '.agent', 'worktrees', 'conflict');
    await execFileAsync('git', ['worktree', 'add', '-b', 'agent/conflict', worktreeRoot, 'HEAD'], {
      cwd: repoRoot,
    });

    await writeFile(path.join(repoRoot, 'README.md'), 'parent\n');
    await execFileAsync('git', ['commit', '-am', 'parent change'], { cwd: repoRoot });

    await writeFile(path.join(worktreeRoot, 'README.md'), 'scope\n');
    const commitResult = await commitAll(worktreeRoot, 'agent: complete conflict scope');
    const applyResult = await applyCommitToCheckout(repoRoot, commitResult.commitHash);

    expect(applyResult.applied).toBe(false);
    expect(applyResult.conflict).toBe(true);
    expect(applyResult.aborted).toBe(true);
    expect(applyResult.status).toContain('README.md');
    expect(applyResult.postAbortStatus).toBe('');
    expect(await readFile(path.join(repoRoot, 'README.md'), 'utf8')).toBe('parent\n');
  });

  it('rejects scope commits that contain unresolved conflict markers before applying', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-git-'));
    await execFileAsync('git', ['init'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, '.gitignore'), '.agent/\n');
    await writeFile(path.join(repoRoot, 'README.md'), 'base\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    const worktreeRoot = path.join(repoRoot, '.agent', 'worktrees', 'markers');
    await execFileAsync('git', ['worktree', 'add', '-b', 'agent/markers', worktreeRoot, 'HEAD'], {
      cwd: repoRoot,
    });
    await writeFile(
      path.join(worktreeRoot, 'README.md'),
      ['<<<<<<< HEAD', 'parent', '=======', 'scope', '>>>>>>> branch', ''].join('\n'),
    );
    const commitResult = await commitAll(worktreeRoot, 'agent: complete marker scope');

    await expect(scanConflictMarkersInCommit(repoRoot, commitResult.commitHash)).resolves.toContain(
      'README.md',
    );
    const applyResult = await applyCommitToCheckout(repoRoot, commitResult.commitHash);

    expect(applyResult.applied).toBe(false);
    expect(applyResult.conflictMarkers).toBe(true);
    expect(await readFile(path.join(repoRoot, 'README.md'), 'utf8')).toBe('base\n');
  });

  it('builds a scope delta with untracked file contents and excludes unchanged baseline dirt', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-git-'));
    await execFileAsync('git', ['init'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoRoot });
    await mkdir(path.join(repoRoot, 'src'), { recursive: true });
    await writeFile(path.join(repoRoot, 'src/existing.ts'), 'export const value = 1;\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    await writeFile(path.join(repoRoot, 'src/existing.ts'), 'export const value = 2;\n');
    const baseline = await createWorktreeSnapshot(repoRoot);

    await writeFile(path.join(repoRoot, 'src/new.ts'), 'export const created = true;\n');
    const reviewPackage = await createReviewPackage(repoRoot, baseline);

    expect(reviewPackage.changedFiles).toEqual(['src/new.ts']);
    expect(reviewPackage.gitStatus).toBe('?? src/new.ts');
    expect(reviewPackage.gitDiff).toContain('diff --git a/src/new.ts b/src/new.ts');
    expect(reviewPackage.gitDiff).toContain('+export const created = true;');
    expect(reviewPackage.gitDiff).not.toContain('value = 2');
    expect(reviewPackage.baselineStatus).toBe(' M src/existing.ts');
  });

  it('can include existing dirty work when a resumed scope makes no new delta', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-git-'));
    await execFileAsync('git', ['init'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoRoot });
    await mkdir(path.join(repoRoot, 'src'), { recursive: true });
    await writeFile(path.join(repoRoot, 'src/existing.ts'), 'export const value = 1;\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    await writeFile(path.join(repoRoot, 'src/existing.ts'), 'export const value = 2;\n');
    const baseline = await createWorktreeSnapshot(repoRoot);
    const reviewPackage = await createReviewPackage(repoRoot, baseline, {
      includeCurrentWhenNoDelta: true,
      ignoreWhenNoDelta: ['scripts/agent/'],
    });

    expect(reviewPackage.changedFiles).toEqual(['src/existing.ts']);
    expect(reviewPackage.gitStatus).toBe('M  src/existing.ts');
    expect(reviewPackage.gitDiff).toContain('value = 2');
  });

  it('ignores configured paths when falling back to current dirty work', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-git-'));
    await execFileAsync('git', ['init'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoRoot });
    await mkdir(path.join(repoRoot, 'src'), { recursive: true });
    await mkdir(path.join(repoRoot, 'scripts/agent'), { recursive: true });
    await writeFile(path.join(repoRoot, 'src/example.ts'), 'export const value = 1;\n');
    await writeFile(path.join(repoRoot, 'scripts/agent/index.mjs'), 'export {};\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    await writeFile(path.join(repoRoot, 'src/example.ts'), 'export const value = 2;\n');
    await writeFile(
      path.join(repoRoot, 'scripts/agent/index.mjs'),
      'export const changed = true;\n',
    );
    const baseline = await createWorktreeSnapshot(repoRoot);
    const reviewPackage = await createReviewPackage(repoRoot, baseline, {
      includeCurrentWhenNoDelta: true,
      ignoreWhenNoDelta: ['scripts/agent/'],
    });

    expect(reviewPackage.changedFiles).toEqual(['src/example.ts']);
  });
});
