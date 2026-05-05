import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';

const maxPrdSnippetChars = 30000;

export async function writeScopeContext({
  repoRoot,
  prdPath,
  relativePrdPath,
  planPath,
  planDir,
  contextDir = path.join(planDir, 'context'),
  plan,
  scope,
  qualityGates,
  baselineStatus,
}) {
  await mkdir(contextDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const contextPath = path.join(contextDir, `${timestamp}-${scope.id}.md`);
  const markdown = await readFile(prdPath, 'utf8');
  const instructionFiles = await readInstructionFiles({ repoRoot, scope });
  const content = formatScopeContext({
    relativePrdPath,
    planPath,
    plan,
    scope,
    qualityGates,
    instructionFiles,
    prdSnippets: extractRelevantPrdSnippets(markdown, scope),
    baselineStatus,
  });

  await writeFile(contextPath, content);

  return contextPath;
}

export function extractRelevantPrdSnippets(markdown, scope) {
  const blocks = splitMarkdownBlocks(markdown);
  const needles = scopeNeedles(scope);
  const scored = blocks
    .map((block, index) => ({
      block,
      index,
      score: scoreBlock(block, needles, index),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = [];
  let totalChars = 0;

  for (const candidate of scored) {
    const text = candidate.block.trim();

    if (!text || totalChars + text.length > maxPrdSnippetChars) {
      continue;
    }

    selected.push(candidate);
    totalChars += text.length;
  }

  if (selected.length === 0) {
    return markdown.slice(0, maxPrdSnippetChars);
  }

  return selected
    .sort((left, right) => left.index - right.index)
    .map((candidate) => candidate.block.trim())
    .join('\n\n---\n\n');
}

function formatScopeContext({
  relativePrdPath,
  planPath,
  plan,
  scope,
  qualityGates,
  instructionFiles,
  prdSnippets,
  baselineStatus,
}) {
  return `# Agent Scope Context

Use this bundle as the first source of context for the next Codex pass.
Read the full PRD or full YAML plan only if this bundle is insufficient.

PRD path: ${relativePrdPath}
YAML plan path: ${planPath}

## Active Scope

\`\`\`yaml
${YAML.stringify(scope, { lineWidth: 100 }).trim()}
\`\`\`

## Focused Quality Gates

${qualityGates.length > 0 ? qualityGates.map((gate) => `- ${gate}`).join('\n') : '- none'}

## Harness Controls For This Scope

${formatHarnessControls(plan.harness)}

## Doer vs Judge Boundaries

- Codex may edit source, tests, and docs required by the active scope.
- The runner owns YAML plan state, scope review, quality gates, Markdown sync, commits, and parent checkout apply.
- Do not mark YAML or Markdown complete from the implementation pass.

## Repo Instructions

${formatInstructionFiles(instructionFiles)}

${verificationHints({ relativePrdPath, scope })}

## Plan Progress Summary

${plan.scopes
  .map((candidate) => {
    const suffix = candidate.id === scope.id ? ' (active)' : '';
    return `- ${candidate.id}: ${candidate.status}${suffix} - ${candidate.title}`;
  })
  .join('\n')}

## Worktree Baseline At Scope Start

\`\`\`text
${baselineStatus || 'clean'}
\`\`\`

## Relevant PRD Snippets

${prdSnippets}
`;
}

async function readInstructionFiles({ repoRoot, scope }) {
  const relativePaths = ['AGENTS.md'];

  for (const ownedFile of scope.ownedFiles ?? []) {
    const normalized = String(ownedFile)
      .replace(/\*\*.*$/, '')
      .replace(/\*.*$/, '')
      .replace(/\/+$/, '');
    let directory = normalized && !path.extname(normalized) ? normalized : path.dirname(normalized);

    while (directory && directory !== '.' && directory !== path.dirname(directory)) {
      relativePaths.push(path.join(directory, 'AGENTS.md'));
      directory = path.dirname(directory);
    }
  }

  const uniqueRelativePaths = [...new Set(relativePaths)];
  const files = [];

  for (const relativePath of uniqueRelativePaths) {
    try {
      const content = await readFile(path.join(repoRoot, relativePath), 'utf8');
      files.push({
        path: relativePath,
        content: content.trim(),
      });
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        throw error;
      }
    }
  }

  return files;
}

function formatHarnessControls(harness) {
  const controls = harness?.controls ?? {};
  const groups = [
    ['Computational guides', controls.computationalGuides],
    ['Inferential guides', controls.inferentialGuides],
    ['Computational sensors', controls.computationalSensors],
    ['Inferential sensors', controls.inferentialSensors],
    ['Control notes', harness?.controlNotes],
  ];

  return groups
    .map(([title, values]) => {
      const lines = Array.isArray(values) && values.length > 0 ? values : ['none declared'];
      return `### ${title}\n\n${lines.map((line) => `- ${line}`).join('\n')}`;
    })
    .join('\n\n');
}

function formatInstructionFiles(instructionFiles) {
  if (instructionFiles.length === 0) {
    return 'No repo instruction files were found for this scope.';
  }

  return instructionFiles
    .map(
      (file) => `### ${file.path}

\`\`\`markdown
${file.content}
\`\`\``,
    )
    .join('\n\n');
}

function verificationHints({ relativePrdPath, scope }) {
  const haystack = [
    relativePrdPath,
    scope.id,
    scope.title,
    ...scope.acceptanceCriteria,
    ...scope.qualityGates,
  ]
    .join('\n')
    .toLowerCase();

  if (!haystack.includes('workfloweditor') && !haystack.includes('workflow editor')) {
    return '';
  }

  return `## Repository Verification Hints

- Prefer \`yarn test:fe:unit <test files>\` for focused unit/component/store verification; WorkflowEditor tests are targetable through the normal Vitest config.
- Do not start with \`yarn vitest run ...\`; this repo does not expose that path reliably in agent worktrees.
- If a browser check is required, use a small focused Playwright command such as \`yarn test:e2e <spec>\`.
- Test auth credentials are \`test@test.com\` / \`test\`.
- If auth, dev-server bootstrap, or Playwright environment setup blocks verification after one focused attempt, stop and ask the user for help with the exact blocker instead of guessing through multiple broad rewrites.
`;
}

function splitMarkdownBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let current = [];

  for (const line of lines) {
    if (/^#{1,4}\s+/.test(line) && current.length > 0) {
      blocks.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    blocks.push(current.join('\n'));
  }

  return blocks;
}

function scopeNeedles(scope) {
  return [
    scope.id,
    scope.title,
    ...scope.acceptanceCriteria,
    ...scope.title.split(/\s+/).filter((word) => word.length > 4),
  ]
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);
}

function scoreBlock(block, needles, index) {
  const lower = block.toLowerCase();
  let score = index === 0 ? 2 : 0;

  for (const needle of needles) {
    if (lower.includes(needle)) {
      score += needle.length > 8 ? 8 : 3;
    }
  }

  if (/^##\s+(summary|acceptance criteria|implementation plan|design progress)/im.test(block)) {
    score += 2;
  }

  return score;
}
