/**
 * cc-cli editor bypass — call workflow.bypassReview.
 *
 * Editor's explicit self-bypass. Sets capHit, fires enterClearance
 * with reviewBypassed=true. Rare — typical bypass comes from the
 * audit layer when the cap is reached automatically.
 */

import { parseArgs } from 'node:util';
import { bypassReview } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  task?: string;
  reason?: string;
  worktree?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdEditorBypass(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <editor-slug> required');
  if (!opts.task) fail('--task <chit-id> required');
  if (!opts.reason) fail('--reason "..." required');
  if (!opts.worktree) fail('--worktree <path> required (cwd for git push)');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = await bypassReview({
    corpRoot,
    taskId: opts.task!,
    reviewerSlug: opts.from!,
    reason: opts.reason!,
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
    console.error(`bypass: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  console.log(`bypassed task ${opts.task} — submission ${result.value.submissionId} created with reviewBypassed=true.`);
  if (result.value.pushedSha) console.log(`  pushedSha: ${result.value.pushedSha}`);
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      task: { type: 'string' },
      reason: { type: 'string' },
      worktree: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli editor bypass: ${msg}`);
  process.exit(1);
}
