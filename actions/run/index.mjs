import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { runCodexScope } from '../codex/index.mjs';
import { writeScopeContext } from '../context/index.mjs';
import {
  applyCommitToCheckout,
  commitAll,
  createReviewPackage,
  createWorktreeSnapshot,
  gitStatus,
  scopeCommitMessage,
} from '../git/index.mjs';
import { humanInputBlockerSummary, parseHumanInputRequest } from '../human-input/index.mjs';
import { syncMarkdownDeterministically } from '../markdown-sync/index.mjs';
import {
  appendPlanScopeProgress,
  extractPlanFromText,
  hasOpenTemporaryFollowUps,
  readPlan,
  resolvePlanPaths,
  selectParallelPlanScopes,
  selectNextPlanScope,
  setPlanRunState,
  updatePlanScope,
  writePlan,
} from '../plan/index.mjs';
import { runPlanReview } from '../plan-review/index.mjs';
import { runQualityGates, splitQualityGates } from '../quality-gates/index.mjs';
import {
  applyScopeReviewResult,
  decideScopeReview,
  reviewFromDecision,
  reviewScopeDiff,
} from '../scope-review/index.mjs';
import {
  buildMarkdownSyncPrompt,
  buildPlanPrompt,
  buildScopePrompt,
} from '../../utils/prompts.mjs';
import { parseTitle } from '../../utils/prd.mjs';
import {
  createRunState,
  readRunnerState,
  resolveStatePaths,
  updateRunState,
  writeRunnerState,
} from '../state/index.mjs';
import { ensureAgentWorktree } from '../worktree/index.mjs';

const maxNoProgressScopeReviewRepairAttempts = 6;
const maxAlignedScopeReviewRepairAttempts = 3;

export function shouldStopScopeReviewRepair({
  attempts,
  changedFiles,
  verdict,
  maxAttempts = maxNoProgressScopeReviewRepairAttempts,
}) {
  return (
    attempts > maxAttempts &&
    (verdict === 'unrelated' || !Array.isArray(changedFiles) || changedFiles.length === 0)
  );
}

export function shouldEscalateScopeReviewRepair({
  attempts,
  changedFiles,
  verdict,
  maxAttempts = maxAlignedScopeReviewRepairAttempts,
}) {
  return (
    verdict === 'repair' &&
    attempts > maxAttempts &&
    Array.isArray(changedFiles) &&
    changedFiles.length > 0
  );
}

function reviewRepairFailure(review) {
  const details = [
    review.summary,
    ...review.findings.map((finding) =>
      [finding.severity, finding.file, finding.message].filter(Boolean).join(': '),
    ),
    ...review.missingWork.map((item) => `Missing work: ${item}`),
  ].filter(Boolean);

  return {
    command: `scope review (${review.verdict})`,
    exitCode: 1,
    outputSummary: details.join('\n'),
  };
}

function scopeWithRepairProgress({ scope, repairAttempts, message }) {
  return {
    ...scope,
    status: 'needs_repair',
    repairAttempts,
    progress: [...(scope.progress ?? []), `${new Date().toISOString()} - ${message}`].slice(-20),
  };
}

async function readHumanInputRequest(lastMessagePath) {
  try {
    return parseHumanInputRequest(await readFile(lastMessagePath, 'utf8'));
  } catch {
    return null;
  }
}

export async function runBoundedParallelQueue({
  limit,
  getReadyItems,
  runItem,
  onItemStarted = async () => {},
  onItemCompleted = async () => ({}),
  itemId = (item) => item.id,
}) {
  const running = new Map();
  const scheduledIds = new Set();
  const completed = [];
  const failed = [];
  let maxRunning = 0;
  let stopScheduling = false;

  const fillOpenSlots = async () => {
    if (stopScheduling) {
      return;
    }

    const availableSlots = limit - running.size;
    if (availableSlots <= 0) {
      return;
    }

    const readyItems = await getReadyItems({
      limit: availableSlots,
      runningIds: new Set(running.keys()),
      scheduledIds: new Set(scheduledIds),
    });

    for (const item of readyItems.slice(0, availableSlots)) {
      const id = String(itemId(item));

      if (running.has(id) || scheduledIds.has(id)) {
        continue;
      }

      scheduledIds.add(id);
      await onItemStarted(item, {
        runningIds: new Set(running.keys()),
        scheduledIds: new Set(scheduledIds),
      });
      running.set(
        id,
        Promise.resolve()
          .then(() => runItem(item))
          .then(
            (result) => ({ id, item, result, error: null }),
            (error) => ({ id, item, result: null, error }),
          ),
      );
      maxRunning = Math.max(maxRunning, running.size);
    }
  };

  await fillOpenSlots();

  while (running.size > 0) {
    const settled = await Promise.race(running.values());
    running.delete(settled.id);

    const completion = await onItemCompleted(settled, {
      runningIds: new Set(running.keys()),
      scheduledIds: new Set(scheduledIds),
    });

    if (settled.error || completion?.failed) {
      failed.push(settled);
      stopScheduling = completion?.stopScheduling !== false;
    } else {
      completed.push(settled);
    }

    if (completion?.stopScheduling) {
      stopScheduling = true;
    }

    await fillOpenSlots();
  }

  return { completed, failed, maxRunning };
}

