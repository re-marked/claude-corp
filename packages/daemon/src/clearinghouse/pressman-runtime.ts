/**
 * Pressman runtime — wake dispatch + reactive watcher + Pulse-fallback
 * sweeper (Project 1.12.1).
 *
 * The Pressman is an Employee with a session. Three things wake it:
 *
 *   1. **Reactive watcher.** ClearanceSubmissionWatcher watches the
 *      clearance-submission chits directory; a new queued submission
 *      dispatches a wake immediately. Round-trip from "audit fires
 *      enterClearance" to "Pressman session begins walking" is sub-
 *      second on the happy path.
 *
 *   2. **Pulse-fallback sweep.** A clock registered against the
 *      daemon's existing Pulse cadence (5min default) does two things
 *      per tick: runs `resumeClearinghouse` to recover stale state
 *      from a dead Pressman, then dispatches a wake if the queue is
 *      non-empty AND no live Pressman currently holds the lock.
 *      Catches every case the watcher missed (e.g. a chit written
 *      while the daemon was down — fs.watch only fires on changes
 *      observed after subscribe).
 *
 *   3. **Boot recovery.** On daemon start, runs `resumeClearinghouse`
 *      once before the watcher subscribes. Released-lock + re-queued
 *      orphans land in the dispatch loop on the first sweep tick.
 *
 * ### Why not call resumeClearinghouse from the agent's pickNext
 *
 * The plan considered putting the self-heal inside the workflow
 * primitive itself. That would have required the CLI process running
 * pickNext to know which slugs are alive — a daemon-side concept.
 * Bridging it (HTTP, IPC) added complexity for no gain. Daemon owns
 * process state; daemon owns recovery. The agent's pickNext just
 * reads current state and trusts the recovery sweep to keep it
 * tidy.
 *
 * ### What this is NOT
 *
 * - Not a scheduler. The runtime never decides what to merge or how
 *   — that's the Pressman session's job. It only wakes the session
 *   at the right moments.
 * - Not a process supervisor. processManager + Sexton handle that.
 *   This runtime trusts process-state queries to be honest.
 * - Not auto-hiring. The Pressman is founder opt-in via
 *   `cc-cli hire --role pressman`; the runtime no-ops on corps
 *   without a Pressman.
 */

import { watch, type FSWatcher, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readConfig,
  MEMBERS_JSON,
  CHANNELS_JSON,
  rankQueue,
  readClearinghouseLock,
  resumeClearinghouse,
  agentSessionKey,
  type Member,
  type Channel,
} from '@claudecorp/shared';
import { log, logError } from '../logger.js';
import type { Daemon } from '../daemon.js';
import { cleanupOrphanWorktrees } from './workflow.js';

// ─── Config ──────────────────────────────────────────────────────────

/**
 * Sweep cadence — same default as Pulse. Each tick runs
 * `resumeClearinghouse` then conditionally dispatches a wake. 5 min
 * is short enough that a stale lock from a daemon-down period gets
 * recovered quickly, long enough that the recovery work is bounded.
 */
export const CLEARINGHOUSE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Per-file dispatch debounce. fs.watch can fire multiple events for
 * a single chit creation (atomic-write-then-rename triggers both
 * 'rename' and 'change'); this ceiling prevents three wake messages
 * for one new submission.
 */
const WATCHER_DEBOUNCE_MS = 2000;

const DISPATCH_TIMEOUT_MS = 10_000;

// ─── Wake dispatch ───────────────────────────────────────────────────

/**
 * Dispatch a wake to the corp's Pressman, mirroring `dispatchSexton`'s
 * shape. Resolves the Pressman in members.json, skips if busy, ensures
 * the process is up, posts a wake message via /cc/say so the response
 * + tool events stream into the founder's view of Pressman's DM.
 *
 * Idempotent in the busy-skip sense: a second wake while Pressman is
 * mid-turn is dropped (Pulse + watcher debounce together prevent a
 * pile-up). The session walks one submission then exits, so multiple
 * pending wakes resolve naturally as the queue drains.
 */
