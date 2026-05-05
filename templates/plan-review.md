Review the executable YAML plan against the full Markdown PRD.

This is a planning pass. Do not edit source code. Return valid YAML only.
Quote strings that contain `:`, backticks, braces, brackets, or long prose.
Prefer block scalars for long messages.

PRD path: {{prdPath}}
YAML plan path: {{planPath}}

Current git status:

```text
{{gitStatus}}
```

Recent agent commits:

```text
{{recentCommits}}
```

Current YAML plan:

```yaml
{ { planYaml } }
```

Markdown PRD:

```markdown
{{markdown}}
```

Required YAML schema:

```yaml
verdict: aligned
summary: >-
  Short planning summary.
missingScopes:
  - title: Scope title
    reason: >-
      Why this scope is needed for the PRD goal.
    acceptanceCriteria:
      - PRD criterion this scope covers.
    qualityGates:
      - yarn types
reopenScopes:
  - scopeId: scope-4
    reason: >-
      Why a completed scope is not actually complete.
scopeUpdates:
  - scopeId: scope-5
    reason: >-
      Why the scope needs clarification.
    addAcceptanceCriteria:
      - Missing criterion to add.
    addQualityGates:
      - yarn test:unit path/to/test.ts
    addDependsOn:
      - scope-4
    setParallelGroup: batch-2
    addOwnedFiles:
      - src/example/**
    addTemporaryFollowUps:
      - Temporary cleanup still required.
    removeTemporaryFollowUps:
      - Exact temporary follow-up text that is obsolete or resolved.
cleanup:
  compactProgress: true
  progressKeepLast: 8
  removeResolvedTemporaryFollowUps: true
finalAcceptanceRisks:
  - >-
    Remaining risk to the final PRD vision.
```

Rules:

- Use `aligned` only when the YAML plan still covers the PRD vision and final acceptance criteria.
- Reconcile both PRD coverage and harness-control coverage. The plan should retain useful
  computational guides, inferential guides, computational sensors, and inferential sensors.
- Use `needs_plan_update` when scopes should be added, reopened, split, clarified, or cleaned.
- Use `blocked` only when the plan cannot be reconciled with the PRD.
- Do not ask for source-code changes directly; express missing work as scopes or scope updates.
- Do not delete acceptance criteria.
- Prefer adding small future scopes over expanding already-large scopes.
- Add new tasks along the way when they clarify real implementation ownership, unblock an active repair loop, or create safe
  parallel work aligned with the PRD north star.
- Do not plan for planning's sake; every new or split scope must remove ambiguity, reduce merge risk, or unlock useful
  independent execution.
- Do not create non-executable or risk-bucket scopes. Put risk-only notes in `finalAcceptanceRisks`; create `missingScopes`
  only for concrete implementation or verification work with an owner, dependencies, and quality gates.
- Split broad future scopes when doing so creates clearer independent worktrees or safer merge points.
- Add or refine `dependsOn`, `parallelGroup`, and `ownedFiles` whenever the plan can support parallel execution.
- Add missing quality gates, verification criteria, or owned-file boundaries when they reduce ambiguity,
  strengthen feedback, or improve parallel safety.
- Parallel groups must contain only scopes with non-overlapping ownership and no hard dependency between them.
- Reopen a completed scope only when its completion claim conflicts with the PRD or evidence in the plan/commits.
- Use cleanup to reduce stale execution context: compact old progress notes and remove resolved or obsolete temporary follow-ups.
- Remove temporary follow-ups only when they are clearly resolved, duplicated, obsolete, or no longer meaningful.
- Keep quality gates executable shell commands when possible.
- Do not preserve harness controls just because they exist. Keep notes concise and removable when a control
  no longer appears to improve agent outcomes.
