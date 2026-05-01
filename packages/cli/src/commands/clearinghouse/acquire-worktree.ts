/**
 * cc-cli clearinghouse acquire-worktree — call workflow.acquireWorktree.
 *
 * Ensures an isolated worktree exists at a deterministic path keyed
 * off the submission id. Idempotent on the path (safe to retry);
 * the branch checkout is recreated fresh on every call.
 */

import { parseArgs } from 'node:util';
import { acquireWorktree } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  submission?: string;
  branch?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdClearinghouseAcquireWorktree(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <pressman-slug> required');
  if (!opts.submission) fail('--submission <chit-id> required');
  if (!opts.branch) fail('--branch <name> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = await acquireWorktree({
    corpRoot,
    submissionId: opts.submission!,
    branch: opts.branch!,
  });

  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, worktree: result.value }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`acquire-worktree failed: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  console.log(`worktree ready: ${result.value.path}`);
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      submission: { type: 'string' },
      branch: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli clearinghouse acquire-worktree: ${msg}`);
  process.exit(1);
}
