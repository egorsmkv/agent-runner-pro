import path from 'node:path';

import { readPlan, resolvePlanPaths, writePlan } from '../../actions/plan/index.mjs';
import { runPlanReview } from '../../actions/plan-review/index.mjs';
import { readRunnerState, resolveStatePaths } from '../../actions/state/index.mjs';

export async function planReviewCommand(argv, { repoRoot, log }) {
  if (argv.includes('--help') || argv.includes('-h')) {
    log(planReviewHelp());
    return 0;
  }

  const options = parsePlanReviewArgs(argv);
  const prdPath = await resolvePrdPath({ repoRoot, file: options.file });
  const planPaths = resolvePlanPaths(repoRoot, prdPath);
  const plan = await readPlan(planPaths.planPath);

  if (!plan) {
    throw new Error('No YAML plan found. Run `yarn agent run --file <prd.md>` first.');
  }

  const result = await runPlanReview({
    repoRoot,
    prdPath,
    relativePrdPath: path.relative(repoRoot, prdPath),
    planPaths,
    verboseJson: options.verboseJson,
    signal: undefined,
    log,
  });

  if (options.dryRun) {
    await writePlan(planPaths.planPath, plan);
    log('[agent] plan review dry-run restored the original YAML plan.');
  }

  return result.review.verdict === 'blocked' ? 1 : 0;
}

function parsePlanReviewArgs(argv) {
  const options = {
    file: null,
    dryRun: false,
    verboseJson: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--file' || arg === '-f') {
      options.file = argv[++index];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--verbose-json') {
      options.verboseJson = true;
    } else {
      throw new Error(`Unknown plan-review option: ${arg}`);
    }
  }

  return options;
}

async function resolvePrdPath({ repoRoot, file }) {
  if (file) {
    return path.resolve(repoRoot, file);
  }

  const state = await readRunnerState(resolveStatePaths(repoRoot, repoRoot).statePath);

  if (!state?.prdPath) {
    throw new Error('No previous agent run found. Pass --file <prd.md>.');
  }

  return path.resolve(repoRoot, state.prdPath);
}

function planReviewHelp() {
  return `Usage: yarn agent plan-review [--file <prd.md>]

Reevaluate the YAML execution plan against the Markdown PRD and clean stale plan notes.

Options:
  --file, -f <path>  Markdown PRD file to review. Defaults to the last run.
  --dry-run          Run review, print result, then restore the original plan.
  --verbose-json     Print raw Codex JSON events.`;
}
