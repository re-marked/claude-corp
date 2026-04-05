/**
 * Morning Standup — auto-generated summary posted to #general
 * after an overnight SLUMBER session (4+ hours).
 *
 * Reads observation logs and telemetry to produce a human-readable
 * briefing. Written as a system message in #general so the whole
 * corp sees it.
 *
 * Format:
 *   Good morning. Here's what happened overnight:
 *   - CEO: 12 ticks, checked inbox, researched auth module
 *   - Worker-1: 8 ticks, implemented session handler, tests passing
 *   Blockers: none
 *   Today's priority: [from CEO's last observations]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readConfig,
  post,
  type Member,
  type Channel,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
  readTodaysObservations,
  parseObservations,
  getObservationStats,
} from '@claudecorp/shared';
import { readTelemetry, computeSessionStats, formatSessionReport } from './slumber-analytics.js';
import { log } from './logger.js';

/** Minimum SLUMBER duration to trigger a morning standup (4 hours). */
const MIN_STANDUP_DURATION_MS = 4 * 60 * 60 * 1000;

export interface StandupOpts {
  corpRoot: string;
  /** SLUMBER session start timestamp */
  activatedAt: number;
  /** Agent IDs that were enrolled */
  enrolledAgents: string[];
}

/**
 * Generate and post a morning standup to #general.
 * Only fires if SLUMBER lasted 4+ hours (overnight sessions).
 */
export async function postMorningStandup(opts: StandupOpts): Promise<boolean> {
  const elapsed = Date.now() - opts.activatedAt;
  if (elapsed < MIN_STANDUP_DURATION_MS) {
    log(`[standup] SLUMBER was ${Math.round(elapsed / 60_000)}m — too short for standup (need 4h+)`);
    return false;
  }

  const members = readConfig<Member[]>(join(opts.corpRoot, MEMBERS_JSON));
  const channels = readConfig<Channel[]>(join(opts.corpRoot, CHANNELS_JSON));
  const general = channels.find(c => c.name === 'general' || c.name === '#general');
  if (!general) {
    log(`[standup] No #general channel found — skipping standup`);
    return false;
  }

  // Build per-agent summaries from observations
  const agentSummaries: string[] = [];
  let blockers: string[] = [];
  let todaysPriority = '';

  for (const agentId of opts.enrolledAgents) {
    const member = members.find(m => m.id === agentId);
    if (!member?.agentDir) continue;

    const agentDir = join(opts.corpRoot, member.agentDir);
    const stats = getObservationStats(agentDir);
    if (!stats || stats.entryCount === 0) continue;

    // Parse observations for this agent
    const content = readTodaysObservations(agentDir);
    const observations = parseObservations(content);

    // Count by category
    const tasks = observations.filter(o => o.category === 'TASK').length;
    const decisions = observations.filter(o => o.category === 'DECISION').length;
    const blocked = observations.filter(o => o.category === 'BLOCKED');
    const checkpoints = observations.filter(o => o.category === 'CHECKPOINT');
    const learned = observations.filter(o => o.category === 'LEARNED');

    // Build summary line
    const parts: string[] = [];
    if (tasks > 0) parts.push(`${tasks} task action${tasks > 1 ? 's' : ''}`);
    if (decisions > 0) parts.push(`${decisions} decision${decisions > 1 ? 's' : ''}`);
    if (checkpoints.length > 0) parts.push(checkpoints.at(-1)!.description);
    if (learned.length > 0) parts.push(`learned: ${learned.at(-1)!.description.slice(0, 60)}`);

    if (parts.length > 0) {
      agentSummaries.push(`  ${member.displayName}: ${parts.join(', ')}`);
    }

    // Collect blockers
    for (const b of blocked) {
      blockers.push(`  ${member.displayName}: ${b.description}`);
    }

    // CEO's last observation = today's priority hint
    if (member.rank === 'master' && observations.length > 0) {
      const lastObs = observations.at(-1)!;
      todaysPriority = lastObs.description.slice(0, 100);
    }
  }

  if (agentSummaries.length === 0) {
    log(`[standup] No agent activity to report — skipping standup`);
    return false;
  }

  // Get analytics summary
  const entries = readTelemetry(opts.corpRoot);
  const cutoff = new Date(opts.activatedAt).toISOString();
  const sessionEntries = entries.filter(e => e.timestamp >= cutoff);
  const stats = computeSessionStats(sessionEntries);

  // Determine greeting based on time
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  // Format the standup
  const elapsedHours = Math.round(elapsed / 3_600_000);
  const lines: string[] = [
    `${greeting}. SLUMBER ran for ${elapsedHours}h. Here's what happened:`,
    '',
    ...agentSummaries,
  ];

  if (blockers.length > 0) {
    lines.push('', 'Blockers:');
    lines.push(...blockers);
  } else {
    lines.push('', 'Blockers: none');
  }

  if (stats.productivityScore > 0) {
    lines.push('', `Productivity: ${stats.productivityScore}% (${stats.productiveTicks}/${stats.totalTicks} ticks productive)`);
  }

  if (todaysPriority) {
    lines.push('', `CEO's last action: ${todaysPriority}`);
  }

  const standupContent = lines.join('\n');

  // Write to #general
  const msgPath = join(opts.corpRoot, general.path, MESSAGES_JSONL);
  post(general.id, msgPath, {
    senderId: 'system',
    content: standupContent,
    source: 'standup',
    kind: 'system',
    metadata: { slumberDurationMs: elapsed },
  });

  log(`[standup] Posted morning standup to #general (${agentSummaries.length} agents, ${elapsedHours}h session)`);
  return true;
}
