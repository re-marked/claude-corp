/**
 * `cc-cli inbox` — Tiered inbox management.
 *
 * Top-level dispatcher routing `cc-cli inbox <subcommand>` to the
 * right handler. Subcommands:
 *
 *   list            — query open items, filter by tier
 *   respond         — close an item as responded (agent engaged)
 *   dismiss         — close an item as dismissed (requires reason
 *                     on Tier 3; rejects --not-important on Tier 3)
 *   carry-forward   — defer an item with a justification; counts
 *                     as resolved for audit purposes but preserves
 *                     visibility in the next wtf render
 *   check           — UserPromptSubmit hook integration; emits a
 *                     system-reminder block listing items created
 *                     since `.inbox-last-checked`
 *
 * Each subcommand parses its own args. This dispatcher stays thin —
 * it just routes.
 */

export async function cmdInbox(rawArgs: string[]): Promise<void> {
  const subcommand = rawArgs[0];
  const subArgs = rawArgs.slice(1);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printInboxHelp();
    return;
  }

  switch (subcommand) {
    case 'list': {
      const { cmdInboxList } = await import('./inbox/list.js');
      await cmdInboxList(subArgs);
      break;
    }
    case 'respond': {
      const { cmdInboxRespond } = await import('./inbox/respond.js');
      await cmdInboxRespond(subArgs);
      break;
    }
    case 'dismiss': {
      const { cmdInboxDismiss } = await import('./inbox/dismiss.js');
      await cmdInboxDismiss(subArgs);
      break;
    }
    case 'carry-forward': {
      const { cmdInboxCarryForward } = await import('./inbox/carry-forward.js');
      await cmdInboxCarryForward(subArgs);
      break;
    }
    // check arrives in a follow-up commit on this branch. Until then,
    // fall through to the unknown-subcommand path.
    default: {
      console.error(`cc-cli inbox: unknown subcommand "${subcommand}"`);
      console.error('');
      printInboxHelp();
      process.exit(1);
    }
  }
}

function printInboxHelp(): void {
  console.log(`cc-cli inbox — Tiered inbox management

Usage:
  cc-cli inbox <subcommand> [options]

Subcommands:
  list              List open inbox items for an agent (filter by --tier)
  respond <id>      Close an item as responded (agent engaged substantively)
  dismiss <id>      Close an item as dismissed (Tier 3 requires --reason "...")
  carry-forward <id>  Defer with --reason "..."; counts as resolved for audit
                      but preserves visibility in next wtf
  check [--inject]  Emit system-reminder for items since last check
                    (UserPromptSubmit hook integration)

Common options (subcommand-specific flags vary; run <subcommand> --help):
  --from <slug>     Required on resolution commands (audit trail)
  --agent <slug>    Required on list + check (whose inbox)
  --corp <name>     Operate on a specific corp

Examples:
  cc-cli inbox list --agent ceo
  cc-cli inbox list --agent ceo --tier 3
  cc-cli inbox respond chit-i-abc123 --from ceo
  cc-cli inbox dismiss chit-i-xyz --reason "noise from automation" --from ceo
  cc-cli inbox carry-forward chit-i-def --reason "waiting on founder clarification" --from ceo
  cc-cli inbox check --agent ceo --inject

Tiers (sender-determined, not recipient-overridable):
  Tier 1 — ambient (system events, broadcast — 24h TTL, auto-destroys)
  Tier 2 — direct (peer @mentions, DMs — 7d TTL, cools after)
  Tier 3 — critical (founder DMs, escalations — 30d TTL, blocks audit gate)`);
}
