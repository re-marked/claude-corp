/**
 * cc-cli editor release — call workflow.releaseReview.
 *
 * Bare claim release. No chit changes. Used on graceful exit when
 * Editor decides to abandon the task without filing comments,
 * approving, or rejecting (e.g. realized mid-walk that another
 * Editor is better positioned). Next pick will re-claim.
 */

import { parseArgs } from 'node:util';
import { releaseReview } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  task?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdEditorRelease(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <editor-slug> required');
  if (!opts.task) fail('--task <chit-id> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = releaseReview({
    corpRoot,
    taskId: opts.task!,
    reviewerSlug: opts.from!,
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
  console.log(`released claim on task ${opts.task}.`);
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      task: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli editor release: ${msg}`);
  process.exit(1);
}
