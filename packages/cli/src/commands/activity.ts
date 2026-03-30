import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  type Channel,
  type Member,
  readConfig,
  tailMessages,
  listTasks,
  CHANNELS_JSON,
  MEMBERS_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import { getCorpRoot, getClient } from '../client.js';

interface AgentSummary {
  name: string;
  status: string;
  lastActive: Date | null;
  recentActions: string[];
}

interface EventItem {
  timestamp: Date;
  channelName: string;
  senderName: string;
  content: string;
  kind: string;
  importance: 'high' | 'normal' | 'low';
}

export async function cmdActivity(opts: {
  agent?: string;
  channel?: string;
  last?: number;
  verbose?: boolean;
  json: boolean;
}) {
  const corpRoot = await getCorpRoot();
  const channels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));
  const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  const maxItems = opts.last ?? 20;

  // Build lookup maps
  const memberMap = new Map<string, Member>();
  for (const m of members) memberMap.set(m.id, m);
  const nameOf = (id: string) => memberMap.get(id)?.displayName ?? (id === 'system' ? 'System' : '?');
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '-');

  // --- Section 1: Agent Status Overview ---
  const agents = members.filter(m => m.type === 'agent');
  let agentStatuses: Record<string, string> = {};

  try {
    const client = getClient();
    const status = await client.status();
    for (const a of (status as any).agents ?? []) {
      agentStatuses[a.memberId] = (status as any).dispatching?.includes(a.displayName) ? 'working' : a.status;
    }
  } catch {
    // Daemon might not be running — show from members only
  }

  const agentSummaries: AgentSummary[] = [];
  for (const agent of agents) {
    const status = agentStatuses[agent.id] ?? 'offline';

    // Find last message from this agent across all channels
    let lastActive: Date | null = null;
    const recentActions: string[] = [];

    for (const ch of channels) {
      try {
        const msgPath = join(corpRoot, ch.path, MESSAGES_JSONL);
        if (!existsSync(msgPath)) continue;
        const recent = tailMessages(msgPath, 20);
        const agentMsgs = recent.filter(m => m.senderId === agent.id && m.kind === 'text');

        for (const m of agentMsgs) {
          const msgTime = new Date(m.timestamp);
          if (!lastActive || msgTime > lastActive) lastActive = msgTime;
        }

        if (agentMsgs.length > 0) {
          const last = agentMsgs[agentMsgs.length - 1]!;
          const preview = last.content.replace(/\n/g, ' ').slice(0, 60);
          recentActions.push(`#${ch.name}: "${preview}"`);
        }
      } catch {}
    }

    agentSummaries.push({ name: agent.displayName, status, lastActive, recentActions: recentActions.slice(0, 2) });
  }

  // --- Section 2: Task Overview ---
  const allTasks = listTasks(corpRoot);
  const taskCounts = {
    in_progress: allTasks.filter(t => t.task.status === 'in_progress').length,
    assigned: allTasks.filter(t => t.task.status === 'assigned').length,
    blocked: allTasks.filter(t => t.task.status === 'blocked').length,
    completed: allTasks.filter(t => t.task.status === 'completed').length,
    pending: allTasks.filter(t => t.task.status === 'pending').length,
  };

  // --- Section 3: Event Stream (smart, not raw) ---
  const events: EventItem[] = [];

  // Filter channels
  let targetChannels = channels;
  if (opts.channel) {
    targetChannels = channels.filter(c => c.name.includes(opts.channel!));
  }

  // Resolve --agent filter
  let filterAgentId: string | undefined;
  if (opts.agent) {
    const agent = members.find(m =>
      m.type === 'agent' && (normalize(m.displayName) === normalize(opts.agent!) || m.id === opts.agent),
    );
    if (agent) filterAgentId = agent.id;
  }

  for (const ch of targetChannels) {
    try {
      const msgPath = join(corpRoot, ch.path, MESSAGES_JSONL);
      if (!existsSync(msgPath)) continue;
      const recent = tailMessages(msgPath, 15);

      for (const msg of recent) {
        if (msg.kind === 'tool_event' && !opts.verbose) continue;
        if (filterAgentId && msg.senderId !== filterAgentId) continue;

        // Classify importance
        let importance: EventItem['importance'] = 'normal';
        if (msg.kind === 'task_event' && msg.content.includes('completed')) importance = 'high';
        if (msg.kind === 'task_event' && msg.content.includes('BLOCKED')) importance = 'high';
        if (msg.content.includes('CRITICAL') || msg.content.includes('escalat')) importance = 'high';
        if (msg.kind === 'system') importance = 'low';

        events.push({
          timestamp: new Date(msg.timestamp),
          channelName: ch.name,
          senderName: nameOf(msg.senderId),
          content: msg.content.replace(/\n/g, ' ').trim(),
          kind: msg.kind,
          importance,
        });
      }
    } catch {}
  }

  events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  const displayEvents = events.slice(0, maxItems);

  // --- Section 4: Problems Detection ---
  const problems: string[] = [];
  for (const agent of agentSummaries) {
    if (agent.status === 'crashed') problems.push(`${agent.name} is CRASHED`);
    if (agent.status === 'offline' || agent.status === 'stopped') problems.push(`${agent.name} is offline`);
  }
  if (taskCounts.blocked > 0) problems.push(`${taskCounts.blocked} task${taskCounts.blocked === 1 ? '' : 's'} BLOCKED`);

  // --- Output ---
  if (opts.json) {
    console.log(JSON.stringify({
      agents: agentSummaries,
      tasks: taskCounts,
      events: displayEvents.map(e => ({
        timestamp: e.timestamp.toISOString(),
        channel: e.channelName,
        sender: e.senderName,
        kind: e.kind,
        content: e.content.slice(0, 200),
        importance: e.importance,
      })),
      problems,
    }, null, 2));
    return;
  }

  // --- Pretty Print ---

  // Problems (if any)
  if (problems.length > 0) {
    console.log('PROBLEMS:');
    for (const p of problems) console.log(`  !! ${p}`);
    console.log('');
  }

  // Agent overview
  console.log('AGENTS:');
  const statusIcon: Record<string, string> = {
    ready: '\u25C6', working: '\u25C6', starting: '\u25CB', stopped: '\u25CB', crashed: '\u2717', offline: '\u25CB',
  };
  const statusLabel: Record<string, string> = {
    ready: 'idle', working: 'working...', starting: 'starting', stopped: 'offline', crashed: 'CRASHED', offline: 'offline',
  };

  for (const a of agentSummaries) {
    const icon = statusIcon[a.status] ?? '\u25CB';
    const label = statusLabel[a.status] ?? a.status;
    const ago = a.lastActive ? timeAgo(a.lastActive) : 'never';
    console.log(`  ${icon} ${a.name.padEnd(16)} ${label.padEnd(12)} last: ${ago}`);
    for (const action of a.recentActions) {
      console.log(`    \u2514 ${action}`);
    }
  }
  console.log('');

  // Task summary
  const taskParts: string[] = [];
  if (taskCounts.in_progress > 0) taskParts.push(`${taskCounts.in_progress} active`);
  if (taskCounts.assigned > 0) taskParts.push(`${taskCounts.assigned} assigned`);
  if (taskCounts.blocked > 0) taskParts.push(`${taskCounts.blocked} blocked`);
  if (taskCounts.pending > 0) taskParts.push(`${taskCounts.pending} pending`);
  if (taskCounts.completed > 0) taskParts.push(`${taskCounts.completed} done`);
  console.log(`TASKS: ${taskParts.length > 0 ? taskParts.join(', ') : 'none'}`);
  console.log('');

  // Event stream
  if (displayEvents.length > 0) {
    console.log('EVENTS:');
    for (const e of displayEvents) {
      const time = e.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const channel = `#${e.channelName}`.substring(0, 16).padEnd(17);
      const sender = e.senderName.substring(0, 13).padEnd(14);
      const badge = e.kind === 'task_event' ? '[TASK] ' : e.kind === 'system' ? '[SYS]  ' : '';
      const marker = e.importance === 'high' ? '!! ' : '';
      const maxContent = 60;
      const content = e.content.length > maxContent ? e.content.slice(0, maxContent - 1) + '\u2026' : e.content;

      console.log(`  [${time}] ${channel} ${sender} ${marker}${badge}${content}`);
    }

    if (events.length > maxItems) {
      console.log(`\n  +${events.length - maxItems} more — use --last ${events.length} to see all`);
    }
  } else {
    console.log('EVENTS: no activity yet');
  }
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
