import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  type Member,
  type Channel,
  type ChannelMessage,
  readConfig,
  listTasks,
  appendMessage,
  generateId,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
} from '@agentcorp/shared';
import { dispatchToAgent, type DispatchContext } from './dispatch.js';
import type { Daemon } from './daemon.js';

const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const FIRST_HEARTBEAT_DELAY_MS = 30 * 1000;   // 30 seconds after start
const STALE_ASSIGNED_MS = 10 * 60 * 1000;     // 10 min
const STALE_IN_PROGRESS_MS = 2 * 60 * 60 * 1000; // 2 hours

export class HeartbeatManager {
  private daemon: Daemon;
  private interval: ReturnType<typeof setInterval> | null = null;
  private initialTimeout: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  start(): void {
    // First heartbeat after 30 seconds
    this.initialTimeout = setTimeout(() => {
      this.tick();
    }, FIRST_HEARTBEAT_DELAY_MS);

    // Then every 10 minutes
    this.interval = setInterval(() => {
      this.tick();
    }, HEARTBEAT_INTERVAL_MS);

    console.log(`[heartbeat] Started (first in 30s, then every 10m)`);
  }

  stop(): void {
    if (this.initialTimeout) clearTimeout(this.initialTimeout);
    if (this.interval) clearInterval(this.interval);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // Don't overlap
    this.running = true;

    try {
      const agents = this.daemon.processManager.listAgents();
      const readyAgents = agents.filter((a) => a.status === 'ready');

      if (readyAgents.length === 0) {
        this.running = false;
        return;
      }

      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const allTasks = listTasks(this.daemon.corpRoot);
      const now = new Date();

      console.log(`[heartbeat] Tick — ${readyAgents.length} agent(s) to wake`);

      for (const agentProc of readyAgents) {
        const member = members.find((m) => m.id === agentProc.memberId);
        if (!member || !member.agentDir) continue;

        // Tasks assigned to this agent
        const myTasks = allTasks.filter((t) => t.task.assignedTo === member.id);
        // Pending unassigned tasks
        const unassigned = allTasks.filter(
          (t) => !t.task.assignedTo && t.task.status === 'pending',
        );

        // Build HEARTBEAT.md
        const heartbeatMd = this.buildHeartbeatMd(member, myTasks, unassigned, now);

        // Write to agent's workspace
        const agentDir = join(this.daemon.corpRoot, member.agentDir);
        try {
          writeFileSync(join(agentDir, 'HEARTBEAT.md'), heartbeatMd, 'utf-8');
        } catch {
          // Agent dir might not exist
        }

        // Dispatch heartbeat
        await this.dispatchHeartbeat(agentProc, member, members, heartbeatMd);
      }
    } catch (err) {
      console.error('[heartbeat] Tick failed:', err);
    } finally {
      this.running = false;
    }
  }

  private buildHeartbeatMd(
    agent: Member,
    myTasks: { task: { id: string; title: string; status: string; priority: string; updatedAt: string }; body: string }[],
    unassigned: { task: { id: string; title: string; status: string; priority: string }; body: string }[],
    now: Date,
  ): string {
    const timestamp = now.toISOString();
    const lines: string[] = [`# Heartbeat — ${timestamp}`, ''];

    // My tasks
    lines.push('## Your Tasks', '');
    if (myTasks.length === 0) {
      lines.push('No tasks assigned to you.', '');
    } else {
      lines.push('### Assigned to you', '');
      for (const t of myTasks) {
        let note = '';
        // Stale detection
        const updatedAt = new Date(t.task.updatedAt);
        const age = now.getTime() - updatedAt.getTime();
        if (t.task.status === 'assigned' && age > STALE_ASSIGNED_MS) {
          note = ' ⚠️ STALE — assigned for >10min, start working on it!';
        } else if (t.task.status === 'in_progress' && age > STALE_IN_PROGRESS_MS) {
          note = ' ⚠️ STALE — in progress for >2hr, update or complete it!';
        }
        lines.push(`- [${t.task.id}] ${t.task.title} (${t.task.priority.toUpperCase()}, ${t.task.status})${note}`);
      }
      lines.push('');
    }

    // Unassigned tasks
    if (unassigned.length > 0) {
      lines.push('### Unassigned (available to claim)', '');
      for (const t of unassigned) {
        lines.push(`- [${t.task.id}] ${t.task.title} (${t.task.priority.toUpperCase()}, pending)`);
      }
      lines.push('');
    }

    // Instructions
    lines.push('## Instructions', '');
    lines.push('Read your SOUL.md for your role and standing orders.');
    lines.push('Work on your highest-priority assigned task.');
    lines.push('Update task status by editing the YAML frontmatter in the task file.');
    lines.push('Append progress notes to the ## Progress Notes section.');
    lines.push('Post updates to #general or your team channel.');
    lines.push('');

    return lines.join('\n');
  }

  private async dispatchHeartbeat(
    agentProc: { memberId: string; displayName: string; port: number; gatewayToken: string; model: string },
    member: Member,
    members: Member[],
    heartbeatMd: string,
  ): Promise<void> {
    const corpRootDisplay = this.daemon.corpRoot.replace(/\\/g, '/');
    const agentDirDisplay = member.agentDir
      ? join(this.daemon.corpRoot, member.agentDir).replace(/\\/g, '/')
      : corpRootDisplay;

    const corpMembers = members.map((m) => ({
      name: m.displayName,
      rank: m.rank,
      type: m.type,
      status: m.status,
    }));

    const context: DispatchContext = {
      agentDir: agentDirDisplay,
      corpRoot: corpRootDisplay,
      channelName: 'heartbeat',
      channelMembers: [member.displayName],
      corpMembers,
      recentHistory: [],
      daemonPort: this.daemon.getPort(),
      agentMemberId: member.id,
      agentRank: member.rank,
    };

    try {
      console.log(`[heartbeat] Dispatching to ${member.displayName}...`);

      const result = await dispatchToAgent(
        agentProc as any,
        `HEARTBEAT: Check your tasks and take action. Your updated HEARTBEAT.md has been written to your workspace.`,
        context,
        `heartbeat-${member.id}-${Date.now()}`,
      );

      // Write response to #heartbeat channel
      this.writeToHeartbeatChannel(member, result.content);

      // Mark dirty for git
      this.daemon.gitManager.markDirty(member.displayName);

      console.log(`[heartbeat] ${member.displayName} checked in`);
    } catch (err) {
      console.error(`[heartbeat] Dispatch to ${member.displayName} failed:`, err);
    }
  }

  private writeToHeartbeatChannel(agent: Member, content: string): void {
    try {
      const channels = readConfig<Channel[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
      const hbChannel = channels.find((c) => c.name === 'heartbeat');
      if (!hbChannel) return;

      const msg: ChannelMessage = {
        id: generateId(),
        channelId: hbChannel.id,
        senderId: agent.id,
        threadId: null,
        content,
        kind: 'text',
        mentions: [],
        metadata: null,
        depth: 0,
        originId: '',
        timestamp: new Date().toISOString(),
      };
      msg.originId = msg.id;
      appendMessage(join(this.daemon.corpRoot, hbChannel.path, MESSAGES_JSONL), msg);
    } catch {
      // Non-fatal
    }
  }
}
