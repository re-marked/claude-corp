/**
 * `cc-cli bacteria` — observability + control surface for the
 * auto-scaling Employee pool organism.
 *
 * Project 1.10.4. Subcommand groups:
 *   status   — colony view per role (active count, today's
 *              mitoses/apoptoses, mean lifespan, peak)
 *   lineage  — family tree visualization for a role pool
 *   pause    — stop bacteria's mitose+apoptose for a role
 *   resume   — re-enable a paused role
 *   evict    — manually apoptose a specific slot (idle slots only)
 */

export async function cmdBacteria(rawArgs: string[]): Promise<void> {
  const subcommand = rawArgs[0];
  const subArgs = rawArgs.slice(1);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printBacteriaHelp();
    return;
  }

  switch (subcommand) {
    case 'status': {
      const { cmdBacteriaStatus } = await import('./bacteria/status.js');
      await cmdBacteriaStatus(subArgs);
      break;
    }
    default: {
      console.error(`cc-cli bacteria: unknown subcommand "${subcommand}"`);
      console.error('');
      printBacteriaHelp();
      process.exit(1);
    }
  }
}

function printBacteriaHelp(): void {
  console.log(`cc-cli bacteria — auto-scaling Employee pool observability + control

Usage:
  cc-cli bacteria <subcommand> [options]

Subcommands:
  status              Per-role colony view: active count, today's
                      mitoses/apoptoses, mean lifespan, peak count.

Flags are per-subcommand. Try \`cc-cli bacteria status --help\`.
`);
}
