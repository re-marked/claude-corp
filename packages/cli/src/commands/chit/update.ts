import { parseArgs } from 'node:util';
import {
  findChitById,
  updateChit,
  chitScopeFromPath,
  isChitIdFormat,
  ChitValidationError,
  ChitMalformedError,
  ChitConcurrentModificationError,
  type Chit,
  type ChitStatus,
  type ChitTypeId,
  type FieldsForType,
  type UpdateChitOpts,
} from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

function parseFieldValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function cmdChitUpdate(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      status: { type: 'string' },
      'add-tag': { type: 'string', multiple: true },
      'remove-tag': { type: 'string', multiple: true },
      'add-ref': { type: 'string', multiple: true },
      'remove-ref': { type: 'string', multiple: true },
      'add-depends-on': { type: 'string', multiple: true },
      'remove-depends-on': { type: 'string', multiple: true },
      'set-field': { type: 'string', multiple: true },
      'append-content': { type: 'string' },
      'replace-content': { type: 'string' },
      'expected-updated-at': { type: 'string' },
      from: { type: 'string' },
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

  const id = parsed.positionals[0];
  if (!id || typeof id !== 'string') {
    fail('chit id is required (e.g. cc-cli chit update chit-t-abcdef01 --status active)');
  }
  if (!isChitIdFormat(id)) {
    fail(`not a valid chit id format: ${id}`);
  }

  if (!v.from || typeof v.from !== 'string') {
    fail('--from is required (the member id of whoever is updating)');
  }
  const updatedBy = v.from as string;

  const corpRoot = await getCorpRoot(typeof v.corp === 'string' ? v.corp : undefined);

  try {
    // Locate chit, derive scope from its path
    const found = findChitById(corpRoot, id);
    if (!found) {
      console.error(`chit not found: ${id}`);
      process.exit(1);
    }
    const scope = chitScopeFromPath(corpRoot, found.path);
    const type = found.chit.type as ChitTypeId;

    // Compose the update
    const addTags = Array.isArray(v['add-tag']) ? (v['add-tag'] as string[]) : [];
    const removeTags = Array.isArray(v['remove-tag']) ? (v['remove-tag'] as string[]) : [];
    const addRefs = Array.isArray(v['add-ref']) ? (v['add-ref'] as string[]) : [];
    const removeRefs = Array.isArray(v['remove-ref']) ? (v['remove-ref'] as string[]) : [];
    const addDeps = Array.isArray(v['add-depends-on']) ? (v['add-depends-on'] as string[]) : [];
    const removeDeps = Array.isArray(v['remove-depends-on'])
      ? (v['remove-depends-on'] as string[])
      : [];
    const setFieldPairs = Array.isArray(v['set-field']) ? (v['set-field'] as string[]) : [];

    const updateOpts: UpdateChitOpts<typeof type> = { updatedBy };

    if (v.status !== undefined) updateOpts.status = v.status as ChitStatus;
    if (v['expected-updated-at'] !== undefined) {
      updateOpts.expectedUpdatedAt = v['expected-updated-at'] as string;
    }

    if (addTags.length > 0 || removeTags.length > 0) {
      const current = (found.chit as Chit).tags;
      const after = new Set(current);
      for (const t of addTags) after.add(t);
      for (const t of removeTags) after.delete(t);
      updateOpts.tags = [...after];
    }
    if (addRefs.length > 0 || removeRefs.length > 0) {
      const current = (found.chit as Chit).references;
      const after = new Set(current);
      for (const r of addRefs) after.add(r);
      for (const r of removeRefs) after.delete(r);
      updateOpts.references = [...after];
    }
    if (addDeps.length > 0 || removeDeps.length > 0) {
      const current = (found.chit as Chit).dependsOn;
      const after = new Set(current);
      for (const d of addDeps) after.add(d);
      for (const d of removeDeps) after.delete(d);
      updateOpts.dependsOn = [...after];
    }

    if (setFieldPairs.length > 0) {
      const typeFieldsUpdate: Record<string, unknown> = {};
      for (const pair of setFieldPairs) {
        const eq = pair.indexOf('=');
        if (eq < 0) {
          console.error(`--set-field expects key=value, got: ${pair}`);
          process.exit(1);
        }
        let key = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1);
        if (key.startsWith(`${type}.`)) key = key.slice(type.length + 1);
        typeFieldsUpdate[key] = parseFieldValue(value);
      }
      updateOpts.fields = { [type]: typeFieldsUpdate } as Partial<{
        [K in typeof type]: FieldsForType[K];
      }>;
    }

    // Body: --replace-content sets whole body, --append-content adds to existing
    if (v['replace-content'] !== undefined && v['append-content'] !== undefined) {
      console.error('--replace-content and --append-content are mutually exclusive');
      process.exit(1);
    }
    if (v['replace-content'] !== undefined) {
      updateOpts.body = v['replace-content'] as string;
    } else if (v['append-content'] !== undefined) {
      const sep = found.body.endsWith('\n') ? '' : '\n';
      updateOpts.body = found.body + sep + (v['append-content'] as string);
    }

    const updated = updateChit(corpRoot, scope, type, id, updateOpts);

    if (v.json) {
      console.log(JSON.stringify(updated, null, 2));
    } else {
      console.log(`updated ${updated.id} (updatedAt=${updated.updatedAt})`);
    }
  } catch (err) {
    if (err instanceof ChitValidationError) {
      console.error(`validation error: ${err.message}`);
      if (err.field) console.error(`  field: ${err.field}`);
      process.exit(2);
    }
    if (err instanceof ChitMalformedError) {
      console.error(`malformed chit: ${err.path}`);
      console.error(`  cause: ${err.cause}`);
      process.exit(3);
    }
    if (err instanceof ChitConcurrentModificationError) {
      console.error(`concurrent modification: ${err.message}`);
      console.error(`  another writer landed between your read and your write.`);
      console.error(`  re-read the chit (cc-cli chit read <id>) and try again.`);
      process.exit(4);
    }
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

function fail(msg: string): never {
  console.error(`cc-cli chit update: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli chit update — Patch a chit's status, links, fields, or body

Usage:
  cc-cli chit update <id> --from <member> [options]

Required:
  --from <member>         Who's making the update (audit trail)

Status:
  --status <status>       Transition to a new status (must be in the
                          type's validStatuses and not locked by a
                          terminal-status currently held)

Links (repeatable):
  --add-tag <tag>, --remove-tag <tag>
  --add-ref <chit-id>, --remove-ref <chit-id>
  --add-depends-on <chit-id>, --remove-depends-on <chit-id>

Fields:
  --set-field key=value   Partial update of fields.<type>.<key>
                          (preserves other sub-fields). Repeatable.
                          Values parse as JSON where possible.

Body:
  --replace-content <md>  Replace body entirely
  --append-content <md>   Append to existing body (newline-separated)

Concurrency:
  --expected-updated-at <iso>  Optimistic concurrency — fail with
                               exit 4 if on-disk updatedAt differs

Output:
  --json                  Return the updated chit as JSON
  --corp <name>           Operate on a specific corp

Examples:
  cc-cli chit update chit-t-abc123 --status active --from ceo
  cc-cli chit update chit-t-abc123 --set-field priority=high --from ceo
  cc-cli chit update chit-t-abc123 --add-tag urgent --remove-tag stale --from ceo
  cc-cli chit update chit-t-abc123 --append-content "14:32 — wrote tests" --from toast`);
}
