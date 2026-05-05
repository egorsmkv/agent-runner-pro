// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { markMatchingChecklistItems } from '../actions/markdown-sync/index.mjs';

describe('markdown sync action', () => {
  it('marks exact matching checklist blocks complete without touching unrelated items', () => {
    const markdown = `# PRD

- [ ] US-001 first thing
      Progress: started.
- [~] US-002 second thing
- [ ] US-003 unrelated thing
`;

    expect(markMatchingChecklistItems(markdown, ['US-001', 'US-002'])).toBe(`# PRD

- [+] US-001 first thing
      Progress: started.
- [+] US-002 second thing
- [ ] US-003 unrelated thing
`);
  });
});
