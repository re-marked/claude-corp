/**
 * cc-cli editor pick — call workflow.pickNextReview.
 *
 * Finds + claims the next review-eligible task for this Editor.
 * Returns the picked task (or null when nothing's ready).
 */

import { parseArgs } from 'node:util';
import { pickNextReview } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface Opts {
  from?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdEditorPick(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <editor-slug> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = pickNextReview({ corpRoot, editorSlug: opts.from! });

  if (opts.json) {
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, picked: result.value }, null, 2));
    } else {
      console.log(JSON.stringify({ ok: false, failure: result.failure }, null, 2));
      process.exit(1);
    }
    return;
  }

  if (!result.ok) {
    console.error(`pick failed: ${result.failure.pedagogicalSummary}`);
    process.exit(1);
  }
  if (result.value === null) {
    console.log('no review-eligible tasks (or all claimed by others).');
    return;
  }
  const p = result.value;
  console.log(`${p.resumed ? 'resumed' : 'claimed'} task ${p.taskId}`);
  console.log(`  branch:    ${p.branch}`);
  console.log(`  contract:  ${p.contractId ?? '(none — standalone)'}`);
  console.log(`  submitter: ${p.submitter}`);
  console.log(`  priority:  ${p.priority}`);
  console.log(`  round:     ${p.currentRound} prior rejections (this is round ${p.currentRound + 1})`);
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}

function fail(msg: string): never {
  console.error(`cc-cli editor pick: ${msg}`);
  process.exit(1);
}
