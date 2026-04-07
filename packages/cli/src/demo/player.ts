/**
 * Demo Player — executes scenario events with realistic timing.
 *
 * Two paths for output:
 *   1. Daemon /demo/broadcast — for live streaming/tool events (TUI animation)
 *   2. Direct JSONL writes via post() — for persistent messages
 *
 * Char-by-char streaming is implemented by slicing message content and
 * firing one stream-token per character with a small delay.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  post,
  generateId,
  readConfig,
  writeConfig,
  type Channel,
  type Member,
  CHANNELS_JSON,
  MEMBERS_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import type {
  Scenario,
  TimedEvent,
  DemoEvent,
  PlayerOptions,
  StreamTokenEvent,
} from './types.js';
import { TYPING_SPEED } from './types.js';

// ── HTTP helper ────────────────────────────────────────────────────

async function broadcastEvent(daemonUrl: string, event: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${daemonUrl}/demo/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch {
    // Non-fatal — TUI might not be connected, JSONL writes still work
  }
}

// ── Channel resolution ─────────────────────────────────────────────

function resolveChannelId(corpRoot: string, channelName: string): string | null {
  try {
    const channels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));
    const ch = channels.find(c => c.name === channelName || c.id === channelName);
    return ch?.id ?? null;
  } catch { return null; }
}

function resolveChannelPath(corpRoot: string, channelName: string): string | null {
  try {
    const channels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));
    const ch = channels.find(c => c.name === channelName || c.id === channelName);
    return ch ? join(corpRoot, ch.path, MESSAGES_JSONL) : null;
  } catch { return null; }
}

function resolveAgentId(corpRoot: string, displayName: string): string | null {
  try {
    const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
    const m = members.find(mem => mem.displayName === displayName);
    return m?.id ?? null;
  } catch { return null; }
}

function resolveFounderId(corpRoot: string): string | null {
  try {
    const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
    const founder = members.find(m => m.rank === 'owner');
    return founder?.id ?? null;
  } catch { return null; }
}

// ── Sleep helper ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Event executors ────────────────────────────────────────────────

async function executeEvent(event: DemoEvent, opts: PlayerOptions): Promise<void> {
  const { corpRoot, daemonUrl, speed } = opts;

  switch (event.type) {
    case 'wait': {
      await sleep(event.ms / speed);
      return;
    }

    case 'user-message': {
      const channelId = resolveChannelId(corpRoot, event.channel);
      const msgPath = resolveChannelPath(corpRoot, event.channel);
      const founderId = resolveFounderId(corpRoot);
      if (!channelId || !msgPath || !founderId) return;

      // Optional typing simulation delay
      if (event.typingDelayMs) await sleep(event.typingDelayMs / speed);

      post(channelId, msgPath, {
        senderId: founderId,
        content: event.content,
        source: 'user',
      });
      return;
    }

    case 'system-message': {
      const channelId = resolveChannelId(corpRoot, event.channel);
      const msgPath = resolveChannelPath(corpRoot, event.channel);
      if (!channelId || !msgPath) return;

      post(channelId, msgPath, {
        senderId: 'system',
        content: event.content,
        source: 'system',
        kind: 'system',
      });
      return;
    }

    case 'dispatch-start': {
      const channelId = resolveChannelId(corpRoot, event.channel);
      if (!channelId) return;
      await broadcastEvent(daemonUrl, {
        type: 'dispatch_start',
        agentName: event.agent,
        channelId,
      });
      return;
    }

    case 'stream-token': {
      // Single token broadcast — for manually controlled streaming
      const channelId = resolveChannelId(corpRoot, event.channel);
      if (!channelId) return;
      await broadcastEvent(daemonUrl, {
        type: 'stream_token',
        agentName: event.agent,
        channelId,
        content: event.content,
      });
      return;
    }

    case 'stream-end': {
      const channelId = resolveChannelId(corpRoot, event.channel);
      const msgPath = resolveChannelPath(corpRoot, event.channel);
      const agentId = resolveAgentId(corpRoot, event.agent);
      if (!channelId || !msgPath || !agentId) return;

      // Stream the content character by character first
      await streamCharByChar(event.agent, channelId, event.content, opts);

      // Broadcast stream_end (clears preview)
      await broadcastEvent(daemonUrl, {
        type: 'stream_end',
        agentName: event.agent,
        channelId,
      });
      await broadcastEvent(daemonUrl, {
        type: 'dispatch_end',
        agentName: event.agent,
        channelId,
      });

      // Persist final message to JSONL
      post(channelId, msgPath, {
        senderId: agentId,
        content: event.content,
        source: 'jack',
      });
      return;
    }

    case 'tool-call': {
      const channelId = resolveChannelId(corpRoot, event.channel);
      const msgPath = resolveChannelPath(corpRoot, event.channel);
      const agentId = resolveAgentId(corpRoot, event.agent);
      if (!channelId || !msgPath || !agentId) return;

      const toolCallId = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Tool start event
      await broadcastEvent(daemonUrl, {
        type: 'tool_start',
        agentName: event.agent,
        channelId,
        toolName: event.tool,
        args: event.args,
      });

      // Wait for tool "execution"
      const duration = (event.durationMs ?? 800) / speed;
      await sleep(duration);

      // Tool end event
      await broadcastEvent(daemonUrl, {
        type: 'tool_end',
        agentName: event.agent,
        channelId,
        toolName: event.tool,
      });

      // Persist tool_event message to JSONL
      const toolMsgContent = formatToolMsgInline(event.tool, event.args);
      post(channelId, msgPath, {
        senderId: agentId,
        content: toolMsgContent,
        source: 'jack',
        kind: 'tool_event',
        metadata: {
          toolName: event.tool,
          toolCallId,
          toolArgs: event.args,
          toolResult: event.result?.slice(0, 300),
        },
      });
      return;
    }

    case 'agent-appear': {
      // Add agent to members.json
      try {
        const membersPath = join(corpRoot, MEMBERS_JSON);
        const members = readConfig<Member[]>(membersPath);
        if (members.find(m => m.id === event.id)) return; // already exists

        const newMember = {
          id: event.id,
          type: 'agent',
          displayName: event.displayName,
          rank: event.rank,
          status: 'active',
          createdAt: new Date().toISOString(),
          agentDir: `agents/${event.id}/`,
          scope: 'corp',
        } as unknown as Member;
        members.push(newMember);
        writeConfig(membersPath, members);
      } catch {}
      return;
    }

    case 'task-create': {
      // Create a task file
      try {
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const tasksDir = join(corpRoot, 'tasks');
        mkdirSync(tasksDir, { recursive: true });
        const frontmatter = [
          '---',
          `id: ${event.id}`,
          `title: "${event.title}"`,
          `status: ${event.status ?? 'pending'}`,
          `priority: ${event.priority ?? 'normal'}`,
          event.assignedTo ? `assignedTo: ${event.assignedTo}` : '',
          `createdAt: ${new Date().toISOString()}`,
          'createdBy: ceo',
          '---',
          '',
          `# ${event.title}`,
          '',
        ].filter(Boolean).join('\n');
        writeFileSync(join(tasksDir, `${event.id}.md`), frontmatter);
      } catch {}
      return;
    }

    case 'task-update': {
      // Update task status (read, modify frontmatter, write)
      try {
        const { readFileSync, writeFileSync } = await import('node:fs');
        const taskPath = join(corpRoot, 'tasks', `${event.id}.md`);
        const content = readFileSync(taskPath, 'utf-8');
        const updated = content.replace(/^status: .*$/m, `status: ${event.status}`);
        writeFileSync(taskPath, updated);
      } catch {}
      return;
    }

    case 'slumber-start': {
      // Broadcast autoemon_state event
      await broadcastEvent(daemonUrl, {
        type: 'autoemon_state',
        state: 'active',
        source: 'slumber',
      });
      return;
    }

    case 'slumber-tick': {
      // Broadcast a status update — visible in the autoemon status bar.
      // Productive ticks pulse the indicator, idle ticks tick quietly.
      await broadcastEvent(daemonUrl, {
        type: 'autoemon_tick',
        agentName: event.agent,
        productive: event.productive,
      });
      return;
    }

    case 'slumber-end': {
      await broadcastEvent(daemonUrl, {
        type: 'autoemon_state',
        state: 'inactive',
      });
      return;
    }

    case 'view-switch': {
      // The TUI doesn't have a direct API to switch views — this is informational only
      // The recorder should manually switch views when this event fires
      return;
    }

    case 'observation-write': {
      // Append to today's observation log: agents/<id>/observations/YYYY/MM/YYYY-MM-DD.md
      try {
        const { mkdirSync, appendFileSync } = await import('node:fs');
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const obsDir = join(corpRoot, 'agents', event.agent, 'observations', String(yyyy), mm);
        mkdirSync(obsDir, { recursive: true });
        const obsPath = join(obsDir, `${yyyy}-${mm}-${dd}.md`);
        const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        appendFileSync(obsPath, `\n## ${time} [${event.category}]\n\n${event.content}\n`);
      } catch {}
      return;
    }

    case 'brain-write': {
      // Create/overwrite agents/<id>/BRAIN/<topic>.md
      try {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const brainDir = join(corpRoot, 'agents', event.agent, 'BRAIN');
        mkdirSync(brainDir, { recursive: true });
        writeFileSync(join(brainDir, `${event.topic}.md`), event.content);
      } catch {}
      return;
    }
  }
}

// ── Char-by-char streaming ─────────────────────────────────────────

async function streamCharByChar(
  agent: string,
  channelId: string,
  fullContent: string,
  opts: PlayerOptions,
): Promise<void> {
  const { daemonUrl, speed } = opts;

  // Broadcast dispatch_start to set up the streaming preview
  await broadcastEvent(daemonUrl, {
    type: 'dispatch_start',
    agentName: agent,
    channelId,
  });

  let accumulated = '';
  for (const char of fullContent) {
    accumulated += char;

    // Broadcast the accumulated content as the new stream_token state
    await broadcastEvent(daemonUrl, {
      type: 'stream_token',
      agentName: agent,
      channelId,
      content: accumulated,
    });

    // Realistic typing delay — slower for spaces/punctuation, faster for letters
    let delay: number = TYPING_SPEED.normal;
    if (char === ' ') delay = TYPING_SPEED.fast;
    else if (char === '.' || char === ',' || char === '!') delay = TYPING_SPEED.slow * 2;
    else if (char === '\n') delay = TYPING_SPEED.slow * 3;

    await sleep(delay / speed);
  }
}

// ── Tool message formatting (simplified copy) ──────────────────────

function formatToolMsgInline(toolName: string, args?: Record<string, unknown>): string {
  const name = toolName.toLowerCase();
  const path = args?.path ?? args?.file_path ?? args?.filePath;
  if (name === 'read' || name === 'read_file') return `read ${path ?? 'a file'}`;
  if (name === 'write' || name === 'create') return `wrote ${path ?? 'a file'}`;
  if (name === 'edit' || name === 'patch') return `edited ${path ?? 'a file'}`;
  if (name === 'bash' || name === 'exec' || name === 'run') {
    const cmd = String(args?.command ?? args?.cmd ?? '').trim();
    return cmd ? `ran \`${cmd.slice(0, 80)}\`` : 'ran a command';
  }
  if (name === 'grep') return `searched for "${args?.pattern ?? '...'}"`;
  if (name === 'glob') return `found ${args?.pattern ?? 'files'}`;
  return `used ${toolName}`;
}

// ── TUI connection check ───────────────────────────────────────────

/** Check if at least one TUI client is connected to the daemon WebSocket. */
async function checkTuiConnected(daemonUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${daemonUrl}/status`);
    if (!resp.ok) return false;
    // Status endpoint doesn't expose client count directly, but if the daemon
    // responds at all we know it's up. We'll trust the user to have the TUI open.
    return true;
  } catch {
    return false;
  }
}

// ── Main player ────────────────────────────────────────────────────

export async function playScenario(opts: PlayerOptions): Promise<void> {
  const raw = readFileSync(opts.scenarioPath, 'utf-8');
  const scenario = JSON.parse(raw) as Scenario;

  console.log(`\n▶ Playing scenario: ${scenario.title}`);
  console.log(`  ${scenario.description}`);
  console.log(`  Duration: ${scenario.durationSec}s (speed: ${opts.speed}x)\n`);

  // Verify daemon is reachable before starting
  const daemonUp = await checkTuiConnected(opts.daemonUrl);
  if (!daemonUp) {
    throw new Error(`Daemon not reachable at ${opts.daemonUrl}. Is it running?`);
  }

  const startedAt = Date.now();
  let lastAt = 0;

  for (const timed of scenario.events) {
    // Wait until this event's timestamp
    const targetMs = timed.at / opts.speed;
    const elapsed = Date.now() - startedAt;
    const waitMs = targetMs - elapsed;
    if (waitMs > 0) await sleep(waitMs);

    // Pause for screenshots if configured
    if (opts.pauseAtSec && timed.at >= opts.pauseAtSec * 1000 && lastAt < opts.pauseAtSec * 1000) {
      console.log(`\n⏸  Paused at ${opts.pauseAtSec}s — press Enter to continue`);
      await new Promise<void>(resolve => {
        process.stdin.once('data', () => resolve());
      });
    }
    lastAt = timed.at;

    // Execute the event
    try {
      await executeEvent(timed.event, opts);
    } catch (err) {
      console.error(`[demo] Event failed:`, timed.event.type, err);
    }
  }

  const totalSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n✓ Scenario complete (${totalSec}s elapsed)\n`);
}
