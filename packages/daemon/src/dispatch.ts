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

# Current Context

Channel: #${ctx.channelName}
Members in this channel: ${channelMemberList}

# All Members

${memberList}${history}`;
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
    signal: AbortSignal.timeout(120_000),
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
