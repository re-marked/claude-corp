/**
 * `log-rotation` sweeper — rotate the daemon log when it grows
 * past a size threshold, prune archived rotations past a
 * retention depth.
 *
 * The daemon writes to a single file at DAEMON_LOG_PATH
 * (~/.claudecorp/.daemon.log) via appendFileSync per log call.
 * On a healthy dev machine the file grows ~1-5 MB/day just from
 * Pulse ticks + dispatches + sweeper runs. Left unrotated, it
 * reaches tens of gigabytes over months of uptime. This is the
 * one sweeper in the v1 batch that actively mutates the
 * filesystem — the five others are report-only.
 *
 * ### Rotation mechanics
 *
 * When DAEMON_LOG_PATH is larger than ROTATE_THRESHOLD_BYTES:
 *   - shift existing archives down:
 *       .daemon.log.{MAX_ARCHIVES-1} → delete (if present)
 *       .daemon.log.{N}              → .daemon.log.{N+1}
 *       ...
 *       .daemon.log.1                → .daemon.log.2
 *   - rename .daemon.log → .daemon.log.1
 *
 * The daemon's next appendFileSync recreates the empty .daemon.log
 * automatically — no file-handle management needed since the
 * logger opens fresh on every call.
 *
 * Emits one info-severity finding per rotation (or none when the
 * log is under threshold).
 *
 * ### Why not fancier rotation schemes
 *
 * logrotate (Linux), logrotator (Windows), and Node's own
 * file-rotator libraries all work, but adding a dep for a single
 * log file is out of proportion. The manual shift-and-rename
 * pattern is 30 lines, works cross-platform (renameSync behaves
 * identically on Linux/macOS/Windows), and doesn't depend on the
 * daemon holding the log handle in a specific way.
 *
 * Compression of archived logs is a nice-to-have we don't need at
 * current sizes — .daemon.log.5 at ~10MB is a trivial grep target.
 *
 * ### Auto-resolve
 *
 * When this sweeper runs and the log is under threshold, it emits
 * no findings. The runner's auto-resolve path closes any prior
 * "rotated" kink with resolution='auto-resolved' — so the kink
 * from last week's rotation gets cleaned up once the log is
 * quiet again.
 */

import { getDaemonLogPath } from '@claudecorp/shared';
import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { log, logError } from '../../logger.js';
import type { SweeperContext, SweeperResult } from './types.js';

/**
 * Rotate when the log passes 10 MB. Tuned empirically — smaller
 * thresholds rotate too often (noisy); larger makes tail + grep
 * slower for founder-facing diagnostic use.
 */
const ROTATE_THRESHOLD_BYTES = 10 * 1024 * 1024;

/**
 * Keep up to 5 archived rotations. At 10MB each that's 50MB of
 * history in the worst case — enough to cover several weeks of
 * daemon activity for retro-investigation, not enough to cause
 * disk-pressure issues on any modern machine.
 */
const MAX_ARCHIVES = 5;

export async function runLogRotation(ctx: SweeperContext): Promise<SweeperResult> {
  // Per-corp scoping: the sweeper rotates THIS daemon's log,
  // resolved from its corp root. Archive paths sit alongside
  // the live log (`<corpRoot>/.daemon.log.1` … `.5`).
  const logPath = getDaemonLogPath(ctx.daemon.corpRoot);

  if (!existsSync(logPath)) {
    return {
      status: 'noop',
      findings: [],
      summary: `log-rotation: no daemon log at ${logPath} (daemon may not have written yet).`,
    };
  }

  let size: number;
  try {
    size = statSync(logPath).size;
  } catch (err) {
    return {
      status: 'failed',
      findings: [],
      summary: `log-rotation: stat on ${logPath} failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (size < ROTATE_THRESHOLD_BYTES) {
    return {
      status: 'noop',
      findings: [],
      summary: `log-rotation: log size ${formatBytes(size)} under threshold ${formatBytes(ROTATE_THRESHOLD_BYTES)}, no rotation needed.`,
    };
  }

  // Shift archives down. Start from the oldest (highest index)
  // and work backward; the top slot gets deleted if present to
  // make room for the previous one.
  try {
    for (let i = MAX_ARCHIVES - 1; i >= 1; i--) {
      const src = archivePath(logPath, i);
      const dst = archivePath(logPath, i + 1);
      if (existsSync(src)) {
        if (i + 1 > MAX_ARCHIVES) {
          // Shouldn't hit this case given the loop bounds; defensive.
          unlinkSync(src);
        } else {
          if (existsSync(dst)) unlinkSync(dst);
          renameSync(src, dst);
        }
      }
    }

    // Drop the oldest if it exists past the cap (from a prior
    // MAX_ARCHIVES value being larger). Keeps the directory clean
    // across config changes.
    const overflow = archivePath(logPath, MAX_ARCHIVES + 1);
    if (existsSync(overflow)) {
      try {
        unlinkSync(overflow);
      } catch {
        // Best-effort cleanup; don't fail rotation over an
        // over-cap file.
      }
    }

    // Rotate the live log into slot 1.
    const slot1 = archivePath(logPath, 1);
    if (existsSync(slot1)) unlinkSync(slot1);
    renameSync(logPath, slot1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[sweeper:log-rotation] rotation failed: ${message}`);
    return {
      status: 'failed',
      findings: [
        {
          subject: logPath,
          severity: 'error',
          title: `log-rotation failed mid-rotation`,
          body: `Attempted to rotate ${logPath} (${formatBytes(size)}) but hit an error: ${message}. The archive chain may be in an intermediate state — inspect ${logPath}.1 through .${MAX_ARCHIVES} and clean up manually if needed. The daemon will continue writing to whichever file currently exists at ${logPath}; if rotation left it missing, the next log call recreates it.`,
        },
      ],
      summary: `log-rotation: failed mid-rotation — ${message}`,
    };
  }

  log(`[sweeper:log-rotation] rotated ${logPath} (was ${formatBytes(size)})`);

  // Deliberately NO finding on successful rotation. A completed
  // rotation is a one-shot state CHANGE, not an ongoing problem —
  // the kink model is "something is wrong RIGHT NOW," and a
  // just-rotated log is the system working correctly.
  //
  // If we emitted a finding, each rotation would create a new
  // active kink (closed kinks don't participate in dedup, per the
  // writeOrBumpKink contract). Over weeks of uptime the kink queue
  // would accumulate rotation history that Sexton can't resolve
  // (the thing it describes already happened and is fine). The
  // summary below + the daemon log line above are the persistent
  // record; the runner's auto-resolve path correctly closes any
  // prior error-case rotation kink on this successful run.
  //
  // Error cases above DO emit findings — those represent an active
  // bad state (archive chain in intermediate state) that wants
  // attention until the next successful rotation clears it.
  return {
    status: 'completed',
    findings: [],
    summary: `log-rotation: rotated ${formatBytes(size)} → fresh log.`,
  };
}

function archivePath(logPath: string, index: number): string {
  return `${logPath}.${index}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
