import { readFile, writeFile } from 'node:fs/promises';

export async function syncMarkdownDeterministically({ prdPath, scope }) {
  const markdown = await readFile(prdPath, 'utf8');
  const nextMarkdown = markMatchingChecklistItems(markdown, scope.acceptanceCriteria);

  if (nextMarkdown === markdown) {
    return {
      synced: false,
      reason: 'No exact checklist matches found for scope acceptance criteria.',
    };
  }

  await writeFile(prdPath, nextMarkdown);

  return {
    synced: true,
    reason: 'Marked exact matching checklist items complete.',
  };
}

export function markMatchingChecklistItems(markdown, criteria) {
  const normalizedCriteria = criteria.map(normalizeText).filter(Boolean);

  if (normalizedCriteria.length === 0) {
    return markdown;
  }

  const lines = markdown.split('\n');
  const nextLines = [...lines];
  const blocks = checklistBlocks(lines);

  for (const block of blocks) {
    const normalizedBlock = normalizeText(block.lines.join(' '));
    const isMatch = normalizedCriteria.some(
      (criterion) => normalizedBlock.includes(criterion) || criterion.includes(normalizedBlock),
    );

    if (isMatch) {
      nextLines[block.start] = nextLines[block.start].replace(/^(\s*-\s+\[)(?:\s|~)(\])/, '$1+$2');
    }
  }

  return nextLines.join('\n');
}

function checklistBlocks(lines) {
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*-\s+\[(?:\s|~|\+)\]/.test(lines[index])) {
      continue;
    }

    const blockLines = [lines[index]];
    let cursor = index + 1;

    while (cursor < lines.length && /^(?:\s{2,}|\s*$)/.test(lines[cursor])) {
      if (/^\s*-\s+\[(?:\s|~|\+)\]/.test(lines[cursor])) {
        break;
      }

      blockLines.push(lines[cursor]);
      cursor += 1;
    }

    blocks.push({
      start: index,
      lines: blockLines,
    });
  }

  return blocks;
}

function normalizeText(value) {
  return String(value)
    .toLowerCase()
    .replace(/[`*_#[\]()+.,:;'"-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
