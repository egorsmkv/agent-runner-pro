# Agent Runner Instructions

## Scope

This repository implements the repo-local `yarn agent` CLI. Keep the runner
independent from any application it is installed beside: do not import
application code from `src/` or other product directories.

## Architecture

- `index.mjs` is only the user-facing command dispatcher.
- `commands/` owns CLI argument parsing and validation for user-facing commands.
  Commands should call actions and should not contain workflow orchestration.
- `actions/` owns executable operations that commands can compose. These are not
  user-facing commands.
  - `actions/run/` owns the PRD execution loop.
  - `actions/human-input/` owns structured human-input blocker parsing from
    Codex final messages.
  - `actions/git/` owns git status and local commit operations.
  - `actions/state/` owns runtime state file paths and JSON state reads/writes.
  - `actions/worktree/` owns agent execution worktree creation/reuse.
  - `actions/plan/` owns YAML plan paths, parsing, normalization, and updates.
  - `actions/plan-review/` owns whole-PRD plan reevaluation, conservative plan
    updates, and stale YAML context cleanup.
  - `actions/codex/` owns `codex exec` subprocess execution and JSONL event
    logging.
  - `actions/context/` owns generated scope context bundles that keep Codex from
    rereading huge PRDs and plans on every pass.
  - `actions/errors/` owns crash logging under `.agent/error.log`.
  - `actions/quality-gates/` owns shell quality gate execution and summaries.
  - `actions/markdown-sync/` owns deterministic Markdown PRD marker updates and
    leaves Codex sync as a fallback for ambiguous PRD edits.
  - `actions/reporter/` owns terminal presentation for stages, Codex events,
    and progress heartbeats.
  - `actions/scope-review/` owns post-implementation diff review before quality
    gates and commits.
- `templates/` stores agent-facing prompt text. Keep substantial prompt changes
  in template files, not inline JavaScript strings.
- `utils/` is for small pure helpers shared by actions/templates. Do not put
  process-spawning, git, filesystem state mutation, or workflow orchestration
  there.
- `tests/` should cover actions and prompt rendering with focused Vitest tests.

## Design Decisions

- Markdown PRDs are human-facing input. The runner must not make execution
  decisions by parsing arbitrary Markdown structure after a YAML plan exists.
- YAML under `.agent/` is the execution source of truth for scope status,
  quality gates, repair attempts, temporary follow-ups, and final acceptance.
- Markdown sync happens only after a scope passes its quality gates.
- Markdown sync should be deterministic when exact checklist markers can be
  matched; use a Codex sync pass only as a fallback.
- Codex implementation prompts should point to a generated scope context bundle
  first. The full PRD and YAML plan are fallback context, not mandatory reads for
  every repair pass.
- Scope quality gates run only after a post-implementation review confirms the
  current diff is related to the active scope and complete enough to verify.
- Plan review runs after completed scopes and before final acceptance. It may add
  missing scopes, reopen stale completed scopes, clarify scope gates/criteria,
  and compact stale YAML progress notes. It must not edit source code.
- Scope review should use the provided diff first. Use full Codex review for
  source/test changes, light review for metadata-only changes, and automatic
  decisions for unchanged diffs to avoid repeated repo exploration.
- Scope review should receive the delta introduced during the current scope,
  including synthetic diffs for untracked files. Pre-existing dirty files are
  shown separately and should not block review unless the current scope changed
  them.
- Top-level crashes are appended to `.agent/error.log`; non-interrupt crashes
  restart once through `resume` when saved state exists.
- Runtime files and logs stay under `.agent/` and are gitignored.
- Source implementation runs in agent-owned git worktrees under
  `.agent/worktrees/`. Serial runs use `<slug>/` on branch `agent/<prd-slug>`;
  parallel runs use `scopes/<slug>/<scope-id>/` on branch
  `agent/<prd-slug>-<scope-id>`. Keep runtime state and source worktrees under
  `.agent/`, and continue to gitignore `.agent/`.
- Existing clean agent worktrees are synced to the parent checkout HEAD before
  reuse. Dirty agent worktrees are left intact for repair/resume.
- Legacy external worktrees under sibling `.agent-worktrees/` may be migrated
  back into `.agent/worktrees/`.
- Codex implementation passes treat YAML state as read-only. The runner and
  review actions own state mutations so execution does not depend on Codex being
  able to write outside the source worktree.
- The first version always uses Codex `gpt-5.4` with medium reasoning. Do not add
  model/profile/sandbox option plumbing unless the user asks for it.
- The runner may create local git commits after completed scopes, but it must
  never push.
- Avoid destructive git commands in this folder.
- Parent checkout cherry-picks are allowed only when the parent checkout is
  clean. Failed cherry-picks must be aborted and reported, not left for the user
  to unwind.
- `--parallel` may run independent scopes only when dependencies are complete and
  `ownedFiles` patterns do not overlap. Keep this conservative; parallelism must
  not trade correctness for throughput.
- Runnable quality gates are shell commands with known command prefixes. Manual
  or descriptive gates should be reported as manual/skipped rather than
  executed.

## Code Style

- Keep modules small and named by responsibility. Prefer
  `actions/<name>/index.mjs` when an action has more than one collaborator or
  may grow.
- Keep command handlers dumb: parse flags, validate inputs, call one action.
- Use Node standard library APIs for process spawning, paths, and file IO.
- Use the `yaml` package for YAML parsing/serialization. Do not hand-roll YAML.
- Keep prompt text readable for agents. Prefer direct instructions over clever
  formatting or implicit behavior.
- Keep terminal output structured and compact. User-facing progress should show
  agent stages first, with Codex session output nested underneath.
- Add tests for new plan/state/git/quality-gate behavior before changing the
  execution loop.
