/**
 * cc-cli clearinghouse pick — call workflow.pickNext.
 *
 * Reads the queue + lock, claims the top submission for this
 * Pressman, flips submissionStatus to 'processing'. Returns the
 * picked submission (or `null` when nothing's ready).
 */

import { parseArgs } from 'node:util';
import { pickNext } from '@claudecorp/daemon';
import { getCorpRoot } from '../../client.js';

interface PickOpts {
  from?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdClearinghousePick(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  if (!opts.from) fail('--from <pressman-slug> required');

  const corpRoot = await getCorpRoot(opts.corp);
  const result = pickNext({ corpRoot, pressmanSlug: opts.from! });

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
    console.log('queue empty (or lock held by another Pressman).');
    return;
  }
  const p = result.value;
  console.log(`${p.resumed ? 'resumed' : 'picked'} ${p.submissionId}`);
  console.log(`  branch:    ${p.branch}`);
  console.log(`  task:      ${p.taskId}`);
  console.log(`  contract:  ${p.contractId}`);
  console.log(`  submitter: ${p.submitter}`);
  console.log(`  priority:  ${p.priority}`);
  if (p.score !== undefined) console.log(`  score:     ${p.score.toFixed(0)}`);
  if (p.retryCount > 0) console.log(`  retries:   ${p.retryCount}`);
}

function parseOpts(rawArgs: string[]): PickOpts {
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
  console.error(`cc-cli clearinghouse pick: ${msg}`);
  process.exit(1);
}
