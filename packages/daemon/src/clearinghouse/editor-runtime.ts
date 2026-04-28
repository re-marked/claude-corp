/**
 * Editor runtime — wake dispatch + reactive watcher + Pulse-fallback
 * sweep (Project 1.12.2). Mirrors {@link ./pressman-runtime.ts}.
 *
 * Three things wake the Editor:
 *
 *   1. **Reactive watcher.** EditorReviewWatcher watches the corp-
 *      scope task chits directory; a task transitioning to
 *      `editorReviewRequested = true` (with no held claim) dispatches
 *      a wake. Round-trip from "audit approves a 1.12.2-aware task"
 *      to "Editor session begins" is sub-second on the happy path.
 *
 *   2. **Pulse-fallback sweep.** A clock registered at the Pulse
 *      cadence (5min) does two things: runs `resumeEditorReviews`
 *      to clear stale claims left by dead Editors, then dispatches
 *      a wake if there's review-eligible work and no live Editor
 *      holds a claim. Catches every case the watcher missed
 *      (project-scope tasks, fs.watch hiccups, daemon-down
 *      windows).
 *
 *   3. **Boot recovery.** On daemon start, runs the sweep once
 *      after processManager initializes so stale claims from the
 *      prior session get reaped before the watcher dispatches.
 *
 * Editor is founder opt-in. Without a hired Editor, every primitive
 * here silently no-ops (dispatchEditor's members.json lookup
 * returns nothing, sweep / watcher dispatches resolve to no-op).
 */

import { watch, type FSWatcher, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  readConfig,
  MEMBERS_JSON,
  CHANNELS_JSON,
  agentSessionKey,
  findChitById,
  queryChits,
  type Member,
  type Channel,
  type Chit,
} from '@claudecorp/shared';
import { log, logError } from '../logger.js';
import type { Daemon } from '../daemon.js';
import { resumeEditorReviews } from './editor-workflow.js';

// ─── Config ──────────────────────────────────────────────────────────

/**
 * Sweep cadence — same as Pulse (and the Pressman sweep). Each tick
 * runs resumeEditorReviews then conditionally dispatches a wake.
 */
export const EDITOR_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Per-file dispatch debounce. fs.watch fires multiple events for
 * a single chit write (rename + change); this ceiling collapses
 * them so one task-update doesn't fire three Editor wakes.
 */
const WATCHER_DEBOUNCE_MS = 2000;

const DISPATCH_TIMEOUT_MS = 10_000;

// ─── Wake dispatch ───────────────────────────────────────────────────

/**
 * Dispatch a wake to the corp's Editor, mirroring `dispatchPressman`.
 * Resolves the Editor in members.json (filtered by role + type +
 * non-archived), skips on busy, ensures the process is up, posts
 * a wake message via /cc/say so the response streams into the
 * founder's view of Editor's DM.
 *
 * Idempotent on busy: a second wake while Editor is mid-turn is
 * dropped. Watcher debounce + sweep cadence together prevent
 * pile-up. Editor's session walks one task per wake then exits;
 * any pending review-eligible tasks get picked up on subsequent
 * wakes as the queue drains.
 */
