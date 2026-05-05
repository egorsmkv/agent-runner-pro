// @vitest-environment node

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  ensureAgentWorktree,
  resolveAgentWorktree,
  resolveAgentWorktreeBase,
  resolveExternalWorktreeBase,
} from '../actions/worktree/index.mjs';

const execFileAsync = promisify(execFile);

describe('agent worktree action', () => {
  it('creates and reuses an in-repo .agent worktree for the PRD', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-worktree-'));
    await execFileAsync('git', ['init'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, '.gitignore'), '.agent/\n');
    await mkdir(path.join(repoRoot, 'node_modules', '.bin'), { recursive: true });
    await mkdir(path.join(repoRoot, 'node_modules', 'react'), { recursive: true });
    await mkdir(path.join(repoRoot, 'node_modules', 'react-dom'), { recursive: true });
    await mkdir(path.join(repoRoot, 'docs/prds'), { recursive: true });
    const prdPath = path.join(repoRoot, 'docs/prds/example-prd.md');
    await writeFile(prdPath, '# PRD\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    const resolved = resolveAgentWorktree({ repoRoot, prdPath });
    const worktreeBase = resolveAgentWorktreeBase(repoRoot);
    const first = await ensureAgentWorktree({ repoRoot, prdPath, log: () => {} });
    const second = await ensureAgentWorktree({ repoRoot, prdPath, log: () => {} });
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: first.worktreeRoot,
    });
    const binLink = await readlink(path.join(first.worktreeRoot, 'node_modules', '.bin'));
    const reactLink = await readlink(path.join(first.worktreeRoot, 'node_modules', 'react'));
    const viteTemp = await stat(path.join(first.worktreeRoot, 'node_modules', '.vite-temp'));

    expect(first).toEqual(resolved);
    expect(second).toEqual(first);
    expect(first.worktreeRoot).toBe(path.join(worktreeBase, 'example-prd'));
    expect(first.worktreeRoot.startsWith(`${repoRoot}${path.sep}`)).toBe(true);
    expect(stdout.trim()).toBe('agent/example-prd');
    expect(binLink).toBe(path.join(repoRoot, 'node_modules', '.bin'));
    expect(reactLink).toBe(path.join(repoRoot, 'node_modules', 'react'));
    expect(viteTemp.isDirectory()).toBe(true);
  });

  it('places per-scope worktrees outside the PRD worktree checkout', async () => {
    const repoRoot = '/repo';
    const prdPath = '/repo/docs/prds/example-prd.md';

    const prdWorktree = resolveAgentWorktree({ repoRoot, prdPath });
    const scopeWorktree = resolveAgentWorktree({ repoRoot, prdPath, scopeId: 'scope-2' });
    const worktreeBase = resolveAgentWorktreeBase(repoRoot);

    expect(prdWorktree.worktreeRoot).toBe(path.join(worktreeBase, 'example-prd'));
    expect(scopeWorktree.worktreeRoot).toBe(
      path.join(worktreeBase, 'scopes', 'example-prd', 'scope-2'),
    );
    expect(scopeWorktree.worktreeRoot.startsWith(`${prdWorktree.worktreeRoot}/`)).toBe(false);
    expect(scopeWorktree.branch).toBe('agent/example-prd-scope-2');
  });

  it('syncs a clean reused worktree to the parent HEAD', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-worktree-sync-'));
    await execFileAsync('git', ['init'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, '.gitignore'), '.agent/\n');
    await mkdir(path.join(repoRoot, 'docs/prds'), { recursive: true });
    const prdPath = path.join(repoRoot, 'docs/prds/example-prd.md');
    await writeFile(prdPath, '# PRD\n');
    await writeFile(path.join(repoRoot, 'README.md'), 'initial\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    const worktree = await ensureAgentWorktree({
      repoRoot,
      prdPath,
      scopeId: 'scope-1',
      log: () => {},
    });

    await writeFile(path.join(repoRoot, 'README.md'), 'parent update\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'parent update'], { cwd: repoRoot });
    const parentHead = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
    ).stdout.trim();

    await ensureAgentWorktree({
      repoRoot,
      prdPath,
      scopeId: 'scope-1',
      log: () => {},
    });

    const worktreeHead = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktree.worktreeRoot })
    ).stdout.trim();
    expect(worktreeHead).toBe(parentHead);
  });

  it('does not sync a dirty reused worktree to the parent HEAD', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-worktree-dirty-'));
    await execFileAsync('git', ['init'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, '.gitignore'), '.agent/\n');
    await mkdir(path.join(repoRoot, 'docs/prds'), { recursive: true });
    const prdPath = path.join(repoRoot, 'docs/prds/example-prd.md');
    await writeFile(prdPath, '# PRD\n');
    await writeFile(path.join(repoRoot, 'README.md'), 'initial\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    const worktree = await ensureAgentWorktree({
      repoRoot,
      prdPath,
      scopeId: 'scope-1',
      log: () => {},
    });
    const originalWorktreeHead = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktree.worktreeRoot })
    ).stdout.trim();

    await writeFile(path.join(worktree.worktreeRoot, 'README.md'), 'dirty worktree\n');
    await writeFile(path.join(repoRoot, 'README.md'), 'parent update\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'parent update'], { cwd: repoRoot });

    await ensureAgentWorktree({
      repoRoot,
      prdPath,
      scopeId: 'scope-1',
      log: () => {},
    });

    const worktreeHead = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktree.worktreeRoot })
    ).stdout.trim();
    expect(worktreeHead).toBe(originalWorktreeHead);
  });

  it('migrates external PRD worktrees back into the repo .agent folder', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-worktree-migrate-prd-'));
    await execFileAsync('git', ['init'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, '.gitignore'), '.agent/\n');
    await mkdir(path.join(repoRoot, 'docs/prds'), { recursive: true });
    const prdPath = path.join(repoRoot, 'docs/prds/example-prd.md');
    await writeFile(prdPath, '# PRD\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    const externalRoot = path.join(resolveExternalWorktreeBase(repoRoot), 'example-prd');
    await mkdir(path.dirname(externalRoot), { recursive: true });
    await execFileAsync(
      'git',
      ['worktree', 'add', '-b', 'agent/example-prd', externalRoot, 'HEAD'],
      { cwd: repoRoot },
    );

    const resolved = await ensureAgentWorktree({
      repoRoot,
      prdPath,
      log: () => {},
    });
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: resolved.worktreeRoot,
    });

    await expect(stat(externalRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(resolved.worktreeRoot).toBe(path.join(repoRoot, '.agent', 'worktrees', 'example-prd'));
    expect(resolved.worktreeRoot.startsWith(`${repoRoot}${path.sep}`)).toBe(true);
    expect(stdout.trim()).toBe('agent/example-prd');
  });

  it('prunes stale external PRD worktree registrations before creating the .agent worktree', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-worktree-prune-'));
    await execFileAsync('git', ['init'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, '.gitignore'), '.agent/\n');
    await mkdir(path.join(repoRoot, 'docs/prds'), { recursive: true });
    const prdPath = path.join(repoRoot, 'docs/prds/example-prd.md');
    await writeFile(prdPath, '# PRD\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    const externalRoot = path.join(resolveExternalWorktreeBase(repoRoot), 'example-prd');
    await mkdir(path.dirname(externalRoot), { recursive: true });
    await execFileAsync(
      'git',
      ['worktree', 'add', '-b', 'agent/example-prd', externalRoot, 'HEAD'],
      { cwd: repoRoot },
    );
    await rm(externalRoot, { recursive: true, force: true });

    const resolved = await ensureAgentWorktree({
      repoRoot,
      prdPath,
      log: () => {},
    });
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: resolved.worktreeRoot,
    });

    expect(resolved.worktreeRoot).toBe(path.join(repoRoot, '.agent', 'worktrees', 'example-prd'));
    expect(stdout.trim()).toBe('agent/example-prd');
  });

  it('migrates legacy nested per-scope worktrees to the .agent scopes folder', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'agent-worktree-migrate-'));
    await execFileAsync('git', ['init'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.email', 'agent@example.com'], { cwd: repoRoot });
    await execFileAsync('git', ['config', 'user.name', 'Agent Test'], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, '.gitignore'), '.agent/\n');
    await mkdir(path.join(repoRoot, 'docs/prds'), { recursive: true });
    const prdPath = path.join(repoRoot, 'docs/prds/example-prd.md');
    await writeFile(prdPath, '# PRD\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });

    const legacyRoot = path.join(repoRoot, '.agent', 'worktrees', 'example-prd', 'scope-2');
    await mkdir(path.dirname(legacyRoot), { recursive: true });
    await execFileAsync(
      'git',
      ['worktree', 'add', '-b', 'agent/example-prd-scope-2', legacyRoot, 'HEAD'],
      { cwd: repoRoot },
    );

    const resolved = await ensureAgentWorktree({
      repoRoot,
      prdPath,
      scopeId: 'scope-2',
      log: () => {},
    });
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: resolved.worktreeRoot,
    });

    await expect(stat(legacyRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(resolved.worktreeRoot).toBe(
      path.join(repoRoot, '.agent', 'worktrees', 'scopes', 'example-prd', 'scope-2'),
    );
    expect(resolved.worktreeRoot.startsWith(`${repoRoot}${path.sep}`)).toBe(true);
    expect(stdout.trim()).toBe('agent/example-prd-scope-2');
  });
});
