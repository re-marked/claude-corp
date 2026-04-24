/**
 * systemd user-service renderer for the Claude Corp daemon.
 *
 * We target the USER systemd instance (`systemctl --user`), not the
 * system one, for two reasons:
 *
 *   1. No sudo required. Registering a user service is a pure-
 *      userspace operation; the user who runs `cc-cli daemon
 *      install-service` is the one whose daemon gets managed. This
 *      matches Claude Corp's "runs in the user's account with the
 *      user's file permissions" trust model.
 *
 *   2. Restart semantics are correct without privilege escalation.
 *      `Restart=always` + `RestartSec=5` mean systemd respawns the
 *      daemon on crash, on OOM kill, on non-zero exit, and on
 *      clean shutdown — everything except an explicit
 *      `systemctl --user stop`.
 *
 * The unit file lands at `~/.config/systemd/user/claudecorp-daemon.service`
 * — systemd's canonical user-unit location. Activation is two
 * commands the user runs once: `daemon-reload` to pick up the new
 * file, then `enable --now` to start it AND mark it for start-at-
 * login.
 *
 * One systemd-specific subtlety: `WantedBy=default.target` (not
 * `multi-user.target` which is the system-level equivalent).
 * `default.target` for user services maps to whichever target the
 * user's systemd instance considers default, usually `graphical-
 * session.target` on desktops or equivalent on headless servers.
 * Using `multi-user.target` in a user unit is a common bug that
 * silently fails to auto-start.
 */

import { join } from 'node:path';
import type { ServiceOpts, ServiceArtifact } from './types.js';

/**
 * The systemd unit file content. `daemonCommand` lands verbatim in
 * ExecStart — systemd's ExecStart handles normal shell-command
 * strings (no interpolation quirks for our case). Logs go to the
 * journal via default systemd stdout/stderr capture; the user reads
 * them with `journalctl --user -u claudecorp-daemon`.
 */
/**
 * Why ExecStart wraps in `bash -lc` instead of running daemonCommand
 * directly: systemd user services inherit a minimal PATH. Users who
 * manage Node via nvm/volta/fnm (very common) have node installed
 * in a version-manager-specific directory (e.g. ~/.nvm/versions/...)
 * that's only added to PATH by their shell's init files (.bashrc,
 * .profile, .zshrc). A non-interactive systemd-spawned process
 * never sources those, so `cc-cli start` fails with "cc-cli not
 * found" unless we explicitly load the login-shell environment.
 *
 * `bash -lc` forces a login shell which sources the right init
 * files, getting node and cc-cli onto PATH the way the user's
 * interactive shell does. Cost: one extra fork at service start
 * (negligible). Benefit: works out of the box for the dominant
 * dev-environment shape.
 *
 * Why StartLimitBurst + StartLimitIntervalSec: Restart=always loops
 * indefinitely by default. A daemon with a startup-time bug could
 * fail-restart thousands of times per hour, burning CPU without
 * anyone noticing until the 5-minute Pulse tick fires and notices
 * the daemon's been up for 2 seconds every tick. The burst cap
 * gives up after 5 failed restarts in 60 seconds, leaving the
 * service in `failed` state visible in `systemctl --user status`.
 */
function renderUnitFile(daemonCommand: string): string {
  // Escape single quotes in daemonCommand for safe embedding inside
  // the single-quoted bash -lc payload. End-users rarely have
  // single quotes in their command, but cheap to do right.
  const safeCommand = daemonCommand.replace(/'/g, `'\\''`);
  return `[Unit]
Description=Claude Corp Daemon
Documentation=https://github.com/re-marked/claude-corp
# network-online.target (not plain network.target): network.target
# fires when the network stack is configured, which is BEFORE
# connectivity is up. The daemon makes Anthropic API calls at
# startup — without network-online, slow-DNS / slow-VPN / laptop-
# resuming-from-sleep boots can burn all 5 restart attempts in
# 60s (StartLimit below) before the network is actually reachable,
# leaving the unit in failed state at login.
#
# Wants= is paired with After= deliberately. After= only controls
# ordering — you can't be "after" a target that never gets
# activated. Wants= pulls network-online.target into the dependency
# graph so it actually fires. Without Wants=, After= is a no-op on
# systems where nothing else requires network-online.
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash -lc '${safeCommand}'
Restart=always
RestartSec=5
# Cap restart loops — if startup fails 5 times in 60s, give up and
# leave the service in failed state (visible via systemctl --user
# status claudecorp-daemon). A healthy daemon won't hit this.
StartLimitBurst=5
StartLimitIntervalSec=60
# Keep stdout/stderr going to the journal. View with:
#   journalctl --user -u claudecorp-daemon -f

[Install]
WantedBy=default.target
`;
}

export function renderSystemdService(opts: ServiceOpts): ServiceArtifact {
  const path = join(opts.homeDir, '.config', 'systemd', 'user', 'claudecorp-daemon.service');
  return {
    content: renderUnitFile(opts.daemonCommand),
    path,
    activationCommand:
      'systemctl --user daemon-reload && systemctl --user enable --now claudecorp-daemon.service',
    activationDescription:
      'Reloads systemd to pick up the new unit file, then enables the service (starts it now + auto-starts on login).',
    deactivationCommand:
      'systemctl --user disable --now claudecorp-daemon.service && systemctl --user daemon-reload',
    deactivationDescription:
      'Stops the running service, disables auto-start on login, then reloads systemd to drop the unit from its cache.',
  };
}
