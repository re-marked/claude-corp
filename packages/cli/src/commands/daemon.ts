/**
 * `cc-cli daemon` — Daemon-level operations.
 *
 * Currently one subcommand (install-service). Structured as a group
 * from the start so additions (status, logs, uninstall-service)
 * land without renaming anything user-facing.
 */

export async function cmdDaemon(rawArgs: string[]): Promise<void> {
  const subcommand = rawArgs[0];
  const subArgs = rawArgs.slice(1);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printDaemonHelp();
    return;
  }

  switch (subcommand) {
    case 'install-service': {
      const { cmdDaemonInstallService } = await import('./daemon/install-service.js');
      await cmdDaemonInstallService(subArgs);
      break;
    }
    case 'uninstall-service': {
      const { cmdDaemonUninstallService } = await import('./daemon/uninstall-service.js');
      await cmdDaemonUninstallService(subArgs);
      break;
    }
    default: {
      console.error(`cc-cli daemon: unknown subcommand "${subcommand}"`);
      console.error('');
      printDaemonHelp();
      process.exit(1);
    }
  }
}

function printDaemonHelp(): void {
  console.log(`cc-cli daemon — Daemon-level operations

Usage:
  cc-cli daemon <subcommand> [options]

Subcommands:
  install-service     Generate an OS-level supervisor config so the daemon
                      auto-restarts on crash + auto-starts on login.
                      Platforms: Linux (systemd), macOS (launchd), Windows
                      (Task Scheduler). Writes the config file; prints the
                      one-liner to activate it. Does NOT auto-activate.

  uninstall-service   Inverse: prints the deactivation command for you to
                      run (stops + unregisters the service), then deletes
                      the on-disk config file. --force skips the delete
                      confirmation; --dry-run previews without touching
                      anything.

Flags are per-subcommand. Try \`cc-cli daemon install-service --help\`.
`);
}