export async function runWorkflow({
  repoRoot,
  prdPath,
  regeneratePlan,
  once = false,
  maxScopes = null,
  parallelLimit = 1,
  retryBlocked = false,
  verboseJson = false,
  log = console.log,
}) {
  const relativePrdPath = path.relative(repoRoot, prdPath);
  const runtimePaths = resolveStatePaths(repoRoot, prdPath);
  const planPaths = resolvePlanPaths(repoRoot, prdPath);
  const markdown = await readFile(prdPath, 'utf8');
  const title = parseTitle(markdown);
  const previousState = await readRunnerState(runtimePaths.statePath);
  const previousPlan = await readPlan(planPaths.planPath);
  let plan = previousPlan;

  log.section?.('Agent Run', [
    ['PRD', title],
    ['file', relativePrdPath],
    ['plan', path.relative(repoRoot, planPaths.planPath)],
    ['mode', regeneratePlan ? 'run' : 'resume'],
  ]) ?? log(`[agent] PRD: ${title}`);

  if (regeneratePlan) {
    log.stage?.('Stage 1: plan generation', [
      ['source', relativePrdPath],
      ['output', path.relative(repoRoot, planPaths.planPath)],
    ]);
    plan = await generatePlan({
      repoRoot,
      relativePrdPath,
      markdown,
      planPaths,
      previousPlan,
      previousState,
      verboseJson,
      log,
    });
    await writePlan(planPaths.planPath, plan);
    log('[agent] regenerated YAML plan from Markdown PRD.');
  }

  if (!plan) {
    throw new Error('No YAML plan found. Run `yarn agent run --file <prd.md>` first.');
  }

  const worktree = parallelLimit > 1 ? null : await ensureAgentWorktree({ repoRoot, prdPath, log });
  const worktreeRelativePrdPath = relativePrdPath;

  let state = createRunState({
    prdPath: relativePrdPath,
    previousState,
  });
  state = updateRunState(state, {
    command: regeneratePlan ? 'run' : 'resume',
    planPath: path.relative(repoRoot, planPaths.planPath),
    gitStatusAtStart: await gitStatus(repoRoot),
    worktreePath: worktree ? path.relative(repoRoot, worktree.worktreeRoot) : null,
    worktreeBranch: worktree?.branch ?? null,
  });
  const stateRef = { current: state };
  await writeRunnerState(runtimePaths.statePath, state);

  const abortController = new AbortController();
  let interrupted = false;
  const handleInterrupt = async () => {
    if (interrupted) {
      return;
    }

    interrupted = true;
    abortController.abort();
    state = updateRunState(stateRef.current, { interrupted: true });
    stateRef.current = state;
    await writeRunnerState(runtimePaths.statePath, state);

    if (state.activeScopeId) {
      const latestPlan = await readPlan(planPaths.planPath);
      if (latestPlan) {
        const interruptedPlan = appendPlanScopeProgress(
          setPlanRunState(latestPlan, {
            activeScopeId: state.activeScopeId,
            currentBlocker: `Interrupted at ${new Date().toISOString()}`,
          }),
          state.activeScopeId,
          'Runner interrupted.',
        );
        await writePlan(planPaths.planPath, interruptedPlan);
      }
    }
  };

  process.once('SIGINT', handleInterrupt);
  process.once('SIGTERM', handleInterrupt);

  try {
    return await runLoop({
      repoRoot,
      prdPath,
      worktreeRoot: worktree?.worktreeRoot ?? repoRoot,
      worktreeRelativePrdPath,
      planPaths,
      runtimePaths,
      state,
      stateRef,
      once,
      maxScopes,
      parallelLimit,
      retryBlocked,
      verboseJson,
      signal: abortController.signal,
      log,
    });
  } finally {
    process.off('SIGINT', handleInterrupt);
    process.off('SIGTERM', handleInterrupt);
  }
}

