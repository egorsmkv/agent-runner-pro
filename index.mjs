#!/usr/bin/env node

import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { appendAgentErrorLog, isInterruptError } from './actions/errors/index.mjs';
import { createReporter } from './actions/reporter/index.mjs';
import { readRecoverableRunnerState } from './actions/state/index.mjs';
import { planReviewCommand } from './commands/plan-review/index.mjs';
import { resumeCommand } from './commands/resume/index.mjs';
import { runCommand } from './commands/run/index.mjs';

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  mainWithCrashResume(process.argv.slice(2))
    .then((exitCode) => {
      if (typeof exitCode === 'number') {
        process.exitCode = exitCode;
      }
    })
    .catch((error) => {
      console.error(error?.stack ?? String(error));
      process.exitCode = 1;
    });
}

async function mainWithCrashResume(argv) {
  try {
    return await main(argv);
  } catch (error) {
    const repoRoot = process.cwd();

    if (isInterruptError(error)) {
      return 130;
    }

    await appendAgentErrorLog({
      repoRoot,
      command: `yarn agent ${argv.join(' ')}`,
      error,
    });

    if (!(await shouldAutoResume({ repoRoot, argv, error }))) {
      throw error;
    }

    const reporter = createReporter();
    reporter('[agent] runner crashed; logged .agent/error.log and restarting with resume once.');

    try {
      return await main(['resume', ...resumeFlags(argv)]);
    } catch (resumeError) {
      await appendAgentErrorLog({
        repoRoot,
        command: `yarn agent resume ${resumeFlags(argv).join(' ')}`,
        error: resumeError,
        phase: 'resume-crash',
      });
      throw resumeError;
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...commandArgs] = argv;
  const reporter = createReporter();
  const context = {
    repoRoot: process.cwd(),
    log: reporter,
  };

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  if (command === 'run') {
    return await runCommand(commandArgs, context);
  }

  if (command === 'resume') {
    return await resumeCommand(commandArgs, context);
  }

  if (command === 'plan-review') {
    return await planReviewCommand(commandArgs, context);
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`Usage:
  yarn agent run --file <prd.md>
  yarn agent resume
  yarn agent plan-review

Commands:
  run       Start over from a Markdown PRD, regenerate the YAML plan, then execute scopes.
  resume    Continue the previous interrupted run from saved YAML/state.
  plan-review
            Reevaluate YAML plan coverage against the Markdown PRD.

Options:
  --once          Complete at most one scope.
  --verbose-json  Print raw Codex JSONL events.

Codex model:
  Fixed to gpt-5.4 with medium reasoning.

Execution:
  Source edits run in .agent/worktrees/<prd-slug> on branch agent/<prd-slug>.
`);
}

async function shouldAutoResume({ repoRoot, argv, error }) {
  const command = argv[0];

  if (!['run', 'resume'].includes(command) || argv.includes('--help') || argv.includes('-h')) {
    return false;
  }

  if (isInterruptError(error)) {
    return false;
  }

  const state = await readRecoverableRunnerState(repoRoot);
  return Boolean(state?.prdPath);
}

function resumeFlags(argv) {
  return argv.filter((arg) => arg === '--once' || arg === '--verbose-json');
}
