import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  getObservationLogPath,
  getObservationStats,
} from '@claudecorp/shared';
import type { Fragment } from './types.js';

export const contextFragment: Fragment = {
  id: 'context',
  applies: () => true,
  order: 90,
  render: (ctx) => {
    const memberList = ctx.corpMembers
      .map((m) => {
        const statusIcon = m.status === 'idle' ? '\u25CB' : m.status === 'busy' ? '\u25CF' : m.status === 'broken' ? '\u2717' : '\u25CB';
        return `  ${statusIcon} ${m.name} (${m.rank}${m.type === 'user' ? ', founder' : ''}) — ${m.status}`;
      })
      .join('\n');

    // Build hierarchy hint
    const founder = ctx.corpMembers.find(m => m.type === 'user');
    const ceo = ctx.corpMembers.find(m => m.rank === 'master' && m.type !== 'user');
    const leaders = ctx.corpMembers.filter(m => m.rank === 'leader');
    const workers = ctx.corpMembers.filter(m => m.rank === 'worker');

    let hierarchyHint = '';
    if (founder && ceo) {
      hierarchyHint = `
## Hierarchy
${founder.name} (Founder, human — unreachable directly)
  └── ${ceo.name} (CEO — Founder's delegate, runs the corp)
${leaders.map(l => `       ├── ${l.name} (leader)`).join('\n')}
${workers.map(w => `       │   └── ${w.name} (worker)`).join('\n')}

## Rank Authority
- **Founder** > **CEO (master)** > **Leaders** > **Workers** > **Subagents**
- You report to your direct supervisor (the agent who hired/manages you)
- Only escalate to CEO if your supervisor can't resolve`;
    }

    // Environment info — adapted from Claude Code's envInfo section in utils/systemPrompt.ts
    const now = new Date();
    const tzOffset = -now.getTimezoneOffset();
    const tzHours = Math.floor(Math.abs(tzOffset) / 60);
    const tzMins = Math.abs(tzOffset) % 60;
    const tzSign = tzOffset >= 0 ? '+' : '-';
    const tzString = `UTC${tzSign}${String(tzHours).padStart(2, '0')}:${String(tzMins).padStart(2, '0')}`;
    const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? 'en-US';
    const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    const shell = process.env.SHELL ?? process.env.COMSPEC ?? 'unknown';

    return `# Corp Members

${memberList}

## Status Meanings
- **idle** — ready to receive tasks, not currently working
- **busy** — actively working on a task (don't interrupt unless urgent)
- **broken** — crashed or errored (Sexton's silentexit sweeper will respawn)
- **offline** — not running (needs manual start)
${hierarchyHint}

${ctx.autoemonEnrolled ? `## Autonomous Mode (Autoemon)
You are in autonomous tick mode. You receive \`<tick>\` prompts instead of heartbeats. See the "Autonomous Work Mode" section above for full details.` : `## Heartbeat Protocol
The Pulse system pings you every 3 minutes:
- **If you are idle:** You'll get "Check your Casket and Inbox." Do useful work — read TASKS.md, check for pending tasks, process inbox items.
- **If you are busy:** You'll get a quick "HEARTBEAT" ping. Reply **HEARTBEAT_OK** immediately and continue your work. Don't stop what you're doing.
- If you don't respond to 2 consecutive heartbeats, the CEO gets notified.`}

## Environment
- **Platform:** ${platform} (${process.arch})
- **Shell:** ${shell}
- **Timezone:** ${tzString} (${locale})
- **Current time:** ${now.toISOString()} (local: ${now.toLocaleString()})
- **Corp root:** ${ctx.corpRoot}

When running shell commands, use the correct syntax for ${platform}. Timestamps from external tools may be in different timezones — the times above are the Founder's local time.

## Session Continuity
${buildContinuityHint(ctx.agentDir, now)}`;
  },
};

/** Build a hint about recent activity for cross-session continuity. */
function buildContinuityHint(agentDir: string, now: Date): string {
  const hints: string[] = [];

  // Check WORKLOG.md freshness
  try {
    const worklogPath = join(agentDir, 'WORKLOG.md');
    if (existsSync(worklogPath)) {
      const stat = statSync(worklogPath);
      const ageMin = Math.round((now.getTime() - stat.mtimeMs) / 60_000);
      if (ageMin < 60) {
        hints.push(`Your WORKLOG.md was updated ${ageMin}m ago — you may have been mid-task. Read it to check.`);
      }
    }
  } catch {}

  // Check today's observation chits
  try {
    const stats = getObservationStats(agentDir);
    if (stats && stats.entryCount > 0) {
      hints.push(`You have ${stats.entryCount} observation chit${stats.entryCount === 1 ? '' : 's'} today (last at ${stats.lastEntry}). Query with \`cc-cli chit list --type observation\` for context on what you've done.`);
    }
  } catch {}

  // Check INBOX.md size (pending items)
  try {
    const inboxPath = join(agentDir, 'INBOX.md');
    if (existsSync(inboxPath)) {
      const size = statSync(inboxPath).size;
      if (size > 500) { // More than just a header
        hints.push(`Your INBOX.md has pending items. Check it before starting new work.`);
      }
    }
  } catch {}

  if (hints.length === 0) {
    return 'Fresh session. Read your Casket files (TASKS.md, INBOX.md, WORKLOG.md) to orient.';
  }

  return hints.join('\n');
}
