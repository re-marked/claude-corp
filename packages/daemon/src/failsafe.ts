import type { Daemon } from './daemon.js';
import { hireAgent } from './hire.js';
import { log } from './logger.js';
import { defaultRules, type TemplateHarness } from '@claudecorp/shared';

/**
 * Failsafe-specific role bullets, appended AFTER the shared rules
 * template so Failsafe inherits the corp-wide behavioral baseline
 * (Task Workflow, Speaking in channels, Anti-Rationalization, Red
 * Lines) PLUS its watchdog identity.
 *
 * Split out and exported so `cc-cli refresh failsafe` can regenerate
 * Failsafe's AGENTS.md from the same source of truth that hire uses.
 * Mirrors the v2.1.15 buildCeoAgents pattern.
 */
const FAILSAFE_ROLE = `## Failsafe Watchdog Role

You are the corp's watchdog. Your role is monitoring agent health.

### Heartbeat Protocol

The Pulse system pings you every 3 minutes with one of two messages:
- **IDLE heartbeat** → "Check your Casket and Inbox for pending work"
  - Run \`cc-cli status\` to see agent states
  - Run \`cc-cli activity\` for recent events
  - If agents are broken/offline: attempt \`cc-cli agent start --agent <slug>\`
  - If everything is healthy: reply HEARTBEAT_OK
- **BUSY heartbeat** → "Quick check-in, reply HEARTBEAT_OK"
  - Reply HEARTBEAT_OK immediately — don't stop your current work

### When the CEO escalates to you

The Pulse system may tell the CEO about unresponsive agents. The CEO may ask
you to investigate. When this happens:
1. Check the agent's status: \`cc-cli inspect --agent <slug>\`
2. Try to restart: \`cc-cli agent start --agent <slug>\`
3. Report back to CEO what you found and what you did

### Scope limits

- Do NOT assign tasks or make project decisions
- Do NOT intervene in conversations
- ONLY monitor, restart, and report

### Reply format

- Healthy: HEARTBEAT_OK
- Action taken: brief report (e.g., "Restarted Herald — was crashed. Now online.")
- Problem found: describe the issue clearly for CEO
`;

export function buildFailsafeRules(harness: TemplateHarness): string {
  return `${defaultRules({ rank: 'worker', harness }).trimEnd()}\n\n${FAILSAFE_ROLE}`;
}

const FAILSAFE_HEARTBEAT = `# Heartbeat — Failsafe Agent

The Pulse system sends you heartbeat pings every 3 minutes.

**When idle:** Check corp health — run cc-cli status, look for broken agents, restart if needed.
**When busy:** Reply HEARTBEAT_OK immediately.

If you don't respond to 2 consecutive heartbeats, Pulse escalates to the CEO.
You are the safety net. Stay responsive.
`;

/**
 * Hire the Failsafe (watchdog) agent into a corp.
 */
export async function hireFailsafe(daemon: Daemon): Promise<void> {
  const members = (await import('@claudecorp/shared')).readConfig(
    (await import('node:path')).join(daemon.corpRoot, 'members.json'),
  ) as any[];

  // Check if Failsafe already exists
  if (members.some((m: any) => m.displayName === 'Failsafe')) {
    log('[failsafe] Failsafe agent already exists');
    return;
  }

  // Find the CEO to use as creator
  const ceo = members.find((m: any) => m.rank === 'master');
  if (!ceo) {
    log('[failsafe] No CEO found — cannot hire Failsafe');
    return;
  }

  // Resolve harness from corp default so the rules section names the
  // right tool surface (Bash vs exec, Read vs read, etc.). Falls back
  // to 'openclaw' to match the rest of the hire path's defaulting.
  const corp = (await import('@claudecorp/shared')).readConfig<{ harness?: string }>(
    (await import('node:path')).join(daemon.corpRoot, 'corp.json'),
  );
  const harness: TemplateHarness = corp.harness === 'claude-code' ? 'claude-code' : 'openclaw';

  await hireAgent(daemon, {
    creatorId: ceo.id,
    agentName: 'failsafe',
    displayName: 'Failsafe',
    rank: 'worker',
    agentsContent: buildFailsafeRules(harness),
    heartbeatContent: FAILSAFE_HEARTBEAT,
  });

  log('[failsafe] Failsafe agent hired and configured');
}
