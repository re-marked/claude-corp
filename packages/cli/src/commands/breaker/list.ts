/**
 * `cc-cli breaker list` — surface active crash-loop trips for the
 * founder. Defaults to active-only; --include-cleared is the audit
 * lens. --role filters by Member.role lookup.
 */

import { parseArgs } from 'node:util';
import { listActiveBreakers, getRole, type Member } from '@claudecorp/shared';
import { getCorpRoot, getMembers } from '../../client.js';

interface ListOpts {
  role?: string;
  includeCleared?: boolean;
  corp?: string;
  json?: boolean;
}

export async function cmdBreakerList(rawArgs: string[]): Promise<void> {
  const opts = parseListOpts(rawArgs);
  const corpRoot = await getCorpRoot(opts.corp);

  const trips = listActiveBreakers(corpRoot, {
    includeCleared: opts.includeCleared,
  });

  // Role resolution — slug → Member.role. Done at the CLI boundary
  // so the shared helper stays role-agnostic.
  const members: Member[] = getMembers(corpRoot);
  const slugToRole = new Map<string, string | undefined>();
  for (const m of members) slugToRole.set(m.id, m.role);

  const filtered = opts.role
    ? trips.filter((t) => slugToRole.get(t.fields['breaker-trip'].slug) === opts.role)
    : trips;

  if (opts.json) {
    console.log(
      JSON.stringify(
        filtered.map((t) => ({
          tripId: t.id,
          status: t.status,
          slug: t.fields['breaker-trip'].slug,
          role: slugToRole.get(t.fields['breaker-trip'].slug) ?? null,
          trippedAt: t.fields['breaker-trip'].trippedAt,
          triggerCount: t.fields['breaker-trip'].triggerCount,
          triggerThreshold: t.fields['breaker-trip'].triggerThreshold,
          triggerWindowMs: t.fields['breaker-trip'].triggerWindowMs,
          recentSilentexitKinks: t.fields['breaker-trip'].recentSilentexitKinks,
          clearedAt: t.fields['breaker-trip'].clearedAt ?? null,
          clearedBy: t.fields['breaker-trip'].clearedBy ?? null,
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (filtered.length === 0) {
    if (opts.role) {
      console.log(`no${opts.includeCleared ? '' : ' active'} breaker trips for role "${opts.role}".`);
    } else {
      console.log(`no${opts.includeCleared ? '' : ' active'} breaker trips.`);
    }
    return;
  }

  console.log(`${filtered.length} ${opts.includeCleared ? 'breaker trip(s)' : 'active breaker trip(s)'}:`);
  console.log('');
  for (const t of filtered) {
    const f = t.fields['breaker-trip'];
    const roleId = slugToRole.get(f.slug);
    const role = roleId ? getRole(roleId) : undefined;
    const roleLabel = role?.displayName ?? roleId ?? '?';
    const statusBadge = t.status === 'active' ? 'ACTIVE' : 'cleared';
    console.log(`  [${statusBadge}] ${f.slug}  (role: ${roleLabel})`);
    console.log(`    trippedAt:  ${f.trippedAt}`);
    console.log(`    count:      ${f.triggerCount} (threshold ${f.triggerThreshold} in ${Math.round(f.triggerWindowMs / 1000)}s)`);
    console.log(`    trip chit:  ${t.id}`);
    if (f.recentSilentexitKinks.length > 0) {
      console.log(`    kinks:      ${f.recentSilentexitKinks.join(', ')}`);
    }
    if (t.status !== 'active' && f.clearedAt) {
      console.log(`    cleared:    ${f.clearedAt} by ${f.clearedBy ?? '?'}${f.clearReason ? ` — ${f.clearReason}` : ''}`);
    }
    console.log('');
  }
  if (!opts.includeCleared) {
    console.log('Reset with: cc-cli breaker reset --slug <slug>');
    console.log('Audit including cleared: cc-cli breaker list --include-cleared');
  }
}

function parseListOpts(rawArgs: string[]): ListOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      role: { type: 'string' },
      'include-cleared': { type: 'boolean' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
    strict: true,
  });
  return {
    role: parsed.values.role as string | undefined,
    includeCleared: !!parsed.values['include-cleared'],
    corp: parsed.values.corp as string | undefined,
    json: !!parsed.values.json,
  };
}
