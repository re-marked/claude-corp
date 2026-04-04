/**
 * SLUMBER Analytics — productivity scoring and session breakdown.
 *
 * Reads autoemon-telemetry.jsonl and produces human-readable stats:
 * - Productivity score (productive ticks / total ticks)
 * - Action breakdown (productive / idle / sleep / error counts)
 * - Time distribution (how long spent on each action type)
 * - Per-agent performance
 * - Session comparison (if multiple sessions exist)
 *
 * Used by: /wake digest, /slumber stats, status bar.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export interface TelemetryEntry {
  timestamp: string;
  agentId: string;
  agentName: string;
  tickNumber: number;
  durationMs: number;
  action: 'productive' | 'idle' | 'sleep' | 'error';
  details: string;
  intervalMs: number;
}

export interface SlumberSessionStats {
  /** Total ticks in the session */
  totalTicks: number;
  /** Productive ticks (agent did real work) */
  productiveTicks: number;
  /** Idle ticks (nothing to do) */
  idleTicks: number;
  /** Sleep ticks (agent chose to sleep) */
  sleepTicks: number;
  /** Error ticks (dispatch failed) */
  errorTicks: number;
  /** Productivity score 0-100% */
  productivityScore: number;
  /** Total time spent on ticks (sum of durationMs) */
  totalDurationMs: number;
  /** Average tick duration */
  avgTickDurationMs: number;
  /** Longest tick (most work done) */
  longestTickMs: number;
  /** Per-agent breakdown */
  agents: Record<string, {
    ticks: number;
    productive: number;
    idle: number;
    sleep: number;
    errors: number;
    score: number;
    totalDurationMs: number;
  }>;
  /** Most common actions (from details) */
  topActions: string[];
  /** Session start/end */
  startedAt: string | null;
  endedAt: string | null;
}

// ── Telemetry Reading ──────────────────────────────────────────────

const TELEMETRY_FILE = 'autoemon-telemetry.jsonl';

/** Read all telemetry entries from the JSONL file. */
export function readTelemetry(corpRoot: string): TelemetryEntry[] {
  const filePath = join(corpRoot, TELEMETRY_FILE);
  if (!existsSync(filePath)) return [];

  try {
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.map(line => {
      try { return JSON.parse(line) as TelemetryEntry; }
      catch { return null; }
    }).filter((e): e is TelemetryEntry => e !== null);
  } catch {
    return [];
  }
}

/** Read telemetry entries from the last N minutes. */
export function readRecentTelemetry(corpRoot: string, sinceMinutes: number): TelemetryEntry[] {
  const cutoff = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
  return readTelemetry(corpRoot).filter(e => e.timestamp >= cutoff);
}

// ── Analytics ──────────────────────────────────────────────────────

/** Compute full session stats from telemetry entries. */
export function computeSessionStats(entries: TelemetryEntry[]): SlumberSessionStats {
  if (entries.length === 0) {
    return {
      totalTicks: 0, productiveTicks: 0, idleTicks: 0, sleepTicks: 0, errorTicks: 0,
      productivityScore: 0, totalDurationMs: 0, avgTickDurationMs: 0, longestTickMs: 0,
      agents: {}, topActions: [], startedAt: null, endedAt: null,
    };
  }

  let productive = 0, idle = 0, sleep = 0, errors = 0;
  let totalDuration = 0, longestTick = 0;
  const agentMap = new Map<string, { ticks: number; productive: number; idle: number; sleep: number; errors: number; totalDurationMs: number }>();
  const actionCounts = new Map<string, number>();

  for (const entry of entries) {
    switch (entry.action) {
      case 'productive': productive++; break;
      case 'idle': idle++; break;
      case 'sleep': sleep++; break;
      case 'error': errors++; break;
    }

    totalDuration += entry.durationMs;
    if (entry.durationMs > longestTick) longestTick = entry.durationMs;

    // Per-agent tracking
    let agent = agentMap.get(entry.agentId);
    if (!agent) {
      agent = { ticks: 0, productive: 0, idle: 0, sleep: 0, errors: 0, totalDurationMs: 0 };
      agentMap.set(entry.agentId, agent);
    }
    agent.ticks++;
    agent.totalDurationMs += entry.durationMs;
    switch (entry.action) {
      case 'productive': agent.productive++; break;
      case 'idle': agent.idle++; break;
      case 'sleep': agent.sleep++; break;
      case 'error': agent.errors++; break;
    }

    // Track action keywords for "top actions"
    if (entry.action === 'productive' && entry.details) {
      const key = entry.details.slice(0, 50);
      actionCounts.set(key, (actionCounts.get(key) ?? 0) + 1);
    }
  }

  const total = entries.length;
  const score = total > 0 ? Math.round((productive / total) * 100) : 0;

  // Build per-agent stats
  const agents: SlumberSessionStats['agents'] = {};
  for (const [agentId, data] of agentMap) {
    agents[agentId] = {
      ...data,
      score: data.ticks > 0 ? Math.round((data.productive / data.ticks) * 100) : 0,
    };
  }

  // Top 5 productive actions
  const topActions = [...actionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([action, count]) => `${action} (${count}x)`);

  return {
    totalTicks: total,
    productiveTicks: productive,
    idleTicks: idle,
    sleepTicks: sleep,
    errorTicks: errors,
    productivityScore: score,
    totalDurationMs: totalDuration,
    avgTickDurationMs: total > 0 ? Math.round(totalDuration / total) : 0,
    longestTickMs: longestTick,
    agents,
    topActions,
    startedAt: entries[0]?.timestamp ?? null,
    endedAt: entries.at(-1)?.timestamp ?? null,
  };
}

// ── Formatting ─────────────────────────────────────────────────────

/** Format session stats as a human-readable report. */
export function formatSessionReport(stats: SlumberSessionStats): string {
  if (stats.totalTicks === 0) return 'No SLUMBER data recorded.';

  const formatMs = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms / 60_000)}m`;
  };

  const lines: string[] = [];

  // Header with score
  const scoreBar = '█'.repeat(Math.round(stats.productivityScore / 10)) + '░'.repeat(10 - Math.round(stats.productivityScore / 10));
  lines.push(`Productivity: ${scoreBar} ${stats.productivityScore}%`);
  lines.push('');

  // Tick breakdown
  lines.push(`Ticks: ${stats.totalTicks} total`);
  lines.push(`  ● Productive: ${stats.productiveTicks}`);
  lines.push(`  ○ Idle: ${stats.idleTicks}`);
  lines.push(`  ◑ Sleep: ${stats.sleepTicks}`);
  if (stats.errorTicks > 0) lines.push(`  ✗ Errors: ${stats.errorTicks}`);
  lines.push('');

  // Timing
  lines.push(`Duration: ${formatMs(stats.totalDurationMs)} total tick time`);
  lines.push(`  Average tick: ${formatMs(stats.avgTickDurationMs)}`);
  lines.push(`  Longest tick: ${formatMs(stats.longestTickMs)}`);

  // Per-agent
  if (Object.keys(stats.agents).length > 1) {
    lines.push('');
    lines.push('Per-agent:');
    for (const [agentId, data] of Object.entries(stats.agents)) {
      lines.push(`  ${agentId}: ${data.ticks} ticks, ${data.score}% productive`);
    }
  }

  // Top actions
  if (stats.topActions.length > 0) {
    lines.push('');
    lines.push('Top actions:');
    for (const action of stats.topActions) {
      lines.push(`  · ${action}`);
    }
  }

  return lines.join('\n');
}
