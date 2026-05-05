Review the current uncommitted changes against the active YAML scope.

This is a review pass. Do not edit files. Return valid YAML only.
Quote strings that contain `:`, backticks, braces, brackets, or long prose.
Prefer block scalars for long messages.

PRD path: {{prdPath}}
YAML plan path: {{planPath}}

Active scope:
{{scopeText}}

Review mode: {{reviewMode}}
Review mode reason: {{reviewReason}}

Changed files:
{{changedFiles}}

Scope delta git status:

```text
{{gitStatus}}
```

Scope delta diff:

```diff
{{gitDiff}}
```

Pre-existing dirty files at scope start:

```text
{{baselineStatus}}
```

Full current git status:

```text
{{currentStatus}}
```

Required YAML schema:

```yaml
verdict: pass
summary: >-
  Short review summary.
findings:
  - severity: high
    message: >-
      What is wrong or risky.
    file: path/to/file.ts
relatedFiles:
  - path/to/file.ts
missingWork:
  - >-
    Work still required for this scope.
temporaryFollowUps:
  - >-
    Temporary work detected in the diff.
verificationEvidence:
  - >-
    Command, test, review, or manual check that supports this verdict.
```

Rules:

- Use the provided scope delta status and diff as the primary source of truth.
- Judge the scope delta first. Only inspect other files when the delta is insufficient to decide.
- The scope delta excludes files that were already dirty and unchanged at scope start.
- The scope delta includes synthetic diffs for untracked files, so do not block only because a file is untracked.
- Do not run repo discovery commands unless the diff is insufficient to judge the scope.
- In `light` mode, do not inspect unrelated source files; review only the provided diff and changed files.
- Use `pass` only when the diff is related to the active scope, appears complete enough to run quality gates,
  and includes adequate verification evidence in the implementation result, scope progress, or diff.
- Use `repair` when the diff is related but incomplete, risky, or missing required tests.
- Use `repair` when source or test files changed but runnable gates, focused tests, or a credible manual
  verification explanation were skipped or are absent.
- Treat "looks plausible but unverified" as `repair` for source/test behavior changes.
- Use `unrelated` when the diff is mostly outside the active scope.
- Use `blocked` when the scope cannot be reviewed from the available diff.
- Treat broad unrelated refactors as a repair or unrelated verdict.
- Mention temporary work that must be tracked before final acceptance.