async function generatePlan({
  repoRoot,
  relativePrdPath,
  markdown,
  planPaths,
  previousPlan,
  previousState,
  verboseJson,
  log,
}) {
  const prompt = await buildPlanPrompt({
    prdPath: relativePrdPath,
    markdown,
    previousPlan,
    previousState,
    gitStatus: await gitStatus(repoRoot),
  });
  const result = await runCodexScope({
    repoRoot,
    prompt,
    logsDir: planPaths.logsDir,
    scopeId: 'plan-generation',
    verboseJson,
    signal: undefined,
    getProgressSnapshot: () => gitStatus(repoRoot),
    log,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Codex plan generation failed with exit code ${result.exitCode}`);
  }

  const finalMessage = await readFile(result.lastMessagePath, 'utf8');
  return setPlanRunState(extractPlanFromText(finalMessage), {
    prdPath: relativePrdPath,
    activeScopeId: null,
    lastCompletedScopeId: null,
  });
}

async function runLoop({
  repoRoot,
  prdPath,
  worktreeRoot,
  worktreeRelativePrdPath,
  planPaths,
  runtimePaths,
  state,
  stateRef,
  once,
  maxScopes,
  parallelLimit,
  retryBlocked,
  verboseJson,
  signal,
  log,
}) {
  let completedScopesThisRun = 0;

  while (true) {
    let plan = await readPlan(planPaths.planPath);

    if (parallelLimit > 1) {
      return await runParallelBatchOnce({
        repoRoot,
        prdPath,
        worktreeRelativePrdPath,
        plan,
        planPaths,
        runtimePaths,
        state,
        stateRef,
        retryBlocked,
        parallelLimit,
        verboseJson,
        signal,
        log,
      });
    }

    const scope = selectNextPlanScope(plan, { retryBlocked });

    if (!scope) {
      log.stage?.('Final acceptance', [
        ['plan', path.relative(repoRoot, planPaths.planPath)],
        ['status', plan.status],
      ]);
      const planReview = await runPlanReview({
        repoRoot: worktreeRoot,
        prdPath: path.resolve(worktreeRoot, worktreeRelativePrdPath),
        relativePrdPath: worktreeRelativePrdPath,
        planPaths,
        verboseJson,
        signal,
        log,
      });

      if (planReview.review.verdict === 'blocked') {
        return 1;
      }

      if (selectNextPlanScope(planReview.plan, { retryBlocked })) {
        continue;
      }

      return await runFinalAcceptance({ repoRoot: worktreeRoot, planPaths, signal, log });
    }

    if (maxScopes != null && completedScopesThisRun >= maxScopes) {
      log(`[agent] reached max scopes: ${maxScopes}`);
      return 0;
    }

    const focusedGates =
      scope.qualityGates.length > 0 ? scope.qualityGates : plan.qualityGates.focused;
    const focusedGateSet = splitQualityGates(focusedGates);
    log.stage?.(`Scope: ${scope.id}`, [
      ['title', scope.title],
      ['status', scope.status],
      ['gates', focusedGateSet.runnable.join(', ') || 'none'],
      ['manual', focusedGateSet.manual.join(', ') || 'none'],
    ]);
    plan = updatePlanScope(plan, scope.id, { status: 'in_progress' });
    plan = appendPlanScopeProgress(
      setPlanRunState(plan, {
        activeScopeId: scope.id,
        currentBlocker: null,
        finalAcceptanceStatus: 'not_complete',
      }),
      scope.id,
      'Runner started scope.',
    );
    await writePlan(planPaths.planPath, plan);

    state = updateRunState(state, {
      activeScopeId: scope.id,
      interrupted: false,
    });
    stateRef.current = state;
    await writeRunnerState(runtimePaths.statePath, state);

    const scopeBaseline = await createWorktreeSnapshot(worktreeRoot);
    await printGitStatus(worktreeRoot, 'before worktree', log);

    const repairFailure =
      scope.status === 'needs_repair'
        ? state.lastQualityGateResults?.find((result) => result.exitCode !== 0)
        : null;
    const contextPath = await writeScopeContext({
      repoRoot,
      prdPath: path.resolve(worktreeRoot, worktreeRelativePrdPath),
      relativePrdPath: worktreeRelativePrdPath,
      planPath: planPaths.planPath,
      planDir: planPaths.planDir,
      contextDir: path.join(worktreeRoot, '.agent', path.basename(planPaths.planDir), 'context'),
      plan,
      scope,
      qualityGates: focusedGateSet.runnable,
      baselineStatus: scopeBaseline.status,
    });
    const prompt = await buildScopePrompt({
      prdPath: worktreeRelativePrdPath,
      planPath: planPaths.planPath,
      contextPath: path.relative(worktreeRoot, contextPath),
      scope,
      qualityGates: focusedGates,
      repairFailure,
    });
    const codexResult = await runCodexScope({
      repoRoot: worktreeRoot,
      prompt,
      logsDir: planPaths.logsDir,
      scopeId: scope.id,
      verboseJson,
      signal,
      getProgressSnapshot: () => gitStatus(worktreeRoot),
      log,
    });

    state = updateRunState(state, {
      lastCodexOutputFile: path.relative(repoRoot, codexResult.lastMessagePath),
    });
    stateRef.current = state;
    await writeRunnerState(runtimePaths.statePath, state);
    plan = await readPlan(planPaths.planPath);

    if (codexResult.exitCode !== 0) {
      plan = updatePlanScope(plan, scope.id, { status: 'blocked' });
      plan = appendPlanScopeProgress(
        plan,
        scope.id,
        `Codex exited with code ${codexResult.exitCode}.`,
      );
      plan = setPlanRunState(plan, {
        activeScopeId: scope.id,
        currentBlocker: `Codex exited with code ${codexResult.exitCode}`,
      });
      await writePlan(planPaths.planPath, plan);
      await printGitStatus(worktreeRoot, 'after worktree', log);
      return 1;
    }

    const humanInputRequest = await readHumanInputRequest(codexResult.lastMessagePath);
    if (humanInputRequest) {
      const summary = humanInputBlockerSummary(humanInputRequest);
      plan = updatePlanScope(plan, scope.id, { status: 'blocked' });
      plan = appendPlanScopeProgress(plan, scope.id, summary);
      plan = setPlanRunState(plan, {
        activeScopeId: scope.id,
        currentBlocker: summary,
      });
      await writePlan(planPaths.planPath, plan);
      log(`[agent] ${summary}`);
      await printGitStatus(worktreeRoot, 'after worktree', log);
      return 0;
    }

    plan = await readPlan(planPaths.planPath);
    const reviewPackage = await createReviewPackage(worktreeRoot, scopeBaseline, {
      includeCurrentWhenNoDelta: scope.status === 'in_progress' || scope.status === 'needs_repair',
      ignoreWhenNoDelta: ['.agent/', 'scripts/agent/'],
    });
    const reviewDecision = decideScopeReview({
      gitStatus: reviewPackage.gitStatus,
      gitDiff: reviewPackage.gitDiff,
      repairFailure,
    });
    log.stage?.(`Scope review: ${scope.id}`, [
      ['status', 'checking diff'],
      ['scope', scope.title],
      ['mode', reviewDecision.mode],
      ['reason', reviewDecision.reason],
    ]);
    const automaticReview = reviewFromDecision(reviewDecision);
    const review =
      automaticReview ??
      (await reviewScopeDiff({
        repoRoot: worktreeRoot,
        relativePrdPath: worktreeRelativePrdPath,
        planPath: planPaths.planPath,
        logsDir: planPaths.logsDir,
        scope: plan.scopes.find((candidate) => candidate.id === scope.id) ?? scope,
        gitStatus: reviewPackage.gitStatus,
        gitDiff: reviewPackage.gitDiff,
        baselineStatus: reviewPackage.baselineStatus,
        currentStatus: reviewPackage.currentStatus,
        reviewMode: reviewDecision.mode,
        reviewReason: reviewDecision.reason,
        changedFiles: reviewPackage.changedFiles,
        verboseJson,
        signal,
        getProgressSnapshot: () => gitStatus(worktreeRoot),
        log,
      }));
    log(`[agent] scope review: ${review.verdict} - ${review.summary}`);
    plan = await applyScopeReviewResult({
      plan,
      planPath: planPaths.planPath,
      scopeId: scope.id,
      review,
    });

    if (review.verdict !== 'pass') {
      plan = await readPlan(planPaths.planPath);
      const currentScope = plan.scopes.find((candidate) => candidate.id === scope.id);
      const attempts = (currentScope?.repairAttempts ?? 0) + 1;
      const repairLimitExhausted = shouldStopScopeReviewRepair({
        attempts,
        changedFiles: reviewPackage.changedFiles,
        verdict: review.verdict,
      });
      const planReviewNeeded = shouldEscalateScopeReviewRepair({
        attempts,
        changedFiles: reviewPackage.changedFiles,
        verdict: review.verdict,
      });
      plan = updatePlanScope(plan, scope.id, {
        status: repairLimitExhausted ? 'blocked' : 'needs_repair',
        repairAttempts: attempts,
      });
      plan = setPlanRunState(plan, {
        activeScopeId: scope.id,
        currentBlocker: repairLimitExhausted
          ? `Scope review repair limit exhausted: ${review.summary}`
          : planReviewNeeded
            ? `Scope review needs plan clarification after ${attempts} aligned repair attempts: ${review.summary}`
            : `Scope review ${review.verdict}: ${review.summary}`,
      });
      await writePlan(planPaths.planPath, plan);

      if (review.verdict === 'blocked' || repairLimitExhausted) {
        await printGitStatus(worktreeRoot, 'after worktree', log);
        return 1;
      }

      if (planReviewNeeded) {
        log(
          `[agent] scope ${scope.id} needs plan clarification after ${attempts} aligned repair attempts.`,
        );
        await printGitStatus(worktreeRoot, 'after worktree', log);
        const planReview = await runPlanReview({
          repoRoot: worktreeRoot,
          prdPath: path.resolve(worktreeRoot, worktreeRelativePrdPath),
          relativePrdPath: worktreeRelativePrdPath,
          planPaths,
          verboseJson,
          signal,
          log,
        });

        return planReview.review.verdict === 'blocked' ? 1 : 0;
      }

      continue;
    }

    const gateResults = await runQualityGates(focusedGateSet.runnable, {
      cwd: worktreeRoot,
      signal,
      log,
    });
    state = updateRunState(state, { lastQualityGateResults: gateResults });
    stateRef.current = state;
    await writeRunnerState(runtimePaths.statePath, state);

    const failedGate = gateResults.find((result) => result.exitCode !== 0);
    plan = await readPlan(planPaths.planPath);

    if (failedGate) {
      const currentScope = plan.scopes.find((candidate) => candidate.id === scope.id);
      const attempts = (currentScope?.repairAttempts ?? 0) + 1;
      const nextStatus = attempts > 2 ? 'blocked' : 'needs_repair';

      plan = updatePlanScope(plan, scope.id, {
        status: nextStatus,
        repairAttempts: attempts,
      });
      plan = appendPlanScopeProgress(
        plan,
        scope.id,
        `Quality gate failed: ${failedGate.command} exited ${failedGate.exitCode}.`,
      );
      plan = setPlanRunState(plan, {
        activeScopeId: scope.id,
        currentBlocker:
          attempts > 2
            ? `Repair limit exhausted for ${failedGate.command}`
            : `Needs repair for ${failedGate.command}`,
      });
      await writePlan(planPaths.planPath, plan);

      if (attempts > 2) {
        await printGitStatus(worktreeRoot, 'after worktree', log);
        return 1;
      }

      continue;
    }

    plan = updatePlanScope(plan, scope.id, {
      status: 'complete',
      repairAttempts: 0,
    });
    plan = appendPlanScopeProgress(
      plan,
      scope.id,
      `Focused quality gates passed: ${focusedGateSet.runnable.join(', ') || 'none'}.`,
    );
    plan = setPlanRunState(plan, {
      activeScopeId: null,
      lastCompletedScopeId: scope.id,
      currentBlocker: null,
    });
    await writePlan(planPaths.planPath, plan);

    const completedScope = plan.scopes.find((candidate) => candidate.id === scope.id);
    await syncMarkdownAfterScope({
      repoRoot: worktreeRoot,
      worktreeRelativePrdPath,
      planPaths,
      scope: completedScope,
      gateResults,
      verboseJson,
      signal,
      log,
    });

    const commitResult = await commitAll(
      worktreeRoot,
      scopeCommitMessage(completedScope, worktreeRelativePrdPath),
    );
    log(
      commitResult.committed
        ? `[git] committed ${scope.id}`
        : `[git] skipped commit: ${commitResult.reason}`,
    );

    if (commitResult.committed) {
      const applyResult = await applyCommitToCheckout(repoRoot, commitResult.commitHash);

      if (applyResult.applied) {
        log(`[git] applied ${scope.id} to parent checkout ${applyResult.commitHash.slice(0, 7)}`);
        const parentGateFailure = await verifyParentCheckoutAfterApply({
          repoRoot,
          gateResults,
          signal,
          log,
        });

        if (parentGateFailure) {
          plan = await readPlan(planPaths.planPath);
          plan = setPlanRunState(plan, {
            activeScopeId: null,
            lastCompletedScopeId: scope.id,
            currentBlocker: `Scope ${scope.id} failed parent checkout verification after apply: ${parentGateFailure.command}`,
          });
          plan = appendPlanScopeProgress(
            plan,
            scope.id,
            `Parent checkout verification failed after apply: ${parentGateFailure.command}`,
          );
          await writePlan(planPaths.planPath, plan);
          return 1;
        }
      } else {
        plan = await readPlan(planPaths.planPath);
        plan = setPlanRunState(plan, {
          activeScopeId: null,
          lastCompletedScopeId: scope.id,
          currentBlocker: `Scope ${scope.id} committed in worktree but was not applied to parent checkout: ${applyResult.reason}`,
        });
        plan = appendPlanScopeProgress(
          plan,
          scope.id,
          `Parent checkout apply failed: ${applyResult.reason}`,
        );
        await writePlan(planPaths.planPath, plan);
        log(`[git] parent apply failed: ${applyResult.reason}`);

        if (applyResult.status) {
          log(`git status parent:\n${applyResult.status}`);
        }

        if (applyResult.output) {
          log(applyResult.output);
        }

        return 1;
      }
    }

    state = updateRunState(state, {
      activeScopeId: null,
      lastCompletedScopeId: scope.id,
      interrupted: false,
    });
    stateRef.current = state;
    await writeRunnerState(runtimePaths.statePath, state);

    await printGitStatus(worktreeRoot, 'after worktree', log);
    completedScopesThisRun += 1;

    const planReview = await runPlanReview({
      repoRoot: worktreeRoot,
      prdPath: path.resolve(worktreeRoot, worktreeRelativePrdPath),
      relativePrdPath: worktreeRelativePrdPath,
      planPaths,
      verboseJson,
      signal,
      log,
    });

    if (planReview.review.verdict === 'blocked') {
      return 1;
    }

    if (once) {
      log('[agent] stopping after one completed scope.');
      return 0;
    }
  }
}

async function runParallelBatchOnce({
  repoRoot,
  prdPath,
  worktreeRelativePrdPath,
  plan,
  planPaths,
  runtimePaths,
  state,
  stateRef,
  retryBlocked,
  parallelLimit,
  verboseJson,
  signal,
  log,
}) {
  log.stage?.('Parallel run', [
    ['limit', String(parallelLimit)],
    ['plan', path.relative(repoRoot, planPaths.planPath)],
  ]);

  let lastCompletedScopeId = state.lastCompletedScopeId ?? null;
  let startedScopeCount = 0;
  const exitCodes = [];

  const updateParallelState = async (runningIds) => {
    state = updateRunState(stateRef.current, {
      activeScopeId: [...runningIds].join(',') || null,
      lastCompletedScopeId,
      interrupted: false,
    });
    stateRef.current = state;
    await writeRunnerState(runtimePaths.statePath, state);
  };

  await updateParallelState(new Set());

  const queueResult = await runBoundedParallelQueue({
    limit: parallelLimit,
    getReadyItems: async ({ limit, runningIds, scheduledIds }) => {
      const latestPlan = await readPlan(planPaths.planPath);
      const runningScopes = [...runningIds]
        .map((scopeId) => latestPlan.scopes.find((candidate) => candidate.id === scopeId))
        .filter(Boolean);

      return selectParallelPlanScopes(latestPlan, {
        limit,
        retryBlocked,
        excludeScopeIds: scheduledIds,
        runningScopes,
      });
    },
    onItemStarted: async (scope, { runningIds }) => {
      startedScopeCount += 1;
      log.stage?.(`Parallel scope: ${scope.id}`, [
        ['title', scope.title],
        ['running', String(runningIds.size + 1)],
        ['limit', String(parallelLimit)],
      ]);

      let nextPlan = await readPlan(planPaths.planPath);
      nextPlan = updatePlanScope(nextPlan, scope.id, { status: 'in_progress' });
      nextPlan = appendPlanScopeProgress(nextPlan, scope.id, 'Parallel runner started scope.');
      nextPlan = setPlanRunState(nextPlan, {
        activeScopeId: null,
        currentBlocker: null,
        finalAcceptanceStatus: 'not_complete',
      });
      await writePlan(planPaths.planPath, nextPlan);
      await updateParallelState(new Set([...runningIds, scope.id]));
    },
    runItem: async (scope) => {
      const latestPlan = await readPlan(planPaths.planPath);

      return await runParallelScopeOnce({
        repoRoot,
        prdPath,
        worktreeRelativePrdPath,
        plan: latestPlan,
        planPaths,
        scope,
        verboseJson,
        signal,
        log,
      });
    },
    onItemCompleted: async ({ result, error }, { runningIds }) => {
      if (error) {
        exitCodes.push(1);
        await updateParallelState(runningIds);
        return { failed: true, stopScheduling: true };
      }

      if (result.exitCode !== 0) {
        let failedPlan = await readPlan(planPaths.planPath);
        const repairAttempts =
          result.repairAttempts ??
          (result.status === 'not_started'
            ? (result.scope.repairAttempts ?? 0)
            : (result.scope.repairAttempts ?? 0) + 1);
        failedPlan = updatePlanScope(failedPlan, result.scope.id, {
          status: result.status ?? 'needs_repair',
          repairAttempts,
        });
        failedPlan = appendPlanScopeProgress(failedPlan, result.scope.id, result.summary);
        failedPlan = setPlanRunState(failedPlan, {
          activeScopeId: null,
          lastCompletedScopeId,
          currentBlocker: `${result.scope.id}: ${result.summary}`,
        });
        await writePlan(planPaths.planPath, failedPlan);
        exitCodes.push(result.exitCode);
        await updateParallelState(runningIds);

        if (result.needsPlanReview) {
          log(`[agent] ${result.scope.id} needs plan clarification; running plan review.`);
          const planReview = await runPlanReview({
            repoRoot,
            prdPath,
            relativePrdPath: worktreeRelativePrdPath,
            planPaths,
            verboseJson,
            signal,
            log,
          });
          if (planReview.review.verdict !== 'blocked') {
            exitCodes.pop();
            return { failed: false, stopScheduling: false };
          }
        }

        return { failed: true, stopScheduling: true };
      }

      if (result.humanInputRequired) {
        let blockedPlan = await readPlan(planPaths.planPath);
        blockedPlan = updatePlanScope(blockedPlan, result.scope.id, {
          status: 'blocked',
          repairAttempts: result.repairAttempts ?? result.scope.repairAttempts ?? 0,
        });
        blockedPlan = appendPlanScopeProgress(blockedPlan, result.scope.id, result.summary);
        blockedPlan = setPlanRunState(blockedPlan, {
          activeScopeId: result.scope.id,
          lastCompletedScopeId,
          currentBlocker: `${result.scope.id}: ${result.summary}`,
        });
        await writePlan(planPaths.planPath, blockedPlan);
        log(`[agent] ${result.scope.id}: ${result.summary}`);
        await updateParallelState(runningIds);
        return { failed: false, stopScheduling: true };
      }

      if (result.commitResult?.committed) {
        const applyResult = await applyCommitToCheckout(repoRoot, result.commitResult.commitHash);
        if (!applyResult.applied) {
          let failedPlan = await readPlan(planPaths.planPath);
          failedPlan = setPlanRunState(failedPlan, {
            activeScopeId: null,
            currentBlocker: `Scope ${result.scope.id} committed in worktree but was not applied to parent checkout: ${applyResult.reason}`,
          });
          failedPlan = appendPlanScopeProgress(
            failedPlan,
            result.scope.id,
            `Parent checkout apply failed: ${applyResult.reason}`,
          );
          await writePlan(planPaths.planPath, failedPlan);
          log(`[git] parent apply failed for ${result.scope.id}: ${applyResult.reason}`);

          if (applyResult.status) {
            log(`git status parent:\n${applyResult.status}`);
          }

          if (applyResult.output) {
            log(applyResult.output);
          }

          exitCodes.push(1);
          await updateParallelState(runningIds);
          return { failed: true, stopScheduling: true };
        }

        log(
          `[git] applied ${result.scope.id} to parent checkout ${applyResult.commitHash.slice(
            0,
            7,
          )}`,
        );
        const parentGateFailure = await verifyParentCheckoutAfterApply({
          repoRoot,
          gateResults: result.gateResults,
          signal,
          log,
        });

        if (parentGateFailure) {
          let failedPlan = await readPlan(planPaths.planPath);
          failedPlan = setPlanRunState(failedPlan, {
            activeScopeId: null,
            currentBlocker: `Scope ${result.scope.id} failed parent checkout verification after apply: ${parentGateFailure.command}`,
          });
          failedPlan = appendPlanScopeProgress(
            failedPlan,
            result.scope.id,
            `Parent checkout verification failed after apply: ${parentGateFailure.command}`,
          );
          await writePlan(planPaths.planPath, failedPlan);
          exitCodes.push(1);
          await updateParallelState(runningIds);
          return { failed: true, stopScheduling: true };
        }
      }

      let completedPlan = await readPlan(planPaths.planPath);
      completedPlan = updatePlanScope(completedPlan, result.scope.id, {
        status: 'complete',
        repairAttempts: 0,
      });
      completedPlan = appendPlanScopeProgress(
        completedPlan,
        result.scope.id,
        `Parallel focused quality gates passed: ${
          result.gateResults.map((gate) => gate.command).join(', ') || 'none'
        }.`,
      );
      lastCompletedScopeId = result.scope.id;
      completedPlan = setPlanRunState(completedPlan, {
        activeScopeId: null,
        lastCompletedScopeId,
        currentBlocker: null,
      });
      await writePlan(planPaths.planPath, completedPlan);
      await updateParallelState(runningIds);

      return { failed: false };
    },
  });

  if (startedScopeCount === 0) {
    log('[agent] no dependency-ready scopes found for parallel execution.');
  }

  await updateParallelState(new Set());
  log(`[agent] parallel run drained; max concurrent scopes: ${queueResult.maxRunning}.`);
  return exitCodes[0] ?? 0;
}

async function runParallelScopeOnce({
  repoRoot,
  prdPath,
  worktreeRelativePrdPath,
  plan,
  planPaths,
  scope,
  verboseJson,
  signal,
  log,
}) {
  const worktree = await ensureAgentWorktree({ repoRoot, prdPath, scopeId: scope.id, log });
  const worktreeRoot = worktree.worktreeRoot;
  const focusedGates =
    scope.qualityGates.length > 0 ? scope.qualityGates : plan.qualityGates.focused;
  const focusedGateSet = splitQualityGates(focusedGates);
  const scopeBaseline = await createWorktreeSnapshot(worktreeRoot);
  let workingScope = scope;
  let repairFailure = null;
  let repairAttempts = scope.repairAttempts ?? 0;

  await printGitStatus(worktreeRoot, `before ${scope.id}`, log);

  while (true) {
    const contextPath = await writeScopeContext({
      repoRoot,
      prdPath: path.resolve(worktreeRoot, worktreeRelativePrdPath),
      relativePrdPath: worktreeRelativePrdPath,
      planPath: planPaths.planPath,
      planDir: planPaths.planDir,
      contextDir: path.join(worktreeRoot, '.agent', path.basename(planPaths.planDir), 'context'),
      plan,
      scope: workingScope,
      qualityGates: focusedGateSet.runnable,
      baselineStatus: scopeBaseline.status,
    });
    const prompt = await buildScopePrompt({
      prdPath: worktreeRelativePrdPath,
      planPath: planPaths.planPath,
      contextPath: path.relative(worktreeRoot, contextPath),
      scope: workingScope,
      qualityGates: focusedGates,
      repairFailure,
    });
    const codexResult = await runCodexScope({
      repoRoot: worktreeRoot,
      prompt,
      logsDir: planPaths.logsDir,
      scopeId: repairFailure ? `${scope.id}-repair` : scope.id,
      verboseJson,
      signal,
      getProgressSnapshot: () => gitStatus(worktreeRoot),
      log,
    });

    if (codexResult.exitCode !== 0) {
      const status = await gitStatus(worktreeRoot);
      return {
        scope: workingScope,
        exitCode: 1,
        status: status ? 'needs_repair' : 'not_started',
        repairAttempts,
        summary: status
          ? `Codex exited with code ${codexResult.exitCode} after changing files.`
          : `Codex exited with code ${codexResult.exitCode} before producing a worktree delta; scope is ready to retry.`,
      };
    }

    const humanInputRequest = await readHumanInputRequest(codexResult.lastMessagePath);
    if (humanInputRequest) {
      return {
        scope: workingScope,
        exitCode: 0,
        status: 'blocked',
        repairAttempts,
        humanInputRequired: true,
        summary: humanInputBlockerSummary(humanInputRequest),
      };
    }

    const reviewPackage = await createReviewPackage(worktreeRoot, scopeBaseline, {
      includeCurrentWhenNoDelta:
        workingScope.status === 'in_progress' || workingScope.status === 'needs_repair',
      ignoreWhenNoDelta: ['.agent/', 'scripts/agent/'],
    });
    const reviewDecision = decideScopeReview({
      gitStatus: reviewPackage.gitStatus,
      gitDiff: reviewPackage.gitDiff,
      repairFailure,
    });
    const automaticReview = reviewFromDecision(reviewDecision);
    const review =
      automaticReview ??
      (await reviewScopeDiff({
        repoRoot: worktreeRoot,
        relativePrdPath: worktreeRelativePrdPath,
        planPath: planPaths.planPath,
        logsDir: planPaths.logsDir,
        scope: workingScope,
        gitStatus: reviewPackage.gitStatus,
        gitDiff: reviewPackage.gitDiff,
        baselineStatus: reviewPackage.baselineStatus,
        currentStatus: reviewPackage.currentStatus,
        reviewMode: reviewDecision.mode,
        reviewReason: reviewDecision.reason,
        changedFiles: reviewPackage.changedFiles,
        verboseJson,
        signal,
        getProgressSnapshot: () => gitStatus(worktreeRoot),
        log,
      }));
    log(`[agent] parallel scope review ${scope.id}: ${review.verdict} - ${review.summary}`);

    if (review.verdict !== 'pass') {
      repairAttempts += 1;
      const repairLimitExhausted = shouldStopScopeReviewRepair({
        attempts: repairAttempts,
        changedFiles: reviewPackage.changedFiles,
        verdict: review.verdict,
      });
      const planReviewNeeded = shouldEscalateScopeReviewRepair({
        attempts: repairAttempts,
        changedFiles: reviewPackage.changedFiles,
        verdict: review.verdict,
      });
      const summary = `Scope review ${review.verdict}: ${review.summary}`;

      if (review.verdict === 'blocked' || repairLimitExhausted) {
        return {
          scope: workingScope,
          exitCode: 1,
          status: 'blocked',
          repairAttempts,
          summary: repairLimitExhausted
            ? `Scope review repair limit exhausted: ${review.summary}`
            : summary,
        };
      }

      if (planReviewNeeded) {
        return {
          scope: workingScope,
          exitCode: 2,
          status: 'needs_repair',
          repairAttempts,
          summary: `Scope needs plan clarification after ${repairAttempts} aligned repair attempts: ${review.summary}`,
          needsPlanReview: true,
        };
      }

      workingScope = scopeWithRepairProgress({
        scope: workingScope,
        repairAttempts,
        message: summary,
      });
      repairFailure = reviewRepairFailure(review);
      log(`[agent] parallel scope repair ${scope.id}: continuing after ${review.verdict}.`);
      continue;
    }

    const gateResults = await runQualityGates(focusedGateSet.runnable, {
      cwd: worktreeRoot,
      signal,
      log,
    });
    const failedGate = gateResults.find((result) => result.exitCode !== 0);

    if (failedGate) {
      repairAttempts += 1;
      const repairLimitExhausted = shouldStopScopeReviewRepair({
        attempts: repairAttempts,
        changedFiles: reviewPackage.changedFiles,
        verdict: 'repair',
      });
      const summary = `Quality gate failed: ${failedGate.command} exited ${failedGate.exitCode}.`;

      if (repairLimitExhausted) {
        return {
          scope: workingScope,
          exitCode: 1,
          status: 'blocked',
          repairAttempts,
          summary: `Quality gate repair limit exhausted: ${failedGate.command}`,
          gateResults,
        };
      }

      workingScope = scopeWithRepairProgress({
        scope: workingScope,
        repairAttempts,
        message: summary,
      });
      repairFailure = failedGate;
      log(`[agent] parallel scope repair ${scope.id}: continuing after failed gate.`);
      continue;
    }

    await syncMarkdownAfterScope({
      repoRoot: worktreeRoot,
      worktreeRelativePrdPath,
      planPaths,
      scope: workingScope,
      gateResults,
      verboseJson,
      signal,
      log,
    });
    const commitResult = await commitAll(
      worktreeRoot,
      scopeCommitMessage(workingScope, worktreeRelativePrdPath),
    );
    log(
      commitResult.committed
        ? `[git] committed ${scope.id}`
        : `[git] skipped commit for ${scope.id}: ${commitResult.reason}`,
    );
    await printGitStatus(worktreeRoot, `after ${scope.id}`, log);

    return {
      scope: workingScope,
      exitCode: 0,
      gateResults,
      commitResult,
    };
  }
}

async function syncMarkdownAfterScope({
  repoRoot,
  worktreeRelativePrdPath,
  planPaths,
  scope,
  gateResults,
  verboseJson,
  signal,
  log,
}) {
  log.stage?.(`Markdown sync: ${scope.id}`, [
    ['prd', worktreeRelativePrdPath],
    ['plan', planPaths.planPath],
  ]);
  const deterministicResult = await syncMarkdownDeterministically({
    prdPath: path.resolve(repoRoot, worktreeRelativePrdPath),
    scope,
    gateResults,
  });

  if (deterministicResult.synced) {
    log(`[agent] markdown sync: ${deterministicResult.reason}`);
    return;
  }

  log(`[agent] markdown sync fallback: ${deterministicResult.reason}`);
  const prompt = await buildMarkdownSyncPrompt({
    prdPath: worktreeRelativePrdPath,
    planPath: planPaths.planPath,
    scope,
    gateResults,
  });
  const result = await runCodexScope({
    repoRoot,
    prompt,
    logsDir: planPaths.logsDir,
    scopeId: `${scope.id}-markdown-sync`,
    verboseJson,
    signal,
    getProgressSnapshot: () => gitStatus(repoRoot),
    log,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Markdown sync failed for ${scope.id} with exit code ${result.exitCode}`);
  }
}

