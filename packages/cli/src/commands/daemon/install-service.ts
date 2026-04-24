/**
 * `cc-cli daemon install-service` — Generate the OS-level supervisor
 * config so the daemon auto-restarts on crash + auto-starts on login.
 *
 * The outermost ring of Claude Corp's unkillability design. Pulse
 * keeps the continuity chain ticking while the daemon lives; this
 * command ensures the daemon itself gets resurrected if it dies.
 *
 * ### What this does
 *
 * 1. Detect the user's OS (process.platform). Supported values:
 *    linux, darwin, win32. Anything else exits with a clear error.
 *
 * 2. Resolve the daemon launch command:
 *      a. `--daemon-command "<cmd>"` if passed (dev use, explicit)
 *      b. Otherwise: if `cc-cli` is resolvable in PATH, use its
 *         absolute path + " start"
 *      c. Otherwise: fall back to bare "cc-cli start" AND print a
 *         warning that the supervisor may not find it on activation
 *
 * 3. Render the platform-appropriate artifact via the shared
 *    renderers (templates/supervisor/).
 *
 * 4. In --dry-run mode: print the target path, the content, and the
 *    activation command. Touch nothing on disk.
 *
 *    In default mode: mkdir the parent dir, write the file (failing
 *    with actionable guidance if a file already exists and --force
 *    wasn't passed), then print the activation command for the user
 *    to run.
 *
 * ### What this does NOT do
 *
 * - Auto-activate. Running `systemctl enable --now` or `launchctl
 *   load` on the user's behalf is a system-state change that
 *   deserves explicit user consent. We print the one-liner; they run
 *   it.
 *
 * - Install cc-cli into PATH. If the user's using a source checkout
 *   with no global install, they pass `--daemon-command` explicitly
 *   (probably something like `"node /abs/path/to/tui/dist/index.js"`
 *   or `"npx tsx /abs/path/to/packages/tui/src/index.tsx"`).
 *
 * - Uninstall or status-check. Future sibling commands
 *   (`cc-cli daemon uninstall-service`, `cc-cli daemon status`).
 *   Deferred until the core install path is proven.
 */

import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  renderServiceForPlatform,
  UnsupportedPlatformError,
  type SupervisorPlatform,
} from '@claudecorp/shared';

const HELP = `cc-cli daemon install-service — Generate an OS-level supervisor config.

Usage:
  cc-cli daemon install-service [options]

Options:
  --daemon-command "<cmd>"   Full command the supervisor invokes.
                             Defaults to absolute cc-cli path + " start"
                             if cc-cli is in PATH; otherwise "cc-cli start"
                             (with a warning).
  --dry-run                  Print what would be written without touching
                             disk.
  --force                    Overwrite an existing service config file.
  --help                     Show this help.

Behavior:
  - Detects your OS (linux/darwin/win32) and renders the right config.
  - Writes to the canonical location per platform:
      linux:   ~/.config/systemd/user/claudecorp-daemon.service
      darwin:  ~/Library/LaunchAgents/com.claudecorp.daemon.plist
      win32:   ~/.claudecorp/supervisor/claudecorp-daemon.xml
  - Prints the one-liner to activate. Does NOT auto-run it.

Why you'd use this:
  The Pulse/Alarum/Sexton chain keeps agents alive while the daemon
  runs. This command keeps the daemon itself alive across OS-level
  kills (OOM, panic, restart, explicit shutdown). Together they
  produce true unkillability: the corp survives anything short of
  running out of tokens or the user explicitly stopping the service.

Examples:
  cc-cli daemon install-service
  cc-cli daemon install-service --dry-run
  cc-cli daemon install-service --daemon-command "npx tsx /path/to/tui/src/index.tsx"
  cc-cli daemon install-service --force
`;

