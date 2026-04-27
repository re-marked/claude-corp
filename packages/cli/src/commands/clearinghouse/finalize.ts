/**
 * cc-cli clearinghouse finalize — call workflow.finalizeMerged.
 *
 * On clean merge: cascades the submission to merged, advances the
 * task workflow `clearance → completed`, advances the contract if
 * all sibling tasks are done, releases the lock, removes the
 * worktree.
 */

import { parseArgs } from 'node:util';
import { finalizeMerged } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  submission?: string;
  'merge-sha'?: string;
  worktree?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdClearinghouseFinalize(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <pressman-slug> required');
  if (!opts.submission) fail('--submission <chit-id> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = await finalizeMerged({
    corpRoot,
    submissionId: opts.submission!,
    slug: opts.from!,
    ...(opts['merge-sha'] ? { mergeCommitSha: opts['merge-sha'] } : {}),
    ...(opts.worktree ? { worktreePath: opts.worktree } : {}),
  });

  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`finalize: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  console.log(`finalized ${opts.submission} (lock released, worktree cleaned).`);
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      submission: { type: 'string' },
      'merge-sha': { type: 'string' },
      worktree: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values as Opts;
}

function fail(msg: string): never {
  console.error(`cc-cli clearinghouse finalize: ${msg}`);
  process.exit(1);
}
