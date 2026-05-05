import { readFile } from 'node:fs/promises';

import YAML from 'yaml';

import { runCodexScope } from '../codex/index.mjs';
import {
  appendPlanScopeProgress,
  readPlan,
  setPlanRunState,
  updatePlanScope,
  writePlan,
} from '../plan/index.mjs';
import { gitRecentCommits, gitStatus } from '../git/index.mjs';
import { renderTemplate } from '../../utils/templates.mjs';

const planReviewVerdicts = ['aligned', 'needs_plan_update', 'blocked'];
const defaultProgressKeepLast = 8;

export async function reviewPlanAlignment({
  repoRoot,
  prdPath,
  relativePrdPath,
  planPath,
  logsDir,
  plan,
  verboseJson = false,
  signal,
  log,
}) {
  const prompt = await buildPlanReviewPrompt({
    repoRoot,
    prdPath,
    relativePrdPath,
    planPath,
    plan,
  });
  const result = await runCodexScope({
    repoRoot,
    prompt,
    logsDir,
    scopeId: 'plan-review',
    verboseJson,
    signal,
    getProgressSnapshot: () => gitStatus(repoRoot),
    log,
  });

  if (result.exitCode !== 0) {
    return {
      verdict: 'blocked',
      summary: `Plan review Codex pass exited ${result.exitCode}.`,
      missingScopes: [],
      reopenScopes: [],
      scopeUpdates: [],
      cleanup: defaultCleanup(),
      finalAcceptanceRisks: [],
    };
  }

  return parsePlanReview(await readFile(result.lastMessagePath, 'utf8'), { tolerant: true });
}

export async function runPlanReview({
  repoRoot,
  prdPath,
  relativePrdPath,
  planPaths,
  verboseJson = false,
  signal,
  log,
}) {
  const plan = await readPlan(planPaths.planPath);

  log.stage?.('Plan review', [
    ['prd', relativePrdPath],
    ['plan', planPaths.planPath.replace(`${repoRoot}/`, '')],
  ]);

  const review = await reviewPlanAlignment({
    repoRoot,
    prdPath,
    relativePrdPath,
    planPath: planPaths.planPath.replace(`${repoRoot}/`, ''),
    logsDir: planPaths.logsDir,
    plan,
    verboseJson,
    signal,
    log,
  });
  const nextPlan = await applyPlanReviewResult({
    plan,
    planPath: planPaths.planPath,
    review,
  });

  log(`[agent] plan review: ${review.verdict} - ${review.summary}`);

  return {
    review,
    plan: nextPlan,
  };
}

export async function applyPlanReviewResult({ plan, planPath, review, writePlanFile = writePlan }) {
  let nextPlan = structuredClone(plan);

  if (review.verdict === 'blocked') {
    nextPlan = applyCleanup(nextPlan, review.cleanup);
    nextPlan = setPlanRunState(nextPlan, {
      status: 'blocked',
      currentBlocker: `Plan review blocked: ${review.summary}`,
    });
    await writePlanFile(planPath, nextPlan);
    return nextPlan;
  }

  for (const update of review.scopeUpdates) {
    nextPlan = applyScopeUpdate(nextPlan, update);
  }

  for (const reopen of review.reopenScopes) {
    const scope = nextPlan.scopes.find((candidate) => candidate.id === reopen.scopeId);

    if (scope) {
      nextPlan = updatePlanScope(nextPlan, scope.id, { status: 'needs_repair' });
      nextPlan = appendPlanScopeProgress(
        nextPlan,
        scope.id,
        `Plan review reopened scope: ${reopen.reason}`,
      );
    }
  }

  for (const missingScope of review.missingScopes) {
    nextPlan = appendMissingScope(nextPlan, missingScope);
  }

  nextPlan = applyCleanup(nextPlan, review.cleanup);
  nextPlan = setPlanRunState(nextPlan, {
    status: nextPlan.scopes.some((scope) => scope.status !== 'complete')
      ? 'not_complete'
      : 'complete',
    currentBlocker: null,
  });
  await writePlanFile(planPath, nextPlan);

  return nextPlan;
}

