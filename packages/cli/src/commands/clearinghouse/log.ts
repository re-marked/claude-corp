/**
 * cc-cli clearinghouse log — the lane's diary.
 *
 * Project 1.12.3 — renders the lane-event chit stream chronologically
 * so a founder can read what the corp shipped overnight as a
 * newspaper, not by grepping individual chits. Three modes:
 *
 *   default                  Terminal events only (finalized /
 *                            blocked / failed / editor-* terminals).
 *                            Grouped by date. One-liner per submission
 *                            with the agent's narrative inlined.
 *
 *   --verbose                All events including intermediate rebase
 *                            / test / attribution outcomes. The full
 *                            firehose; useful when debugging.
 *
 *   --replay <submission-id> Walk one submission's entire journey as
 *                            a single chronological story. Pulls
 *                            narratives + payload bits into a
 *                            readable paragraph.
 *
 * Filters apply across all modes:
 *   --since ISO / --until ISO  Bounded time range.
 *   --today / --this-week /    Convenience presets.
 *   --this-month
 *   --merged-only              Terminal-mode: only submission-finalized.
 *   --blocked-only             Terminal-mode: only submission-blocked.
 *   --failed-only              Terminal-mode: only submission-failed.
 *   --role <id>                Filter by submitter role (resolved via
 *                              members.json).
 */

