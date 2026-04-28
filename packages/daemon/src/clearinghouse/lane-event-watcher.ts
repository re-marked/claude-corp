/**
 * Lane-event notification watcher (Project 1.12.3).
 *
 * Watches `<corpRoot>/chits/lane-event/` and fires channel + DM
 * posts on the terminal-state events that the human surface
 * actually wants to see:
 *
 *   submission-finalized → #general: "Merged X's PR for task Y
 *                          (sha Z). <narrative>"
 *   submission-blocked   → DM the author with the escalation id
 *   submission-failed    → DM the author with the reason
 *   editor-approved      → DM the author (less verbose)
 *   editor-rejected      → DM the author with escalation id
 *   editor-bypassed      → DM the author noting the cap-bypass
 *
 * The intermediate events (rebase outcomes, individual test
 * results, attribution stages) are noise on the human surface —
 * valuable in the diary (`cc-cli clearinghouse log`) and the
 * Sexton digest, but not in `#general`.
 *
 * ### Why daemon-side, not agent-side
 *
 * Pressman / Editor bootstraps already teach the agents to send
 * messages on terminal events. Those messages are richer because
 * the agent has full context. But agents can forget, or their
 * session can die mid-message. This watcher is the daemon's
 * guarantee that SOME notification fires on every terminal event,
 * even when the agent doesn't.
 *
 * Two layers, opinionated: agent-primary (richer prose), daemon-
 * fallback (reliable). post()'s 5s dedup window prevents the agent
 * + daemon from both posting nearly-identical messages.
 *
 * ### Lifecycle
 *
 * Subscribe at daemon start. fs.watch fires only on new file
 * events — historical lane-events don't re-fire when the watcher
 * starts (which is what we want; they were already notified at
 * the time, or missed). No boot-time replay.
 */

import { watch, type FSWatcher, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readConfig,
  findChitById,
  post,
  CHANNELS_JSON,
  MEMBERS_JSON,
  MESSAGES_JSONL,
  type Chit,
  type Channel,
  type Member,
  type LaneEventFields,
  type LaneEventKind,
  type ClearanceSubmissionFields,
  type TaskFields,
} from '@claudecorp/shared';
import { log, logError } from '../logger.js';
import type { Daemon } from '../daemon.js';

const WATCHER_DEBOUNCE_MS = 1000;

/** The kinds that trigger a notification. Other kinds stay in the diary only. */
const NOTIFY_KINDS = new Set<LaneEventKind>([
  'submission-finalized',
  'submission-blocked',
  'submission-failed',
  'editor-approved',
  'editor-rejected',
  'editor-bypassed',
]);