export async function dispatchPressman(daemon: Daemon): Promise<void> {
  let pressman: Member;
  try {
    const members = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
    const found = members.find(
      (m) => m.role === 'pressman' && m.type === 'agent' && m.status !== 'archived',
    );
    if (!found) {
      // No Pressman hired (or fired). Silent — the founder opted out.
      return;
    }
    pressman = found;
  } catch (err) {
    logError(`[pressman-runtime] dispatch: members.json read failed — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Busy-skip: if Pressman is already mid-turn, don't queue another.
  // The session walks one submission per wake; the next sweep or
  // watcher event will re-dispatch when she's done.
  const workStatus = daemon.getAgentWorkStatus(pressman.id);
  if (workStatus === 'busy') {
    log(`[pressman-runtime] dispatch: Pressman busy — skipping (next sweep re-evaluates)`);
    return;
  }

  // Ensure the process is up. spawnAgent is idempotent for already-
  // running processes; if it's died between the work-status check
  // and now (rare race), this respawns.
  const proc = daemon.processManager.getAgent(pressman.id);
  if (!proc || proc.status !== 'ready') {
    try {
      log(`[pressman-runtime] dispatch: spawning Pressman process`);
      await daemon.processManager.spawnAgent(pressman.id);
    } catch (err) {
      logError(`[pressman-runtime] dispatch: spawn failed — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  // Resolve Pressman's founder DM so the walk's output streams where
  // Mark can see it. Same pattern as sexton-runtime + dreams.
  let dmChannelId: string | undefined;
  try {
    const channels = readConfig<Channel[]>(join(daemon.corpRoot, CHANNELS_JSON));
    const allMembers = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
    const founder = allMembers.find((m) => m.rank === 'owner');
    const dm = channels.find(
      (c) => c.kind === 'direct' && c.memberIds.includes(pressman.id) && (founder ? c.memberIds.includes(founder.id) : false),
    );
    dmChannelId = dm?.id;
  } catch (err) {
    logError(`[pressman-runtime] dispatch: channel resolution failed — ${err instanceof Error ? err.message : String(err)}. Dispatching without channelId.`);
  }

  const message = WAKE_MESSAGE;
  const sessionKey = agentSessionKey(pressman.displayName);

  try {
    const resp = await fetch(`http://127.0.0.1:${daemon.getPort()}/cc/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: pressman.id,
        message,
        sessionKey,
        ...(dmChannelId !== undefined && { channelId: dmChannelId }),
      }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    const data = (await resp.json()) as { ok?: boolean; error?: string; response?: string };
    if (!data.ok) {
      logError(`[pressman-runtime] dispatch: /cc/say rejected — ${data.error ?? 'unknown error'}`);
      return;
    }
    log(`[pressman-runtime] dispatch: wake completed — response: ${(data.response ?? '').slice(0, 80)}`);
  } catch (err) {
    logError(`[pressman-runtime] dispatch: /cc/say failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

const WAKE_MESSAGE = `The clearinghouse queue has work. Walk \`patrol/clearing\` — \
process one submission to a terminal state, then exit cleanly. Start \
with \`cc-cli clearinghouse pick --from <your-slug> --json\`. Pass \
\`--json\` to every clearinghouse subcommand.`;

// ─── Reactive watcher ────────────────────────────────────────────────

/**
 * Watches the clearance-submission chit directory for new files and
 * dispatches a Pressman wake when a queued submission appears.
 * Mirrors the contract-watcher / task-watcher shape.
 *
 * Debounces per-file so atomic-write-then-rename doesn't fire two
 * wakes for one chit. Recovers from watcher errors by resubscribing
 * after a short delay.
 */
export class ClearanceSubmissionWatcher {
  private daemon: Daemon;
  private watcher: FSWatcher | null = null;
  private debounce = new Map<string, NodeJS.Timeout>();
  private dir: string;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
    this.dir = join(daemon.corpRoot, 'chits', 'clearance-submission');
  }

  start(): void {
    if (this.watcher) return; // idempotent
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
      // The directory is created lazily on first chit write. Re-check
      // periodically until it appears, then subscribe. Without this
      // a corp that hires Pressman before the first submission would
      // never get reactive wakes (until daemon restart after the dir
      // exists).
      setTimeout(() => this.subscribe(), 30_000);
      return;
    }
    try {
      this.watcher = watch(this.dir, (event, filename) => {
        if (!filename || !filename.endsWith('.md')) return;
        this.onChange(filename);
      });
      this.watcher.on('error', (err) => {
        logError(`[pressman-runtime] watcher error: ${err instanceof Error ? err.message : String(err)} — resubscribing in 2s`);
        try { this.watcher?.close(); } catch { /* ignore */ }
        this.watcher = null;
        setTimeout(() => this.subscribe(), 2000);
      });
      log(`[pressman-runtime] watching ${this.dir}`);
    } catch (err) {
      logError(`[pressman-runtime] watcher subscribe failed: ${err instanceof Error ? err.message : String(err)} — retrying in 5s`);
      setTimeout(() => this.subscribe(), 5000);
    }
  }

  private onChange(filename: string): void {
    // Debounce per-file: collapse the rename + change events fs.watch
    // emits during atomic chit writes.
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
    const path = join(this.dir, filename);
    if (!existsSync(path)) return; // chit deleted between event and handler
    let content: string;
    try {
      content = readFileSync(path, 'utf-8');
    } catch {
      return;
    }
    // Lightweight check — look for the queued status in the
    // frontmatter. We don't need the full chit parse here; the
    // primitive (rankQueue) does that on the dispatch path.
    if (!/submissionStatus:\s*['"]?queued['"]?/.test(content)) return;
    log(`[pressman-runtime] watcher: queued submission detected (${filename}) — dispatching wake`);
    await dispatchPressman(this.daemon);
  }
}

// ─── Sweep tick ──────────────────────────────────────────────────────

/**
 * One sweep tick. Runs the boot/periodic recovery (resumeClearinghouse)
 * then conditionally dispatches a wake. Pure async function so the
 * daemon's clocks system can register it directly.
 */
export async function clearinghouseSweep(daemon: Daemon): Promise<void> {
  const isAlive = (slug: string): boolean => {
    const proc = daemon.processManager.getAgent(slug);
    return proc?.status === 'ready' || proc?.status === 'starting';
  };

  // Recover stale state.
  try {
    const result = resumeClearinghouse(daemon.corpRoot, isAlive);
    if (result.lockReleased || result.submissionsReset > 0) {
      log(`[pressman-runtime] sweep: recovery — lockReleased=${result.lockReleased}, submissionsReset=${result.submissionsReset}`);
    }
  } catch (err) {
    logError(`[pressman-runtime] sweep: resumeClearinghouse threw — ${err instanceof Error ? err.message : String(err)}`);
  }

  // Decide whether to dispatch a wake.
  let lockHeld = false;
  try {
    const lock = readClearinghouseLock(daemon.corpRoot);
    lockHeld = lock.heldBy !== null && isAlive(lock.heldBy);
  } catch { /* fall through to no-op */ }
  if (lockHeld) return; // a live Pressman is already on it

  let queueDepth = 0;
  try {
    queueDepth = rankQueue(daemon.corpRoot).length;
  } catch { return; }
  if (queueDepth === 0) return;

  log(`[pressman-runtime] sweep: queue depth ${queueDepth}, no live holder — dispatching wake`);
  await dispatchPressman(daemon);
}

// ─── Boot recovery ───────────────────────────────────────────────────

/**
 * Boot recovery — runs once at daemon start, AFTER processManager is
 * initialized so `isAlive` returns meaningful values. Three things:
 *
 *   1. resumeClearinghouse — release stale lock, re-queue any
 *      submissions whose processingBy slot is no longer alive.
 *   2. cleanupOrphanWorktrees — remove `.clearinghouse/wt-*` dirs
 *      that don't match any active submission. Recovers disk space
 *      from prior sessions that died mid-walk.
 *   3. Eager dispatch — if the queue is non-empty after recovery,
 *      dispatch a Pressman wake immediately. Without this, a corp
 *      that booted with pending work would wait up to one sweep
 *      cadence (5min) before the first dispatch.
 *
 * Async because cleanup + dispatch are async; called via `void` from
 * daemon.ts so boot doesn't block on it. Failures log; never throw.
 */
export async function clearinghouseBootRecover(daemon: Daemon): Promise<void> {
  const isAlive = (slug: string): boolean => {
    const proc = daemon.processManager.getAgent(slug);
    return proc?.status === 'ready' || proc?.status === 'starting';
  };

  // 1. Recover stale lock + orphaned submissions.
  try {
    const result = resumeClearinghouse(daemon.corpRoot, isAlive);
    if (result.lockReleased || result.submissionsReset > 0) {
      log(`[pressman-runtime] boot: recovery — lockReleased=${result.lockReleased}, submissionsReset=${result.submissionsReset}`);
    }
  } catch (err) {
    logError(`[pressman-runtime] boot: resumeClearinghouse threw — ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Reap orphan worktree directories.
  try {
    const cleanup = await cleanupOrphanWorktrees({ corpRoot: daemon.corpRoot });
    if (cleanup.ok && (cleanup.value.removed > 0 || cleanup.value.failed > 0)) {
      log(`[pressman-runtime] boot: orphan worktrees — removed=${cleanup.value.removed}, failed=${cleanup.value.failed}`);
    } else if (!cleanup.ok) {
      logError(`[pressman-runtime] boot: cleanupOrphanWorktrees failed — ${cleanup.failure.pedagogicalSummary}`);
    }
  } catch (err) {
    logError(`[pressman-runtime] boot: cleanupOrphanWorktrees threw — ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Eager dispatch — if queue is non-empty + no live holder, wake
  // Pressman now instead of waiting for the first sweep tick.
  let lockHeld = false;
  try {
    const lock = readClearinghouseLock(daemon.corpRoot);
    lockHeld = lock.heldBy !== null && isAlive(lock.heldBy);
  } catch { /* fall through */ }
  if (lockHeld) return;

  let queueDepth = 0;
  try {
    queueDepth = rankQueue(daemon.corpRoot).length;
  } catch { return; }
  if (queueDepth === 0) return;

  log(`[pressman-runtime] boot: queue depth ${queueDepth} — dispatching wake eagerly`);
  await dispatchPressman(daemon);
}
