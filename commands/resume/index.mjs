import path from 'node:path';

import { runWorkflow } from '../../actions/run/index.mjs';
import { readRecoverableRunnerState } from '../../actions/state/index.mjs';

export async function resumeCommand(argv, { repoRoot, log }) {
  if (argv.includes('--help') || argv.includes('-h')) {
    log(resumeHelp());
    return 0;
  }

  const options = parseResumeArgs(argv);
  const state = await readRecoverableRunnerState(repoRoot);

  if (!state?.prdPath) {
    throw new Error('No previous agent run found. Use `yarn agent run --file <prd.md>` first.');
  }

  if (!state.interrupted) {
    log('[agent] previous run was not marked interrupted; continuing from saved state anyway.');
  }

  return await runWorkflow({
    repoRoot,
    prdPath: path.resolve(repoRoot, state.prdPath),
    regeneratePlan: false,
    once: options.once,
    parallelLimit: options.parallelLimit,
    verboseJson: options.verboseJson,
    log,
  });
}

function parseResumeArgs(argv) {
  const options = {
    once: false,
    parallelLimit: 1,
    verboseJson: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--once') {
      options.once = true;
    } else if (arg === '--parallel') {
      options.parallelLimit = Number(argv[++index] ?? 1);
    } else if (arg === '--verbose-json') {
      options.verboseJson = true;
    } else {
      throw new Error(`Unknown resume option: ${arg}`);
    }
  }

  return options;
}

function resumeHelp() {
  return `Usage: yarn agent resume

Continue the last interrupted PRD run from saved YAML state.

Options:
  --once          Run one scope and exit.
  --parallel <n>  Run up to n independent scopes in parallel.
  --verbose-json  Print raw Codex JSON events.

Execution:
  Source edits continue in .agent/worktrees/<prd-slug> on branch agent/<prd-slug>.`;
}
