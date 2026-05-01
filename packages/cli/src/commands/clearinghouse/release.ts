/**
 * cc-cli clearinghouse release — call workflow.releaseAll.
 *
 * Bare cleanup — releases the lock + removes the worktree. No chit
 * changes. Used by the agent on graceful exit paths where the
 * submission state has already been written by an earlier primitive,
 * or where the agent decided to abandon the walk without a terminal
 * state (e.g. realized mid-walk that another Pressman is better
 * positioned to handle this submission).
 */

import { parseArgs } from 'node:util';
import { releaseAll } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  worktree?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdClearinghouseRelease(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <pressman-slug> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = await releaseAll({
    corpRoot,
    slug: opts.from!,
    ...(opts.worktree ? { worktreePath: opts.worktree } : {}),
  });

  if (opts.json) {
    if (result.ok) console.log(JSON.stringify({ ok: true }, null, 2));
    else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`release: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  console.log('lock released' + (opts.worktree ? ` + worktree ${opts.worktree} cleaned.` : '.'));
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      worktree: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli clearinghouse release: ${msg}`);
  process.exit(1);
}
