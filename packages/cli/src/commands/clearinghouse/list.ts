/**
 * cc-cli clearinghouse list — paginated submission browser.
 *
 * Project 1.12.3 — for forensic browse across time. Mirrors
 * `cc-cli breaker list`'s shape: filter by status, role, time
 * window; default shows active submissions; --include-merged
 * widens to historical merges. The status command (1.12.1) shows
 * the right-now snapshot; this is the time-traveler's surface.
 */

import { parseArgs } from 'node:util';
import {
  queryChits,
  readConfig,
  MEMBERS_JSON,
  type Chit,
  type Member,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

interface Opts {
  status?: string;
  role?: string;
  'include-merged'?: boolean;
  'include-failed'?: boolean;
  since?: string;
  until?: string;
  limit?: string;
  corp?: string;
  json?: boolean;
}

const VALID_STATUSES = new Set(['queued', 'processing', 'merged', 'conflict', 'rejected', 'failed', 'flake-suspected']);

export async function cmdClearinghouseList(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  const corpRoot = await getCorpRoot(opts.corp);

  if (opts.status && !VALID_STATUSES.has(opts.status)) {
    console.error(`list: --status must be one of ${Array.from(VALID_STATUSES).join(' | ')}`);
    process.exit(1);
  }

  let result: ReturnType<typeof queryChits<'clearance-submission'>>;
  try {
    result = queryChits<'clearance-submission'>(corpRoot, {
      types: ['clearance-submission'],
      scopes: ['corp'],
    });
  } catch (err) {
    console.error(`list: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let submissions = result.chits.map((c) => c.chit as Chit<'clearance-submission'>);

  // Status filter — explicit status takes precedence; otherwise
  // default-active (queued/processing/conflict). Include flags
  // widen to terminal states.
  if (opts.status) {
    submissions = submissions.filter((s) => s.fields['clearance-submission'].submissionStatus === opts.status);
  } else {
    const include = new Set(['queued', 'processing', 'conflict']);
    if (opts['include-merged']) include.add('merged');
    if (opts['include-failed']) {
      include.add('failed');
      include.add('rejected');
    }
    submissions = submissions.filter((s) => include.has(s.fields['clearance-submission'].submissionStatus));
  }

  // Role filter — resolve role's slugs from members.json, match
  // submitter against that set.
  if (opts.role) {
    const slugs = new Set<string>();
    try {
      const members = readConfig<Member[]>(`${corpRoot}/${MEMBERS_JSON}`);
      for (const m of members) if (m.role === opts.role) slugs.add(m.id);
    } catch { /* empty set yields no-match */ }
    submissions = submissions.filter((s) => slugs.has(s.fields['clearance-submission'].submitter));
  }

  // Time window — applied against submittedAt for chronological
  // bounds (not chit.createdAt; submittedAt is the canonical lane
  // entry timestamp).
  if (opts.since) {
    submissions = submissions.filter((s) => s.fields['clearance-submission'].submittedAt >= opts.since!);
  }
  if (opts.until) {
    submissions = submissions.filter((s) => s.fields['clearance-submission'].submittedAt <= opts.until!);
  }

  submissions.sort((a, b) =>
    (b.fields['clearance-submission'].submittedAt ?? '').localeCompare(
      a.fields['clearance-submission'].submittedAt ?? '',
    ),
  );

  const limit = opts.limit ? parseInt(opts.limit, 10) : 50;
  if (Number.isFinite(limit) && limit > 0) {
    submissions = submissions.slice(0, limit);
  }

  if (opts.json) {
    console.log(JSON.stringify({
      submissions: submissions.map((s) => ({
        id: s.id,
        ...s.fields['clearance-submission'],
        chitStatus: s.status,
      })),
    }, null, 2));
    return;
  }

  if (submissions.length === 0) {
    console.log('(no submissions match)');
    return;
  }

  console.log(`${submissions.length} submission(s):`);
  console.log('');
  for (const s of submissions) {
    const f = s.fields['clearance-submission'];
    console.log(`  ${s.id}`);
    console.log(`    branch:    ${f.branch}`);
    console.log(`    submitter: ${f.submitter}`);
    console.log(`    status:    ${f.submissionStatus}`);
    console.log(`    priority:  ${f.priority}`);
    console.log(`    retries:   ${f.retryCount}`);
    if (f.reviewBypassed) console.log(`    bypassed:  true (Editor cap-hit)`);
    if (f.mergeCommitSha) console.log(`    sha:       ${f.mergeCommitSha.slice(0, 8)}`);
    if (f.lastFailureReason) console.log(`    reason:    ${f.lastFailureReason}`);
    console.log(`    submitted: ${f.submittedAt}`);
    console.log('');
  }
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      status: { type: 'string' },
      role: { type: 'string' },
      'include-merged': { type: 'boolean' },
      'include-failed': { type: 'boolean' },
      since: { type: 'string' },
      until: { type: 'string' },
      limit: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values as Opts;
}
