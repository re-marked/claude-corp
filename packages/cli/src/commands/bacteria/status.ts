/**
 * `cc-cli bacteria status` — per-role colony view.
 *
 * Reads bacteria-events.jsonl + members.json + the role registry +
 * the pause file. Computes today's stats per worker-tier role:
 * active count, generation range, today's mitose / apoptose counts,
 * mean lifespan of slots that apoptosed today, peak simultaneous
 * count today.
 *
 * --role <id> filters to one role. --json emits the structured
 * computation.
 */

import { parseArgs } from 'node:util';
import {
  employeeRoles,
  readBacteriaEvents,
  readPausedRoles,
  type ApoptoseEvent,
  type BacteriaEvent,
  type Member,
  type RoleEntry,
} from '@claudecorp/shared';
import { getCorpRoot, getMembers } from '../../client.js';

interface StatusOpts {
  role?: string;
  corp?: string;
  json?: boolean;
}

interface RoleStats {
  role: string;
  roleDisplayName: string;
  active: number;
  generations: { min: number; max: number } | null;
  todayMitoses: number;
  todayApoptoses: number;
  peakToday: number;
  meanLifespanMs: number | null;
  paused: boolean;
  target: { value: number; isOverride: boolean };
  hysteresisMs: { value: number; isOverride: boolean };
}

// Constants kept aligned with daemon's bacteria/types.ts. CLI doesn't
// import from daemon (would create a cross-package edge); the values
// are the documented defaults — update both files together if either
// changes (REFACTOR.md 1.10 records the design choice).
const DEFAULT_TARGET = 1.5;
const DEFAULT_HYSTERESIS_MS = 3 * 60 * 1000;

export async function cmdBacteriaStatus(rawArgs: string[]): Promise<void> {
  const opts = parseStatusOpts(rawArgs);
  const corpRoot = await getCorpRoot(opts.corp);

  const members = getMembers(corpRoot);
  const startOfDay = startOfTodayIso();
  const allEvents = readBacteriaEvents(corpRoot, { since: startOfDay });
  const pausedRoles = readPausedRoles(corpRoot);

  const roles = employeeRoles().filter((r) => r.tier === 'worker');
  const filtered = opts.role ? roles.filter((r) => r.id === opts.role) : roles;
  if (opts.role && filtered.length === 0) {
    console.error(`cc-cli bacteria status: unknown or non-worker role "${opts.role}"`);
    process.exit(1);
  }

  const stats = filtered.map((role) =>
    computeRoleStats(role, members, allEvents, pausedRoles),
  );

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), roles: stats }, null, 2));
    return;
  }

  console.log(formatHumanStatus(stats));
}

// ─── Pure helpers (testable) ────────────────────────────────────────

export function computeRoleStats(
  role: RoleEntry,
  members: readonly Member[],
  todayEvents: readonly BacteriaEvent[],
  pausedRoles: ReadonlySet<string>,
): RoleStats {
  const pool = members.filter(
    (m) =>
      m.type === 'agent' &&
      m.status !== 'archived' &&
      m.role === role.id &&
      (m.kind ?? 'partner') === 'employee',
  );

  const generations = pool.length === 0
    ? null
    : {
        min: Math.min(...pool.map((m) => m.generation ?? 0)),
        max: Math.max(...pool.map((m) => m.generation ?? 0)),
      };

  const roleEvents = todayEvents.filter((e) => e.role === role.id);
  const mitoses = roleEvents.filter((e) => e.kind === 'mitose').length;
  const apoptoses = roleEvents.filter((e): e is ApoptoseEvent => e.kind === 'apoptose');

  const meanLifespanMs = apoptoses.length > 0
    ? Math.round(apoptoses.reduce((sum, e) => sum + e.lifetimeMs, 0) / apoptoses.length)
    : null;

  // Peak simultaneous today: replay events from start-of-day. Starting
  // count = current active - net change today. Walk events: mitose +1,
  // apoptose -1. Track max.
  const startCount = pool.length - mitoses + apoptoses.length;
  let runningCount = Math.max(0, startCount);
  let peak = runningCount;
  for (const e of roleEvents) {
    if (e.kind === 'mitose') runningCount++;
    else runningCount = Math.max(0, runningCount - 1);
    if (runningCount > peak) peak = runningCount;
  }

  return {
    role: role.id,
    roleDisplayName: role.displayName,
    active: pool.length,
    generations,
    todayMitoses: mitoses,
    todayApoptoses: apoptoses.length,
    peakToday: peak,
    meanLifespanMs,
    paused: pausedRoles.has(role.id),
    target: {
      value: role.bacteriaTarget ?? DEFAULT_TARGET,
      isOverride: role.bacteriaTarget !== undefined,
    },
    hysteresisMs: {
      value: role.bacteriaHysteresisMs ?? DEFAULT_HYSTERESIS_MS,
      isOverride: role.bacteriaHysteresisMs !== undefined,
    },
  };
}

export function formatHumanStatus(rolesStats: readonly RoleStats[]): string {
  if (rolesStats.length === 0) return 'No worker-tier roles in the registry.';
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`Bacteria pool status — ${date}`, ''];
  for (const s of rolesStats) {
    lines.push(formatOneRole(s));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function formatOneRole(s: RoleStats): string {
  const lines: string[] = [];
  const genLabel = s.generations
    ? s.generations.min === s.generations.max
      ? `gen ${s.generations.min}`
      : `gens ${s.generations.min}-${s.generations.max}`
    : '';
  const headRight = s.active === 0 ? '0 active' : `${s.active} active${genLabel ? `, ${genLabel}` : ''}`;
  lines.push(`${s.roleDisplayName} (${s.role}): ${headRight}`);

  if (s.todayMitoses === 0 && s.todayApoptoses === 0 && s.active === 0) {
    lines.push('  today: no activity');
  } else {
    const today = `${s.todayMitoses} mitoses, ${s.todayApoptoses} apoptoses, peak ${s.peakToday} simultaneous`;
    lines.push(`  today: ${today}`);
    if (s.meanLifespanMs !== null) {
      lines.push(`  mean lifespan: ${formatDuration(s.meanLifespanMs)}`);
    }
  }

  const pausedLabel = s.paused ? 'PAUSED' : 'no';
  lines.push(`  paused: ${pausedLabel}`);

  const targetLabel = `${s.target.value}${s.target.isOverride ? ' (override)' : ' (default)'}`;
  lines.push(`  target: ${targetLabel}`);

  const hysteresisLabel = `${formatDuration(s.hysteresisMs.value)}${s.hysteresisMs.isOverride ? ' (override)' : ' (default)'}`;
  lines.push(`  hysteresis: ${hysteresisLabel}`);

  return lines.join('\n');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM === 0 ? `${h}h` : `${h}h${remM}m`;
}

function startOfTodayIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function parseStatusOpts(rawArgs: string[]): StatusOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      role: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
    strict: true,
  });
  return {
    role: parsed.values.role as string | undefined,
    corp: parsed.values.corp as string | undefined,
    json: !!parsed.values.json,
  };
}
