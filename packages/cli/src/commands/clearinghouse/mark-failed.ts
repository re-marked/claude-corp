/**
 * cc-cli clearinghouse mark-failed — call workflow.markFailedAndRelease.
 *
 * Two flavors driven by --requeue:
 *
 *   default: terminal-fail. Submission marked failed; task cascades
 *     to failed; lock + worktree released. Used for sanity-failed,
 *     branch-deleted, fatal-rebase, fatal-merge, inconclusive-tests.
 *
 *   --requeue: push-race re-queue. Increments retryCount; if under
 *     PRESSMAN_RETRY_CAP, flips back to 'queued' for the next pick.
 *     If at cap, terminal-fails with a "retry cap exhausted" reason.
 *     Used after merge race outcome.
 */

import { parseArgs } from 'node:util';
import { markFailedAndRelease } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  submission?: string;
  reason?: string;
  requeue?: boolean;
  worktree?: string;
  narrative?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdClearinghouseMarkFailed(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <pressman-slug> required');
  if (!opts.submission) fail('--submission <chit-id> required');
  if (!opts.reason) fail('--reason "..." required');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = await markFailedAndRelease({
    corpRoot,
    submissionId: opts.submission!,
    reason: opts.reason!,
    slug: opts.from!,
    requeue: opts.requeue === true,
    ...(opts.worktree ? { worktreePath: opts.worktree } : {}),
    ...(opts.narrative ? { narrative: opts.narrative } : {}),
  });

  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, ...result.value }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`mark-failed: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  if (result.value.requeued) {
    console.log(`re-queued ${opts.submission} (retryCount=${result.value.retryCount}); lock + worktree released.`);
  } else {
    console.log(`failed ${opts.submission}; lock + worktree released.`);
  }
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      submission: { type: 'string' },
      reason: { type: 'string' },
      requeue: { type: 'boolean' },
      worktree: { type: 'string' },
      narrative: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli clearinghouse mark-failed: ${msg}`);
  process.exit(1);
}