export class LaneEventWatcher {
  private daemon: Daemon;
  private watcher: FSWatcher | null = null;
  private debounce = new Map<string, NodeJS.Timeout>();
  private dir: string;
  /**
   * Watermark advancing past the createdAt of the most recent
   * event we've fully processed (notified or deterministically
   * filtered). Initialized to boot time so the first subscribe
   * replays gap events without flooding pre-boot history. Every
   * subsequent subscribe — including post-error mid-life
   * resubscribes — backfills only events the watermark hasn't
   * yet covered, closing the 2s mid-day gap fs.watch leaves
   * behind without re-firing all history.
   *
   * Codex round 3 P2: prior `bootTimestamp + didBackfill` design
   * fixed cold-boot but lost mid-day gap events; the watermark
   * unifies both cases.
   */
  private lastHandledMtime: string;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
    this.dir = join(daemon.corpRoot, 'chits', 'lane-event');
    this.lastHandledMtime = new Date().toISOString();
  }

  start(): void {
    if (this.watcher) return;
    this.subscribe();
  }

  stop(): void {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
  }

  private subscribe(): void {
    if (!existsSync(this.dir)) {
      // Lazy: dir is created on first lane-event write. Re-check
      // every 30s until it appears, then subscribe.
      setTimeout(() => this.subscribe(), 30_000);
      return;
    }
    try {
      this.watcher = watch(this.dir, (_event, filename) => {
        if (!filename || !filename.endsWith('.md')) return;
        this.onChange(filename);
      });
      this.watcher.on('error', (err) => {
        logError(`[lane-event-watcher] watcher error: ${err instanceof Error ? err.message : String(err)} — resubscribing in 2s`);
        try { this.watcher?.close(); } catch { /* ignore */ }
        this.watcher = null;
        setTimeout(() => this.subscribe(), 2000);
      });
      log(`[lane-event-watcher] watching ${this.dir}`);
      // Backfill on every successful subscribe — initial or after
      // a mid-life error-resubscribe. Watermark gate makes this a
      // near-no-op in steady state (most files predate the
      // watermark) while still covering the 2s gap fs.watch leaves
      // when watcher.on('error') fires.
      void this.backfill();
    } catch (err) {
      logError(`[lane-event-watcher] subscribe failed: ${err instanceof Error ? err.message : String(err)} — retrying in 5s`);
      setTimeout(() => this.subscribe(), 5000);
    }
  }

  private async backfill(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      logError(`[lane-event-watcher] backfill readdir failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let replayed = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      try {
        // mtime gate — cheap stat avoids reading + parsing every
        // historical chit just to discover it predates the
        // watermark. Steady-state resubscribes filter out almost
        // everything here without ever opening a chit file.
        const path = join(this.dir, entry);
        const st = await stat(path);
        if (st.mtime.toISOString() <= this.lastHandledMtime) continue;
      } catch {
        continue;
      }
      try {
        await this.handle(entry);
        replayed++;
      } catch (err) {
        logError(`[lane-event-watcher] backfill handle failed for ${entry}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (replayed > 0) {
      log(`[lane-event-watcher] backfilled ${replayed} gap-window event(s)`);
    }
  }

  private onChange(filename: string): void {
    const existing = this.debounce.get(filename);
    if (existing) clearTimeout(existing);
    this.debounce.set(
      filename,
      setTimeout(() => {
        this.debounce.delete(filename);
        void this.handle(filename);
      }, WATCHER_DEBOUNCE_MS),
    );
  }

  private async handle(filename: string): Promise<void> {
    const chitId = filename.replace(/\.md$/, '');
    let event: Chit<'lane-event'>;
    try {
      const hit = findChitById(this.daemon.corpRoot, chitId);
      if (!hit || hit.chit.type !== 'lane-event') return;
      event = hit.chit as Chit<'lane-event'>;
    } catch {
      return; // partial-write race; next change re-fires (no watermark advance)
    }

    const f = event.fields['lane-event'];
    if (NOTIFY_KINDS.has(f.kind)) {
      try {
        await this.fire(f);
      } catch (err) {
        logError(`[lane-event-watcher] fire failed for ${chitId} (${f.kind}): ${err instanceof Error ? err.message : String(err)}`);
        // Still advance — post()'s 5s dedup makes a backfill replay
        // a no-op anyway, and we don't want a single transient post
        // failure to stick the watermark forever.
      }
    }
    // Advance the watermark once we've fully looked at the event,
    // including filtered (non-NOTIFY_KINDS) cases — replaying them
    // would just re-filter and waste cycles.
    this.advanceWatermark(event.createdAt);
  }

  private advanceWatermark(createdAt: string | undefined): void {
    if (!createdAt) return;
    if (createdAt > this.lastHandledMtime) {
      this.lastHandledMtime = createdAt;
    }
  }

  private async fire(f: LaneEventFields): Promise<void> {
    // Resolve the submission (post-submission events) and task
    // (always present) for context. Submission-less editor events
    // skip the submission lookup gracefully.
    let submitterSlug: string | null = null;
    let branch: string | undefined;
    if (f.submissionId) {
      const subHit = findChitById(this.daemon.corpRoot, f.submissionId);
      if (subHit && subHit.chit.type === 'clearance-submission') {
        const sf = (subHit.chit as Chit<'clearance-submission'>).fields['clearance-submission'];
        submitterSlug = sf.submitter;
        branch = sf.branch;
      }
    }
    if (!submitterSlug) {
      // Fall back to task assignee/handedBy.
      const taskHit = findChitById(this.daemon.corpRoot, f.taskId);
      if (taskHit && taskHit.chit.type === 'task') {
        const tf = (taskHit.chit as Chit<'task'>).fields.task;
        submitterSlug = tf.assignee ?? tf.handedBy ?? null;
        branch = branch ?? tf.branchUnderReview ?? undefined;
      }
    }

    const branchTag = branch ? `\`${branch}\`` : `task ${f.taskId}`;

    switch (f.kind) {
      case 'submission-finalized': {
        const sha = f.payload?.mergeCommitSha
          ? ` (sha \`${f.payload.mergeCommitSha.slice(0, 8)}\`)`
          : '';
        const submitter = submitterSlug ?? 'unknown';
        const narrative = f.narrative ? ` — ${f.narrative}` : '';
        const body = `Merged ${submitter}'s PR for ${branchTag}${sha}${narrative}`;
        this.postToGeneral(body, f);
        break;
      }
      case 'submission-blocked': {
        const escalation = f.payload?.escalationId ? `; escalation \`${f.payload.escalationId}\`` : '';
        const body = `Your PR for ${branchTag} hit a blocker${escalation}. ${f.payload?.failureSummary ?? f.narrative ?? ''}`.trim();
        this.dmAuthor(submitterSlug, body, f);
        break;
      }
      case 'submission-failed': {
        const body = `Your PR for ${branchTag} failed: ${f.payload?.failureSummary ?? f.narrative ?? 'see audit log'}`;
        this.dmAuthor(submitterSlug, body, f);
        break;
      }
      case 'editor-approved': {
        const round = f.payload?.reviewRound !== undefined ? `round ${f.payload.reviewRound + 1}` : 'review';
        const narrative = f.narrative ? ` — ${f.narrative}` : '';
        const body = `Editor approved your PR for ${branchTag} (${round})${narrative}`;
        this.dmAuthor(submitterSlug, body, f);
        break;
      }
      case 'editor-rejected': {
        const escalation = f.payload?.escalationId ? `; see escalation \`${f.payload.escalationId}\`` : '';
        const cap = f.payload?.capHit ? ' — cap reached, next round will bypass review' : '';
        const summary = f.payload?.failureSummary ?? f.narrative ?? '';
        const body = `Editor rejected your PR for ${branchTag}${escalation}${cap}. ${summary}`.trim();
        this.dmAuthor(submitterSlug, body, f);
        break;
      }
      case 'editor-bypassed': {
        const body = `Editor cap-bypassed your PR for ${branchTag}; submission proceeded with reviewBypassed=true. ${f.payload?.failureSummary ?? f.narrative ?? ''}`.trim();
        this.dmAuthor(submitterSlug, body, f);
        break;
      }
      default:
        // Defensive — NOTIFY_KINDS already filtered.
        return;
    }
  }

  private postToGeneral(content: string, f: LaneEventFields): void {
    let channels: Channel[];
    try {
      channels = readConfig<Channel[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
    } catch (err) {
      logError(`[lane-event-watcher] channels.json read failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const general = channels.find((c) => c.kind === 'broadcast' && c.name === 'general');
    if (!general) {
      logError(`[lane-event-watcher] no #general channel found — dropping post for ${f.kind}`);
      return;
    }
    try {
      post(general.id, join(this.daemon.corpRoot, general.path, MESSAGES_JSONL), {
        senderId: 'system',
        content,
        source: 'system',
        metadata: { laneEventKind: f.kind, taskId: f.taskId, ...(f.submissionId ? { submissionId: f.submissionId } : {}) },
      });
      // Wake the channel so subscribers see it without waiting.
      setTimeout(() => this.daemon.router.pokeChannel(general.id), 100);
    } catch (err) {
      logError(`[lane-event-watcher] post to #general failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private dmAuthor(authorSlug: string | null, content: string, f: LaneEventFields): void {
    if (!authorSlug) {
      logError(`[lane-event-watcher] no author slug resolved for ${f.kind} on ${f.taskId} — dropping DM`);
      return;
    }
    let channels: Channel[];
    let members: Member[];
    try {
      channels = readConfig<Channel[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
      members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
    } catch (err) {
      logError(`[lane-event-watcher] config read failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const founder = members.find((m) => m.rank === 'owner');
    const dm = channels.find(
      (c) => c.kind === 'direct'
        && c.memberIds.includes(authorSlug)
        && (founder ? c.memberIds.includes(founder.id) : true),
    );
    if (!dm) {
      logError(`[lane-event-watcher] no DM channel for ${authorSlug} — dropping ${f.kind} notification`);
      return;
    }
    try {
      post(dm.id, join(this.daemon.corpRoot, dm.path, MESSAGES_JSONL), {
        senderId: 'system',
        content,
        source: 'system',
        mentions: [authorSlug],
        metadata: { laneEventKind: f.kind, taskId: f.taskId, ...(f.submissionId ? { submissionId: f.submissionId } : {}) },
      });
      setTimeout(() => this.daemon.router.pokeChannel(dm.id), 100);
    } catch (err) {
      logError(`[lane-event-watcher] DM post failed for ${authorSlug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
