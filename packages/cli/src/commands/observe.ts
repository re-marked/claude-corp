import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import {
  createChit,
  isKnownChitType,
  ChitValidationError,
  type ObservationFields,
} from '@claudecorp/shared';
import { getCorpRoot } from '../client.js';

/**
 * `cc-cli observe` — the agent-native observation command.
 *
 * Post-0.5, observations are chits of type=observation under agent scope.
 * Writing them via the generic `cc-cli chit create --type observation
 * --scope agent:... --from ... --field category=... ...` is correct but
 * too verbose for the common agent-flow path ("I just did X and want to
 * record it").
 *
 * This command is the ergonomic front door:
 *
 *   cc-cli observe "Worked through the auth refactor" --from toast --category TASK
 *
 *   cc-cli observe "Mark reaffirmed: prefers actionable errors over terse ones" \
 *     --from toast --category FEEDBACK --subject mark --importance 4
 *
 *   cc-cli observe "Auth uses JWT not sessions" --from toast \
 *     --category LEARNED --files src/auth.ts,src/sessions.ts
 *
 * Accepts the pre-chits ActivityCategory vocabulary (TASK / RESEARCH /
 * DECISION / BLOCKED / LEARNED / CREATED / REVIEWED / CHECKPOINT / SLUMBER
 * / ERROR / HANDOFF / FEEDBACK) and translates internally to the chit
 * ObservationFields.category vocabulary (FEEDBACK / DECISION / DISCOVERY
 * / PREFERENCE / NOTICE / CORRECTION). The original category is preserved
 * as a `from-log:<ORIGINAL>` tag so the expressiveness isn't lost.
 *
 * Required: --from <slug> (author + scope).
 *           Plus a description either positional OR via --content.
 * Defaults: --category NOTICE, --importance 2, --subject = --from value.
 *
 * Advanced users can still pass arbitrary --field/--scope/etc flags;
 * those pass through untouched since we delegate to chit create for the
 * actual write.
 */

const ACTIVITY_CATEGORIES = [
  'TASK',
  'RESEARCH',
  'DECISION',
  'BLOCKED',
  'LEARNED',
  'CREATED',
  'REVIEWED',
  'CHECKPOINT',
  'SLUMBER',
  'ERROR',
  'HANDOFF',
  'FEEDBACK',
] as const;

const CHIT_CATEGORIES = [
  'FEEDBACK',
  'DECISION',
  'DISCOVERY',
  'PREFERENCE',
  'NOTICE',
  'CORRECTION',
] as const;

type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];
type ChitCategory = (typeof CHIT_CATEGORIES)[number];

function mapCategory(cat: string): { chitCategory: ChitCategory; preserveAsTag: boolean } {
  // If the user passed a chit-vocabulary category, accept it verbatim
  // (no translation, no from-log tag).
  if ((CHIT_CATEGORIES as readonly string[]).includes(cat)) {
    return { chitCategory: cat as ChitCategory, preserveAsTag: false };
  }
  // Activity-vocabulary translation with from-log preservation.
  switch (cat) {
    case 'DECISION':
      return { chitCategory: 'DECISION', preserveAsTag: true };
    case 'RESEARCH':
    case 'LEARNED':
      return { chitCategory: 'DISCOVERY', preserveAsTag: true };
    case 'ERROR':
      return { chitCategory: 'CORRECTION', preserveAsTag: true };
    default:
      return { chitCategory: 'NOTICE', preserveAsTag: true };
  }
}

