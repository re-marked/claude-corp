/**
 * cc-cli clearinghouse test — call workflow.testStep.
 *
 * Runs the corp's test command with one flake retry. Classifies the
 * outcome as passed-first / flake / consistent-fail / inconclusive.
 * Agent decides next-step from `classifiedAs`.
 */

import { parseArgs } from 'node:util';
import { testStep } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  submission?: string;
  worktree?: string;
  command?: string;
  'max-retries'?: string;
  narrative?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdClearinghouseTest(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <pressman-slug> required');
  if (!opts.submission) fail('--submission <chit-id> required');
  if (!opts.worktree) fail('--worktree <path> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const maxRetries = opts['max-retries'] !== undefined ? parseInt(opts['max-retries'], 10) : undefined;
  if (maxRetries !== undefined && (!Number.isFinite(maxRetries) || maxRetries < 0)) {
    fail(`--max-retries must be a non-negative integer, got "${opts['max-retries']}"`);
  }
  const result = await testStep({
    corpRoot,
    submissionId: opts.submission!,
    worktreePath: opts.worktree!,
    emittedBy: opts.from!,
    ...(opts.command ? { testCommand: opts.command } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(opts.narrative ? { narrative: opts.narrative } : {}),
  });

  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, test: result.value }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`test failed: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  const r = result.value;
  console.log(`test classified: ${r.classifiedAs}`);
  console.log(`  runs:         ${r.allRuns.length}`);
  console.log(`  final:        ${r.finalRun.outcome} (${r.finalRun.durationMs}ms)`);
  if (r.finalRun.failures.length > 0) {
    console.log(`  failures:`);
    for (const f of r.finalRun.failures.slice(0, 10)) {
      console.log(`    - ${f.name}`);
    }
    if (r.finalRun.failures.length > 10) {
      console.log(`    ...and ${r.finalRun.failures.length - 10} more`);
    }
  }
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      submission: { type: 'string' },
      worktree: { type: 'string' },
      command: { type: 'string' },
      'max-retries': { type: 'string' },
      narrative: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values as Opts;
}

function fail(msg: string): never {
  console.error(`cc-cli clearinghouse test: ${msg}`);
  process.exit(1);
}
