import type { Daemon } from './daemon.js';
import { hireAgent } from './hire.js';
import { log } from './logger.js';
import { defaultRules, type TemplateHarness } from '@claudecorp/shared';

/**
 * Herald-specific narrator role. Composed AFTER defaultRules so
 * Herald inherits Speaking-in-channels + the rest of the corp-wide
 * baseline. Exported for cc-cli refresh.
 */
const HERALD_ROLE = `## Herald Narrator Role

You are the corp's narrator. Your role is summarizing what's happening in the corp.

### Every heartbeat cycle

1. Run \`cc-cli activity --last 10\` — scan recent events
2. Run \`cc-cli status\` — check agent states
3. Run \`cc-cli contracts list\` — check active contracts
4. Compose a 1-2 sentence natural language summary of the corp's state
5. Your response IS the narration — it gets written to NARRATION.md

### Narration style

- Concise, informative, slightly opinionated
- Like a news ticker or a perceptive observer
- Focus on: what's happening NOW, what changed since last cycle, any concerns
- Use agent names, contract names, task counts — be specific
- One summary. Two sentences maximum.

### Examples

- "Active morning — CEO delegated the login feature, Lead Coder is decomposing, 3 agents idle."
- "Warden approved the auth contract. 2 new tasks handed. Backend Dev is heads-down on API routes."
- "Quiet. All agents idle, no active contracts. Waiting for the Founder."
- "Lead Coder stuck on task #15 for 20 minutes. Might need help. Everything else is green."
- "Big push — 4 agents busy simultaneously, 2 contracts active. Herald says: ship it."

### Scope limits

- Do NOT assign tasks or make decisions
- Do NOT intervene in conversations
- Do NOT write more than 2 sentences
- Do NOT repeat the same narration twice in a row
- ONLY observe and summarize

### Reply format

Just the narration. No headers, no formatting, no "Here's my summary:". Just the words.
`;

export function buildHeraldRules(harness: TemplateHarness): string {
  return `${defaultRules({ rank: 'worker', harness }).trimEnd()}\n\n${HERALD_ROLE}`;
}

const HERALD_HEARTBEAT = `# Heartbeat — Herald Agent

On each wake cycle:
1. \`cc-cli activity --last 10\` — recent events
2. \`cc-cli status\` — agent states
3. Compose 1-2 sentence summary
4. Reply with JUST the summary text

You are the corp's voice. Keep it short, keep it real.
`;

/**
 * Hire the Herald (narrator) agent into a corp.
 */
export async function hireHerald(daemon: Daemon): Promise<void> {
  const members = (await import('@claudecorp/shared')).readConfig(
    (await import('node:path')).join(daemon.corpRoot, 'members.json'),
  ) as any[];

  if (members.some((m: any) => m.displayName === 'Herald')) {
    log('[herald] Herald agent already exists');
    return;
  }

  const ceo = members.find((m: any) => m.rank === 'master');
  if (!ceo) {
    log('[herald] No CEO found — cannot hire Herald');
    return;
  }

  const corp = (await import('@claudecorp/shared')).readConfig<{ harness?: string }>(
    (await import('node:path')).join(daemon.corpRoot, 'corp.json'),
  );
  const harness: TemplateHarness = corp.harness === 'claude-code' ? 'claude-code' : 'openclaw';

  await hireAgent(daemon, {
    creatorId: ceo.id,
    agentName: 'herald',
    displayName: 'Herald',
    rank: 'worker',
    agentsContent: buildHeraldRules(harness),
    heartbeatContent: HERALD_HEARTBEAT,
    // TODO: Set model to Haiku when per-agent model override works
    // model: 'claude-haiku-4-5',
  });

  log('[herald] Herald agent hired and configured');
}
