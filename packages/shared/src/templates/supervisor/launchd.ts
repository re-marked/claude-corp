/**
 * launchd LaunchAgent renderer for the Claude Corp daemon.
 *
 * Targets the USER LaunchAgent location (`~/Library/LaunchAgents/`),
 * not the system LaunchDaemon location. LaunchAgents run in the
 * user's security context at login; LaunchDaemons run as root at
 * boot. Claude Corp belongs in the user's context — it reads/writes
 * the user's home directory, uses the user's credentials for
 * Anthropic API calls, and shouldn't require sudo to install.
 *
 * The plist lands at `~/Library/LaunchAgents/com.claudecorp.daemon.plist`.
 * Activation is one command: `launchctl load <path>` registers the
 * service AND starts it (via `RunAtLoad=true`).
 *
 * Keys we set and why:
 *
 *   Label               Reverse-DNS unique id. Convention matches
 *                       other user-installed services on macOS.
 *   ProgramArguments    Execv-style command array. We wrap in
 *                       /bin/sh -c to handle arbitrary shell syntax
 *                       in `daemonCommand` (quoting, &&, env vars,
 *                       etc.) — launchd doesn't do shell parsing.
 *   RunAtLoad           Start immediately on load AND on login.
 *   KeepAlive           Restart on exit, regardless of exit code.
 *                       Combined with RunAtLoad this is the
 *                       unkillability primitive: launchd respawns
 *                       the daemon every time it dies.
 *   StandardOutPath     Redirect stdout to ~/Library/Logs/claudecorp/.
 *   StandardErrorPath   Redirect stderr to the same dir, separate file.
 *                       Using ~/Library/Logs/ not /tmp — tmp clears
 *                       on reboot, losing debugging history.
 *   WorkingDirectory    Run from the user's home. Defensive; prevents
 *                       surprise-cwd from whatever invoked launchctl.
 *
 * One launchd quirk worth naming: the `RunAtLoad + KeepAlive`
 * combination can tight-loop if the daemon crashes instantly on
 * startup. launchd has a built-in throttle (10 seconds between
 * restart attempts when the previous run exited in under 10s), so
 * a crash-loop gets auto-throttled without us having to spec it.
 * Our Pulse's own continuity chain picks up from the other end
 * (Alarum wakes Sexton when the daemon's been up long enough for
 * her state to be readable).
 */

import { join } from 'node:path';
import type { ServiceOpts, ServiceArtifact } from './types.js';

/**
 * Minimal XML escape for the five plist-relevant entities. plists
 * are XML, so any user-supplied string (daemonCommand, log paths)
 * that might contain `<`, `&`, etc. needs escaping. homeDir rarely
 * hits these but belt-and-suspenders.
 */
function escapePlist(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Why ProgramArguments uses `bash -lc` instead of `/bin/sh -c`:
 * launchd-spawned processes inherit a minimal PATH. Users managing
 * Node via nvm/volta/fnm (very common on macOS) have their node
 * version only on PATH after shell init files (.zshrc / .bash_profile)
 * run. Non-interactive /bin/sh doesn't source those, so
 * `cc-cli start` fails with "command not found." `bash -lc` forces
 * a login shell which loads the user's interactive environment.
 *
 * Why ThrottleInterval=10: launchd has an internal 10-second
 * minimum between restarts, but making it explicit guarantees the
 * behavior against any future default change and documents the
 * intent. If the daemon exits instantly, launchd waits 10s before
 * respawning — enough gap to not burn CPU in a hard crash-loop.
 * Unlike systemd, launchd has no total-failure-cap primitive; that
 * trade-off is inherent to the platform. A buggy daemon under
 * launchd will throttle but still retry forever, which is worse
 * than systemd's failed-state but better than an unthrottled loop.
 */
function renderPlistFile(daemonCommand: string, homeDir: string): string {
  const logDir = join(homeDir, 'Library', 'Logs', 'claudecorp').replace(/\\/g, '/');
  const stdoutPath = `${logDir}/daemon.log`;
  const stderrPath = `${logDir}/daemon.err`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claudecorp.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>${escapePlist(daemonCommand)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>WorkingDirectory</key>
  <string>${escapePlist(homeDir.replace(/\\/g, '/'))}</string>
  <key>StandardOutPath</key>
  <string>${escapePlist(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(stderrPath)}</string>
</dict>
</plist>
`;
}

export function renderLaunchdPlist(opts: ServiceOpts): ServiceArtifact {
  const path = join(opts.homeDir, 'Library', 'LaunchAgents', 'com.claudecorp.daemon.plist');
  // activationCommand references the literal tilde'd path that the
  // user would type at their shell (launchctl expands ~).
  return {
    content: renderPlistFile(opts.daemonCommand, opts.homeDir),
    path,
    activationCommand: 'launchctl load ~/Library/LaunchAgents/com.claudecorp.daemon.plist',
    activationDescription:
      'Registers the LaunchAgent with launchd and starts it immediately. Auto-starts on every login thereafter. Logs land in ~/Library/Logs/claudecorp/.',
  };
}
