/**
 * cc-cli editor approve — call workflow.approveReview.
 *
 * Editor's pass-the-review exit. Fires enterClearance with
 * reviewBypassed=false, clears review state on success. The
 * submission then enters Pressman's lane and merges via
 * patrol/clearing.
 */

import { parseArgs } from 'node:util';
import { approveReview } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  task?: string;
  worktree?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdEditorApprove(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <editor-slug> required');
  if (!opts.task) fail('--task <chit-id> required');
  if (!opts.worktree) fail('--worktree <path> required (cwd for git push)');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = await approveReview({
    corpRoot,
    taskId: opts.task!,
    reviewerSlug: opts.from!,
    worktreePath: opts.worktree!,
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
    console.error(`approve: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  console.log(`approved task ${opts.task} — submission ${result.value.submissionId} created.`);
  if (result.value.pushedSha) console.log(`  pushedSha: ${result.value.pushedSha}`);
  console.log(`  reviewRound: ${result.value.reviewRound} prior rejections.`);
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      task: { type: 'string' },
      worktree: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli editor approve: ${msg}`);
  process.exit(1);
}
