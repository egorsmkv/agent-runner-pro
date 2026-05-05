// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { parseTitle } from '../utils/prd.mjs';

describe('codex PRD helpers', () => {
  it('reads the first markdown h1 as the PRD title', () => {
    expect(parseTitle('# PRD: Example\n\nBody')).toBe('PRD: Example');
  });

  it('uses a fallback title when the PRD has no h1', () => {
    expect(parseTitle('Body only')).toBe('Untitled PRD');
  });
});