import { parseArgs } from 'node:util';
import {
  queryChits,
  readConfig,
  getRole,
  findChitById,
  MEMBERS_JSON,
  type Chit,
  type Member,
  type LaneEventFields,
  type LaneEventKind,
  type ClearanceSubmissionFields,
  type TaskFields,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

interface Opts {
  since?: string;
  until?: string;
  today?: boolean;
  'this-week'?: boolean;
  'this-month'?: boolean;
  'merged-only'?: boolean;
  'blocked-only'?: boolean;
  'failed-only'?: boolean;
  role?: string;
  replay?: string;
  verbose?: boolean;
  corp?: string;
  json?: boolean;
}

const TERMINAL_KINDS = new Set<LaneEventKind>([
  'submission-finalized',
  'submission-blocked',
  'submission-failed',
  'editor-approved',
  'editor-rejected',
  'editor-bypassed',
]);

export async function cmdClearinghouseLog(rawArgs: string[]): Promise<void> {
  const opts = parseOpts(rawArgs);
  const corpRoot = await getCorpRoot(opts.corp);

  // Pull all lane-events (active + terminal status both surface in the
  // diary; non-ephemeral so nothing has aged out).
  let result: ReturnType<typeof queryChits<'lane-event'>>;
  try {
    result = queryChits<'lane-event'>(corpRoot, {
      types: ['lane-event'],
      scopes: ['corp'],
    });
  } catch (err) {
    console.error(`log: failed to read lane-events — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let events = result.chits.map((c) => c.chit as Chit<'lane-event'>);

  // Time filter — compute the [since, until] window once.
  const { since, until } = resolveTimeWindow(opts);
  if (since) events = events.filter((e) => (e.createdAt ?? '') >= since);
  if (until) events = events.filter((e) => (e.createdAt ?? '') <= until);

  // Replay short-circuits — print one submission's full journey.
  if (opts.replay) {
    return renderReplay(corpRoot, events, opts.replay, !!opts.json);
  }

  // Role filter — resolve once at the top, then apply.
  if (opts.role) {
    const slugsForRole = resolveSlugsForRole(corpRoot, opts.role);
    events = events.filter((e) => {
      // Match if the event's submitter (looked up via the
      // submission, or the task) is in the role's slug set.
      const slug = resolveEventSubmitter(corpRoot, e);
      return slug !== null && slugsForRole.has(slug);
    });
  }

  // Mode filter — terminal-only by default, all events when --verbose.
  if (!opts.verbose) {
    events = events.filter((e) => TERMINAL_KINDS.has(e.fields['lane-event'].kind));
  }
  if (opts['merged-only']) {
    events = events.filter((e) => e.fields['lane-event'].kind === 'submission-finalized');
  } else if (opts['blocked-only']) {
    events = events.filter((e) => e.fields['lane-event'].kind === 'submission-blocked');
  } else if (opts['failed-only']) {
    events = events.filter((e) => e.fields['lane-event'].kind === 'submission-failed');
  }

  // Sort chronological ascending — a diary reads top-to-bottom.
  events.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));

  if (opts.json) {
    console.log(JSON.stringify({
      events: events.map((e) => ({
        id: e.id,
        createdAt: e.createdAt,
        kind: e.fields['lane-event'].kind,
        submissionId: e.fields['lane-event'].submissionId ?? null,
        taskId: e.fields['lane-event'].taskId,
        emittedBy: e.fields['lane-event'].emittedBy,
        narrative: e.fields['lane-event'].narrative ?? null,
        payload: e.fields['lane-event'].payload ?? null,
      })),
    }, null, 2));
    return;
  }

  if (events.length === 0) {
    console.log('(no lane events match)');
    return;
  }

  // Group by date for readable output.
  let lastDate = '';
  for (const e of events) {
    const date = (e.createdAt ?? '').slice(0, 10);
    if (date !== lastDate) {
      console.log('');
      console.log(formatDateHeader(date));
      lastDate = date;
    }
    console.log(formatEventLine(corpRoot, e));
  }
}

function resolveTimeWindow(opts: Opts): { since?: string; until?: string } {
  if (opts.since || opts.until) {
    const out: { since?: string; until?: string } = {};
    if (opts.since) out.since = opts.since;
    if (opts.until) out.until = opts.until;
    return out;
  }
  const now = new Date();
  if (opts.today) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { since: start.toISOString() };
  }
  if (opts['this-week']) {
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    return { since: start.toISOString() };
  }
  if (opts['this-month']) {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    return { since: start.toISOString() };
  }
  return {};
}

function resolveSlugsForRole(corpRoot: string, roleId: string): Set<string> {
  const out = new Set<string>();
  try {
    const members = readConfig<Member[]>(`${corpRoot}/${MEMBERS_JSON}`);
    for (const m of members) {
      if (m.role === roleId) out.add(m.id);
    }
  } catch { /* members.json unreadable; empty set yields no-match */ }
  return out;
}

function resolveEventSubmitter(corpRoot: string, e: Chit<'lane-event'>): string | null {
  // Prefer the submission's submitter when populated. Fall back to
  // the task's assignee/handedBy. Both are best-effort lookups.
  //
  // Codex P1 catch: prior version used dynamic require() inside a
  // try/catch, which throws unconditionally in @claudecorp/cli's ESM
  // build — every call returned null, degrading every label to
  // 'unknown' and silently dropping all events from --role filtering.
  // Top-level import fixes both.
  const f = e.fields['lane-event'];
  if (f.submissionId) {
    try {
      const hit = findChitById(corpRoot, f.submissionId);
      if (hit && hit.chit.type === 'clearance-submission') {
        return (hit.chit as Chit<'clearance-submission'>).fields['clearance-submission'].submitter;
      }
    } catch { /* fall through to task lookup */ }
  }
  try {
    const hit = findChitById(corpRoot, f.taskId);
    if (hit && hit.chit.type === 'task') {
      const tf = (hit.chit as Chit<'task'>).fields.task;
      return tf.assignee ?? tf.handedBy ?? null;
    }
  } catch { /* fall through */ }
  return null;
}

function formatDateHeader(dateStr: string): string {
  if (!dateStr) return '(undated)';
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toUTCString().replace(/ \d{2}:\d{2}:\d{2} GMT/, '').trim();
}

function formatEventLine(corpRoot: string, e: Chit<'lane-event'>): string {
  const f = e.fields['lane-event'];
  const time = (e.createdAt ?? '').slice(11, 16);
  const submitter = resolveEventSubmitter(corpRoot, e) ?? 'unknown';
  const narrative = f.narrative ? `\n      "${f.narrative}"` : '';

  switch (f.kind) {
    case 'submission-finalized': {
      const sha = f.payload?.mergeCommitSha ? f.payload.mergeCommitSha.slice(0, 8) : '?';
      const branch = f.payload?.branch ?? f.taskId;
      return `  ${time}  ${submitter}'s ${branch} → merged ${sha}${narrative}`;
    }
    case 'submission-blocked': {
      const branch = f.payload?.branch ?? f.taskId;
      const reason = f.payload?.failureSummary ?? f.narrative ?? f.payload?.failureCategory ?? '?';
      return `  ${time}  ${submitter}'s ${branch} → BLOCKED — ${reason}`;
    }
    case 'submission-failed': {
      const branch = f.payload?.branch ?? f.taskId;
      const reason = f.payload?.failureSummary ?? f.narrative ?? '?';
      return `  ${time}  ${submitter}'s ${branch} → failed — ${reason}`;
    }
    case 'editor-approved':
      return `  ${time}  Editor approved ${submitter}'s task ${f.taskId} (round ${(f.payload?.reviewRound ?? 0) + 1})${narrative}`;
    case 'editor-rejected': {
      const round = f.payload?.reviewRound ?? 1;
      const cap = f.payload?.capHit ? ' [cap hit]' : '';
      const reason = f.payload?.failureSummary ?? f.narrative ?? '';
      return `  ${time}  Editor rejected ${submitter}'s task ${f.taskId} round ${round}${cap} — ${reason}`;
    }
    case 'editor-bypassed':
      return `  ${time}  Editor cap-bypassed ${submitter}'s task ${f.taskId}${narrative}`;
    default: {
      // Verbose-only intermediate events.
      const branch = f.payload?.branch ? ` ${f.payload.branch}` : '';
      const detail = f.narrative ? ` — "${f.narrative}"` : '';
      return `  ${time}  ${f.kind}${branch} (task ${f.taskId})${detail}`;
    }
  }
}

function renderReplay(
  corpRoot: string,
  events: Chit<'lane-event'>[],
  submissionId: string,
  asJson: boolean,
): void {
  // Filter to the target submission's events. Submissions identify by
  // submissionId in payload; pre-submission editor events use taskId
  // — for replay we expect a submission id, so taskId-only events
  // (editor-claimed/-rejected/-released) only show up if the user
  // happens to know the task id and passes it. Document that in the
  // help text.
  const matching = events
    .filter((e) => {
      const f = e.fields['lane-event'];
      return f.submissionId === submissionId || f.taskId === submissionId;
    })
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));

  if (asJson) {
    console.log(JSON.stringify({
      target: submissionId,
      events: matching.map((e) => ({
        createdAt: e.createdAt,
        kind: e.fields['lane-event'].kind,
        narrative: e.fields['lane-event'].narrative ?? null,
        payload: e.fields['lane-event'].payload ?? null,
      })),
    }, null, 2));
    return;
  }

  if (matching.length === 0) {
    console.log(`(no lane events for ${submissionId})`);
    return;
  }
  const submitter = resolveEventSubmitter(corpRoot, matching[0]!) ?? 'unknown';
  console.log(`Replay of ${submissionId} (${submitter}):`);
  console.log('');
  for (const e of matching) {
    const f = e.fields['lane-event'];
    const time = (e.createdAt ?? '').slice(11, 19);
    const narrative = f.narrative ? ` — "${f.narrative}"` : '';
    console.log(`  ${time}  ${f.kind}${narrative}`);
  }
}

function parseOpts(rawArgs: string[]): Opts {
  const { values } = parseArgs({
    args: rawArgs,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      today: { type: 'boolean' },
      'this-week': { type: 'boolean' },
      'this-month': { type: 'boolean' },
      'merged-only': { type: 'boolean' },
      'blocked-only': { type: 'boolean' },
      'failed-only': { type: 'boolean' },
      role: { type: 'string' },
      replay: { type: 'string' },
      verbose: { type: 'boolean' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  return values as Opts;
}

// suppress unused
void getRole;
