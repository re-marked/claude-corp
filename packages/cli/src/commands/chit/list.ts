import { parseArgs } from 'node:util';
import {
  queryChits,
  isKnownChitType,
  ChitValidationError,
  type Chit,
  type ChitScope,
  type ChitStatus,
  type ChitTypeId,
  type QueryChitsOpts,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

/**
 * Parse a duration string ("7d", "24h", "30m", "60s") into milliseconds.
 * Returns null for malformed input (caller decides how to surface).
 */
function parseDuration(raw: string): number | null {
  const match = /^(\d+)([smhd])$/.exec(raw);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * factor;
}

/**
 * --since N<unit> → updatedAt >= (now - N). "chits updated within the
 * last <duration>." --until N<unit> → updatedAt <= (now - N). "chits
 * older than <duration>."
 */
function durationToIso(raw: string): string | null {
  const ms = parseDuration(raw);
  if (ms === null) return null;
  return new Date(Date.now() - ms).toISOString();
}

export async function cmdChitList(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      type: { type: 'string', multiple: true },
      status: { type: 'string', multiple: true },
      tag: { type: 'string', multiple: true },
      scope: { type: 'string', multiple: true },
      ref: { type: 'string', multiple: true },
      'depends-on': { type: 'string', multiple: true },
      since: { type: 'string' },
      until: { type: 'string' },
      ephemeral: { type: 'boolean' },
      'no-ephemeral': { type: 'boolean' },
      'include-archive': { type: 'boolean', default: false },
      'created-by': { type: 'string' },
      sort: { type: 'string' },
      'sort-order': { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;

  if (v.help) {
    printHelp();
    return;
  }

  // Validate --type values against the registry before we run
  const types = Array.isArray(v.type) ? (v.type as string[]) : undefined;
  if (types) {
    for (const t of types) {
      if (!isKnownChitType(t)) {
        console.error(`unknown chit type: ${t}`);
        process.exit(1);
      }
    }
  }

  // Build the query options
  const queryOpts: QueryChitsOpts = {};
  if (types) queryOpts.types = types as ChitTypeId[];
  if (Array.isArray(v.status)) queryOpts.statuses = v.status as ChitStatus[];
  if (Array.isArray(v.tag)) queryOpts.tags = v.tag as string[];
  if (Array.isArray(v.scope)) queryOpts.scopes = v.scope as ChitScope[];
  if (Array.isArray(v.ref)) queryOpts.references = v.ref as string[];
  if (Array.isArray(v['depends-on'])) queryOpts.dependsOn = v['depends-on'] as string[];
  if (typeof v['created-by'] === 'string') queryOpts.createdBy = v['created-by'];

  if (typeof v.since === 'string') {
    const iso = durationToIso(v.since);
    if (!iso) {
      console.error(`invalid --since duration: ${v.since} (expected e.g. 7d, 24h, 30m)`);
      process.exit(1);
    }
    queryOpts.updatedSince = iso;
  }
  if (typeof v.until === 'string') {
    const iso = durationToIso(v.until);
    if (!iso) {
      console.error(`invalid --until duration: ${v.until}`);
      process.exit(1);
    }
    queryOpts.updatedUntil = iso;
  }

  // Ephemeral: --ephemeral sets true, --no-ephemeral sets false, neither = both
  if (v['no-ephemeral']) queryOpts.ephemeral = false;
  else if (v.ephemeral) queryOpts.ephemeral = true;

  if (v['include-archive']) queryOpts.includeArchive = true;

  if (typeof v.sort === 'string') {
    if (v.sort !== 'updatedAt' && v.sort !== 'createdAt' && v.sort !== 'id') {
      console.error(`invalid --sort value: ${v.sort} (expected updatedAt, createdAt, or id)`);
      process.exit(1);
    }
    queryOpts.sortBy = v.sort;
  }
  if (typeof v['sort-order'] === 'string') {
    if (v['sort-order'] !== 'asc' && v['sort-order'] !== 'desc') {
      console.error(`invalid --sort-order: ${v['sort-order']}`);
      process.exit(1);
    }
    queryOpts.sortOrder = v['sort-order'];
  }

  if (typeof v.limit === 'string') {
    const n = parseInt(v.limit, 10);
    if (isNaN(n) || n < 0) {
      console.error(`invalid --limit: ${v.limit}`);
      process.exit(1);
    }
    queryOpts.limit = n;
  }
  if (typeof v.offset === 'string') {
    const n = parseInt(v.offset, 10);
    if (isNaN(n) || n < 0) {
      console.error(`invalid --offset: ${v.offset}`);
      process.exit(1);
    }
    queryOpts.offset = n;
  }

  const corpRoot = await getCorpRoot(typeof v.corp === 'string' ? v.corp : undefined);

  try {
    const result = queryChits(corpRoot, queryOpts);

    if (v.json) {
      console.log(
        JSON.stringify(
          {
            chits: result.chits.map((c) => ({ chit: c.chit, path: c.path })),
            malformed: result.malformed,
          },
          null,
          2,
        ),
      );
    } else {
      printTable(result.chits);
    }

    // Surface malformed to stderr even when the primary output was clean.
    // Founder and agent monitors should never miss corruption.
    if (result.malformed.length > 0) {
      console.error(`\n${result.malformed.length} malformed chit${result.malformed.length === 1 ? '' : 's'} encountered during scan:`);
      for (const m of result.malformed) {
        console.error(`  ${m.path}`);
        console.error(`    ${m.error}`);
      }
      console.error(`audit log: <corp>/chits/_log/malformed.jsonl`);
    }
  } catch (err) {
    if (err instanceof ChitValidationError) {
      console.error(`validation error: ${err.message}`);
      if (err.field) console.error(`  field: ${err.field}`);
      process.exit(2);
    }
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

function printTable(chits: Array<{ chit: Chit; path: string }>): void {
  if (chits.length === 0) {
    console.log('(no chits match)');
    return;
  }

  // Extract columns; compute widths for alignment
  const rows = chits.map(({ chit }) => {
    const typeFields = (chit.fields as Record<string, unknown>)[chit.type] as Record<string, unknown>;
    const title =
      (typeof typeFields?.title === 'string' ? typeFields.title : undefined) ??
      (typeof typeFields?.subject === 'string' ? typeFields.subject : undefined) ??
      '';
    return {
      id: chit.id,
      type: chit.type,
      status: chit.status,
      title: String(title).slice(0, 40),
      updatedAt: chit.updatedAt.slice(0, 19), // drop fractional + tz for compactness
      tags: chit.tags.slice(0, 3).join(',') + (chit.tags.length > 3 ? '…' : ''),
    };
  });

  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    type: Math.max(4, ...rows.map((r) => r.type.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    title: Math.max(5, ...rows.map((r) => r.title.length)),
    updatedAt: 19,
    tags: Math.max(4, ...rows.map((r) => r.tags.length)),
  };

  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));

  console.log(
    `${pad('ID', widths.id)}  ${pad('TYPE', widths.type)}  ${pad('STATUS', widths.status)}  ${pad('TITLE', widths.title)}  ${pad('UPDATED', widths.updatedAt)}  TAGS`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.id, widths.id)}  ${pad(r.type, widths.type)}  ${pad(r.status, widths.status)}  ${pad(r.title, widths.title)}  ${pad(r.updatedAt, widths.updatedAt)}  ${r.tags}`,
    );
  }
  console.log(`\n${rows.length} chit${rows.length === 1 ? '' : 's'}`);
}

function printHelp(): void {
  console.log(`cc-cli chit list — Query chits with filter composition

Usage:
  cc-cli chit list [options]

Filters (repeatable flags are OR within, AND across):
  --type <type>           One or more chit types
  --status <status>       One or more statuses
  --tag <tag>             One or more tags
  --scope <scope>         One or more scopes (corp, agent:<slug>, ...)
  --ref <chit-id>         Chits that reference this id
  --depends-on <chit-id>  Chits that depend_on this id
  --created-by <member>   Author filter
  --since <duration>      Updated within last <duration> (7d, 24h, 30m)
  --until <duration>      Updated more than <duration> ago
  --ephemeral             Only ephemeral chits
  --no-ephemeral          Only non-ephemeral chits
  --include-archive       Include _archive/ subtrees

Sorting / pagination:
  --sort <field>          updatedAt (default) | createdAt | id
  --sort-order <asc|desc> Default: desc
  --limit <n>             Default 50; 0 for unlimited
  --offset <n>            Pagination offset

Output:
  --json                  Structured output ({ chits, malformed })
  (default)               Human-readable aligned table

Notes:
  Malformed chits encountered during the scan are ALWAYS surfaced to
  stderr, even on a successful query. The full record is in the audit
  log at <corp>/chits/_log/malformed.jsonl — queryChits collects them
  instead of silently skipping, so corruption is never invisible.

Examples:
  cc-cli chit list --type task --status active
  cc-cli chit list --type observation --tag feedback --since 7d
  cc-cli chit list --scope agent:toast --ephemeral
  cc-cli chit list --depends-on chit-t-abcdef01`);
}
