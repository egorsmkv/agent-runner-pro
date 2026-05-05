import YAML from 'yaml';

import { renderTemplate } from './templates.mjs';

export async function buildPlanPrompt({
  prdPath,
  markdown,
  previousPlan = null,
  previousState = null,
  gitStatus = '',
}) {
  return await renderTemplate('plan.md', {
    prdPath,
    markdown,
    previousPlanYaml: previousPlan ? YAML.stringify(previousPlan, { lineWidth: 100 }) : 'null',
    previousStateJson: previousState ? JSON.stringify(previousState, null, 2) : 'null',
    gitStatus: gitStatus || 'clean',
  });
}

export async function buildScopePrompt({
  prdPath,
  planPath,
  contextPath,
  scope,
  qualityGates,
  repairFailure = null,
  finalAcceptance = false,
}) {
  const qualityGateLines =
    qualityGates.length > 0
      ? qualityGates.map((command) => `- \`${command}\``).join('\n')
      : '- No focused quality gates were detected. Run the smallest relevant verification.';
  const repairBlock = repairFailure
    ? `

The previous verification failed.

Command:
\`${repairFailure.command}\`

Exit code: ${repairFailure.exitCode}

Output summary:
\`\`\`
${repairFailure.outputSummary || 'No output captured.'}
\`\`\`
`
    : '';

  return await renderTemplate('scope.md', {
    mode: repairFailure ? 'repair' : finalAcceptance ? 'final acceptance' : 'implementation',
    prdPath,
    planPath: planPath ?? 'not provided',
    contextPath: contextPath ?? 'not provided',
    scopeText: formatScopeForPrompt(scope),
    qualityGateLines,
    repairBlock,
  });
}

export async function buildMarkdownSyncPrompt({ prdPath, planPath, scope, gateResults }) {
  return await renderTemplate('markdown-sync.md', {
    prdPath,
    planPath,
    scopeText: formatScopeForPrompt(scope),
    gateSummary: gateResults
      .map((result) => `- ${result.command}: exit ${result.exitCode}`)
      .join('\n'),
  });
}

function formatScopeForPrompt(scope) {
  if (scope.body) {
    return scope.body;
  }

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
${scope.verificationEvidence?.map((evidence) => `  - ${evidence}`).join('\n') || '  []'}
recentProgress:
${
  scope.progress
    ?.slice(-8)
    .map((item) => `  - ${item}`)
    .join('\n') || '  []'
}`;
}
