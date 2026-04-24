/**
 * `cc-cli daemon uninstall-service` — The inverse of install-service.
 *
 * Symmetric action: stop the running service, unregister it from
 * the OS supervisor, delete the on-disk config file. Leaves the
 * daemon itself in whatever state it was in (running or not); this
 * command only touches the supervisor layer.
 *
 * Like install-service, this prints the OS-level deactivation
 * command and asks the user to run it — we don't shell out to
 * systemctl / launchctl / schtasks ourselves because system-wide
 * state change deserves explicit consent.
 *
 * What IS automated:
 *   - Detecting the platform
 *   - Resolving the canonical config path
 *   - Deleting the config file (after user confirms / passes --force)
 *   - Printing the deactivation command alongside the file removal
 *
 * The expected flow:
 *   1. User runs `cc-cli daemon uninstall-service`
 *   2. Command prints the deactivation command for them to run
 *   3. Command asks: "also delete the on-disk config file?"
 *   4. On yes (or --force), deletes the file
 *
 * Simpler mental model: uninstall = "stop the supervisor + clean
 * up the config I put on disk at install time." The user runs one
 * OS-level command; we handle the file.
 */

import { parseArgs } from 'node:util';
import { unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  renderServiceForPlatform,
  UnsupportedPlatformError,
  type SupervisorPlatform,
} from '@claudecorp/shared';

const HELP = `cc-cli daemon uninstall-service — Remove the OS supervisor config.

Usage:
  cc-cli daemon uninstall-service [options]

Options:
  --dry-run                  Print what would be removed without touching
                             disk.
  --force                    Skip the confirmation prompt and delete the
                             config file unconditionally.
  --help                     Show this help.

Behavior:
  1. Detects your OS (linux/darwin/win32).
  2. Looks up the canonical config path for your platform.
  3. Prints the deactivation command for you to run (systemctl disable,
     launchctl unload, schtasks delete). Does NOT auto-run it.
  4. Deletes the on-disk config file (if present).

The deactivation command unregisters the service from the OS
supervisor. The file deletion cleans up the config Claude Corp wrote
at install time. Both are needed to fully undo install-service;
neither happens without explicit user action.

Examples:
  cc-cli daemon uninstall-service --dry-run
  cc-cli daemon uninstall-service
  cc-cli daemon uninstall-service --force
`;

export async function cmdDaemonUninstallService(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  const v = parsed.values;

  if (v.help) {
    console.log(HELP);
    return;
  }

  // --- 1. Platform detection --------------------------------------
  const platform = process.platform;
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    console.error(
      `cc-cli daemon uninstall-service: platform "${platform}" is not supported. ` +
        `Shipped renderers: linux (systemd), darwin (launchd), win32 (Task Scheduler).`,
    );
    process.exit(1);
  }
  const supervisorPlatform: SupervisorPlatform = platform;

  // --- 2. Resolve artifact (only need path + deactivation info) ---
  // daemonCommand doesn't matter for uninstall — renderers pin the
  // path from homeDir alone. We pass a placeholder to satisfy the
  // shared type.
  let artifact;
  try {
    artifact = renderServiceForPlatform(supervisorPlatform, {
      daemonCommand: '<not-relevant-for-uninstall>',
      homeDir: homedir(),
    });
  } catch (err) {
    if (err instanceof UnsupportedPlatformError) {
      console.error(`cc-cli daemon uninstall-service: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // --- 3. Dry-run path --------------------------------------------
  if (v['dry-run']) {
    console.log(`[DRY RUN] Would remove:`);
    console.log(`  ${artifact.path}  ${existsSync(artifact.path) ? '(exists)' : '(not present)'}`);
    console.log('');
    console.log(`Before deleting the file, run (yourself):`);
    console.log(`  ${artifact.deactivationCommand}`);
    console.log('');
    console.log(artifact.deactivationDescription);
    return;
  }

  // --- 4. Print deactivation command FIRST ------------------------
  // Ordering matters: the user has to stop + unregister the service
  // before we delete its config file, otherwise the OS supervisor
  // retains a reference to a file that no longer exists. Print the
  // command prominently; prompt for file deletion after.
  console.log(`Step 1 — run this to stop + unregister the service from your OS:`);
  console.log(`  ${artifact.deactivationCommand}`);
  console.log('');
  console.log(artifact.deactivationDescription);
  console.log('');

  // --- 5. Delete the on-disk config -------------------------------
  if (!existsSync(artifact.path)) {
    console.log(`Step 2 — config file already gone (${artifact.path}). Nothing to delete.`);
    return;
  }

  if (!v.force) {
    console.log(`Step 2 — delete the on-disk config file?`);
    console.log(`  ${artifact.path}`);
    console.log(`  (Re-run with --force to confirm deletion, or remove it manually.)`);
    return;
  }

  try {
    unlinkSync(artifact.path);
    console.log(`Step 2 — deleted ${artifact.path}`);
  } catch (err) {
    console.error(
      `cc-cli daemon uninstall-service: failed to delete ${artifact.path} — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  console.log('');
  console.log(
    `Uninstall complete. Re-run \`cc-cli daemon install-service\` any time to restore.`,
  );
}