export function parsePlanReview(text, { tolerant = false } = {}) {
  const fenced = text.match(/```(?:ya?ml)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  let review;

  try {
    review = YAML.parse(fenced);
  } catch (error) {
    if (!tolerant) {
      throw error;
    }

    return fallbackPlanReview(fenced, error);
  }

  if (!review || typeof review !== 'object') {
    if (tolerant) {
      return fallbackPlanReview(fenced, new Error('Plan review must be a YAML object.'));
    }

    throw new Error('Plan review must be a YAML object.');
  }

  let verdict;

  try {
    verdict = normalizeVerdict(review.verdict);
  } catch (error) {
    if (!tolerant) {
      throw error;
    }

    return fallbackPlanReview(fenced, error);
  }

  return {
    verdict,
    summary: String(review.summary ?? `${verdict} plan review`),
    missingScopes: normalizeMissingScopes(review.missingScopes),
    reopenScopes: normalizeReopenScopes(review.reopenScopes),
    scopeUpdates: normalizeScopeUpdates(review.scopeUpdates),
    cleanup: normalizeCleanup(review.cleanup),
    finalAcceptanceRisks: normalizeStringArray(review.finalAcceptanceRisks),
  };
}

async function buildPlanReviewPrompt({ repoRoot, prdPath, relativePrdPath, planPath, plan }) {
  return await renderTemplate('plan-review.md', {
    prdPath: relativePrdPath,
    planPath,
    gitStatus: (await gitStatus(repoRoot)) || 'clean',
    recentCommits: (await gitRecentCommits(repoRoot)) || 'none',
    planYaml: YAML.stringify(plan, { lineWidth: 100 }),
    markdown: await readFile(prdPath, 'utf8'),
  });
}

function applyScopeUpdate(plan, update) {
  const scope = plan.scopes.find((candidate) => candidate.id === update.scopeId);

  if (!scope) {
    return plan;
  }

  const patch = {};

  if (update.addAcceptanceCriteria.length > 0) {
    patch.acceptanceCriteria = mergeUnique(scope.acceptanceCriteria, update.addAcceptanceCriteria);
  }

  if (update.addQualityGates.length > 0) {
    patch.qualityGates = mergeUnique(scope.qualityGates, update.addQualityGates);
  }

  if (update.addDependsOn.length > 0) {
    patch.dependsOn = mergeUnique(scope.dependsOn ?? [], update.addDependsOn);
  }

  if (update.setParallelGroup != null) {
    patch.parallelGroup = update.setParallelGroup;
  }

  if (update.addOwnedFiles.length > 0) {
    patch.ownedFiles = mergeUnique(scope.ownedFiles ?? [], update.addOwnedFiles);
  }

  let temporaryFollowUps = scope.temporaryFollowUps;

  if (update.removeTemporaryFollowUps.length > 0) {
    const removeSet = new Set(update.removeTemporaryFollowUps);
    temporaryFollowUps = temporaryFollowUps.filter((item) => !removeSet.has(item));
  }

  if (update.addTemporaryFollowUps.length > 0) {
    temporaryFollowUps = mergeUnique(temporaryFollowUps, update.addTemporaryFollowUps);
  }

  patch.temporaryFollowUps = temporaryFollowUps;

  let nextPlan = updatePlanScope(plan, scope.id, patch);

  if (update.reason) {
    nextPlan = appendPlanScopeProgress(nextPlan, scope.id, `Plan review update: ${update.reason}`);
  }

  return nextPlan;
}

function appendMissingScope(plan, missingScope) {
  const nextPlan = structuredClone(plan);
  const nextIndex =
    Math.max(
      0,
      ...nextPlan.scopes.map((scope) => Number(scope.id.match(/^scope-(\d+)$/)?.[1] ?? 0)),
    ) + 1;

  nextPlan.scopes.push({
    id: `scope-${nextIndex}`,
    title: missingScope.title,
    status: 'not_started',
    acceptanceCriteria: missingScope.acceptanceCriteria,
    qualityGates: missingScope.qualityGates,
    dependsOn: missingScope.dependsOn,
    parallelGroup: missingScope.parallelGroup,
    ownedFiles: missingScope.ownedFiles,
    temporaryFollowUps: [],
    progress: [`${new Date().toISOString()} - Added by plan review: ${missingScope.reason}`],
    repairAttempts: 0,
  });

  return nextPlan;
}

function applyCleanup(plan, cleanup) {
  const nextPlan = structuredClone(plan);
  const keepLast = cleanup.progressKeepLast ?? defaultProgressKeepLast;

  for (const scope of nextPlan.scopes) {
    if (cleanup.removeResolvedTemporaryFollowUps) {
      scope.temporaryFollowUps = uniqueStrings(scope.temporaryFollowUps).filter(
        (line) =>
          !/\b(resolved|removed|obsolete|no longer needed|accepted as final|accepted final)\b/i.test(
            line,
          ),
      );
    } else {
      scope.temporaryFollowUps = uniqueStrings(scope.temporaryFollowUps);
    }

    if (cleanup.compactProgress && scope.status !== 'in_progress') {
      scope.progress = compactProgress(scope.progress, keepLast);
    }
  }

  return nextPlan;
}

function compactProgress(progress, keepLast) {
  const important = progress.filter((line) => /quality gates passed|scope review pass/i.test(line));
  return uniqueStrings([...important, ...progress.slice(-keepLast)]).slice(-Math.max(keepLast, 2));
}

function normalizeVerdict(value) {
  const verdict = String(value ?? '').trim();
  if (planReviewVerdicts.includes(verdict)) {
    return verdict;
  }

  throw new Error(`Invalid plan review verdict: ${value}`);
}

function normalizeMissingScopes(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      title: String(item.title ?? 'Plan review follow-up'),
      reason: String(item.reason ?? 'Required by plan review.'),
      acceptanceCriteria: normalizeStringArray(item.acceptanceCriteria),
      qualityGates: normalizeStringArray(item.qualityGates),
      dependsOn: normalizeStringArray(item.dependsOn),
      parallelGroup: item.parallelGroup == null ? null : String(item.parallelGroup),
      ownedFiles: normalizeStringArray(item.ownedFiles),
    }));
}

function normalizeReopenScopes(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === 'object' && item.scopeId)
    .map((item) => ({
      scopeId: String(item.scopeId),
      reason: String(item.reason ?? 'Plan review found incomplete work.'),
    }));
}

function normalizeScopeUpdates(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === 'object' && item.scopeId)
    .map((item) => ({
      scopeId: String(item.scopeId),
      reason: String(item.reason ?? ''),
      addAcceptanceCriteria: normalizeStringArray(item.addAcceptanceCriteria),
      addQualityGates: normalizeStringArray(item.addQualityGates),
      addDependsOn: normalizeStringArray(item.addDependsOn),
      setParallelGroup: item.setParallelGroup == null ? null : String(item.setParallelGroup),
      addOwnedFiles: normalizeStringArray(item.addOwnedFiles),
      addTemporaryFollowUps: normalizeStringArray(item.addTemporaryFollowUps),
      removeTemporaryFollowUps: normalizeStringArray(item.removeTemporaryFollowUps),
    }));
}

function normalizeCleanup(value) {
  if (!value || typeof value !== 'object') {
    return defaultCleanup();
  }

  return {
    compactProgress: value.compactProgress !== false,
    progressKeepLast: Number(value.progressKeepLast ?? defaultProgressKeepLast),
    removeResolvedTemporaryFollowUps: value.removeResolvedTemporaryFollowUps !== false,
  };
}

function defaultCleanup() {
  return {
    compactProgress: false,
    progressKeepLast: defaultProgressKeepLast,
    removeResolvedTemporaryFollowUps: true,
  };
}

function fallbackPlanReview(text, error) {
  return {
    verdict: 'blocked',
    summary: `Plan review output was not valid YAML: ${error.message}`,
    missingScopes: [],
    reopenScopes: [],
    scopeUpdates: [],
    cleanup: defaultCleanup(),
    finalAcceptanceRisks: [oneLine(text)],
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function mergeUnique(left, right) {
  return uniqueStrings([...left, ...right]);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 500);
}
