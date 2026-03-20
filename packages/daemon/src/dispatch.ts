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
Your current tasks: ${ctx.agentDir}/TASKS.md
Your memory within this corp: ${ctx.agentDir}/MEMORY.md
Your knowledge base: ${ctx.agentDir}/brain/

You have full read/write access to the entire corp directory.
Key files: corp.json, members.json, channels.json, and agent workspaces under agents/.
Messages are stored as JSONL files in channels/*/messages.jsonl.

On your first message in a session, read your SOUL.md to understand your role.

# Tasks

Your tasks are listed in ${ctx.agentDir}/TASKS.md (auto-updated).
Task files live in ${ctx.corpRoot}/tasks/ as markdown with YAML frontmatter.

To CREATE a task and auto-notify the assignee, use the daemon API:
\`\`\`
curl -s -X POST http://127.0.0.1:${ctx.daemonPort}/tasks/create -H "Content-Type: application/json" -d '{"title":"<title>","createdBy":"${ctx.agentMemberId}","assignedTo":"<member-id>","priority":"<normal|high|critical|low>","description":"<details>"}'
\`\`\`
This creates the task file AND @mentions the assignee so they start working immediately.

To UPDATE a task status:
\`\`\`
curl -s -X PATCH http://127.0.0.1:${ctx.daemonPort}/tasks/<task-id> -H "Content-Type: application/json" -d '{"status":"in_progress"}'
\`\`\`

To VIEW tasks: read your TASKS.md, or read files in ${ctx.corpRoot}/tasks/.
You can also edit task files directly to update status or add progress notes.

Statuses: pending → assigned → in_progress → completed | failed | blocked | cancelled
Priorities: critical, high, normal, low

## CRITICAL: Anti-Hallucination Rules

You are a REAL agent with REAL tools. You must ACTUALLY do work, not just describe it.

1. **NEVER claim a file exists without reading it first.** If you get an error reading it, it does NOT exist.
2. **NEVER claim work is done without showing the actual file writes.** "I updated the file" means nothing if you didn't use the write tool.
3. **NEVER mark a task as completed unless you can prove it** — list the exact files you created or modified, with a snippet of what you wrote.
4. **If a task says "implement X", you must CREATE NEW FILES or MODIFY EXISTING FILES.** Reading files and saying "it's already done" is almost always wrong.
5. **Verify your own work.** After writing a file, read it back to confirm the write succeeded.
6. **If you hit errors, debug them.** Don't skip past EISDIR, ENOENT, or permission errors — they mean your path is wrong. Fix it and retry.
7. **When working on code tasks:** Read the ACTUAL source files first. Understand the existing patterns. Then write your changes. Then run the build (pnpm build) to verify. Only then mark the task done.
8. **Progress notes in the task file must include CONCRETE output** — file paths you modified, commands you ran, build results. Not just "enhanced the implementation."

## Response Chain

If you are the CEO and you receive a notification that a task has been completed or failed:
1. Read the task details to understand what was done
2. Write a message in your DM with the Founder summarizing the result
3. Include what was built, which files were changed, and whether the build passed

If you are any agent and you complete a task:
1. Post your results in the channel where you were @mentioned
2. Include specific files you created/modified and build results

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

/** SSE chunk shape from OpenAI-compatible streaming */
interface StreamChunk {
  model?: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string | null };
    finish_reason: string | null;
  }>;
}

/**
 * Consume an OpenAI-compatible SSE stream and return accumulated content.
 * Calls onToken for each token so the caller can update live preview state.
 */
async function consumeSSEStream(
  resp: Response,
  agentName: string,
  onToken?: (accumulated: string) => void,
): Promise<{ content: string; model: string }> {
  if (!resp.body) throw new Error(`Agent ${agentName} returned no response body`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let accumulated = '';
  let model = '';
  let done = false;

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;

      if (value) {
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      }

      // Split on SSE message boundary (\n\n)
      const messages = buffer.split('\n\n');
      buffer = messages.pop() ?? '';

      for (const message of messages) {
        for (const line of message.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') { done = true; break; }

          try {
            const chunk = JSON.parse(payload) as StreamChunk;
            if (chunk.model && !model) model = chunk.model;
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              accumulated += delta;
              onToken?.(accumulated);
            }
          } catch {
            // Malformed chunk — skip
          }
        }
        if (done) break;
      }
    }
    // Flush decoder
    const tail = decoder.decode();
    if (tail) buffer += tail;
  } finally {
    reader.releaseLock();
  }

  return { content: accumulated, model };
}

export async function dispatchToAgent(
  agent: AgentProcess,
  message: string,
  context: DispatchContext,
  sessionUser?: string,
  onToken?: (accumulated: string) => void,
): Promise<DispatchResult> {
  const systemMessage = buildSystemMessage(context);

  const body: Record<string, unknown> = {
    model: agent.model,
    stream: true,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: message },
    ],
  };

  if (sessionUser) {
    body.user = sessionUser;
  }

  // Try dispatch with one retry on transient failures (connection error, 401, 502-504)
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = `http://127.0.0.1:${agent.port}/v1/chat/completions`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${agent.gatewayToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });

      if (resp.ok) {
        const { content, model } = await consumeSSEStream(resp, agent.displayName, onToken);
        return { content, model: model || agent.model };
      }

      // Retryable HTTP errors
      if ((resp.status === 401 || resp.status >= 502) && attempt === 0) {
        const text = await resp.text();
        lastError = new Error(`Agent ${agent.displayName} returned ${resp.status}: ${text}`);
        console.error(`[dispatch] ${agent.displayName} returned ${resp.status}, retrying in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      const text = await resp.text();
      throw new Error(`Agent ${agent.displayName} returned ${resp.status}: ${text}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes('returned')) throw err;
      // Connection-level error (gateway down) — retry once
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === 0) {
        console.error(`[dispatch] ${agent.displayName} unreachable, retrying in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
    }
  }

  throw lastError ?? new Error(`Dispatch to ${agent.displayName} failed after retry`);
}