export async function dispatchEditor(daemon: Daemon): Promise<void> {
  let editor: Member;
  try {
    const members = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
    const found = members.find(
      (m) => m.role === 'editor' && m.type === 'agent' && m.status !== 'archived',
    );
    if (!found) {
      // No Editor hired (or fired). Silent — founder opted out.
      return;
    }
    editor = found;
  } catch (err) {
    logError(`[editor-runtime] dispatch: members.json read failed — ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Busy-skip: if Editor is mid-turn, don't queue another. The
  // session walks one task per wake; the next sweep / watcher
  // fires when she's done.
  const workStatus = daemon.getAgentWorkStatus(editor.id);
  if (workStatus === 'busy') {
    log(`[editor-runtime] dispatch: Editor busy — skipping (next sweep re-evaluates)`);
    return;
  }

  // Ensure the process is up. spawnAgent is idempotent.
  const proc = daemon.processManager.getAgent(editor.id);
  if (!proc || proc.status !== 'ready') {
    try {
      log(`[editor-runtime] dispatch: spawning Editor process`);
      await daemon.processManager.spawnAgent(editor.id);
    } catch (err) {
      logError(`[editor-runtime] dispatch: spawn failed — ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  // Resolve Editor's founder DM so the walk's output streams where
  // Mark can see it. Same pattern as Pressman / Sexton.
  let dmChannelId: string | undefined;
  try {
    const channels = readConfig<Channel[]>(join(daemon.corpRoot, CHANNELS_JSON));
    const allMembers = readConfig<Member[]>(join(daemon.corpRoot, MEMBERS_JSON));
    const founder = allMembers.find((m) => m.rank === 'owner');
    const dm = channels.find(
      (c) => c.kind === 'direct' && c.memberIds.includes(editor.id) && (founder ? c.memberIds.includes(founder.id) : false),
    );
    dmChannelId = dm?.id;
  } catch (err) {
    logError(`[editor-runtime] dispatch: channel resolution failed — ${err instanceof Error ? err.message : String(err)}. Dispatching without channelId.`);
  }

  const message = WAKE_MESSAGE;
  const sessionKey = agentSessionKey(editor.displayName);

  try {
    const resp = await fetch(`http://127.0.0.1:${daemon.getPort()}/cc/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: editor.id,
        message,
        sessionKey,
        ...(dmChannelId !== undefined && { channelId: dmChannelId }),
      }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    const data = (await resp.json()) as { ok?: boolean; error?: string; response?: string };
    if (!data.ok) {
      logError(`[editor-runtime] dispatch: /cc/say rejected — ${data.error ?? 'unknown error'}`);
      return;
    }
    log(`[editor-runtime] dispatch: wake completed — response: ${(data.response ?? '').slice(0, 80)}`);
  } catch (err) {
    logError(`[editor-runtime] dispatch: /cc/say failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

const WAKE_MESSAGE = `There's a task awaiting your code review. Walk \
\`patrol/code-review\` — process one task to a terminal state \
(approve / reject / bypass), then exit cleanly. Start with \
\`cc-cli editor pick --from <your-slug> --json\`. Pass \`--json\` \
to every editor subcommand.`;

// ─── Reactive watcher ────────────────────────────────────────────────

/**
 * Watches the corp-scope task chits directory for changes and
 * dispatches an Editor wake when a task with editorReviewRequested
 * appears (or a previously-claimed task gets its claim cleared).
 *
 * Project- and team-scope task chits live in different directories
 * (`projects/<name>/chits/task/`); for v1 we don't watch those — the
 * Pulse-fallback sweep catches them within one cadence (5min).
 * Sufficient for the typical corp-scope-task flow.
 */
export class EditorReviewWatcher {
  private daemon: Daemon;
  private watcher: FSWatcher | null = null;
  private debounce = new Map<string, NodeJS.Timeout>();
  private dir: string;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
    this.dir = join(daemon.corpRoot, 'chits', 'task');
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
      // Lazy: chit dir is created on first task write. Re-check
      // every 30s until it appears.
      setTimeout(() => this.subscribe(), 30_000);
      return;
    }
    try {
      this.watcher = watch(this.dir, (_event, filename) => {
        if (!filename || !filename.endsWith('.md')) return;
        this.onChange(filename);
      });
      this.watcher.on('error', (err) => {
        logError(`[editor-runtime] watcher error: ${err instanceof Error ? err.message : String(err)} — resubscribing in 2s`);
        try { this.watcher?.close(); } catch { /* ignore */ }
        this.watcher = null;
        setTimeout(() => this.subscribe(), 2000);
      });
      log(`[editor-runtime] watching ${this.dir}`);

      // One-shot scan: dispatch if there's already review-eligible
      // work on subscribe. Covers the case where audit fired
      // editorReviewRequested while the watcher was offline (boot
      // recovery + this scan together close that gap).
      void this.scanAndDispatchIfWork();
    } catch (err) {
      logError(`[editor-runtime] watcher subscribe failed: ${err instanceof Error ? err.message : String(err)} — retrying in 5s`);
      setTimeout(() => this.subscribe(), 5000);
    }
  }

  private async scanAndDispatchIfWork(): Promise<void> {
    try {
      if (hasReviewEligibleWork(this.daemon.corpRoot, this.daemonIsAlive())) {
        log(`[editor-runtime] watcher subscribe: review-eligible work present — dispatching`);
        await dispatchEditor(this.daemon);
      }
    } catch (err) {
      logError(`[editor-runtime] watcher initial scan failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private daemonIsAlive(): (slug: string) => boolean {
    return (slug: string) => {
      const proc = this.daemon.processManager.getAgent(slug);
      return proc?.status === 'ready' || proc?.status === 'starting';
    };
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
    const path = join(this.dir, filename);
    if (!existsSync(path)) return;
    const chitId = filename.replace(/\.md$/, '');
    let chit: Chit<'task'> | undefined;
    try {
      const hit = findChitById(this.daemon.corpRoot, chitId);
      if (!hit || hit.chit.type !== 'task') return;
      chit = hit.chit as Chit<'task'>;
    } catch {
      return;
    }
    const f = chit.fields.task;
    // Dispatch only when review is requested AND not already
    // claimed AND not capHit AND at under_review.
    if (f.editorReviewRequested !== true) return;
    if ((f.reviewerClaim ?? null) !== null) return;
    if (f.editorReviewCapHit === true) return;
    if (f.workflowStatus !== 'under_review') return;
    if (!f.branchUnderReview) return;
    log(`[editor-runtime] watcher: review-eligible task detected (${chitId}) — dispatching wake`);
    await dispatchEditor(this.daemon);
  }
}

// ─── Sweep tick + boot recovery ──────────────────────────────────────

function isAliveOf(daemon: Daemon): (slug: string) => boolean {
  return (slug: string) => {
    const proc = daemon.processManager.getAgent(slug);
    return proc?.status === 'ready' || proc?.status === 'starting';
  };
}

/** Walk all active task chits across scopes; true if any are review-eligible AND no live editor holds a claim on them. */
function hasReviewEligibleWork(
  corpRoot: string,
  isAlive: (slug: string) => boolean,
): boolean {
  let tasks: ReturnType<typeof queryChits<'task'>>;
  try {
    tasks = queryChits<'task'>(corpRoot, { types: ['task'], statuses: ['active'] });
  } catch {
    return false;
  }
  for (const c of tasks.chits) {
    const f = (c.chit as Chit<'task'>).fields.task;
    if (f.editorReviewRequested !== true) continue;
    if (f.editorReviewCapHit === true) continue;
    if (f.workflowStatus !== 'under_review') continue;
    if (!f.branchUnderReview) continue;
    const claim = f.reviewerClaim ?? null;
    if (claim && isAlive(claim.slug)) continue; // active reviewer working it
    return true;
  }
  return false;
}

/**
 * One sweep tick. Reaps stale reviewer claims (dead-Editor leftovers)
 * then dispatches a wake when review-eligible work is present.
 * Async function so the daemon's clocks system can register it
 * directly.
 */
export async function editorSweep(daemon: Daemon): Promise<void> {
  const isAlive = isAliveOf(daemon);

  // Recover stale claims left by dead Editors.
  try {
    const result = resumeEditorReviews(daemon.corpRoot, isAlive);
    if (result.claimsReset > 0) {
      log(`[editor-runtime] sweep: recovery — claimsReset=${result.claimsReset}`);
    }
  } catch (err) {
    logError(`[editor-runtime] sweep: resumeEditorReviews threw — ${err instanceof Error ? err.message : String(err)}`);
  }

  // Decide whether to dispatch.
  if (!hasReviewEligibleWork(daemon.corpRoot, isAlive)) return;
  log(`[editor-runtime] sweep: review-eligible work present — dispatching`);
  await dispatchEditor(daemon);
}

/**
 * Boot recovery — runs once at daemon start, AFTER processManager
 * initializes so isAlive returns meaningful values. Reaps stale
 * claims + dispatches eagerly when work is pending so a corp
 * booting with queued reviews doesn't wait one sweep cadence.
 *
 * Async because dispatch awaits a /cc/say roundtrip; called via
 * `void` from daemon.ts so boot doesn't block on it. Failures log,
 * never throw.
 */
export async function editorBootRecover(daemon: Daemon): Promise<void> {
  const isAlive = isAliveOf(daemon);
  try {
    const result = resumeEditorReviews(daemon.corpRoot, isAlive);
    if (result.claimsReset > 0) {
      log(`[editor-runtime] boot: recovery — claimsReset=${result.claimsReset}`);
    }
  } catch (err) {
    logError(`[editor-runtime] boot: resumeEditorReviews threw — ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!hasReviewEligibleWork(daemon.corpRoot, isAlive)) return;
  log(`[editor-runtime] boot: review-eligible work present — dispatching wake eagerly`);
  await dispatchEditor(daemon);
}
