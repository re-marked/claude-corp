import { join } from 'node:path';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import {
  type Member,
  type Channel,
  readConfig,
  listTasks,
  tailMessages,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import type { Daemon } from './daemon.js';
import { dispatchToAgent, type DispatchContext } from './dispatch.js';
import { dispatchTaskToDm } from './task-events.js';
import { composeSystemMessage } from './fragments/index.js';
import { log, logError } from './logger.js';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // Refresh every 5 minutes
const INBOX_CHECK_INTERVAL_MS = 60 * 1000; // Check inbox every 60 seconds
const STALE_ASSIGNED_MS = 10 * 60 * 1000;
const STALE_IN_PROGRESS_MS = 2 * 60 * 60 * 1000;

/**
 * Manages TASKS.md files for each agent — a live task inbox.
 * Also refreshes periodically so heartbeat-woken agents see current data.
 *
 * TASKS.md = "what you need to work on right now" (live, updated on change)
 * HEARTBEAT.md = "what to do when you wake up" (static standing orders)
 */
export class HeartbeatManager {
  private daemon: Daemon;
  private interval: ReturnType<typeof setInterval> | null = null;
  private inboxInterval: ReturnType<typeof setInterval> | null = null;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  start(): void {
    this.refreshAll();

    this.interval = setInterval(() => {
      this.refreshAll();
    }, REFRESH_INTERVAL_MS);

    // 60-second inbox heartbeat for idle agents
    this.inboxInterval = setInterval(() => {
      this.dispatchInboxSummaries();
    }, INBOX_CHECK_INTERVAL_MS);

    // Wire busy→idle: update casket, then feed next task or inbox
    this.daemon.onAgentIdle((memberId, displayName) => {
      // Always update casket files on idle transition (captures latest session)
      this.generateCasketFiles(memberId);

      // Priority 1: queued tasks — feed the next one
      if (this.daemon.inbox.hasQueuedTasks(memberId)) {
        log(`[heartbeat] ${displayName} became idle with queued tasks — dispatching next task`);
        this.dispatchNextQueuedTask(memberId);
        return;
      }
      // Priority 2: unread inbox messages
      if (this.daemon.inbox.hasUnread(memberId)) {
        log(`[heartbeat] ${displayName} became idle with unread inbox — dispatching summary`);
        this.dispatchInboxToAgent(memberId);
      }
    });

    log('[heartbeat] TASKS.md refresh (5m) + inbox heartbeat (60s) started');
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.inboxInterval) clearInterval(this.inboxInterval);
  }

  /** Dispatch queued tasks or inbox summaries to all IDLE agents */
  private dispatchInboxSummaries(): void {
    try {
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const agents = members.filter(m => m.type === 'agent' && m.agentDir);

      for (const agent of agents) {
        const status = this.daemon.getAgentWorkStatus(agent.id);
        if (status !== 'idle') continue;

        // Priority 1: queued tasks
        if (this.daemon.inbox.hasQueuedTasks(agent.id)) {
          this.dispatchNextQueuedTask(agent.id);
          continue;
        }

        // Priority 2: inbox messages
        if (!this.daemon.inbox.hasUnread(agent.id)) continue;

        this.dispatchInboxToAgent(agent.id);
      }
    } catch (err) {
      logError(`[heartbeat] Inbox dispatch failed: ${err}`);
    }
  }

  /** Dispatch inbox summary to a single agent */
  private async dispatchInboxToAgent(memberId: string): Promise<void> {
    try {
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const agent = members.find(m => m.id === memberId);
      if (!agent?.agentDir) return;

      const agentProc = this.daemon.processManager.getAgent(memberId);
      if (!agentProc || agentProc.status !== 'ready') return;

      const summary = this.daemon.inbox.getSummary(memberId);
      if (!summary) return;

      // Build lightweight context for inbox dispatch
      const corpRoot = this.daemon.corpRoot.replace(/\\/g, '/');
      const agentDir = join(this.daemon.corpRoot, agent.agentDir).replace(/\\/g, '/');
      const allMembers = members.map(m => ({ name: m.displayName, rank: m.rank, type: m.type, status: m.status }));

      let supervisorName: string | null = null;
      if (agent.spawnedBy) {
        const sup = members.find(m => m.id === agent.spawnedBy);
        supervisorName = sup?.displayName ?? null;
      }

      const context: DispatchContext = {
        agentDir,
        corpRoot,
        channelName: 'inbox',
        channelMembers: [agent.displayName],
        corpMembers: allMembers,
        recentHistory: [],
        daemonPort: this.daemon.getPort(),
        agentMemberId: agent.id,
        agentRank: agent.rank,
        agentDisplayName: agent.displayName,
        channelKind: 'direct',
        supervisorName,
      };

      // Mark busy during inbox dispatch
      this.daemon.setAgentWorkStatus(memberId, agent.displayName, 'busy');

      const wsClient = agentProc.mode === 'remote' ? this.daemon.openclawWS : this.daemon.corpGatewayWS;
      const sessionKey = `inbox:${agentProc.model.replace('openclaw:', '')}:${Date.now()}`;

      try {
        const result = await dispatchToAgent(agentProc, summary, context, sessionKey, undefined, wsClient);
        log(`[heartbeat] ${agent.displayName} inbox response: ${result.content.slice(0, 60)}`);
      } catch (err) {
        logError(`[heartbeat] ${agent.displayName} inbox dispatch failed: ${err}`);
      }

      this.daemon.setAgentWorkStatus(memberId, agent.displayName, 'idle');
      this.daemon.inbox.clear(memberId);
    } catch (err) {
      logError(`[heartbeat] Inbox dispatch to ${memberId} failed: ${err}`);
    }
  }

  /** Dequeue and dispatch the next queued task to an agent's DM. */
  private dispatchNextQueuedTask(memberId: string): void {
    try {
      // Build set of completed task IDs for blocker resolution
      const allTasks = listTasks(this.daemon.corpRoot);
      const completedIds = new Set(
        allTasks.filter(t => t.task.status === 'completed').map(t => t.task.id),
      );

      const task = this.daemon.inbox.dequeueNext(memberId, completedIds);
      if (!task) return;

      // Dispatch to DM via the same path as direct task assignment
      dispatchTaskToDm(this.daemon, task.assigneeId, task.taskTitle, task.taskId);
      log(`[heartbeat] Fed queued task "${task.taskTitle}" to agent ${memberId}`);
    } catch (err) {
      logError(`[heartbeat] Failed to dispatch queued task to ${memberId}: ${err}`);
    }
  }

  /** Refresh TASKS.md for ALL agents. Called periodically + on task changes. */
  refreshAll(): void {
    try {
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const allTasks = listTasks(this.daemon.corpRoot);
      const agents = members.filter((m) => m.type === 'agent' && m.agentDir);
      const now = new Date();
      const corpRoot = this.daemon.corpRoot.replace(/\\/g, '/');

      for (const agent of agents) {
        const myTasks = allTasks.filter((t) => t.task.assignedTo === agent.id);
        const unassigned = allTasks.filter(
          (t) => !t.task.assignedTo && t.task.status === 'pending',
        );

        const content = this.buildTasksMd(corpRoot, myTasks, unassigned, now);

        try {
          const agentDir = join(this.daemon.corpRoot, agent.agentDir!);
          if (existsSync(agentDir)) {
            writeFileSync(join(agentDir, 'TASKS.md'), content, 'utf-8');
          }
        } catch {
          // Non-fatal
        }

        // Generate casket files (INBOX.md + WORKLOG.md)
        this.generateCasketFiles(agent.id);
      }
    } catch (err) {
      logError(`[heartbeat] TASKS.md refresh failed: ${err}`);
    }
  }

  /** Refresh TASKS.md for a single agent by member ID. */
  refreshAgent(memberId: string): void {
    try {
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const agent = members.find((m) => m.id === memberId);
      if (!agent?.agentDir) return;

      const allTasks = listTasks(this.daemon.corpRoot);
      const myTasks = allTasks.filter((t) => t.task.assignedTo === agent.id);
      const unassigned = allTasks.filter(
        (t) => !t.task.assignedTo && t.task.status === 'pending',
      );
      const corpRoot = this.daemon.corpRoot.replace(/\\/g, '/');
      const content = this.buildTasksMd(corpRoot, myTasks, unassigned, new Date());

      const agentDir = join(this.daemon.corpRoot, agent.agentDir);
      if (existsSync(agentDir)) {
        writeFileSync(join(agentDir, 'TASKS.md'), content, 'utf-8');
      }
    } catch {
      // Non-fatal
    }
  }

  private buildTasksMd(
    corpRoot: string,
    myTasks: { task: { id: string; title: string; status: string; priority: string; updatedAt: string }; body: string }[],
    unassigned: { task: { id: string; title: string; status: string; priority: string }; body: string }[],
    now: Date,
  ): string {
    const lines: string[] = [`# Tasks — updated ${now.toISOString()}`, ''];

    if (myTasks.length === 0 && unassigned.length === 0) {
      lines.push('No tasks. You\'re free.', '');
      return lines.join('\n');
    }

    // Assigned tasks
    if (myTasks.length > 0) {
      lines.push('## Assigned to you', '');
      for (const t of myTasks) {
        let note = '';
        const age = now.getTime() - new Date(t.task.updatedAt).getTime();
        if (t.task.status === 'assigned' && age > STALE_ASSIGNED_MS) {
          note = ' ⚠️ START THIS';
        } else if (t.task.status === 'in_progress' && age > STALE_IN_PROGRESS_MS) {
          note = ' ⚠️ UPDATE OR COMPLETE';
        }
        lines.push(`- **[${t.task.id}]** ${t.task.title}`);
        lines.push(`  Status: ${t.task.status} | Priority: ${t.task.priority.toUpperCase()}${note}`);
        lines.push(`  File: ${corpRoot}/tasks/${t.task.id}.md`);
        lines.push('');
      }
    }

    // Unassigned
    if (unassigned.length > 0) {
      lines.push('## Unassigned (you can claim these)', '');
      for (const t of unassigned) {
        lines.push(`- **[${t.task.id}]** ${t.task.title} (${t.task.priority.toUpperCase()})`);
        lines.push(`  File: ${corpRoot}/tasks/${t.task.id}.md`);
        lines.push('');
      }
    }

    // How to work on tasks
    lines.push('## How to work on a task', '');
    lines.push(`1. Open the task file at the path above`);
    lines.push(`2. Read the description and acceptance criteria`);
    lines.push(`3. Update the YAML frontmatter: change \`status\` to \`in_progress\``);
    lines.push(`4. Do the work`);
    lines.push(`5. Append notes to the \`## Progress Notes\` section`);
    lines.push(`6. When done, change \`status\` to \`completed\``);
    lines.push('');

    return lines.join('\n');
  }

  // --- Casket file generation ---

  /** Generate INBOX.md + WORKLOG.md for a single agent. */
  private generateCasketFiles(memberId: string): void {
    try {
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const agent = members.find(m => m.id === memberId);
      if (!agent?.agentDir) return;

      const agentDir = join(this.daemon.corpRoot, agent.agentDir);
      if (!existsSync(agentDir)) return;

      // INBOX.md
      this.writeInboxMd(agent, agentDir);

      // WORKLOG.md
      this.writeWorklogMd(agent, agentDir, members);
    } catch {
      // Non-fatal
    }
  }

  /** Generate INBOX.md from InboxManager state + task queue. */
  private writeInboxMd(agent: Member, agentDir: string): void {
    const now = new Date().toISOString();
    const lines: string[] = [`# Inbox — updated ${now}`, ''];

    // Pending messages
    const snapshot = this.daemon.inbox.getInboxSnapshot(agent.id);
    if (snapshot) {
      lines.push('## Pending Messages', '', snapshot, '');
    }

    // Queued tasks
    const queueCount = this.daemon.inbox.getQueuedTaskCount(agent.id);
    if (queueCount > 0) {
      const next = this.daemon.inbox.peekNext(agent.id);
      lines.push('## Queued Tasks', '');
      lines.push(`${queueCount} task${queueCount === 1 ? '' : 's'} waiting.`);
      if (next) {
        lines.push(`Next up: **${next.taskTitle}** (${next.taskPriority.toUpperCase()})`);
      }
      lines.push('');
    }

    if (lines.length <= 2) {
      lines.push('Nothing pending. You\'re clear.', '');
    }

    writeFileSync(join(agentDir, 'INBOX.md'), lines.join('\n'), 'utf-8');
  }

  /** Generate WORKLOG.md from agent's DM message history. */
  private writeWorklogMd(agent: Member, agentDir: string, members: Member[]): void {
    try {
      const channels = readConfig<Channel[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
      const founder = members.find(m => m.rank === 'owner');
      if (!founder) return;

      // Find agent's DM channel
      const dmChannel = channels.find(
        c => c.kind === 'direct' &&
        c.memberIds.includes(agent.id) &&
        c.memberIds.includes(founder.id),
      );
      if (!dmChannel) return;

      const dmPath = join(this.daemon.corpRoot, dmChannel.path, MESSAGES_JSONL);
      if (!existsSync(dmPath)) return;

      const messages = tailMessages(dmPath, 20);
      if (messages.length === 0) return;

      const now = new Date().toISOString();
      const lines: string[] = [`# Worklog — updated ${now}`, '', 'Recent DM activity (last 20 messages):', ''];

      for (const msg of messages) {
        if (msg.kind === 'tool_event') continue; // Skip noisy tool events

        const time = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const sender = members.find(m => m.id === msg.senderId);
        const senderName = sender?.displayName ?? (msg.senderId === 'system' ? 'System' : '?');
        const content = msg.content.replace(/\n/g, ' ').slice(0, 200);

        lines.push(`**[${time}]** ${senderName}: ${content}`);
        lines.push('');
      }

      lines.push('Use this to maintain continuity. Pick up where you left off.');

      writeFileSync(join(agentDir, 'WORKLOG.md'), lines.join('\n'), 'utf-8');
    } catch {
      // Non-fatal — DM channel might not exist yet
    }
  }
}
