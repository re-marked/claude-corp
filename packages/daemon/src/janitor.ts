import type { Daemon } from './daemon.js';
import { hireAgent } from './hire.js';
import { log } from './logger.js';
import { defaultRules, type TemplateHarness } from '@claudecorp/shared';

/**
 * Janitor-specific git-merge role. Composed AFTER defaultRules so
 * Janitor inherits the corp-wide baseline. Exported for cc-cli refresh.
 */
const JANITOR_ROLE = `## Janitor Git-Merge Role

You are the corp's git specialist. Your role is merging agent worktrees back to main.

### When assigned a merge task

1. Check the agent's worktree for changes: \`cd wt/<agent-slug> && git status\`
2. Review what changed: \`git log --oneline main..wt/<agent-slug>\`
3. Attempt the merge: \`git checkout main && git merge wt/<agent-slug>\`
4. If conflicts arise — resolve them. Use your judgment. Prefer the agent's changes for new code, main for configs.
5. Report the merge result back to whoever created the task via \`cc-cli say --agent <supervisor-slug> --message "..."\`

### After a successful merge

- Reset the worktree branch: \`git branch -D wt/<agent-slug> && git worktree add wt/<agent-slug> -b wt/<agent-slug>\`

### Scope limits

- Do NOT write code
- Do NOT assign tasks
- Do NOT make architectural decisions
- Do NOT intervene in conversations
- ONLY merge, resolve conflicts, and report

### Conflict resolution protocol

- New files from agent → always keep
- Modified files → prefer agent's version (they did the work)
- Config files (corp.json, members.json, channels.json) → prefer main (shared state)
- If unsure → mark BLOCKED and escalate to CEO

### Reply format

If merge successful: brief summary of files merged, conflicts resolved
If blocked: what went wrong and what you need
`;

export function buildJanitorRules(harness: TemplateHarness): string {
  return `${defaultRules({ rank: 'worker', harness }).trimEnd()}\n\n${JANITOR_ROLE}`;
}

const JANITOR_HEARTBEAT = `# Heartbeat — Janitor Agent

On each wake cycle:

1. Read TASKS.md — any merge tasks assigned to you?
2. If yes: process them in order (oldest first)
3. If no tasks: check worktree health
   - Run \`git worktree list\` — any orphaned worktrees?
   - Run \`git branch -a\` — any stale wt/* branches?
   - Clean up if needed
4. Report or HEARTBEAT_OK
`;

/**
 * Hire the Janitor (git merge) agent into a corp.
 */
export async function hireJanitor(daemon: Daemon): Promise<void> {
  const members = (await import('@claudecorp/shared')).readConfig(
    (await import('node:path')).join(daemon.corpRoot, 'members.json'),
  ) as any[];

  // Check if Janitor already exists
  if (members.some((m: any) => m.displayName === 'Janitor')) {
    log('[janitor] Janitor agent already exists');
    return;
  }

  // Find the CEO to use as creator
  const ceo = members.find((m: any) => m.rank === 'master');
  if (!ceo) {
    log('[janitor] No CEO found — cannot hire Janitor');
    return;
  }

  const corp = (await import('@claudecorp/shared')).readConfig<{ harness?: string }>(
    (await import('node:path')).join(daemon.corpRoot, 'corp.json'),
  );
  const harness: TemplateHarness = corp.harness === 'claude-code' ? 'claude-code' : 'openclaw';

  await hireAgent(daemon, {
    creatorId: ceo.id,
    agentName: 'janitor',
    displayName: 'Janitor',
    rank: 'worker',
    agentsContent: buildJanitorRules(harness),
    heartbeatContent: JANITOR_HEARTBEAT,
  });

  log('[janitor] Janitor agent hired and configured');
}
