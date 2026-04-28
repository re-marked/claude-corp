/**
 * cc-cli editor reject — call workflow.rejectReview.
 *
 * Editor's needs-more-work exit. Increments task.editorReviewRound,
 * sets capHit if at the role's cap, files an escalation chit
 * routing to the author's role via Hand 1.4.1, clears the claim.
 */

import { parseArgs } from 'node:util';
import { rejectReview } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  task?: string;
  reason?: string;
  detail?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdEditorReject(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <editor-slug> required');
  if (!opts.task) fail('--task <chit-id> required');
  if (!opts.reason) fail('--reason "..." required (one-line summary)');
  if (!opts.detail) fail('--detail "..." required (pedagogical body for the escalation)');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = rejectReview({
    corpRoot,
    taskId: opts.task!,
    reviewerSlug: opts.from!,
    reason: opts.reason!,
    detail: opts.detail!,
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
    console.error(`reject: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  console.log(`rejected task ${opts.task} — escalation ${result.value.escalationId}`);
  console.log(`  newRound: ${result.value.newRound}${result.value.capHit ? ' (cap hit; next audit will bypass)' : ''}`);
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      task: { type: 'string' },
      reason: { type: 'string' },
      detail: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli editor reject: ${msg}`);
  process.exit(1);
}
