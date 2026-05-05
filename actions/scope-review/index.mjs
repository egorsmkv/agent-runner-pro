import { readFile } from 'node:fs/promises';

import YAML from 'yaml';

import { runCodexScope } from '../codex/index.mjs';
import { appendPlanScopeProgress, updatePlanScope, writePlan } from '../plan/index.mjs';
import { renderTemplate } from '../../utils/templates.mjs';

export async function reviewScopeDiff({
  repoRoot,
  relativePrdPath,
  planPath,
  logsDir,
  scope,
  gitStatus,
  gitDiff,
  baselineStatus = '',
  currentStatus = '',
  reviewMode = 'full',
  reviewReason = null,
  changedFiles = [],
  verboseJson,
  signal,
  getProgressSnapshot,
  log,
}) {
  const prompt = await buildScopeReviewPrompt({
    prdPath: relativePrdPath,
    planPath,
    scope,
    gitStatus,
    gitDiff,
    baselineStatus,
    currentStatus,
    reviewMode,
    reviewReason,
    changedFiles,
  });
  const result = await runCodexScope({
    repoRoot,
    prompt,
    logsDir,
    scopeId: `${scope.id}-review`,
    verboseJson,
    signal,
    getProgressSnapshot,
    log,
  });

  if (result.exitCode !== 0) {
    return {
      verdict: 'blocked',
      summary: `Scope review Codex pass exited ${result.exitCode}.`,
      findings: [],
      relatedFiles: [],
      missingWork: [],
      temporaryFollowUps: [],
      verificationEvidence: [],
    };
  }

  const finalMessage = await readFile(result.lastMessagePath, 'utf8');
  return parseScopeReview(finalMessage, { tolerant: true });
}

export async function applyScopeReviewResult({
  plan,
  planPath,
  scopeId,
  review,
  writePlanFile = writePlan,
}) {
  let nextPlan = appendPlanScopeProgress(
    plan,
    scopeId,
    `Scope review ${review.verdict}: ${review.summary}`,
  );

  if (review.temporaryFollowUps.length > 0) {
    const scope = nextPlan.scopes.find((candidate) => candidate.id === scopeId);
    nextPlan = updatePlanScope(nextPlan, scopeId, {
      temporaryFollowUps: mergeUnique(scope?.temporaryFollowUps ?? [], review.temporaryFollowUps),
    });
  }

  if (review.verificationEvidence?.length > 0) {
    const scope = nextPlan.scopes.find((candidate) => candidate.id === scopeId);
    nextPlan = updatePlanScope(nextPlan, scopeId, {
      verificationEvidence: mergeUnique(
        scope?.verificationEvidence ?? [],
        review.verificationEvidence,
      ),
    });
  }

  if (review.verdict !== 'pass') {
    nextPlan = updatePlanScope(nextPlan, scopeId, {
      status: review.verdict === 'blocked' ? 'blocked' : 'needs_repair',
    });
  }

  await writePlanFile(planPath, nextPlan);
  return nextPlan;
}

export function decideScopeReview({
  gitStatus,
  gitDiff,
  previousGitDiff = null,
  repairFailure = null,
} = {}) {
  const changedFiles = parseGitStatusFiles(gitStatus);

  if (changedFiles.length === 0) {
    if (repairFailure) {
      return {
        mode: 'skip',
        reason:
          'No tracked worktree changes were found during a repair pass; proceeding to gates to verify the current scope state.',
        changedFiles,
      };
    }

    return {
      mode: 'auto-repair',
      reason: 'No tracked worktree changes were found after the Codex pass.',
      changedFiles,
    };
  }

  if (previousGitDiff != null && gitDiff === previousGitDiff) {
    if (repairFailure) {
      return {
        mode: 'skip',
        reason:
          'Tracked diff did not change during a quality-gate repair pass; proceeding to rerun gates.',
        changedFiles,
      };
    }

    return {
      mode: 'auto-repair',
      reason: 'Tracked diff did not change during the Codex pass.',
      changedFiles,
    };
  }

  if (changedFiles.every(isMetadataFile)) {
    return {
      mode: 'light',
      reason: 'Only PRD, Markdown, or agent metadata changed.',
      changedFiles,
    };
  }

  return {
    mode: 'full',
    reason: 'Source or test files changed.',
    changedFiles,
  };
}

export function reviewFromDecision(decision) {
  if (decision.mode === 'skip') {
    return {
      verdict: 'pass',
      summary: decision.reason,
      findings: [],
      relatedFiles: decision.changedFiles,
      missingWork: [],
      temporaryFollowUps: [],
      verificationEvidence: [],
    };
  }

  if (decision.mode === 'auto-repair') {
    return {
      verdict: 'repair',
      summary: decision.reason,
      findings: [
        {
          severity: 'medium',
          message: decision.reason,
          file: null,
        },
      ],
      relatedFiles: decision.changedFiles,
      missingWork: [decision.reason],
      temporaryFollowUps: [],
      verificationEvidence: [],
    };
  }

  return null;
}

