/**
 * Supervisor template module — platform-agnostic entry point for
 * rendering OS-level daemon supervisor configs.
 *
 * The three per-platform renderers (systemd / launchd / task-scheduler)
 * are pure functions exported individually for tests and for callers
 * that want a specific platform without going through detection.
 *
 * The public API most callers want is `renderServiceForPlatform`:
 * given a `SupervisorPlatform` value and opts, dispatch to the right
 * renderer and return a `ServiceArtifact`. Platform detection itself
 * lives in the CLI layer (install-service inspects `process.platform`
 * at invocation time) — keeping that out of `@claudecorp/shared` so
 * shared remains environment-free (node-platform references stay in
 * the daemon/CLI packages that actually run in a specific env).
 *
 * Why a single dispatcher instead of letting callers switch by hand:
 * install-service would otherwise grow a three-way switch that
 * repeats the platform→renderer mapping each time a new renderer
 * lands. Centralizing it here means adding a new platform (e.g.
 * BSD with rc.d) is one function + one case added to this module,
 * and every caller picks it up.
 */

export type { SupervisorPlatform, ServiceOpts, ServiceArtifact } from './types.js';
export { renderSystemdService } from './systemd.js';
export { renderLaunchdPlist } from './launchd.js';
export { renderTaskSchedulerXml } from './task-scheduler.js';

import type { SupervisorPlatform, ServiceOpts, ServiceArtifact } from './types.js';
import { renderSystemdService } from './systemd.js';
import { renderLaunchdPlist } from './launchd.js';
import { renderTaskSchedulerXml } from './task-scheduler.js';

/**
 * Thrown when `renderServiceForPlatform` is called with a platform
 * that has no shipped renderer. The CLI catches this and surfaces a
 * clean error to the user ("your platform isn't supported yet; pass
 * --daemon-command and install manually") rather than letting an
 * undefined-result propagate.
 */
export class UnsupportedPlatformError extends Error {
  constructor(readonly platform: string) {
    super(`No supervisor renderer for platform "${platform}" — supported: linux, darwin, win32`);
    this.name = 'UnsupportedPlatformError';
  }
}

/**
 * Render the supervisor artifact for the given platform. Throws
 * `UnsupportedPlatformError` for anything outside the three
 * supported values.
 */
export function renderServiceForPlatform(
  platform: SupervisorPlatform,
  opts: ServiceOpts,
): ServiceArtifact {
  switch (platform) {
    case 'linux':
      return renderSystemdService(opts);
    case 'darwin':
      return renderLaunchdPlist(opts);
    case 'win32':
      return renderTaskSchedulerXml(opts);
    default: {
      // Type-exhaustive default guard — if SupervisorPlatform ever
      // grows a member, TS flags this. Also catches the case of a
      // caller passing a string that got widened past the union.
      const _exhaustive: never = platform;
      throw new UnsupportedPlatformError(_exhaustive);
    }
  }
}