export async function cmdObserve(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      from: { type: 'string' },
      scope: { type: 'string' },
      category: { type: 'string' },
      subject: { type: 'string' },
      importance: { type: 'string' },
      description: { type: 'string' },
      content: { type: 'string' },
      files: { type: 'string' },
      tag: { type: 'string', multiple: true },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      // These pass through to chit create if the user wants to set them
      // explicitly. The alias mostly hides them behind the shortcuts above.
      type: { type: 'string' },
      id: { type: 'string' },
      ephemeral: { type: 'boolean' },
      'no-ephemeral': { type: 'boolean' },
      ttl: { type: 'string' },
      ref: { type: 'string', multiple: true },
      'depends-on': { type: 'string', multiple: true },
      field: { type: 'string', multiple: true },
      'content-file': { type: 'string' },
      title: { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;

  if (v.help) {
    printHelp();
    return;
  }

  // --from is required — it names the author AND (unless --scope overrides)
  // anchors the chit to that agent's scope.
  if (!v.from || typeof v.from !== 'string') {
    fail('--from is required (the member id of the observing agent)');
  }
  const from = v.from as string;

  // Description from positional, --description, or --content.
  const positionalDesc = parsed.positionals[0];
  const description =
    (typeof v.description === 'string' && v.description) ||
    (typeof v.content === 'string' && v.content) ||
    positionalDesc ||
    '';
  if (!description) {
    fail(
      'observation description required (positional arg, --description, or --content)',
    );
  }

  // Category default + translation
  const rawCategory = typeof v.category === 'string' ? v.category.toUpperCase() : 'NOTICE';
  const { chitCategory, preserveAsTag } = mapCategory(rawCategory);

  // Importance default + parse
  let importance = 2;
  if (typeof v.importance === 'string') {
    const n = parseInt(v.importance, 10);
    if (isNaN(n) || n < 1 || n > 5) {
      fail(`--importance must be an integer 1-5, got: ${v.importance}`);
    }
    importance = n;
  }

  // Subject default = from
  const subject = typeof v.subject === 'string' ? v.subject : from;

  // Scope default = agent:<from>
  const scope = typeof v.scope === 'string' ? v.scope : `agent:${from}`;

  // Files → file:<path> tags
  const tags: string[] = Array.isArray(v.tag) ? [...(v.tag as string[])] : [];
  if (preserveAsTag) tags.push(`from-log:${rawCategory}`);
  if (typeof v.files === 'string' && v.files.length > 0) {
    for (const f of v.files.split(',').map((s) => s.trim()).filter(Boolean)) {
      tags.push(`file:${f}`);
    }
  }

  // Body: if --content-file passed, read that; otherwise use the description
  // as the body so the full text is preserved verbatim.
  let body = description;
  if (typeof v['content-file'] === 'string') {
    try {
      body = readFileSync(v['content-file'], 'utf-8');
    } catch (err) {
      fail(`could not read --content-file: ${(err as Error).message}`);
    }
  }

  const corpRoot = await getCorpRoot(typeof v.corp === 'string' ? v.corp : undefined);

  const fields: ObservationFields = {
    category: chitCategory,
    subject,
    importance: importance as 1 | 2 | 3 | 4 | 5,
    title: description.slice(0, 80),
    context: description,
  };

  try {
    const chit = createChit(corpRoot, {
      type: 'observation',
      scope: scope as 'corp' | `agent:${string}` | `project:${string}` | `team:${string}`,
      fields: { observation: fields },
      createdBy: from,
      tags,
      body,
    });

    if (v.json) {
      console.log(JSON.stringify(chit, null, 2));
    } else {
      console.log(chit.id);
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
  // Silence unused-var warning for isKnownChitType import — kept for symmetry
  // with cmdChitCreate and in case callers extend this module.
  void isKnownChitType;
}

function fail(msg: string): never {
  console.error(`cc-cli observe: ${msg}`);
  process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli observe — Record an observation (agent-native wrapper)

Usage:
  cc-cli observe "<description>" --from <slug> [options]

Required:
  --from <slug>       Author (also sets scope to agent:<slug> unless
                      --scope overrides)
  Plus a description (positional, --description, or --content).

Common options:
  --category <cat>    Activity category (TASK / RESEARCH / DECISION / BLOCKED
                      / LEARNED / CREATED / REVIEWED / CHECKPOINT / SLUMBER
                      / ERROR / HANDOFF / FEEDBACK) — translated to the chit
                      vocabulary with original preserved as a from-log tag.
                      Chit-vocabulary values (FEEDBACK / DECISION / DISCOVERY
                      / PREFERENCE / NOTICE / CORRECTION) also accepted and
                      used verbatim. Default: NOTICE.
  --subject <id>      Who/what this observation is about. Default: --from.
  --importance <1-5>  Default: 2.
  --files a.md,b.md   Comma-separated file refs; added as file:<path> tags.
  --tag <tag>         Extra tag (repeatable).
  --scope <scope>     Override default scope (agent:<from>).

Advanced (pass through to chit create):
  --ephemeral / --no-ephemeral / --ttl / --id / --ref / --depends-on
  --field key=value / --title / --content-file <path>

Output:
  --json              Full chit object as JSON (default: just the id)
  --corp <name>       Specific corp (defaults to active)

Examples:
  cc-cli observe "Picked up the auth task, skimming the existing code" \\
    --from toast --category TASK

  cc-cli observe "Mark prefers actionable error messages" \\
    --from toast --category FEEDBACK --subject mark --importance 4

  cc-cli observe "Auth uses JWT tokens, sessions deprecated" \\
    --from toast --category LEARNED --files src/auth.ts,src/sessions.ts`);
}