async function verifyParentCheckoutAfterApply({ repoRoot, gateResults, signal, log }) {
  const commands = [
    ...new Set(
      (gateResults ?? [])
        .filter((gate) => gate && !gate.skipped)
        .map((gate) => gate.command)
        .filter(Boolean),
    ),
  ];

  if (commands.length === 0) {
    return null;
  }

  log.stage?.('Parent checkout verification', [['gates', commands.join(', ')]]);
  const parentGateResults = await runQualityGates(commands, {
    cwd: repoRoot,
    signal,
    log,
  });

  return parentGateResults.find((result) => result.exitCode !== 0) ?? null;
}

async function runFinalAcceptance({ repoRoot, planPaths, signal, log }) {
  let plan = await readPlan(planPaths.planPath);

  if (hasOpenTemporaryFollowUps(plan)) {
    plan = setPlanRunState(plan, {
      status: 'blocked',
      finalAcceptanceStatus: 'blocked',
      currentBlocker: 'Open temporary follow-ups remain.',
    });
    await writePlan(planPaths.planPath, plan);
    log('[agent] final acceptance blocked by open temporary follow-ups.');
    return 1;
  }

  const finalGates =
    plan.qualityGates.final.length > 0 ? plan.qualityGates.final : plan.qualityGates.focused;
  const finalGateSet = splitQualityGates(finalGates);
  log.stage?.('Final quality gates', [
    ['gates', finalGateSet.runnable.join(', ') || 'none'],
    ['manual', finalGateSet.manual.join(', ') || 'none'],
  ]);
  const gateResults = await runQualityGates(finalGateSet.runnable, { cwd: repoRoot, signal, log });
  const failedGate = gateResults.find((result) => result.exitCode !== 0);

  if (failedGate) {
    plan = setPlanRunState(plan, {
      status: 'blocked',
      finalAcceptanceStatus: 'blocked',
      currentBlocker: `Final quality gate failed: ${failedGate.command}`,
    });
    await writePlan(planPaths.planPath, plan);
    return 1;
  }

  plan = setPlanRunState(plan, {
    status: 'complete',
    finalAcceptanceStatus: 'complete',
    currentBlocker: null,
  });
  await writePlan(planPaths.planPath, plan);
  log('[agent] final acceptance complete.');
  return 0;
}

async function printGitStatus(repoRoot, label, log) {
  log(`[git] status ${label}:`);
  log((await gitStatus(repoRoot)) || 'clean');
}
