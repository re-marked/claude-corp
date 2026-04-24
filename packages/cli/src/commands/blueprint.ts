/**
 * `cc-cli blueprint` — top-level dispatcher for the Project 1.8
 * blueprint CLI surface.
 *
 * Routes `cc-cli blueprint <subcommand>` to the right handler. Each
 * subcommand owns its own arg parsing via node:util's parseArgs so
 * the dispatcher stays thin and subcommands evolve independently.
 *
 * This file REPLACES the pre-1.8 prose-blueprint reader (which walked
 * <corpRoot>/blueprints/*.md as human-readable runbooks). Blueprints
 * are now chits (type: 'blueprint'); the CLI consumes them via the
 * shared primitives from PRs 1-2 (parseBlueprint, castFromBlueprint,
 * findBlueprintByName, listBlueprintChits).
 *
 * Subcommands land incrementally across PR 3 commits:
 *   commit 2: new         (THIS commit)
 *   commit 3: list, show
 *   commit 4: validate, cast
 * Each subcommand lives in packages/cli/src/commands/blueprint/<name>.ts.
 * The dispatcher's switch grows as subcommands land — dynamic imports
 * fail type-check if a module doesn't exist, so we only route to what's
 * actually wired. Running 'cc-cli blueprint list' before commit 3 lands
 * hits the "unknown subcommand" fallthrough with the help screen.
 */

export async function cmdBlueprint(rawArgs: string[]): Promise<void> {
  const subcommand = rawArgs[0];
  const subArgs = rawArgs.slice(1);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printBlueprintHelp();
    return;
  }

  switch (subcommand) {
    case 'new': {
      const { cmdBlueprintNew } = await import('./blueprint/new.js');
      await cmdBlueprintNew(subArgs);
      break;
    }
    default: {
      console.error(`Unknown blueprint subcommand: ${subcommand}`);
      console.error('');
      printBlueprintHelp();
      process.exit(1);
    }
  }
}

function printBlueprintHelp(): void {
  console.log(`cc-cli blueprint — Reusable workflow templates (Project 1.8)

Usage: cc-cli blueprint <subcommand> [options]

Subcommands:
  new       Scaffold a new draft blueprint chit
  list      Query blueprints (default: active only, all scopes)
  show      Render a blueprint human-readable
  validate  Parse a draft blueprint; on success, promote to active
  cast      Cast a Contract + Task chain from a blueprint + vars

Common flags:
  --scope <scope>        Scope (corp / project:<name> / agent:<slug>)
  --from <member-id>     Author identity (required for agents)
  --corp <name>          Operate on a specific corp (defaults to active)
  --help                 Show this help

Run 'cc-cli blueprint <subcommand> --help' for subcommand-specific options.

A blueprint is a chit (type='blueprint') carrying a DAG of steps +
typed variables. Cast expands Handlebars templates against caller vars
and produces a Contract chit + Task chain that walks the DAG.`);
}
