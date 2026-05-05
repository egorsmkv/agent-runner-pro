import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';

export const planStatuses = ['not_started', 'in_progress', 'needs_repair', 'blocked', 'complete'];
const maxProgressEntriesPerScope = 20;
const planStringifyOptions = {
  lineWidth: 100,
  defaultKeyType: 'PLAIN',
  defaultStringType: 'QUOTE_DOUBLE',
};

export function planSlugForPrd(prdPath) {
  return path
    .basename(prdPath, path.extname(prdPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function resolvePlanPaths(repoRoot, prdPath) {
  const planDir = path.join(repoRoot, '.agent', planSlugForPrd(prdPath));

  return {
    planDir,
    planPath: path.join(planDir, 'plan.yaml'),
    logsDir: path.join(planDir, 'logs'),
  };
}

export async function readPlan(planPath) {
  try {
    const rawPlan = await readFile(planPath, 'utf8');
    const repairedRawPlan = repairPlanStringArrayItems(rawPlan);
    try {
      const plan = normalizePlan(YAML.parse(repairedRawPlan));
      if (repairedRawPlan !== rawPlan) {
        await writePlan(planPath, plan);
      }
      return plan;
    } catch (error) {
      const repairedPlan = parseRepairedPlanYaml(rawPlan, error);
      await writePlan(planPath, repairedPlan);
      return repairedPlan;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function writePlan(planPath, plan) {
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, YAML.stringify(normalizePlan(plan), planStringifyOptions));
}

export function extractPlanFromText(text) {
  const fenced = text.match(/```(?:ya?ml)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  return normalizePlan(YAML.parse(repairPlanStringArrayItems(fenced)));
}

function parseRepairedPlanYaml(rawPlan, originalError) {
  const repairedPlan = repairPlanStringArrayItems(rawPlan);

  if (repairedPlan === rawPlan) {
    throw originalError;
  }

  try {
    return normalizePlan(YAML.parse(repairedPlan));
  } catch {
    throw originalError;
  }
}

export function repairTimestampProgressItems(rawPlan) {
  return String(rawPlan).replace(
    /^(\s*)-\s+(\d{4}-\d{2}-\d{2}T[^\n'"]*)$/gm,
    (_match, indent, value) => `${indent}- >-\n${indent}  ${value}`,
  );
}

export function repairPlanStringArrayItems(rawPlan) {
  const stringArrayKeys = new Set([
    'acceptanceCriteria',
    'qualityGates',
    'dependsOn',
    'ownedFiles',
    'temporaryFollowUps',
    'progress',
    'verificationEvidence',
    'focused',
    'final',
    'computationalGuides',
    'inferentialGuides',
    'computationalSensors',
    'inferentialSensors',
    'controlNotes',
  ]);
  const lines = repairTimestampProgressItems(rawPlan).split('\n');
  const arrayStack = [];

  return lines
    .map((line) => {
      const indentation = line.match(/^(\s*)/)?.[1].length ?? 0;

      while (arrayStack.length > 0 && indentation <= arrayStack[arrayStack.length - 1].indent) {
        arrayStack.pop();
      }

      const keyMatch = line.match(/^(\s*)([A-Za-z][A-Za-z0-9]*):\s*(?:#.*)?$/);
      if (keyMatch && stringArrayKeys.has(keyMatch[2])) {
        arrayStack.push({ indent: keyMatch[1].length });
        return line;
      }

      const activeArray = arrayStack[arrayStack.length - 1];
      if (!activeArray || indentation <= activeArray.indent) {
        return line;
      }

      const itemMatch = line.match(/^(\s*)-\s+(.+?)\s*$/);
      if (!itemMatch) {
        return line;
      }

      const [, itemIndent, rawValue] = itemMatch;
      if (isQuotedYamlString(rawValue) || rawValue === '[]' || rawValue === '{}') {
        return line;
      }

      if (!needsQuotedYamlString(rawValue)) {
        return line;
      }

      return `${itemIndent}- ${JSON.stringify(rawValue)}`;
    })
    .join('\n');
}

function isQuotedYamlString(value) {
  return value.startsWith('"') || value.startsWith("'") || value.startsWith('|') || value.startsWith('>');
}

function needsQuotedYamlString(value) {
  return /:\s/.test(value) || /[`[\]{}]/.test(value) || /^[!&*%@]/.test(value);
}

export function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Plan YAML must be an object.');
  }

  const scopes = Array.isArray(plan.scopes) ? plan.scopes : [];
  if (scopes.length === 0) {
    throw new Error('Plan YAML must include at least one scope.');
  }

  return {
    version: Number(plan.version ?? 1),
    prdPath: String(plan.prdPath ?? ''),
    status: normalizePlanStatus(plan.status ?? 'not_complete'),
    activeScopeId: plan.activeScopeId ?? null,
    lastCompletedScopeId: plan.lastCompletedScopeId ?? null,
    finalAcceptanceStatus: normalizePlanStatus(plan.finalAcceptanceStatus ?? 'not_complete'),
    qualityGates: normalizeQualityGates(plan.qualityGates),
    harness: normalizeHarness(plan.harness),
    scopes: scopes.map((scope, index) => normalizeScope(scope, index)),
    lastRunAt: plan.lastRunAt ?? null,
    currentBlocker: plan.currentBlocker ?? null,
  };
}

function normalizeScope(scope, index) {
  if (!scope || typeof scope !== 'object') {
    throw new Error(`Scope ${index + 1} must be an object.`);
  }

  const status = String(scope.status ?? 'not_started');
  if (!planStatuses.includes(status)) {
    throw new Error(`Invalid scope status: ${status}`);
  }

  return {
    id: String(scope.id ?? `scope-${index + 1}`),
    title: String(scope.title ?? `Scope ${index + 1}`),
    status,
    acceptanceCriteria: normalizeStringArray(scope.acceptanceCriteria),
    qualityGates: normalizeStringArray(scope.qualityGates),
    dependsOn: normalizeStringArray(scope.dependsOn),
    parallelGroup: scope.parallelGroup == null ? null : String(scope.parallelGroup),
    ownedFiles: normalizeStringArray(scope.ownedFiles),
    temporaryFollowUps: uniqueStrings(normalizeStringArray(scope.temporaryFollowUps)),
    verificationEvidence: uniqueStrings(normalizeStringArray(scope.verificationEvidence)),
    progress: normalizeProgress(scope.progress),
    repairAttempts: Number(scope.repairAttempts ?? 0),
  };
}

function normalizeHarness(harness) {
  const controls =
    harness && typeof harness === 'object' && harness.controls && typeof harness.controls === 'object'
      ? harness.controls
      : {};

  return {
    controls: {
      computationalGuides: normalizeStringArray(controls.computationalGuides),
      inferentialGuides: normalizeStringArray(controls.inferentialGuides),
      computationalSensors: normalizeStringArray(controls.computationalSensors),
      inferentialSensors: normalizeStringArray(controls.inferentialSensors),
    },
    controlNotes: normalizeStringArray(harness?.controlNotes),
  };
}

function normalizeQualityGates(qualityGates) {
  if (!qualityGates || typeof qualityGates !== 'object') {
    return { focused: ['yarn types'], final: ['yarn types', 'yarn lint'] };
  }

  return {
    focused: normalizeStringArray(qualityGates.focused),
    final: normalizeStringArray(qualityGates.final),
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(normalizeTextValue).filter(Boolean);
}

function normalizeProgress(value) {
  return normalizeStringArray(value)
    .filter((item) => item !== '[object Object]')
    .slice(-maxProgressEntriesPerScope);
}

function normalizeTextValue(item) {
  if (typeof item === 'string') {
    return item.trim();
  }

  if (item && typeof item === 'object') {
    if (item.timestamp && item.message) {
      return `${item.timestamp} - ${item.message}`.trim();
    }

    if (item.message) {
      return String(item.message).trim();
    }

    if (item.summary) {
      return String(item.summary).trim();
    }

    try {
      return JSON.stringify(item);
    } catch {
      return '';
    }
  }

  return String(item ?? '').trim();
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function normalizePlanStatus(value) {
  const status = String(value);
  if (status === 'complete' || status === 'blocked' || status === 'not_complete') {
    return status;
  }

  return 'not_complete';
}

export function selectNextPlanScope(plan, { retryBlocked = false } = {}) {
  const activeScope = plan.activeScopeId
    ? plan.scopes.find((candidate) => candidate.id === plan.activeScopeId)
    : null;

  if (
    activeScope &&
    isExecutablePlanScope(activeScope) &&
    (activeScope.status === 'in_progress' ||
      activeScope.status === 'needs_repair' ||
      activeScope.status === 'not_started' ||
      (retryBlocked && activeScope.status === 'blocked'))
  ) {
    return activeScope;
  }

  const statuses = retryBlocked
    ? ['in_progress', 'needs_repair', 'not_started', 'blocked']
    : ['in_progress', 'needs_repair', 'not_started'];

  for (const status of statuses) {
    const scope = plan.scopes.find(
      (candidate) =>
        candidate.status === status &&
        isExecutablePlanScope(candidate) &&
        scopeDependenciesComplete(plan, candidate),
    );
    if (scope) {
      return scope;
    }
  }

  return null;
}

export function selectParallelPlanScopes(
  plan,
  { limit = 2, retryBlocked = false, excludeScopeIds = [], runningScopes = [] } = {},
) {
  const statuses = retryBlocked
    ? ['in_progress', 'needs_repair', 'not_started', 'blocked']
    : ['in_progress', 'needs_repair', 'not_started'];
  const excluded = new Set([...excludeScopeIds].map(String));
  const candidates = [];

  for (const status of statuses) {
    candidates.push(
      ...plan.scopes.filter(
        (scope) =>
          !excluded.has(scope.id) &&
          scope.status === status &&
          isExecutablePlanScope(scope) &&
          scopeDependenciesComplete(plan, scope),
      ),
    );
  }

  const uniqueCandidates = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!seen.has(candidate.id)) {
      uniqueCandidates.push(candidate);
      seen.add(candidate.id);
    }
  }

  const selected = [...runningScopes];
  const selectedCandidates = [];

  for (const candidate of uniqueCandidates) {
    if (selectedCandidates.length >= limit) {
      break;
    }

    if (selected.some((scope) => scopesOverlap(scope, candidate))) {
      continue;
    }

    selected.push(candidate);
    selectedCandidates.push(candidate);
  }

  return selectedCandidates;
}

export function isExecutablePlanScope(scope) {
  const scopeText = [
    scope.title,
    ...(scope.acceptanceCriteria ?? []),
    ...(scope.temporaryFollowUps ?? []),
  ]
    .join('\n')
    .toLowerCase();

  return !(
    /\bnon[-\s]?executable\b/.test(scopeText) ||
    /do not execute\b/.test(scopeText) ||
    /do not run implementation\b/.test(scopeText) ||
    /must not receive implementation work\b/.test(scopeText) ||
    /do not route repairs\b/.test(scopeText)
  );
}

export function scopeDependenciesComplete(plan, scope) {
  const dependencies = scope.dependsOn ?? [];

  if (dependencies.length === 0) {
    return true;
  }

  return dependencies.every(
    (dependencyId) =>
      plan.scopes.find((candidate) => candidate.id === dependencyId)?.status === 'complete',
  );
}

function scopesOverlap(left, right) {
  const leftFiles = left.ownedFiles ?? [];
  const rightFiles = right.ownedFiles ?? [];

  if (leftFiles.length === 0 || rightFiles.length === 0) {
    return false;
  }

  return leftFiles.some((leftFile) =>
    rightFiles.some((rightFile) => ownedFilePatternsOverlap(leftFile, rightFile)),
  );
}

function ownedFilePatternsOverlap(left, right) {
  const leftPrefix = ownedFilePrefix(left);
  const rightPrefix = ownedFilePrefix(right);

  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

function ownedFilePrefix(pattern) {
  return String(pattern)
    .replace(/\*\*.*$/, '')
    .replace(/\*.*$/, '')
    .replace(/\/+$/, '');
}

export function updatePlanScope(plan, scopeId, patch) {
  const nextPlan = structuredClone(plan);
  const scope = nextPlan.scopes.find((candidate) => candidate.id === scopeId);

  if (!scope) {
    throw new Error(`Scope not found in plan: ${scopeId}`);
  }

  Object.assign(scope, patch);
  nextPlan.lastRunAt = new Date().toISOString();

  return normalizePlan(nextPlan);
}

export function appendPlanScopeProgress(plan, scopeId, message) {
  const nextPlan = structuredClone(plan);
  const scope = nextPlan.scopes.find((candidate) => candidate.id === scopeId);

  if (!scope) {
    throw new Error(`Scope not found in plan: ${scopeId}`);
  }

  scope.progress = [...scope.progress, `${new Date().toISOString()} - ${message}`];
  nextPlan.lastRunAt = new Date().toISOString();

  return normalizePlan(nextPlan);
}

export function setPlanRunState(plan, patch) {
  return normalizePlan({
    ...plan,
    ...patch,
    lastRunAt: new Date().toISOString(),
  });
}

export function hasOpenTemporaryFollowUps(plan) {
  return plan.scopes.some((scope) =>
    scope.temporaryFollowUps.some(
      (line) => !/\b(resolved|removed|accepted as final|accepted final)\b/i.test(line),
    ),
  );
}
