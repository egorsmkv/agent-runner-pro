// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { humanInputBlockerSummary, parseHumanInputRequest } from '../actions/human-input/index.mjs';

describe('agent human input requests', () => {
  it('parses a fenced ask_human YAML block', () => {
    const request = parseHumanInputRequest(`
I need a decision.

\`\`\`yaml
ask_human:
  question: Which owner should expose the command?
  recommendation: Use the store domain.
  blockingReason: Two domains are plausible and both affect public API.
  defaultOptionId: store
  options:
    - id: store
      label: Store domain
      tradeoff: Keeps components thin.
    - id: component
      label: Component local
      tradeoff: Faster but leaks policy.
\`\`\`
`);

    expect(request).toEqual({
      question: 'Which owner should expose the command?',
      recommendation: 'Use the store domain.',
      blockingReason: 'Two domains are plausible and both affect public API.',
      defaultOptionId: 'store',
      options: [
        {
          id: 'store',
          label: 'Store domain',
          tradeoff: 'Keeps components thin.',
        },
        {
          id: 'component',
          label: 'Component local',
          tradeoff: 'Faster but leaks policy.',
        },
      ],
    });
  });

  it('ignores prose and YAML without a question', () => {
    expect(parseHumanInputRequest('No question here.')).toBeNull();
    expect(parseHumanInputRequest('ask_human:\n  recommendation: Decide this.')).toBeNull();
  });

  it('builds a compact blocker summary', () => {
    expect(
      humanInputBlockerSummary({
        question: 'Choose owner?',
        recommendation: 'Use dynamicNodes.',
        defaultOptionId: 'dynamicNodes',
        blockingReason: 'Public API shape changes.',
        options: [{ id: 'dynamicNodes', label: 'Dynamic nodes', tradeoff: 'Matches overlay API.' }],
      }),
    ).toContain('Human input required: Choose owner?');
  });
});
