import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readPlan } from '../plan/index.mjs';

export function resolveStatePaths(repoRoot, prdPath) {
  const stateDir = path.join(repoRoot, '.agent');
  const logsDir = path.join(stateDir, 'logs');
  const statePath = path.join(stateDir, 'state.json');
  const relativePrdPath = path.relative(repoRoot, prdPath);

  return {
    stateDir,
    logsDir,
    statePath,
    relativePrdPath,
  };
}

export async function readRunnerState(statePath) {
  try {
    const rawState = await readFile(statePath, 'utf8');

    if (!rawState.trim()) {
      return null;
    }

    return JSON.parse(rawState);
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

export async function readRecoverableRunnerState(repoRoot) {
  const statePath = resolveStatePaths(repoRoot, repoRoot).statePath;
  const state = await readRunnerState(statePath);

  if (state?.prdPath) {
    return state;
  }

  const planPath = await findLatestPlanPath(path.join(repoRoot, '.agent'));

  if (!planPath) {
    return null;
  }

  const plan = await readPlan(planPath);

  if (!plan?.prdPath) {
    return null;
  }

  return createRunState({
    prdPath: plan.prdPath,
    activeScopeId: plan.activeScopeId ?? null,
    previousState: {
      lastCompletedScopeId: plan.lastCompletedScopeId ?? null,
    },
  });
}

export async function writeRunnerState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmpPath, statePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

async function findLatestPlanPath(stateDir) {
  let entries;

  try {
    entries = await readdir(stateDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const planPath = path.join(stateDir, entry.name, 'plan.yaml');

    try {
      const planStat = await stat(planPath);
      candidates.push({ planPath, mtimeMs: planStat.mtimeMs });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.planPath ?? null;
}

export function createRunState({ prdPath, activeScopeId = null, previousState = null }) {
  const now = new Date().toISOString();

  return {
    version: 1,
    prdPath,
    activeScopeId,
    lastCompletedScopeId: previousState?.lastCompletedScopeId ?? null,
    lastCodexOutputFile: previousState?.lastCodexOutputFile ?? null,
    lastQualityGateResults: previousState?.lastQualityGateResults ?? [],
    interrupted: false,
    startedAt: previousState?.startedAt ?? now,
    updatedAt: now,
  };
}

export function updateRunState(state, patch) {
  return {
    ...state,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}
