import { join } from 'node:path';
import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import {
  type Member,
  type Channel,
  type ChannelMessage,
  readConfig,
  listTasks,
  readTask,
  taskPath,
  tailMessages,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import type { Daemon } from './daemon.js';
import { type DispatchContext } from './dispatch.js';
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
    // No manual pre-call needed — ClockManager fires immediately on register
    this.interval = this.daemon.clocks.register({
      id: 'tasks-refresh',
      name: 'Tasks Refresh',
      type: 'heartbeat',
      intervalMs: REFRESH_INTERVAL_MS,
      target: 'all agents',
      description: 'Refreshes TASKS.md + Casket files (INBOX.md, WORKLOG.md) for all agents',
      callback: () => this.refreshAll(),
    });

    // 60-second inbox heartbeat for idle agents
    this.inboxInterval = this.daemon.clocks.register({
      id: 'inbox-check',
      name: 'Inbox Check',
      type: 'heartbeat',
      intervalMs: INBOX_CHECK_INTERVAL_MS,
      target: 'idle agents',
      description: 'Dispatches queued tasks (one at a time) + inbox summaries to idle agents',
      callback: () => this.dispatchInboxSummaries(),
    });

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
        autoemonEnrolled: this.daemon.autoemon.isEnrolled(agent.id),
      };

      // Mark busy during inbox dispatch
      this.daemon.setAgentWorkStatus(memberId, agent.displayName, 'busy');

      const sessionKey = `inbox:${agentProc.model.replace('openclaw:', '')}:${Date.now()}`;

      try {
        const result = await this.daemon.harness.dispatch({
          agentId: agentProc.memberId,
          message: summary,
          sessionKey,
          context,
        });
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

      // Also scan project task directories for project-scoped agents
      const projectTasksCache = new Map<string, typeof allTasks>();

      for (const agent of agents) {
        let myTasks = allTasks.filter((t) => t.task.assignedTo === agent.id);
        let unassigned = allTasks.filter(
          (t) => !t.task.assignedTo && t.task.status === 'pending',
        );

        // For project-scoped agents, also include project-specific tasks
        if (agent.scope === 'project' && agent.scopeId) {
          try {
            const { getProject } = require('@claudecorp/shared');
            const project = getProject(this.daemon.corpRoot, agent.scopeId);
            if (project) {
              let projectTasks = projectTasksCache.get(project.name);
              if (!projectTasks) {
                const projectTasksDir = join(this.daemon.corpRoot, 'projects', project.name, 'tasks');
                if (existsSync(projectTasksDir)) {
                  // listTasks reads from corpRoot/tasks/ — scan project dir manually
                  const { readdirSync } = require('node:fs');
                  const files = readdirSync(projectTasksDir).filter((f: string) => f.endsWith('.md'));
                  projectTasks = files.map((f: string) => {
                    try { return readTask(join(projectTasksDir, f)); } catch { return null; }
                  }).filter(Boolean) as typeof allTasks;
                  projectTasksCache.set(project.name, projectTasks);
                }
              }
              if (projectTasks) {
                const myProjectTasks = projectTasks.filter(t => t.task.assignedTo === agent.id);
                const unassignedProject = projectTasks.filter(t => !t.task.assignedTo && t.task.status === 'pending');
                myTasks = [...myTasks, ...myProjectTasks];
                unassigned = [...unassigned, ...unassignedProject];
              }
            }
          } catch {}
        }

        const content = this.buildTasksMd(corpRoot, myTasks, unassigned, now, allTasks, members);

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
    myTasks: { task: any; body: string }[],
    unassigned: { task: any; body: string }[],
    now: Date,
    allTasks?: { task: any; body: string }[],
    members?: Member[],
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

        // Dependency chain visualization
        if (t.task.blockedBy?.length && allTasks) {
          const blockerInfo = (t.task.blockedBy as string[]).map(blockerId => {
            const blocker = allTasks.find(bt => bt.task.id === blockerId);
            if (!blocker) return `${blockerId} (unknown)`;
            const icon = blocker.task.status === 'completed' ? '\u2713' : blocker.task.status === 'in_progress' ? '\u25CF' : '\u25CB';
            return `${icon} "${blocker.task.title}" (${blocker.task.status})`;
          });
          const resolved = (t.task.blockedBy as string[]).filter(id => {
            const b = allTasks.find(bt => bt.task.id === id);
            return b?.task.status === 'completed';
          }).length;
          lines.push(`  Depends on (${resolved}/${(t.task.blockedBy as string[]).length} resolved): ${blockerInfo.join(', ')}`);
        }

        // Handed-by info (who delegated this to you)
        if (t.task.handedBy && members) {
          const hander = members.find(m => m.id === t.task.handedBy);
          const handerName = hander?.displayName ?? 'unknown';
          const handedAt = t.task.handedAt ? new Date(t.task.handedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
          lines.push(`  Handed by: @${handerName.toLowerCase().replace(/\s+/g, '-')}${handedAt ? ` at ${handedAt}` : ''}`);
        }
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

  private readonly SESSION_GAP_MS = 10 * 60 * 1000; // 10 min gap = new session

  /** Generate INBOX.md + WORKLOG.md for a single agent. */
  private generateCasketFiles(memberId: string): void {
    try {
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const agent = members.find(m => m.id === memberId);
      if (!agent?.agentDir) return;

      const agentDir = join(this.daemon.corpRoot, agent.agentDir);
      if (!existsSync(agentDir)) return;

      const channels = readConfig<Channel[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
      const allTasks = listTasks(this.daemon.corpRoot);

      this.writeInboxMd(agent, agentDir, channels, members, allTasks);
      this.writeWorklogMd(agent, agentDir, channels, members, allTasks);
      this.writeStatusMd(agent, agentDir, members, allTasks);
    } catch {
      // Non-fatal
    }
  }

  /**
   * INBOX.md — everything waiting for the agent.
   * Includes: next task with full description, task queue, actual mention content, unread activity.
   */
  private writeInboxMd(
    agent: Member,
    agentDir: string,
    channels: Channel[],
    members: Member[],
    allTasks: { task: any; body: string }[],
  ): void {
    const now = new Date().toISOString();
    const corpRoot = this.daemon.corpRoot.replace(/\\/g, '/');
    const lines: string[] = [`# Inbox — updated ${now}`, ''];
    let hasContent = false;

    // --- Section 1: Next Task (most important — what to work on) ---
    const nextQueued = this.daemon.inbox.peekNext(agent.id);
    if (nextQueued) {
      hasContent = true;
      lines.push('## Next Task', '');
      try {
        const tp = taskPath(this.daemon.corpRoot, nextQueued.taskId);
        const { task, body } = readTask(tp);
        const priorityBadge = task.priority === 'critical' ? '!! CRITICAL' : task.priority.toUpperCase();
        lines.push(`**${task.title}** (${priorityBadge})`);
        lines.push(`File: ${corpRoot}/tasks/${task.id}.md`);
        if (body.trim()) {
          lines.push('', body.trim().slice(0, 500));
        }
        if (task.acceptanceCriteria?.length) {
          lines.push('', 'Acceptance criteria:');
          for (const ac of task.acceptanceCriteria) {
            lines.push(`- [ ] ${ac}`);
          }
        }
        if (task.blockedBy?.length) {
          const blockerNames = task.blockedBy.map((id: string) => {
            const bt = allTasks.find(t => t.task.id === id);
            return bt ? `"${bt.task.title}" (${bt.task.status})` : id;
          });
          lines.push('', `Blocked by: ${blockerNames.join(', ')}`);
        }
      } catch {
        lines.push(`**${nextQueued.taskTitle}** (${nextQueued.taskPriority.toUpperCase()})`);
      }
      lines.push('');
    }

    // --- Section 2: Task Queue (what's after the next task) ---
    const queueCount = this.daemon.inbox.getQueuedTaskCount(agent.id);
    if (queueCount > 1) {
      // We already showed the first one above — show the rest
      hasContent = true;
      lines.push(`## Task Queue (${queueCount - 1} more waiting)`, '');
      // Peek at the queue without dequeuing — read from task files
      const myQueuedTasks = allTasks.filter(t =>
        t.task.assignedTo === agent.id &&
        (t.task.status === 'assigned' || t.task.status === 'pending'),
      );
      for (const t of myQueuedTasks.slice(0, 5)) {
        const blocked = t.task.blockedBy?.length ? ' (BLOCKED)' : '';
        lines.push(`${myQueuedTasks.indexOf(t) + 1}. **${t.task.title}** (${t.task.priority.toUpperCase()})${blocked} — ${t.task.id}.md`);
      }
      if (myQueuedTasks.length > 5) {
        lines.push(`   ...and ${myQueuedTasks.length - 5} more`);
      }
      lines.push('');
    }

    // --- Section 3: Mentions waiting (actual message content) ---
    const agentChannels = channels.filter(c => c.memberIds.includes(agent.id));
    const mentionLines: string[] = [];

    for (const ch of agentChannels) {
      try {
        const msgPath = join(this.daemon.corpRoot, ch.path, MESSAGES_JSONL);
        if (!existsSync(msgPath)) continue;

        // Read recent messages and find ones that mention this agent
        const recent = tailMessages(msgPath, 30);
        const mentions = recent.filter(m =>
          m.kind === 'text' &&
          m.senderId !== agent.id &&
          (m.mentions.includes(agent.id) || (ch.kind === 'direct' && m.senderId !== agent.id)),
        );

        // Only show unread-ish mentions (last 5 per channel)
        const relevantMentions = mentions.slice(-5);
        if (relevantMentions.length === 0) continue;

        mentionLines.push(`### #${ch.name} (${relevantMentions.length} mention${relevantMentions.length === 1 ? '' : 's'})`);
        for (const m of relevantMentions) {
          const sender = members.find(mem => mem.id === m.senderId);
          const senderName = sender?.displayName ?? (m.senderId === 'system' ? 'System' : '?');
          const time = new Date(m.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
          const content = m.content.replace(/\n/g, ' ').slice(0, 150);
          mentionLines.push(`[${time}] ${senderName}: ${content}`);
        }
        mentionLines.push('');
      } catch {
        // Skip unreadable channels
      }
    }

    if (mentionLines.length > 0) {
      hasContent = true;
      lines.push('## Mentions Waiting', '', ...mentionLines);
    }

    // --- Section 4: Direct messages (cc-say) ---
    const ccSayCount = this.daemon.inbox.getInboxSnapshot(agent.id);
    if (ccSayCount && ccSayCount.includes('direct message')) {
      hasContent = true;
      lines.push('## Direct Messages', '', ccSayCount.split('\n').filter(l => l.includes('direct message')).join('\n'), '');
    }

    if (!hasContent) {
      lines.push('Nothing pending. You\'re clear.', '');
    }

    writeFileSync(join(agentDir, 'INBOX.md'), lines.join('\n'), 'utf-8');
  }

  /**
   * WORKLOG.md — what the agent did recently.
   * Scans ALL channels the agent participates in, groups by session,
   * includes task status changes, and generates a summary at the top.
   */
  private writeWorklogMd(
    agent: Member,
    agentDir: string,
    channels: Channel[],
    members: Member[],
    allTasks: { task: any; body: string }[],
  ): void {
    try {
      const corpRoot = this.daemon.corpRoot;
      const now = new Date();

      // Collect agent's messages from ALL channels they're in
      const agentChannels = channels.filter(c => c.memberIds.includes(agent.id));
      const allMessages: (ChannelMessage & { channelName: string })[] = [];

      for (const ch of agentChannels) {
        try {
          const msgPath = join(corpRoot, ch.path, MESSAGES_JSONL);
          if (!existsSync(msgPath)) continue;
          const recent = tailMessages(msgPath, 50);
          // Include: messages FROM this agent + system messages TO this agent (task dispatches, etc.)
          const relevant = recent.filter(m =>
            m.kind !== 'tool_event' && (
              m.senderId === agent.id ||
              (m.senderId === 'system' && m.mentions.includes(agent.id)) ||
              (ch.kind === 'direct' && m.senderId !== agent.id)
            ),
          );
          for (const m of relevant) {
            allMessages.push({ ...m, channelName: ch.name });
          }
        } catch {}
      }

      if (allMessages.length === 0) {
        writeFileSync(join(agentDir, 'WORKLOG.md'), `# Worklog — updated ${now.toISOString()}\n\nNo activity yet. This is your first session.\n`, 'utf-8');
        return;
      }

      // Sort by timestamp
      allMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // Group into sessions (gap > 10 min = new session)
      interface Session { start: Date; end: Date; messages: typeof allMessages }
      const sessions: Session[] = [];
      let currentSession: Session | null = null;

      for (const msg of allMessages) {
        const msgTime = new Date(msg.timestamp);
        if (!currentSession || (msgTime.getTime() - currentSession.end.getTime()) > this.SESSION_GAP_MS) {
          currentSession = { start: msgTime, end: msgTime, messages: [] };
          sessions.push(currentSession);
        }
        currentSession.end = msgTime;
        currentSession.messages.push(msg);
      }

      // Get agent's current tasks for status context
      const myTasks = allTasks.filter(t => t.task.assignedTo === agent.id);
      const inProgress = myTasks.filter(t => t.task.status === 'in_progress');
      const recentlyCompleted = myTasks.filter(t =>
        t.task.status === 'completed' &&
        (now.getTime() - new Date(t.task.updatedAt).getTime()) < 2 * 60 * 60 * 1000, // Last 2 hours
      );

      const lines: string[] = [`# Worklog — updated ${now.toISOString()}`, ''];

      // --- Session Summary (most important section — Dredge reads this) ---
      lines.push('## Session Summary', '');
      const lastSession = sessions[sessions.length - 1];
      if (lastSession) {
        const ago = Math.round((now.getTime() - lastSession.end.getTime()) / 60000);
        lines.push(`Last active: ${ago < 1 ? 'just now' : `${ago}m ago`}`);
      }
      if (inProgress.length > 0) {
        const current = inProgress[0]!;
        lines.push(`Working on: **${current.task.title}** (${current.task.status})`);
        lines.push(`Task file: ${corpRoot.replace(/\\/g, '/')}/tasks/${current.task.id}.md`);
      } else if (myTasks.some(t => t.task.status === 'assigned')) {
        const next = myTasks.find(t => t.task.status === 'assigned')!;
        lines.push(`Next task: **${next.task.title}** (assigned, not started)`);
      } else {
        lines.push('No active task.');
      }
      if (recentlyCompleted.length > 0) {
        lines.push(`Recently completed: ${recentlyCompleted.map(t => `"${t.task.title}"`).join(', ')}`);
      }

      // Extract last agent message as "last thing said"
      const lastAgentMsg = [...allMessages].reverse().find(m => m.senderId === agent.id && m.kind === 'text');
      if (lastAgentMsg) {
        const preview = lastAgentMsg.content.replace(/\n/g, ' ').slice(0, 150);
        lines.push(`Last message: "${preview}"`);
      }
      lines.push('');

      // --- Recent Sessions (last 3, newest first) ---
      lines.push('## Recent Sessions', '');
      const recentSessions = sessions.slice(-3).reverse();

      for (let i = 0; i < recentSessions.length; i++) {
        const session = recentSessions[i]!;
        const startTime = session.start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const endTime = session.end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        const duration = Math.round((session.end.getTime() - session.start.getTime()) / 60000);

        lines.push(`### Session ${recentSessions.length - i} (${startTime} - ${endTime}, ${duration}m)`);

        // Summarize session: agent's own messages (what they said/did)
        const agentMsgs = session.messages.filter(m => m.senderId === agent.id && m.kind === 'text');
        const systemMsgs = session.messages.filter(m => m.senderId === 'system');
        const otherMsgs = session.messages.filter(m => m.senderId !== agent.id && m.senderId !== 'system' && m.kind === 'text');

        // Show what the agent received
        for (const m of systemMsgs.slice(0, 3)) {
          const content = m.content.replace(/\n/g, ' ').slice(0, 120);
          lines.push(`- Received: ${content}`);
        }
        for (const m of otherMsgs.slice(0, 3)) {
          const sender = members.find(mem => mem.id === m.senderId);
          const content = m.content.replace(/\n/g, ' ').slice(0, 120);
          lines.push(`- From @${sender?.displayName ?? '?'}: ${content}`);
        }

        // Show what the agent said/did
        for (const m of agentMsgs.slice(0, 5)) {
          const content = m.content.replace(/\n/g, ' ').slice(0, 150);
          const channel = m.channelName !== agentMsgs[0]?.channelName ? ` (in #${m.channelName})` : '';
          lines.push(`- Said${channel}: ${content}`);
        }

        if (session.messages.length > 10) {
          lines.push(`- ...${session.messages.length - 10} more messages`);
        }
        lines.push('');
      }

      lines.push('Read your TASKS.md and INBOX.md for current state. This worklog is for continuity only.');

      writeFileSync(join(agentDir, 'WORKLOG.md'), lines.join('\n'), 'utf-8');
    } catch {
      // Non-fatal
    }
  }

  /**
   * STATUS.md — Corp Vitals. Situational awareness of the whole corp.
   * Who's online, what they're working on, task health, clock health.
   */
  private writeStatusMd(
    agent: Member,
    agentDir: string,
    members: Member[],
    allTasks: { task: any; body: string }[],
  ): void {
    try {
      const now = new Date();
      const lines: string[] = [`# Corp Vitals — updated ${now.toISOString()}`, ''];

      // --- Herald Narration (if available) ---
      try {
        const narrationPath = join(this.daemon.corpRoot, 'NARRATION.md');
        if (existsSync(narrationPath)) {
          const narrationRaw = readFileSync(narrationPath, 'utf-8');
          // Extract header timestamp and summary
          const headerMatch = narrationRaw.match(/# Herald — (\d{2}:\d{2}:\d{2})/);
          const narrationLines = narrationRaw.split('\n').filter((l: string) => l.trim() && !l.startsWith('#'));

          if (narrationLines.length > 0) {
            // Check staleness — NARRATION.md file mtime
            const mtime = statSync(narrationPath).mtimeMs;
            const ageMs = Date.now() - mtime;
            const stale = ageMs > 10 * 60 * 1000; // > 10 min = stale

            const timeStr = headerMatch?.[1] ?? '';
            const staleNote = stale ? ' (stale — Herald may be offline)' : '';

            lines.push('## Herald', '');
            lines.push(`> ${narrationLines[0]!.trim()}`);
            if (timeStr) lines.push(`> — ${timeStr}${staleNote}`);
            lines.push('');
          }
        }
      } catch {}

      // --- Agent Status Grid ---
      lines.push('## Agents', '');
      const agents = members.filter(m => m.type === 'agent');
      for (const a of agents) {
        const workStatus = this.daemon.getAgentWorkStatus(a.id);
        const icon = workStatus === 'idle' ? '\u25CB' : workStatus === 'busy' ? '\u25CF' : workStatus === 'broken' ? '\u2717' : '\u25CB';
        const isYou = a.id === agent.id ? ' (you)' : '';

        // Find what this agent is working on
        let currentWork = '';
        const agentTasks = allTasks.filter(t => t.task.assignedTo === a.id && t.task.status === 'in_progress');
        if (agentTasks.length > 0) {
          currentWork = ` — working on "${agentTasks[0]!.task.title}"`;
        }

        lines.push(`${icon} **${a.displayName}** (${a.rank}) ${workStatus}${currentWork}${isYou}`);
      }
      lines.push('');

      // --- Task Health ---
      const taskCounts = {
        total: allTasks.length,
        inProgress: allTasks.filter(t => t.task.status === 'in_progress').length,
        assigned: allTasks.filter(t => t.task.status === 'assigned').length,
        blocked: allTasks.filter(t => t.task.status === 'blocked').length,
        completed: allTasks.filter(t => t.task.status === 'completed').length,
        pending: allTasks.filter(t => t.task.status === 'pending').length,
      };

      lines.push('## Task Health', '');
      const parts: string[] = [];
      if (taskCounts.inProgress > 0) parts.push(`${taskCounts.inProgress} active`);
      if (taskCounts.assigned > 0) parts.push(`${taskCounts.assigned} assigned`);
      if (taskCounts.blocked > 0) parts.push(`\u26A0 ${taskCounts.blocked} BLOCKED`);
      if (taskCounts.pending > 0) parts.push(`${taskCounts.pending} pending`);
      if (taskCounts.completed > 0) parts.push(`${taskCounts.completed} done`);
      lines.push(parts.length > 0 ? parts.join(' | ') : 'No tasks');
      lines.push('');

      // --- Blocked tasks (visible to all — someone might be able to help) ---
      const blockedTasks = allTasks.filter(t => t.task.status === 'blocked');
      if (blockedTasks.length > 0) {
        lines.push('## Blocked Tasks (needs attention)', '');
        for (const bt of blockedTasks) {
          const assignee = members.find(m => m.id === bt.task.assignedTo);
          const assigneeName = assignee?.displayName ?? 'unassigned';
          lines.push(`- **${bt.task.title}** (${assigneeName}) — ${bt.task.id}.md`);
        }
        lines.push('');
      }

      // --- Clock Health (from daemon clocks) ---
      try {
        const clocks = this.daemon.clocks.list();
        const errorClocks = clocks.filter(c => c.consecutiveErrors > 0);
        if (errorClocks.length > 0) {
          lines.push('## Clock Errors', '');
          for (const c of errorClocks) {
            lines.push(`- \u2717 ${c.name}: ${c.consecutiveErrors} consecutive errors — ${c.lastError?.slice(0, 80) ?? 'unknown'}`);
          }
          lines.push('');
        }
      } catch {}

      // --- Your Metrics (self-awareness) ---
      try {
        const myAnalytics = this.daemon.analytics.getSnapshot().agents[agent.id];
        if (myAnalytics) {
          const totalTime = (myAnalytics.busyTimeMs ?? 0) + (myAnalytics.idleTimeMs ?? 0);
          const utilization = totalTime > 0 ? Math.round((myAnalytics.busyTimeMs / totalTime) * 100) : 0;
          lines.push('## Your Metrics', '');
          lines.push(`- Utilization: ${utilization}%`);
          lines.push(`- Tasks completed: ${myAnalytics.tasksCompleted}`);
          lines.push(`- Current streak: ${myAnalytics.streak} (best: ${myAnalytics.bestStreak})`);
          lines.push(`- Dispatches: ${myAnalytics.dispatchCount}`);
          if (myAnalytics.errorCount > 0) lines.push(`- Errors: ${myAnalytics.errorCount}`);
          lines.push('');
        }
      } catch {}

      // --- Recent Completions (momentum) ---
      const recentCompleted = allTasks
        .filter(t => t.task.status === 'completed' && t.task.updatedAt)
        .sort((a, b) => new Date(b.task.updatedAt).getTime() - new Date(a.task.updatedAt).getTime())
        .slice(0, 5);
      if (recentCompleted.length > 0) {
        lines.push('## Recent Completions', '');
        for (const t of recentCompleted) {
          const assignee = members.find(m => m.id === t.task.assignedTo);
          const name = assignee?.displayName ?? '?';
          const time = new Date(t.task.updatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
          lines.push(`- \u2713 "${t.task.title}" by ${name} at ${time}`);
        }
        lines.push('');
      }

      // --- Corp Uptime ---
      const uptimeMs = Date.now() - this.daemon.startedAt;
      const hours = Math.floor(uptimeMs / 3_600_000);
      const mins = Math.floor((uptimeMs % 3_600_000) / 60_000);
      lines.push(`Uptime: ${hours}h ${mins}m | This file is auto-generated every 5 minutes.`);

      writeFileSync(join(agentDir, 'STATUS.md'), lines.join('\n'), 'utf-8');
    } catch {
      // Non-fatal
    }
  }
}
