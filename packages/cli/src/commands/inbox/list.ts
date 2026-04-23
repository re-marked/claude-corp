/**
 * `cc-cli inbox list` — read-only query of an agent's inbox.
 *
 * Returns items currently active (status === 'active') by default,
 * optionally filtered by tier. `--include-resolved` widens to
 * completed/rejected/closed/cold so founders can audit history.
 *
 * Output shape: one line per item, aligned columns. Human-readable
 * by default; `--json` for machine consumers (the TUI, scripts).
 */

import { parseArgs } from 'node:util';
import {
  queryChits,
  type Chit,
  type ChitScope,
  type ChitStatus,
  type InboxItemTier,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

export async function cmdInboxList(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      agent: { type: 'string' },
      tier: { type: 'string' },
      'include-resolved': { type: 'boolean', default: false },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;

  if (v.help) {
    printHelp();
    return;
  }
  if (!v.agent || typeof v.agent !== 'string') {
    fail('--agent <slug> required');
  }

  const slug = v.agent as string;
  const corpRoot = await getCorpRoot(typeof v.corp === 'string' ? v.corp : undefined);

  // Status filter — default to active only. Widen only when the
  // caller opts in, so the common "what's in front of me right now"
  // query stays fast and focused.
  const statuses: ChitStatus[] = v['include-resolved']
    ? ['active', 'completed', 'rejected', 'closed', 'cold']
    : ['active'];

  // Tier filter — optional integer 1/2/3. Invalid values fail at the
  // CLI boundary rather than silently returning empty.
  let tierFilter: InboxItemTier | null = null;
  if (v.tier !== undefined) {
    const n = Number.parseInt(String(v.tier), 10);
    if (n !== 1 && n !== 2 && n !== 3) {
      fail(`--tier must be 1, 2, or 3 (got: ${JSON.stringify(v.tier)})`);
    }
    tierFilter = n as InboxItemTier;
  }

  const scope: ChitScope = `agent:${slug}`;
  const result = queryChits(corpRoot, {
    types: ['inbox-item'],
    statuses,
    scopes: [scope],
    limit: 200,
    // includeCold piggy-backs on include-resolved so the surface is
    // one flag, not two. Cold items are the "stale but kept" tier
    // 2/3 residue — same audit-history meaning as closed, so they
    // belong in the same opt-in.
    includeCold: v['include-resolved'] === true,
    sortBy: 'createdAt',
    sortOrder: 'desc',
  });

  const items = (result.chits as Chit<'inbox-item'>[]).filter(
    (c) => tierFilter === null || c.fields['inbox-item']?.tier === tierFilter,
  );

  if (v.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  if (items.length === 0) {
    console.log(`(no items for ${slug}${tierFilter ? ` at tier ${tierFilter}` : ''})`);
    return;
  }

  // Plaintext listing: [TIER] id  from · subject  (status · age)
  for (const c of items) {
    const f = c.fields['inbox-item'];
    if (!f) continue;
    const tierLabel = `[T${f.tier}]`;
    const age = ageLabel(c.createdAt);
    const statusPart = c.status === 'active' ? '' : `  (${c.status})`;
    console.log(`${tierLabel}  ${c.id}  ${f.from} · ${f.subject}  (${age})${statusPart}`);
  }
}

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function fail(msg: string): never {
  console.error(`cc-cli inbox list: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli inbox list — query an agent's inbox items

Usage:
  cc-cli inbox list --agent <slug> [options]

Options:
  --agent <slug>          Required. Whose inbox to read.
  --tier 1|2|3            Optional. Filter by tier.
  --include-resolved      Include completed/rejected/closed/cold items.
                          Default: active only.
  --corp <name>           Operate on a specific corp.
  --json                  Machine-readable output.

Examples:
  cc-cli inbox list --agent ceo
  cc-cli inbox list --agent ceo --tier 3
  cc-cli inbox list --agent ceo --include-resolved --json`);
}
