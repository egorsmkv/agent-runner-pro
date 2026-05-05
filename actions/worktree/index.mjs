import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readlink, stat, symlink } from 'node:fs/promises';
import path from 'node:path';

import { planSlugForPrd } from '../plan/index.mjs';

export function resolveAgentWorktree({ repoRoot, prdPath, scopeId = null }) {
  const slug = planSlugForPrd(prdPath);
  const worktreeBase = resolveAgentWorktreeBase(repoRoot);

  return {
    slug,
    branch: scopeId ? `agent/${slug}-${scopeId}` : `agent/${slug}`,
    worktreeRoot: scopeId
      ? path.join(worktreeBase, 'scopes', slug, scopeId)
      : path.join(worktreeBase, slug),
  };
}

export async function ensureAgentWorktree({
  repoRoot,
  prdPath,
  scopeId = null,
  log = console.log,
}) {
  const worktree = resolveAgentWorktree({ repoRoot, prdPath, scopeId });

  if (await isGitWorktree(worktree.worktreeRoot)) {
    await syncCleanWorktreeToParentHead({
      repoRoot,
      worktreeRoot: worktree.worktreeRoot,
      log,
    });
    await ensureWorktreeNodeTooling({ repoRoot, worktreeRoot: worktree.worktreeRoot });
    log.stage?.('Agent worktree', [
      ['path', path.relative(repoRoot, worktree.worktreeRoot)],
      ['branch', worktree.branch],
      ['mode', 'reuse'],
    ]);
    return worktree;
  }

  const migratableRoot = await findMigratableWorktree({ repoRoot, slug: worktree.slug, scopeId });

  if (migratableRoot) {
    await mkdir(path.dirname(worktree.worktreeRoot), { recursive: true });
    await runGit(repoRoot, ['worktree', 'move', migratableRoot, worktree.worktreeRoot]);
    await ensureWorktreeNodeTooling({ repoRoot, worktreeRoot: worktree.worktreeRoot });
    log.stage?.('Agent worktree', [
      ['path', path.relative(repoRoot, worktree.worktreeRoot)],
      ['branch', worktree.branch],
      ['mode', 'migrated to .agent/worktrees'],
    ]);
    return worktree;
  }

  await pruneStaleMigratableWorktrees({ repoRoot, slug: worktree.slug, scopeId });

  await mkdir(path.dirname(worktree.worktreeRoot), { recursive: true });
  const branchExists = await gitBranchExists(repoRoot, worktree.branch);
  const args = branchExists
    ? ['worktree', 'add', worktree.worktreeRoot, worktree.branch]
    : ['worktree', 'add', '-b', worktree.branch, worktree.worktreeRoot, 'HEAD'];

  await runGit(repoRoot, args);
  await ensureWorktreeNodeTooling({ repoRoot, worktreeRoot: worktree.worktreeRoot });
  log.stage?.('Agent worktree', [
    ['path', path.relative(repoRoot, worktree.worktreeRoot)],
    ['branch', worktree.branch],
    ['mode', branchExists ? 'attached existing branch' : 'created branch'],
  ]);

  return worktree;
}

export function resolveAgentWorktreeBase(repoRoot) {
  return path.join(repoRoot, '.agent', 'worktrees');
}

export function resolveExternalWorktreeBase(repoRoot) {
  const resolvedRoot = path.resolve(repoRoot);
  const repoName = path.basename(resolvedRoot) || 'repo';
  const repoHash = createHash('sha1').update(resolvedRoot).digest('hex').slice(0, 10);

  return path.join(path.dirname(resolvedRoot), '.agent-worktrees', `${repoName}-${repoHash}`);
}

