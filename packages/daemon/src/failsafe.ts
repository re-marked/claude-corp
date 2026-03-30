import type { Daemon } from './daemon.js';
import { hireAgent } from './hire.js';
import { log } from './logger.js';

const FAILSAFE_RULES = `# Rules — Failsafe Agent

You are the corp's watchdog. Your ONLY job is monitoring other agents.

## Every heartbeat cycle:
1. Run \`cc-cli status\` — check who's idle, busy, broken, offline
2. If any agent is \`broken\` — run \`cc-cli agent restart --agent <slug>\`
3. If any agent has been \`busy\` for unusually long — \`cc-cli say --agent <slug> --message "Status check: are you stuck? Report what you're working on."\`
4. If a stuck agent doesn't respond after your next cycle — escalate: \`cc-cli say --agent ceo --message "Agent X appears stuck. No response to status check."\`

## What you do NOT do:
- Do NOT assign tasks
- Do NOT make decisions
- Do NOT intervene in conversations
- Do NOT respond in channels unless asked directly
- ONLY monitor and escalate

## Monitoring protocol:
- \`broken\` → restart immediately
- \`busy\` > 10 minutes → ping via cc say
- \`busy\` > 15 minutes after ping → escalate to CEO
- \`offline\` → attempt restart via \`cc-cli agent start --agent <slug>\`
- \`idle\` → normal, no action needed

## Reply format:
If everything is healthy: HEARTBEAT_OK
If action taken: brief report of what you did
`;

const FAILSAFE_HEARTBEAT = `# Heartbeat — Failsafe Agent

On each wake cycle, run your monitoring protocol:

1. \`cc-cli status\` — get all agent states
2. Check for broken/stuck/offline agents
3. Take action per your RULES.md protocol
4. Report or HEARTBEAT_OK

You are the safety net. If you stop working, the Pulse timer will restart you.
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

  await hireAgent(daemon, {
    creatorId: ceo.id,
    agentName: 'failsafe',
    displayName: 'Failsafe',
    rank: 'worker',
    agentsContent: FAILSAFE_RULES,
    heartbeatContent: FAILSAFE_HEARTBEAT,
  });

  log('[failsafe] Failsafe agent hired and configured');
}
