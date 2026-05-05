import { access } from 'node:fs/promises';
import path from 'node:path';

import { runWorkflow } from '../../actions/run/index.mjs';

export async function runCommand(argv, { repoRoot, log }) {
  if (argv.includes('--help') || argv.includes('-h')) {
    log(runHelp());
    return 0;
  }

  const options = parseRunArgs(argv);
  const prdPath = path.resolve(repoRoot, options.file);

  await validatePrdPath(prdPath);

  return await runWorkflow({
    repoRoot,
    prdPath,
    regeneratePlan: true,
    once: options.once,
    parallelLimit: options.parallelLimit,
    verboseJson: options.verboseJson,
    log,
  });
}

function parseRunArgs(argv) {
  const options = {
    file: null,
    once: false,
    parallelLimit: 1,
    verboseJson: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--file' || arg === '-f') {
      options.file = argv[++index];
    } else if (arg === '--once') {
      options.once = true;
    } else if (arg === '--parallel') {
      options.parallelLimit = Number(argv[++index] ?? 1);
    } else if (arg === '--verbose-json') {
      options.verboseJson = true;
    } else {
      throw new Error(`Unknown run option: ${arg}`);
    }
  }

  if (!options.file) {
    throw new Error('Usage: yarn agent run --file <prd.md>');
  }

  return options;
}

function runHelp() {
  return `Usage: yarn agent run --file <prd.md>

Start a PRD from Markdown source of truth, generate structured YAML state, and run scopes until completion.

Options:
  --file, -f <path>  Markdown PRD file to execute.
  --once             Run one scope and exit.
  --parallel <n>     Run up to n independent scopes in parallel.
  --verbose-json     Print raw Codex JSON events.

Execution:
  Source edits run in .agent/worktrees/<prd-slug> on branch agent/<prd-slug>.`;
}

async function validatePrdPath(prdPath) {
  if (path.extname(prdPath) !== '.md') {
    throw new Error('PRD path must point to a Markdown file.');
  }

  await access(prdPath);
}
