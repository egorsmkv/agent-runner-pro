# Agent Runner

- Originally made by Oleksii Bondarenko.
- Enhanced by Yehor Smoliakov with ideas from [this article](https://ai.gopubby.com/harness-engineering-what-every-ai-engineer-needs-to-know-in-2026-0ab649e5686a).

Agent Runner is a repo-local `yarn agent` CLI for executing Markdown PRDs with
Codex. It converts a human-readable PRD into YAML execution state, runs scoped
implementation passes in agent-owned git worktrees under `.agent/worktrees/`,
verifies the resulting diff, runs quality gates, syncs completed checklist items
back to Markdown, and creates local commits.

The runner is designed for local development workflows. It never pushes changes.

## Requirements

- Node.js with Yarn available in the repository.
- Git repository checkout with permission to create local branches and worktrees.
- `codex` CLI available on `PATH`.
- Project-specific quality gate commands from the PRD available in the checkout.

## Quick Start

Install dependencies:

```sh
yarn install
```

Run the included example PRD:

```sh
yarn agent run --file docs/prds/example-feature.md --once
```

Continue a saved or interrupted run:

```sh
yarn agent resume
```

Run tests for the runner:

```sh
yarn test
```

## Example PRD

The repository includes an example PRD at
[`docs/prds/example-feature.md`](docs/prds/example-feature.md). It describes a
Node.js app with a React UI that renders news from public RSS feeds.

Use it as a starting point for new PRDs:

```sh
yarn agent run --file docs/prds/example-feature.md
```

A good PRD should include a clear title, scope-sized checklist items, concrete
acceptance criteria, quality gates, and explicit out-of-scope items.

## Commands

```sh
yarn agent run --file <prd.md>
```

Start from a Markdown PRD, regenerate `.agent/<prd-slug>/plan.yaml`, then
execute scopes until completion or a blocker. Use `--once` to stop after one
completed scope.

```sh
yarn agent resume
```

Continue the previous interrupted or saved run from `.agent/state.json` and the
existing YAML plan.

```sh
yarn agent plan-review [--file <prd.md>]
```

Reevaluate YAML plan coverage against the Markdown PRD. Plan review may add
missing scopes, reopen stale scopes, clarify acceptance criteria, and compact
stale progress notes.

## Options

- `--file`, `-f`: Markdown PRD file to run or review.
- `--once`: Complete at most one scope.
- `--parallel <n>`: Run up to `n` dependency-ready scopes in separate worktrees.
  Parallel selection skips scopes with overlapping `ownedFiles` patterns.
- `--verbose-json`: Print raw Codex JSONL events.
- `--dry-run`: Supported by `plan-review`; restores the original plan after
  review.

## How It Works

1. `run` reads the Markdown PRD and generates YAML state under `.agent/`.
2. The runner selects the next ready scope from YAML.
3. Codex works in an `.agent/worktrees/...` checkout. Serial runs use branch
   `agent/<prd-slug>`; parallel runs use per-scope branches named
   `agent/<prd-slug>-<scope-id>`.
4. Scope review checks whether the diff matches the active scope.
5. Focused quality gates run in the worktree. Descriptive or manual gates are
   reported separately and are not executed as shell commands.
6. Completed checklist markers are synced back to the Markdown PRD.
7. The scope is committed locally and cherry-picked back into the parent
   checkout when the parent checkout is clean.
8. Plan review runs after completed scopes and may add missing scopes, reopen
   stale scopes, clarify criteria, or compact stale progress notes.
9. Final plan review and final quality gates run before acceptance.

Runtime state, logs, and agent source worktrees stay under `.agent/`, which is
gitignored.

## Runtime Files

- `.agent/state.json`: recoverable run state for `resume`.
- `.agent/<prd-slug>/plan.yaml`: YAML execution source of truth.
- `.agent/<prd-slug>/logs/*.jsonl`: raw Codex JSON event logs.
- `.agent/<prd-slug>/logs/*-last-message.txt`: final Codex messages.
- `.agent/<prd-slug>/harness-metrics.jsonl`: local Codex pass metrics for harness decay review.
- `.agent/<prd-slug>/context/*.md`: generated scope context bundles.
- `.agent/error.log`: appended top-level crash log.
- `.agent/worktrees/<prd-slug>/`: serial source worktree.
- `.agent/worktrees/scopes/<prd-slug>/<scope-id>/`: parallel source worktrees.

If Codex returns a structured `ask_human` YAML block in its final message, the
runner marks the active scope blocked and records the question, recommendation,
and options in the YAML plan.

## Development Notes

- `index.mjs` is the user-facing command dispatcher.
- `commands/` parses and validates CLI arguments.
- `actions/` owns executable workflow behavior.
- `templates/` stores agent-facing prompts.
- `utils/` contains small pure helpers.
- `tests/` contains focused Vitest coverage.

The Codex implementation model is fixed to `gpt-5.4` with medium reasoning.

Harness controls should be treated as removable. Periodically run
`yarn agent plan-review --file <prd.md> --dry-run` and compare the plan review
with `.agent/<prd-slug>/harness-metrics.jsonl` to identify controls that add
latency, tokens, or repair loops without improving review and gate outcomes.