export function parseScopeReview(text, { tolerant = false } = {}) {
  const fenced = text.match(/```(?:ya?ml)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  let review;

  try {
    review = YAML.parse(fenced);
  } catch (error) {
    if (!tolerant) {
      throw error;
    }

    return fallbackReviewFromText(fenced, error);
  }

  if (!review || typeof review !== 'object') {
    if (tolerant) {
      return fallbackReviewFromText(fenced, new Error('Scope review must be a YAML object.'));
    }

    throw new Error('Scope review must be a YAML object.');
  }

  let verdict;

  try {
    verdict = normalizeVerdict(review.verdict);
  } catch (error) {
    if (!tolerant) {
      throw error;
    }

    return fallbackReviewFromText(fenced, error);
  }

  return {
    verdict,
    summary: String(review.summary ?? `${verdict} review`),
    findings: normalizeFindings(review.findings),
    relatedFiles: normalizeStringArray(review.relatedFiles),
    missingWork: normalizeStringArray(review.missingWork),
    temporaryFollowUps: normalizeStringArray(review.temporaryFollowUps),
    verificationEvidence: normalizeStringArray(review.verificationEvidence),
  };
}

function fallbackReviewFromText(text, error) {
  const verdict = extractLooseVerdict(text) ?? 'repair';
  const summary =
    extractLooseSummary(text) ?? oneLine(text) ?? 'Scope review output was not valid YAML.';

  return {
    verdict: verdict === 'pass' ? 'repair' : verdict,
    summary: `Review output was not valid YAML; treating as repair. ${summary}`,
    findings: [
      {
        severity: 'medium',
        message: `Review parser failed: ${error.message}`,
        file: null,
      },
    ],
    relatedFiles: [],
    missingWork: [summary],
    temporaryFollowUps: [],
    verificationEvidence: [],
  };
}

function extractLooseVerdict(text) {
  const match = String(text).match(/\bverdict:\s*(pass|repair|unrelated|blocked)\b/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function extractLooseSummary(text) {
  const match = String(text).match(/\bsummary:\s*([\s\S]*?)(?=\n\w+:|\n\s*-\s+\w+:|$)/i);
  return match ? oneLine(match[1]) : null;
}

async function buildScopeReviewPrompt({
  prdPath,
  planPath,
  scope,
  gitStatus,
  gitDiff,
  baselineStatus,
  currentStatus,
  reviewMode,
  reviewReason,
  changedFiles,
}) {
  return await renderTemplate('scope-review.md', {
    prdPath,
    planPath,
    scopeText: formatScopeForReview(scope),
    gitStatus: gitStatus || 'clean',
    gitDiff: gitDiff || 'No diff.',
    baselineStatus: baselineStatus || 'clean',
    currentStatus: currentStatus || 'clean',
    reviewMode,
    reviewReason: reviewReason ?? 'No special review mode reason.',
    changedFiles:
      changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`).join('\n') : '[]',
  });
}

function formatScopeForReview(scope) {
  return `id: ${scope.id}
title: ${scope.title}
status: ${scope.status}
acceptanceCriteria:
${scope.acceptanceCriteria?.map((criterion) => `  - ${criterion}`).join('\n') || '  []'}
qualityGates:
${scope.qualityGates?.map((command) => `  - ${command}`).join('\n') || '  []'}
temporaryFollowUps:
${scope.temporaryFollowUps?.map((followUp) => `  - ${followUp}`).join('\n') || '  []'}
verificationEvidence:
${scope.verificationEvidence?.map((evidence) => `  - ${evidence}`).join('\n') || '  []'}`;
}

function normalizeVerdict(value) {
  const verdict = String(value ?? '').trim();
  if (['pass', 'repair', 'unrelated', 'blocked'].includes(verdict)) {
    return verdict;
  }

  throw new Error(`Invalid scope review verdict: ${value}`);
}

function normalizeFindings(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      severity: String(item.severity ?? 'medium'),
      message: String(item.message ?? ''),
      file: item.file == null ? null : String(item.file),
    }))
    .filter((item) => item.message);
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item)).filter(Boolean);
}

function mergeUnique(first, second) {
  return [...new Set([...first, ...second])];
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function parseGitStatusFiles(gitStatus) {
  return String(gitStatus ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim() || line.trim())
    .map((file) => file.split(' -> ').at(-1))
    .filter(Boolean);
}

function isMetadataFile(file) {
  return (
    file.startsWith('.agent/') ||
    file.startsWith('docs/prds/') ||
    file.endsWith('.md') ||
    file.endsWith('.yaml') ||
    file.endsWith('.yml')
  );
}
