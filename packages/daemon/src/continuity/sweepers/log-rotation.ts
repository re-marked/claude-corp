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

import { DAEMON_LOG_PATH } from '@claudecorp/shared';
import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { log, logError } from '../../logger.js';
import type { SweeperContext, SweeperResult, SweeperFinding } from './types.js';

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
  // Unused but kept in the signature so the module type-conforms
  // — future variants might consume Daemon state to decide
  // (e.g., never rotate mid-incident).
  void ctx;

  const findings: SweeperFinding[] = [];

  if (!existsSync(DAEMON_LOG_PATH)) {
    return {
      status: 'noop',
      findings: [],
      summary: `log-rotation: no daemon log at ${DAEMON_LOG_PATH} (daemon may not have written yet).`,
    };
  }

  let size: number;
  try {
    size = statSync(DAEMON_LOG_PATH).size;
  } catch (err) {
    return {
      status: 'failed',
      findings: [],
      summary: `log-rotation: stat on ${DAEMON_LOG_PATH} failed — ${err instanceof Error ? err.message : String(err)}`,
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
      const src = archivePath(i);
      const dst = archivePath(i + 1);
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
    const overflow = archivePath(MAX_ARCHIVES + 1);
    if (existsSync(overflow)) {
      try {
        unlinkSync(overflow);
      } catch {
        // Best-effort cleanup; don't fail rotation over an
        // over-cap file.
      }
    }

    // Rotate the live log into slot 1.
    const slot1 = archivePath(1);
    if (existsSync(slot1)) unlinkSync(slot1);
    renameSync(DAEMON_LOG_PATH, slot1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[sweeper:log-rotation] rotation failed: ${message}`);
    return {
      status: 'failed',
      findings: [
        {
          subject: DAEMON_LOG_PATH,
          severity: 'error',
          title: `log-rotation failed mid-rotation`,
          body: `Attempted to rotate ${DAEMON_LOG_PATH} (${formatBytes(size)}) but hit an error: ${message}. The archive chain may be in an intermediate state — inspect ${DAEMON_LOG_PATH}.1 through .${MAX_ARCHIVES} and clean up manually if needed. The daemon will continue writing to whichever file currently exists at ${DAEMON_LOG_PATH}; if rotation left it missing, the next log call recreates it.`,
        },
      ],
      summary: `log-rotation: failed mid-rotation — ${message}`,
    };
  }

  log(`[sweeper:log-rotation] rotated ${DAEMON_LOG_PATH} (was ${formatBytes(size)})`);

  findings.push({
    subject: DAEMON_LOG_PATH,
    severity: 'info',
    title: `Rotated daemon log (was ${formatBytes(size)})`,
    body: `Rotated ${DAEMON_LOG_PATH} from ${formatBytes(size)} to a fresh empty file. Prior contents archived as ${DAEMON_LOG_PATH}.1; older archives shifted down the chain (up to .${MAX_ARCHIVES}). The daemon's next write recreates the live log automatically.`,
  });

  return {
    status: 'completed',
    findings,
    summary: `log-rotation: rotated ${formatBytes(size)} → fresh log.`,
  };
}

function archivePath(index: number): string {
  return `${DAEMON_LOG_PATH}.${index}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
