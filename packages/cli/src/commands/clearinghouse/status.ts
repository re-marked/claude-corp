/**
 * cc-cli clearinghouse status — admin/debug snapshot of the lane.
 *
 * Shows the lock holder, queue depth, and a small recent-window of
 * submissions (any non-queued state, capped at 10). Composes
 * readClearinghouseLock + rankQueue + queryChits — no daemon
 * round-trip needed.
 *
 * Full forensic views (per-submission timeline, escalation chain)
 * land in 1.12.3 as `cc-cli clearinghouse show <id>`. This is the
 * "what's happening right now?" surface.
 */

import { parseArgs } from 'node:util';
import {
  rankQueue,
  readClearinghouseLock,
  queryChits,
  type Chit,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

interface Opts {
  corp?: string;
  json?: boolean;
}

const RECENT_WINDOW = 10;

export async function cmdClearinghouseStatus(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  const corpRoot = await getCorpRoot(opts.corp);

  const lock = readClearinghouseLock(corpRoot);
  const queue = rankQueue(corpRoot);

  // Pull all clearance-submissions, sorted by updatedAt desc, drop
  // the queued ones (those are visible via `queue`), keep top N.
  let allSubs: ReturnType<typeof queryChits<'clearance-submission'>>;
  try {
    allSubs = queryChits<'clearance-submission'>(corpRoot, {
      types: ['clearance-submission'],
      scopes: ['corp'],
    });
  } catch {
    allSubs = { chits: [] } as unknown as ReturnType<typeof queryChits<'clearance-submission'>>;
  }
  const nonQueued = allSubs.chits
    .map((c) => c.chit as Chit<'clearance-submission'>)
    .filter((c) => c.fields['clearance-submission'].submissionStatus !== 'queued')
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, RECENT_WINDOW);

  if (opts.json) {
    console.log(JSON.stringify({
      lock,
      queue: queue.map((q) => ({
        submissionId: q.chit.id,
        branch: q.chit.fields['clearance-submission'].branch,
        priority: q.chit.fields['clearance-submission'].priority,
        retryCount: q.chit.fields['clearance-submission'].retryCount,
        score: q.score,
      })),
      recent: nonQueued.map((c) => ({
        submissionId: c.id,
        branch: c.fields['clearance-submission'].branch,
        submissionStatus: c.fields['clearance-submission'].submissionStatus,
        processingBy: c.fields['clearance-submission'].processingBy,
        mergeCommitSha: c.fields['clearance-submission'].mergeCommitSha,
        lastFailureReason: c.fields['clearance-submission'].lastFailureReason,
        updatedAt: c.updatedAt,
      })),
    }, null, 2));
    return;
  }

  console.log('clearinghouse status');
  console.log('');
  console.log('Lock:');
  if (lock.heldBy) {
    console.log(`  held by: ${lock.heldBy}`);
    console.log(`  on:      ${lock.submissionId}`);
    console.log(`  since:   ${lock.claimedAt}`);
  } else {
    console.log('  free');
  }
  console.log('');
  console.log(`Queue: ${queue.length} submission(s)`);
  for (const q of queue.slice(0, 10)) {
    const f = q.chit.fields['clearance-submission'];
    console.log(`  [score ${q.score.toFixed(0)}] ${q.chit.id}  ${f.branch}  (${f.priority}, retries=${f.retryCount})`);
  }
  if (queue.length > 10) {
    console.log(`  ...and ${queue.length - 10} more`);
  }
  console.log('');
  console.log(`Recent (non-queued, top ${RECENT_WINDOW}):`);
  if (nonQueued.length === 0) {
    console.log('  (none)');
  } else {
    for (const c of nonQueued) {
      const f = c.fields['clearance-submission'];
      const tag = f.submissionStatus === 'merged'
        ? `merged ${f.mergeCommitSha?.slice(0, 8) ?? '?'}`
        : f.submissionStatus === 'processing'
          ? `processing by ${f.processingBy ?? '?'}`
          : f.submissionStatus;
      console.log(`  ${c.id}  ${f.branch}  [${tag}]`);
      if (f.lastFailureReason) console.log(`    reason: ${f.lastFailureReason}`);
    }
  }
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values;
}
