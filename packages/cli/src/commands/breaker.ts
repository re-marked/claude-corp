/**
 * `cc-cli breaker` — founder controls for the crash-loop circuit
 * breaker (Project 1.11). Subcommand groups:
 *   list   — active trips by default; --include-cleared for audit
 *   reset  — close an active trip so spawnAgent stops refusing
 *   show   — full forensic view of one trip
 *
 * Reset writes a chit; daemon's spawn-time findActiveBreaker picks
 * up the cleared state on the next attempt. No in-memory daemon
 * coordination needed (unlike bacteria evict, which mutates
 * members.json the daemon caches).
 */

export async function cmdBreaker(rawArgs: string[]): Promise<void> {
  const subcommand = rawArgs[0];
  const subArgs = rawArgs.slice(1);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printBreakerHelp();
    return;
  }

  switch (subcommand) {
    case 'list': {
      const { cmdBreakerList } = await import('./breaker/list.js');
      await cmdBreakerList(subArgs);
      break;
    }
    case 'reset': {
      const { cmdBreakerReset } = await import('./breaker/reset.js');
      await cmdBreakerReset(subArgs);
      break;
    }
    case 'show': {
      const { cmdBreakerShow } = await import('./breaker/show.js');
      await cmdBreakerShow(subArgs);
      break;
    }
    default: {
      console.error(`cc-cli breaker: unknown subcommand "${subcommand}"`);
      console.error('');
      printBreakerHelp();
      process.exit(1);
    }
  }
}

function printBreakerHelp(): void {
  console.log(`cc-cli breaker — crash-loop circuit breaker controls

Usage:
  cc-cli breaker <subcommand> [options]

Subcommands:
  list                    List active trips. --include-cleared for audit.
                          --role <id> filters by Member.role.
  reset --slug <slug>     Close an active trip. Subsequent spawn attempts
                          go through normally. --reason "..." records why.
  show <slug-or-trip-id>  Detailed view: full forensic context, all
                          referenced silent-exit kinks, spawn history.

Trips fire when the silent-exit sweeper sees a slot crash N times
within M minutes (defaults: 3 / 5min, per-role overrides via
RoleEntry.crashLoopThreshold + crashLoopWindowMs).
`);
}