async function findMigratableWorktree({ repoRoot, slug, scopeId }) {
  const candidates = migratableWorktreeCandidates({ repoRoot, slug, scopeId });

  for (const candidate of candidates) {
    if (await isGitWorktree(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function pruneStaleMigratableWorktrees({ repoRoot, slug, scopeId }) {
  const candidates = [
    ...migratableWorktreeCandidates({ repoRoot, slug, scopeId }),
    ...canonicalWorktreeCandidates({ repoRoot, slug, scopeId }),
  ];
  const registeredWorktrees = await listRegisteredWorktrees(repoRoot);

  if (
    registeredWorktrees.some(
      (worktree) =>
        candidates.some((candidate) => sameOrEquivalentWorktreePath(worktree.path, candidate)) &&
        worktree.prunable,
    )
  ) {
    await runGit(repoRoot, ['worktree', 'prune']);
  }
}

function sameOrEquivalentWorktreePath(registeredPath, candidatePath) {
  if (registeredPath === candidatePath) {
    return true;
  }

  const marker = `${path.sep}.agent${path.sep}worktrees${path.sep}`;
  const candidateIndex = candidatePath.indexOf(marker);
  const externalMarker = `${path.sep}.agent-worktrees${path.sep}`;
  const externalCandidateIndex = candidatePath.indexOf(externalMarker);

  return (
    (candidateIndex >= 0 && registeredPath.endsWith(candidatePath.slice(candidateIndex))) ||
    (externalCandidateIndex >= 0 &&
      registeredPath.endsWith(candidatePath.slice(externalCandidateIndex)))
  );
}

function canonicalWorktreeCandidates({ repoRoot, slug, scopeId }) {
  const worktreeBase = resolveAgentWorktreeBase(repoRoot);

  return scopeId
    ? [path.join(worktreeBase, 'scopes', slug, scopeId)]
    : [path.join(worktreeBase, slug)];
}

function migratableWorktreeCandidates({ repoRoot, slug, scopeId }) {
  const externalBase = resolveExternalWorktreeBase(repoRoot);

  return scopeId
    ? [
        path.join(repoRoot, '.agent', 'worktrees', slug, scopeId),
        path.join(externalBase, 'scopes', slug, scopeId),
        path.join(externalBase, slug, scopeId),
      ]
    : [path.join(externalBase, slug)];
}

async function listRegisteredWorktrees(repoRoot) {
  const result = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  const worktrees = [];
  let current = null;

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), prunable: false };
      worktrees.push(current);
    } else if (line.startsWith('prunable ') && current) {
      current.prunable = true;
    }
  }

  return worktrees;
}

async function syncCleanWorktreeToParentHead({ repoRoot, worktreeRoot, log }) {
  const status = (
    await runGit(worktreeRoot, ['status', '--short', '--untracked-files=all'])
  ).stdout.trim();

  if (status) {
    return;
  }

  const parentHead = (await runGit(repoRoot, ['rev-parse', 'HEAD'])).stdout.trim();
  const worktreeHead = (await runGit(worktreeRoot, ['rev-parse', 'HEAD'])).stdout.trim();

  if (parentHead === worktreeHead) {
    return;
  }

  await runGit(worktreeRoot, ['reset', '--hard', parentHead]);
  log(`[git] synced clean agent worktree to parent ${parentHead.slice(0, 7)}`);
}

async function ensureWorktreeNodeTooling({ repoRoot, worktreeRoot }) {
  const rootNodeModules = path.join(repoRoot, 'node_modules');

  if (!(await pathExists(rootNodeModules))) {
    return;
  }

  const worktreeNodeModules = path.join(worktreeRoot, 'node_modules');
  await mkdir(path.join(worktreeNodeModules, '.vite-temp'), { recursive: true });
  await ensureSymlink({
    linkPath: path.join(worktreeNodeModules, '.bin'),
    targetPath: path.join(rootNodeModules, '.bin'),
  });
  await ensureSymlink({
    linkPath: path.join(worktreeNodeModules, 'react'),
    targetPath: path.join(rootNodeModules, 'react'),
  });
  await ensureSymlink({
    linkPath: path.join(worktreeNodeModules, 'react-dom'),
    targetPath: path.join(rootNodeModules, 'react-dom'),
  });
}

async function isGitWorktree(worktreeRoot) {
  try {
    const entry = await stat(worktreeRoot);

    if (!entry.isDirectory()) {
      return false;
    }

    const result = await runGit(worktreeRoot, ['rev-parse', '--is-inside-work-tree']);
    return result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function gitBranchExists(repoRoot, branch) {
  const result = await runGit(
    repoRoot,
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    {
      rejectOnFailure: false,
    },
  );

  return result.exitCode === 0;
}

async function ensureSymlink({ linkPath, targetPath }) {
  if (!(await pathExists(targetPath))) {
    return;
  }

  try {
    const entry = await lstat(linkPath);

    if (!entry.isSymbolicLink()) {
      return;
    }

    const currentTarget = await readlink(linkPath);
    if (path.resolve(path.dirname(linkPath), currentTarget) === targetPath) {
      return;
    }

    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  await symlink(targetPath, linkPath);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function runGit(cwd, args, { rejectOnFailure = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      const result = { exitCode: exitCode ?? 1, stdout, stderr };

      if (result.exitCode === 0 || !rejectOnFailure) {
        resolve(result);
        return;
      }

      reject(
        new Error(`git ${args.join(' ')} failed with ${result.exitCode}\n${stderr || stdout}`),
      );
    });
  });
}
