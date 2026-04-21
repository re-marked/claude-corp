/**
 * `cc-cli chit` — Unified work-record primitive management.
 *
 * Top-level dispatcher that routes `cc-cli chit <subcommand>` to the
 * right handler. Each subcommand parses its own args (rather than
 * forcing the top-level cli to know every chit-specific flag), keeping
 * the main cli dispatcher thin and letting each command evolve its own
 * interface.
 */

export async function cmdChit(rawArgs: string[]): Promise<void> {
  // rawArgs = everything after 'chit', e.g. ['create', '--type', 'task']
  //           or ['read', 'chit-t-abc', '--json']
  const subcommand = rawArgs[0];
  const subArgs = rawArgs.slice(1); // strip the subcommand name

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printChitHelp();
    return;
  }

  switch (subcommand) {
    case 'create': {
      const { cmdChitCreate } = await import('./chit/create.js');
      await cmdChitCreate(subArgs);
      break;
    }
    case 'read': {
      const { cmdChitRead } = await import('./chit/read.js');
      await cmdChitRead(subArgs);
      break;
    }
    case 'update': {
      const { cmdChitUpdate } = await import('./chit/update.js');
      await cmdChitUpdate(subArgs);
      break;
    }
    case 'close': {
      const { cmdChitClose } = await import('./chit/close.js');
      await cmdChitClose(subArgs);
      break;
    }
    default: {
      console.error(`Unknown chit subcommand: ${subcommand}`);
      console.error('');
      printChitHelp();
      process.exit(1);
    }
  }
}

function printChitHelp(): void {
  console.log(`cc-cli chit — Unified work-record primitive

Usage: cc-cli chit <subcommand> [options]

Subcommands:
  create    Create a new chit of a given type
  read      Read a chit by id (resolves scope automatically)
  update    Patch status, tags, links, fields, or body
  close     Transition a chit to a terminal status
  list      Query chits with filters (coming)
  promote   Flip ephemeral → permanent (coming)
  archive   Move a closed chit to _archive/ (coming)

Common flags:
  --from <member-id>     Author (required for agents; founder implied otherwise)
  --corp <name>          Operate on a specific corp (defaults to active)
  --json                 Output JSON (machine-readable)
  --help                 Show this help

Run 'cc-cli chit <subcommand> --help' for subcommand-specific options.

Every work-record in Claude Corp is a chit — tasks, observations,
contracts, caskets, handoffs, dispatch-contexts, pre-brain-entries,
step-logs. One primitive, many types, consistent interface.`);
}
