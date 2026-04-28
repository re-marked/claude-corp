/**
 * cc-cli clearinghouse show <submission-id> — forensic per-submission view.
 *
 * Project 1.12.3 — drills into one submission. Renders:
 *   - Submission summary (branch, submitter, status, retries, merge sha)
 *   - Lane-event timeline for this submission (full journey including
 *     intermediate rebase / test / merge events)
 *   - Linked review-comments grouped by category + severity
 *   - Linked escalation chits (if any)
 *
 * Replaces "grep through chits manually" with one call. Same
 * data shape as `cc-cli clearinghouse log --replay <id>` for the
 * timeline; this view adds the comment + escalation joins.
 */

import { parseArgs } from 'node:util';
import {
  findChitById,
  queryChits,
  type Chit,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

interface Opts {
  corp?: string;
  json?: boolean;
}

export async function cmdClearinghouseShow(rawArgs: string[]): Promise<void> {
  const positionals = parseArgs({
    args: rawArgs,
    options: { corp: { type: 'string' }, json: { type: 'boolean' } },
    allowPositionals: true,
  });
  const submissionId = positionals.positionals[0];
  if (!submissionId) {
    console.error('cc-cli clearinghouse show: <submission-id> required');
    process.exit(1);
  }
  const opts = positionals.values as Opts;
  const corpRoot = await getCorpRoot(opts.corp);

  const subHit = findChitById(corpRoot, submissionId);
  if (!subHit || subHit.chit.type !== 'clearance-submission') {
    console.error(`show: submission ${submissionId} not found`);
    process.exit(1);
  }
  const sub = subHit.chit as Chit<'clearance-submission'>;
  const f = sub.fields['clearance-submission'];

  // Pull the lane-event timeline for this submission.
  let events: Chit<'lane-event'>[] = [];
  try {
    const result = queryChits<'lane-event'>(corpRoot, {
      types: ['lane-event'],
      scopes: ['corp'],
    });
    events = result.chits
      .map((c) => c.chit as Chit<'lane-event'>)
      .filter((e) =>
        e.fields['lane-event'].submissionId === submissionId
        || e.fields['lane-event'].taskId === f.taskId,
      )
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  } catch { /* empty timeline */ }

  // Pull review-comments for this task.
  let comments: Chit<'review-comment'>[] = [];
  try {
    const result = queryChits<'review-comment'>(corpRoot, {
      types: ['review-comment'],
      scopes: ['corp'],
    });
    comments = result.chits
      .map((c) => c.chit as Chit<'review-comment'>)
      .filter((c) => c.fields['review-comment'].taskId === f.taskId);
  } catch { /* empty */ }

  // Pull escalations originating from this submission or task.
  let escalations: Chit<'escalation'>[] = [];
  try {
    const result = queryChits<'escalation'>(corpRoot, {
      types: ['escalation'],
      scopes: ['corp'],
    });
    escalations = result.chits
      .map((c) => c.chit as Chit<'escalation'>)
      .filter((e) =>
        e.fields.escalation.originatingChit === submissionId
        || e.fields.escalation.originatingChit === f.taskId,
      );
  } catch { /* empty */ }

  if (opts.json) {
    console.log(JSON.stringify({
      submission: { id: sub.id, ...f, chitStatus: sub.status },
      timeline: events.map((e) => ({
        id: e.id,
        createdAt: e.createdAt,
        kind: e.fields['lane-event'].kind,
        emittedBy: e.fields['lane-event'].emittedBy,
        narrative: e.fields['lane-event'].narrative ?? null,
        payload: e.fields['lane-event'].payload ?? null,
      })),
      comments: comments.map((c) => ({ id: c.id, ...c.fields['review-comment'] })),
      escalations: escalations.map((e) => ({ id: e.id, ...e.fields.escalation })),
    }, null, 2));
    return;
  }

  // Prose view.
  console.log(`submission ${sub.id}`);
  console.log(`  branch:    ${f.branch}`);
  console.log(`  task:      ${f.taskId}`);
  console.log(`  contract:  ${f.contractId}`);
  console.log(`  submitter: ${f.submitter}`);
  console.log(`  status:    ${f.submissionStatus} (chit: ${sub.status})`);
  console.log(`  priority:  ${f.priority}`);
  console.log(`  retries:   ${f.retryCount}`);
  console.log(`  bypassed:  ${f.reviewBypassed ?? false}`);
  if (f.mergeCommitSha) console.log(`  sha:       ${f.mergeCommitSha}`);
  if (f.lastFailureReason) console.log(`  reason:    ${f.lastFailureReason}`);
  console.log(`  submitted: ${f.submittedAt}`);
  if (f.mergedAt) console.log(`  merged:    ${f.mergedAt}`);
  console.log('');

  if (events.length > 0) {
    console.log(`Timeline (${events.length} event(s)):`);
    for (const e of events) {
      const ef = e.fields['lane-event'];
      const t = (e.createdAt ?? '').slice(11, 19);
      const by = ef.emittedBy ? `by ${ef.emittedBy}` : '(daemon)';
      const narrative = ef.narrative ? `\n      "${ef.narrative}"` : '';
      console.log(`  ${t}  ${ef.kind} ${by}${narrative}`);
    }
    console.log('');
  }

  if (comments.length > 0) {
    const blockers = comments.filter((c) => c.fields['review-comment'].severity === 'blocker');
    const suggestions = comments.filter((c) => c.fields['review-comment'].severity === 'suggestion');
    const nits = comments.filter((c) => c.fields['review-comment'].severity === 'nit');
    console.log(`Review comments (${comments.length} total — ${blockers.length} blocker, ${suggestions.length} suggestion, ${nits.length} nit):`);
    const groupByCat = (cs: Chit<'review-comment'>[]) => {
      const bug = cs.filter((c) => c.fields['review-comment'].category === 'bug');
      const drift = cs.filter((c) => c.fields['review-comment'].category === 'drift');
      return { bug, drift };
    };
    for (const [label, cs] of [['Blockers', blockers], ['Suggestions', suggestions], ['Nits', nits]] as const) {
      if (cs.length === 0) continue;
      console.log(`  ${label}:`);
      const { bug, drift } = groupByCat(cs);
      for (const [cat, list] of [['bug', bug], ['drift', drift]] as const) {
        for (const c of list) {
          const cf = c.fields['review-comment'];
          console.log(`    [${cat}] ${cf.filePath}:${cf.lineStart}${cf.lineEnd !== cf.lineStart ? `-${cf.lineEnd}` : ''}  round ${cf.reviewRound}`);
          console.log(`      ${cf.issue}`);
        }
      }
    }
    console.log('');
  }

  if (escalations.length > 0) {
    console.log(`Escalations (${escalations.length}):`);
    for (const e of escalations) {
      const ef = e.fields.escalation;
      console.log(`  ${e.id}  severity=${ef.severity}  to=${ef.to}`);
      console.log(`    ${ef.reason}`);
    }
    console.log('');
  }
}

