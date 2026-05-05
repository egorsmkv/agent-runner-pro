You are running a bounded {{mode}} pass for a large PRD.

PRD path: {{prdPath}}
YAML plan path: {{planPath}}
Scope context path: {{contextPath}}

Active scope:
{{scopeText}}

Required quality gates for this pass:
{{qualityGateLines}}
{{repairBlock}}

Instructions:

- Read the scope context file first. It contains the active scope, relevant PRD snippets, plan progress, and worktree baseline.
- Read the full PRD or full YAML plan only when the scope context is insufficient.
- Read all relevant repo instructions before editing.
- Treat the current checkout as the agent worktree for source edits, tests, and verification.
- Work only on the active scope unless another change is required to satisfy its acceptance criteria.
- Respect existing uncommitted user changes. Do not revert unrelated changes.
- Keep changes surgical and update tests when behavior changes.
- Run the required quality gates when practical.
- In your final message, include a concise verification evidence section listing each command, test,
  review, or manual check you ran, plus any gate you could not run and why.
- Do not mark the scope complete in the Markdown PRD. The runner will sync progress to Markdown after quality gates pass.
- Do not edit the YAML plan directly during implementation. The runner owns plan state updates.
- If you add temporary code or leave a known cleanup, call it out clearly in your final message so the review pass can track it.
- Stop and record a blocker instead of making broad speculative changes.
- For rare key architectural decisions that materially affect public API ownership, data flow, or long-term boundaries, ask the human instead of guessing. Use this only when the scope cannot be completed safely from the PRD, plan, and code context.
- To ask, stop before broad edits and make your final message contain a fenced YAML block with this shape:

```yaml
ask_human:
  question: >-
    One concrete decision you need.
  recommendation: >-
    The option you recommend and why.
  blockingReason: >-
    Why continuing without this answer is risky.
  defaultOptionId: recommended-option
  options:
    - id: recommended-option
      label: Short label
      tradeoff: >-
        Impact if chosen.
    - id: alternate-option
      label: Short label
      tradeoff: >-
        Impact if chosen.
```

- Final acceptance requires all PRD acceptance criteria complete and no unresolved temporary follow-ups.
