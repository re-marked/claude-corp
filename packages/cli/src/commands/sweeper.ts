/**
 * `cc-cli sweeper` — Sexton's workers, on-demand.
 *
 * Currently one subcommand (run). Structured as a group from the
 * start so additions (list, show, close, cast, new) land without
 * renaming anything user-facing.
 *
 * ### What a sweeper is
 *
 * A single-purpose code module Sexton invokes during her patrol to
 * do mechanical maintenance work — respawn dead slots, reconcile
 * members.json vs workspace directories, flag malformed chits,
 * rotate logs. Each sweeper returns structured observations that
 * Sexton reads, judges, and escalates when needed.
 *
 * ### Intended caller
 *
 * Sexton herself, from within her dispatch session:
 *   cc-cli sweeper run silentexit
 *
 * Founder can also invoke manually for diagnostic use:
 *   cc-cli sweeper run silentexit --json
 */

export async function cmdSweeper(rawArgs: string[]): Promise<void> {
  const subcommand = rawArgs[0];
  const subArgs = rawArgs.slice(1);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printSweeperHelp();
    return;
  }

  switch (subcommand) {
    case 'run': {
      const { cmdSweeperRun } = await import('./sweeper/run.js');
      await cmdSweeperRun(subArgs);
      break;
    }
    default: {
      console.error(`cc-cli sweeper: unknown subcommand "${subcommand}"`);
      console.error('');
      printSweeperHelp();
      process.exit(1);
    }
  }
}

function printSweeperHelp(): void {
  console.log(`cc-cli sweeper — Sexton's workers, on-demand

Usage:
  cc-cli sweeper <subcommand> [options]

Subcommands:
  run <name>          Invoke a code sweeper by name. Posts to the
                      daemon's /sweeper/run endpoint; prints the
                      SweeperResult (status, kinks recorded,
                      one-line summary).

Known sweepers (v1):
  silentexit          Respawn slots whose process died without
                      clean exit + pending Casket work. Honors
                      fire/archive. No-op on pure-claude-code
                      corps where no long-running process dies.
  agentstuck          Flag live agents whose current task hasn't
                      moved in 30+ min (not dead — stuck).
  orphantask          Find queued tasks with no assignee or an
                      archived assignee + no active blocker.
  phantom-cleanup     Reconcile members.json against on-disk
                      agent workspace dirs (both directions).
  chit-hygiene        Walk the chit store; flag malformed chits
                      + orphan references/dependsOn pointers.
  log-rotation        Rotate the daemon log when it grows past
                      10MB; keep up to 5 archived rotations.

Findings are written as kink chits with per-(source,subject)
dedup + runner-driven auto-resolve. Query open kinks via
\`cc-cli chit list --type kink --status active\`.

Flags are per-subcommand. Try \`cc-cli sweeper run --help\`.
`);
}