export async function cmdDaemonInstallService(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      'daemon-command': { type: 'string' },
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
      `cc-cli daemon install-service: platform "${platform}" is not supported. ` +
        `Shipped renderers: linux (systemd), darwin (launchd), win32 (Task Scheduler). ` +
        `Install a supervisor config manually or open an issue.`,
    );
    process.exit(1);
  }
  const supervisorPlatform: SupervisorPlatform = platform;

  // --- 2. Resolve daemon command ----------------------------------
  let daemonCommand: string;
  if (typeof v['daemon-command'] === 'string' && v['daemon-command'].length > 0) {
    daemonCommand = v['daemon-command'];
  } else {
    const resolved = resolveCliAbsolutePath();
    if (resolved) {
      daemonCommand = `${quoteIfNeeded(resolved)} start`;
    } else {
      daemonCommand = 'cc-cli start';
      console.error(
        `cc-cli daemon install-service: WARNING — couldn't find cc-cli in PATH. ` +
          `Falling back to bare "cc-cli start". If the OS supervisor fails to launch the daemon ` +
          `on activation, rerun with --daemon-command "<absolute path to cc-cli> start" or ` +
          `--daemon-command "node /abs/path/to/tui/dist/index.js" for a source install.`,
      );
    }
  }

  // --- 3. Render artifact ------------------------------------------
  let artifact;
  try {
    artifact = renderServiceForPlatform(supervisorPlatform, {
      daemonCommand,
      homeDir: homedir(),
    });
  } catch (err) {
    if (err instanceof UnsupportedPlatformError) {
      console.error(`cc-cli daemon install-service: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // --- 4. Dry-run path --------------------------------------------
  if (v['dry-run']) {
    console.log(`[DRY RUN] Would write ${artifact.content.length} bytes to:`);
    console.log(`  ${artifact.path}`);
    console.log('');
    console.log('--- File content ---');
    console.log(artifact.content);
    console.log('--- End content ---');
    console.log('');
    console.log(`After writing, activate with:`);
    console.log(`  ${artifact.activationCommand}`);
    console.log('');
    console.log(artifact.activationDescription);
    return;
  }

  // --- 5. Real write path -----------------------------------------
  if (existsSync(artifact.path) && !v.force) {
    console.error(
      `cc-cli daemon install-service: ${artifact.path} already exists. ` +
        `Pass --force to overwrite, or --dry-run to see what would change.`,
    );
    process.exit(1);
  }

  try {
    mkdirSync(dirname(artifact.path), { recursive: true });
    writeFileSync(artifact.path, artifact.content, 'utf-8');
  } catch (err) {
    console.error(
      `cc-cli daemon install-service: failed to write ${artifact.path} — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  console.log(`Wrote ${artifact.path}`);
  console.log('');
  console.log(`To activate (run this yourself — not auto-run):`);
  console.log(`  ${artifact.activationCommand}`);
  console.log('');
  console.log(artifact.activationDescription);
  console.log('');
  console.log(
    `Once activated, the daemon will auto-start on login + restart on crash. ` +
      `Combined with Pulse/Alarum/Sexton (agent-level unkillability), the corp ` +
      `survives anything short of running out of tokens.`,
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Best-effort PATH lookup for cc-cli. Returns the absolute path if
 * found, empty string otherwise. Swallows execution errors — this
 * is diagnostic, not load-bearing; the caller decides what to do
 * with empty.
 *
 * Uses `where cc-cli` on Windows, `which cc-cli` elsewhere. Both
 * print the resolved path to stdout and exit non-zero if not found.
 */
function resolveCliAbsolutePath(): string {
  const lookup = process.platform === 'win32' ? 'where cc-cli' : 'which cc-cli';
  try {
    const out = execSync(lookup, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const firstLine = out.trim().split(/\r?\n/)[0];
    return firstLine ?? '';
  } catch {
    return '';
  }
}

/**
 * Wrap a path in double quotes if it contains whitespace. Necessary
 * for paths like "C:\Program Files\nodejs\cc-cli.cmd" embedded into
 * ExecStart / ProgramArguments / schtasks Arguments. No quoting
 * needed if the path is whitespace-free — avoids introducing weird
 * quotes into common cases.
 */
function quoteIfNeeded(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}
