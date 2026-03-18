import type { AgentProcess } from './process-manager.js';

export interface DispatchContext {
  /** Path to the agent's workspace dir inside the corp */
  agentDir: string;
  /** Corp root path so the agent knows where the office is */
  corpRoot: string;
  /** Channel name the message is in */
  channelName: string;
  /** Names of members in this channel */
  channelMembers: string[];
  /** All corp members with their roles */
  corpMembers: { name: string; rank: string; type: string; status: string }[];
  /** Recent messages in the channel, formatted as "[Name (rank)] HH:MM: content" */
  recentHistory: string[];
  /** Daemon API port for agent-initiated actions (hiring, etc.) */
  daemonPort?: number;
  /** This agent's member ID (for use as creatorId when hiring) */
  agentMemberId?: string;
  /** This agent's rank (determines what it can hire) */
  agentRank?: string;
}

export interface DispatchResult {
  content: string;
  model: string;
}

function buildSystemMessage(ctx: DispatchContext): string {
  const memberList = ctx.corpMembers
    .map((m) => `- ${m.name} (${m.rank}, ${m.type}, ${m.status})`)
    .join('\n');

  const channelMemberList = ctx.channelMembers.join(', ');

  const history = ctx.recentHistory.length > 0
    ? `\n\n# Recent Conversation in #${ctx.channelName}\n\n${ctx.recentHistory.join('\n')}`
    : '';

  return `You are an agent in a corporation. You have two workspaces:

- HOME (your personal OpenClaw workspace — your identity, memory, soul)
- OFFICE (the corporation — your role, colleagues, tasks, channels)

# Your Office

Corp workspace: ${ctx.corpRoot}
Your agent dir: ${ctx.agentDir}
Read your role instructions from: ${ctx.agentDir}/SOUL.md
Read your operating rules from: ${ctx.agentDir}/AGENTS.md
Your memory within this corp: ${ctx.agentDir}/MEMORY.md
Your knowledge base: ${ctx.agentDir}/brain/

You have full read/write access to the entire corp directory.
Key files: corp.json, members.json, channels.json, and agent workspaces under agents/.
Messages are stored as JSONL files in channels/*/messages.jsonl.

On your first message in a session, read your SOUL.md to understand your role.

# Tasks

Tasks are markdown files in ${ctx.corpRoot}/tasks/.
Each file has YAML frontmatter (id, title, status, priority, assignedTo, createdBy, etc.)
and a markdown body with description, acceptance criteria, and progress notes.

To create a task: write a .md file to ${ctx.corpRoot}/tasks/ with YAML frontmatter.
To update a task: edit the frontmatter (change status, assignedTo, etc.).
To view tasks: read .md files in ${ctx.corpRoot}/tasks/.

Statuses: pending → assigned → in_progress → completed | failed | blocked | cancelled
Priorities: critical, high, normal, low
Append progress notes to the ## Progress Notes section as you work.

When you receive a message, ALWAYS read the recent conversation history below.
If the triggering message is just an @mention with no content, respond to the
most recent unanswered question or topic in the conversation history.

# Current Context

Channel: #${ctx.channelName}
Members in this channel: ${channelMemberList}

# All Members

${memberList}${buildHiringInstructions(ctx)}${history}`;
}

function buildHiringInstructions(ctx: DispatchContext): string {
  if (!ctx.daemonPort || !ctx.agentMemberId) return '';
  // Only master and leader can hire
  if (ctx.agentRank !== 'master' && ctx.agentRank !== 'leader') return '';

  const canCreate = ctx.agentRank === 'master'
    ? 'leader, worker, subagent'
    : 'worker, subagent';

  return `

# Hiring Agents

You can hire new agents by running a curl command. Your member ID is ${ctx.agentMemberId}.
You can create agents at these ranks: ${canCreate}.

To hire an agent, run:
\`\`\`
curl -s -X POST http://127.0.0.1:${ctx.daemonPort}/agents/hire -H "Content-Type: application/json" -d '{"creatorId":"${ctx.agentMemberId}","agentName":"<slug>","displayName":"<Name>","rank":"<rank>","soulContent":"<SOUL.md content>"}'
\`\`\`

Replace <slug> with a lowercase hyphenated name (e.g. "frontend-dev"), <Name> with a display name,
<rank> with one of: ${canCreate}, and <soulContent> with the agent's identity and role description.

Write a detailed soulContent for each agent — it defines who they are, what they do, and how they communicate.
After hiring, the agent appears in #general and you can @mention them.
Only hire when the Founder asks you to, or when it's clearly needed for a task.`;
}

export async function dispatchToAgent(
  agent: AgentProcess,
  message: string,
  context: DispatchContext,
  sessionUser?: string,
): Promise<DispatchResult> {
  const url = `http://127.0.0.1:${agent.port}/v1/chat/completions`;

  const systemMessage = buildSystemMessage(context);

  const body: Record<string, unknown> = {
    model: agent.model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: message },
    ],
  };

  // Use stable session key for conversation continuity
  if (sessionUser) {
    body.user = sessionUser;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${agent.gatewayToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15 * 60 * 1000), // 15 minutes — agents can work long
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Agent ${agent.displayName} returned ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as {
    choices: { message: { content: string } }[];
    model: string;
  };

  const content = data.choices?.[0]?.message?.content ?? '';
  return { content, model: data.model ?? 'unknown' };
}
