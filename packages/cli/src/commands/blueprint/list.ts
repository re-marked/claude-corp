import { parseArgs } from 'node:util';
import {
  listBlueprintChits,
  chitScopeFromPath,
  type ChitScope,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

/**
 * `cc-cli blueprint list [--scope <scope>] [--all] [--json]`
 *
 * Query blueprints across scopes. Default: active only, every
 * discoverable scope (agent / project / corp). Useful for founders +
 * agents scanning what's available to cast.
 *
 * Table output is dense — one line per blueprint with name + scope +
 * origin + status + step count. Same-name across different scopes
 * appear as separate rows so the caller can see the project/corp
 * precedence without silent shadowing.
 *
 * JSON output is a flat array suitable for jq piping or programmatic
 * consumers.
 */

const HELP = `Usage: cc-cli blueprint list [options]

List blueprints across scopes. Default: active only, every scope.

Options:
  --scope <scope>       Filter to one scope (e.g. 'corp', 'project:fire').
                        Multiple --scope flags OR together.
  --all                 Include draft + closed blueprints (default: active only).
  --json                Machine-readable JSON output.
  --corp <name>         Operate on a specific corp (defaults to active).
  --help                Show this help.

Examples:
  cc-cli blueprint list                    # active blueprints, every scope
  cc-cli blueprint list --all              # include drafts + closed
  cc-cli blueprint list --scope corp       # only corp-scope
  cc-cli blueprint list --json | jq .
`;

interface ListRow {
  readonly name: string;
  readonly scope: ChitScope;
  readonly origin: string;
  readonly status: string;
  readonly stepCount: number;
  readonly id: string;
  readonly title: string | null;
  readonly summary: string | null;
}

export async function cmdBlueprintList(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      scope: { type: 'string', multiple: true },
      all: { type: 'boolean' },
      json: { type: 'boolean' },
      corp: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
  });

  if (parsed.values.help) {
    console.log(HELP);
    return;
  }

  const scopes = parsed.values.scope as string[] | undefined;
  const includeNonActive = !!parsed.values.all;
  const asJson = !!parsed.values.json;
  const corpOpt = parsed.values.corp as string | undefined;

  const corpRoot = await getCorpRoot(corpOpt);

  const chitWithBodies = listBlueprintChits(corpRoot, {
    ...(scopes && scopes.length > 0 ? { scopes: scopes as ChitScope[] } : {}),
    includeNonActive,
  });

  const rows: ListRow[] = chitWithBodies.map((cwb) => {
    const bp = cwb.chit.fields.blueprint;
    return {
      name: bp.name,
      // Scope is derived from the file path (chits don't carry it in
      // frontmatter). chitScopeFromPath inverts chitPath.
      scope: chitScopeFromPath(corpRoot, cwb.path),
      origin: bp.origin,
      status: cwb.chit.status,
      stepCount: bp.steps.length,
      id: cwb.chit.id,
      title: bp.title ?? null,
      summary: bp.summary ?? null,
    };
  });

  // Stable ordering: scope (corp first, then agent:, then project:,
  // then team:), then name alphabetical. Consistent output helps
  // diff-style comparisons between runs.
  rows.sort((a, b) => {
    const scopeOrder = (s: ChitScope): number => {
      if (s === 'corp') return 0;
      if (s.startsWith('agent:')) return 1;
      if (s.startsWith('project:')) return 2;
      return 3; // team:<name>
    };
    const so = scopeOrder(a.scope) - scopeOrder(b.scope);
    if (so !== 0) return so;
    const ss = a.scope.localeCompare(b.scope);
    if (ss !== 0) return ss;
    return a.name.localeCompare(b.name);
  });

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    if (includeNonActive) {
      console.log('No blueprints found in any scope.');
    } else {
      console.log('No active blueprints. Pass --all to include drafts + closed.');
    }
    return;
  }

  // Table rendering. Column widths auto-sized to the longest value per
  // column (capped so a very long name doesn't break the layout).
  const nameWidth = Math.min(
    Math.max(4, ...rows.map((r) => r.name.length)),
    40,
  );
  const scopeWidth = Math.min(
    Math.max(5, ...rows.map((r) => r.scope.length)),
    30,
  );
  const originWidth = 8; // 'authored' / 'builtin' — both fit
  const statusWidth = 7; // 'draft' / 'active' / 'closed' — all fit

  const pad = (s: string, w: number): string => {
    if (s.length >= w) return s.length > w ? s.slice(0, w - 1) + '…' : s;
    return s + ' '.repeat(w - s.length);
  };

  const header =
    pad('NAME', nameWidth) +
    '  ' +
    pad('SCOPE', scopeWidth) +
    '  ' +
    pad('ORIGIN', originWidth) +
    '  ' +
    pad('STATUS', statusWidth) +
    '  STEPS';
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const r of rows) {
    console.log(
      pad(r.name, nameWidth) +
        '  ' +
        pad(r.scope, scopeWidth) +
        '  ' +
        pad(r.origin, originWidth) +
        '  ' +
        pad(r.status, statusWidth) +
        '  ' +
        r.stepCount,
    );
  }

  console.log('');
  console.log(
    `${rows.length} blueprint${rows.length === 1 ? '' : 's'}. ` +
      `View one: cc-cli blueprint show <name>`,
  );
}
