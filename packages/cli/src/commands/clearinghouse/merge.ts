/**
 * cc-cli clearinghouse merge — call workflow.mergeStep.
 *
 * Pushes the (rebased) PR branch to origin. Returns MergeAttemptResult
 * with one of merged / race / hook-rejected / branch-deleted / fatal.
 * Agent branches: merged → finalize; race → mark-failed --requeue;
 * hook-rejected → file-blocker; branch-deleted/fatal → mark-failed.
 */

import { parseArgs } from 'node:util';
import { mergeStep } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  submission?: string;
  worktree?: string;
  branch?: string;
  narrative?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdClearinghouseMerge(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <pressman-slug> required');
  if (!opts.submission) fail('--submission <chit-id> required');
  if (!opts.worktree) fail('--worktree <path> required');
  if (!opts.branch) fail('--branch <name> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = await mergeStep({
    corpRoot,
    submissionId: opts.submission!,
    worktreePath: opts.worktree!,
    branch: opts.branch!,
    emittedBy: opts.from!,
    ...(opts.narrative ? { narrative: opts.narrative } : {}),
  });

  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, merge: result.value }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`merge failed: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  const m = result.value;
  console.log(`merge outcome: ${m.outcome}`);
  if (m.mergeCommitSha) console.log(`  sha:    ${m.mergeCommitSha}`);
  if (m.outcome === 'hook-rejected' && m.hookOutput) {
    console.log(`  hook output:`);
    for (const line of m.hookOutput.split('\n')) console.log(`    ${line}`);
  }
  if (m.failureRecord) {
    console.log(`  reason: ${m.failureRecord.pedagogicalSummary}`);
    console.log(`  route:  ${m.failureRecord.route}`);
  }
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      submission: { type: 'string' },
      worktree: { type: 'string' },
      branch: { type: 'string' },
      narrative: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli clearinghouse merge: ${msg}`);
  process.exit(1);
}
