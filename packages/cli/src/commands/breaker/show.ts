/**
 * `cc-cli breaker show <slug-or-trip-id>` — full forensic view of
 * one trip. Resolves either a Member slug (looks up the active
 * trip; falls back to most recent any-status if no active match)
 * or a chit id directly.
 */

import { parseArgs } from 'node:util';
import {
  findActiveBreaker,
  listActiveBreakers,
  getRole,
  type Member,
  type Chit,
} from '@claudecorp/shared';
import { getCorpRoot, getMembers } from '../../client.js';

interface ShowOpts {
  target?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdBreakerShow(rawArgs: string[]): Promise<void> {
  const opts = parseShowOpts(rawArgs);
  if (!opts.target) {
    console.error('cc-cli breaker show: positional <slug-or-trip-id> required');
    process.exit(1);
  }
  const corpRoot = await getCorpRoot(opts.corp);

  // Resolution order: active by slug → any by id → any by slug.
  // listActiveBreakers with includeCleared=true is the broad search.
  const allTrips = listActiveBreakers(corpRoot, { includeCleared: true });
  let trip: Chit<'breaker-trip'> | null = null;

  // 1. Active by slug
  trip = findActiveBreaker(corpRoot, opts.target);
  // 2. Any by chit id
  if (!trip) trip = allTrips.find((t) => t.id === opts.target) ?? null;
  // 3. Most recent (any status) by slug
  if (!trip) {
    const matches = allTrips
      .filter((t) => t.fields['breaker-trip'].slug === opts.target)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    trip = matches[0] ?? null;
  }

  if (!trip) {
    console.error(`no breaker trip found for "${opts.target}".`);
    process.exit(1);
  }

  const f = trip.fields['breaker-trip'];

  if (opts.json) {
    console.log(JSON.stringify({ ...trip }, null, 2));
    return;
  }

  const members: Member[] = getMembers(corpRoot);
  const member = members.find((m) => m.id === f.slug);
  const role = member?.role ? getRole(member.role) : undefined;

  console.log(`Breaker trip ${trip.id} — ${trip.status === 'active' ? 'ACTIVE' : 'cleared'}`);
  console.log('');
  console.log(`Slug:         ${f.slug}`);
  console.log(`Display name: ${member?.displayName ?? '(member missing)'}`);
  console.log(`Role:         ${role?.displayName ?? member?.role ?? '?'}`);
  console.log(`Tripped at:   ${f.trippedAt}`);
  console.log(`Trigger:      count=${f.triggerCount}, threshold=${f.triggerThreshold}, window=${Math.round(f.triggerWindowMs / 1000)}s`);
  console.log('');
  console.log(`Reason: ${f.reason}`);
  console.log('');
  if (f.recentSilentexitKinks.length > 0) {
    console.log('Silent-exit kink references:');
    for (const k of f.recentSilentexitKinks) {
      console.log(`  ${k}`);
    }
    console.log('');
  }
  if (f.spawnHistory.length > 0) {
    console.log('Spawn history (loop-start anchors):');
    for (const ts of f.spawnHistory) {
      console.log(`  ${ts}`);
    }
    console.log('');
  }
  if (trip.status !== 'active') {
    console.log(`Cleared at:   ${f.clearedAt ?? '?'}`);
    console.log(`Cleared by:   ${f.clearedBy ?? '?'}`);
    if (f.clearReason) console.log(`Reason:       ${f.clearReason}`);
  } else {
    console.log('Resolve via: cc-cli breaker reset --slug ' + f.slug);
    console.log('Or remove the slot: cc-cli fire --remove --slug ' + f.slug);
  }
}

function parseShowOpts(rawArgs: string[]): ShowOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  return {
    target: parsed.positionals[0],
    corp: parsed.values.corp as string | undefined,
    json: !!parsed.values.json,
  };
}
