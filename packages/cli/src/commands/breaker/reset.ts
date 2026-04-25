/**
 * `cc-cli breaker reset --slug <slug>` — close an active crash-loop
 * trip. Subsequent ProcessManager.spawnAgent calls go through
 * normally. Bacteria's slug-collision avoidance stops blocking the
 * slug.
 *
 * Idempotent: resetting a slug with no active trip is a friendly
 * no-op (says so, exits 0). The founder's path through this
 * command should never punish a stale typo.
 */

import { parseArgs } from 'node:util';
import { closeBreakerForSlug, findActiveBreaker } from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

interface ResetOpts {
  slug?: string;
  reason?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdBreakerReset(rawArgs: string[]): Promise<void> {
  const opts = parseResetOpts(rawArgs);
  if (!opts.slug) {
    console.error('cc-cli breaker reset: --slug <slug> required');
    process.exit(1);
  }
  const corpRoot = await getCorpRoot(opts.corp);

  const before = findActiveBreaker(corpRoot, opts.slug);
  if (!before) {
    const result = { ok: true, slug: opts.slug, action: 'noop', message: 'no active trip' };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`no active breaker trip for "${opts.slug}" — nothing to reset.`);
    }
    return;
  }

  const closed = closeBreakerForSlug({
    corpRoot,
    slug: opts.slug,
    reason: opts.reason ?? 'founder reset via cc-cli breaker reset',
    clearedBy: 'founder',
  });

  const result = {
    ok: true,
    slug: opts.slug,
    action: 'reset',
    closedTrips: closed.map((c) => c.id),
  };
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`breaker reset for "${opts.slug}".`);
  for (const c of closed) {
    console.log(`  closed trip chit ${c.id}.`);
  }
  console.log('  spawnAgent will go through on the next attempt.');
  console.log('  bacteria can recycle the slug for fresh mitoses.');
}

function parseResetOpts(rawArgs: string[]): ResetOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      slug: { type: 'string' },
      reason: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  const positional = parsed.positionals[0];
  return {
    slug: (parsed.values.slug as string | undefined) ?? positional,
    reason: parsed.values.reason as string | undefined,
    corp: parsed.values.corp as string | undefined,
    json: !!parsed.values.json,
  };
}
