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
function renderUnitFile(daemonCommand: string): string {
  return `[Unit]
Description=Claude Corp Daemon
Documentation=https://github.com/re-marked/claude-corp
After=network.target

[Service]
Type=simple
ExecStart=${daemonCommand}
Restart=always
RestartSec=5
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
  };
}
