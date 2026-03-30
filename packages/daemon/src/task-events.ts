import { join } from 'node:path';
import {
  type Channel,
  type Member,
  type ChannelMessage,
  type Corporation,
  readConfig,
  readTask,
  taskPath,
  appendMessage,
  generateId,
  getTheme,
  type ThemeId,
  CHANNELS_JSON,
  MEMBERS_JSON,
  MESSAGES_JSONL,
  CORP_JSON,
} from '@claudecorp/shared';
import type { Daemon } from './daemon.js';
import { log, logError } from './logger.js';

/** Write a task event message to the #tasks channel (not dispatched — info only). */
export function writeTaskEvent(corpRoot: string, content: string): void {
  try {
    const channels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));
    const corp = readConfig<Corporation>(join(corpRoot, CORP_JSON));
    const theme = getTheme((corp.theme || 'corporate') as ThemeId);
    const tasksChannel = channels.find((c) => c.name === theme.channels.tasks);
    if (!tasksChannel) return;

    const msg: ChannelMessage = {
      id: generateId(),
      channelId: tasksChannel.id,
      senderId: 'system',
      threadId: null,
      content: `[TASK] ${content}`,
      kind: 'task_event',
      mentions: [],
      metadata: null,
      depth: 0,
      originId: '',
      timestamp: new Date().toISOString(),
    };
    msg.originId = msg.id;
    appendMessage(join(corpRoot, tasksChannel.path, MESSAGES_JSONL), msg);
  } catch {
    // Non-fatal
  }
}

/**
 * Log a task assignment to #tasks as a read-only event (no @mention, no dispatch).
 */
export function logTaskAssignment(
  corpRoot: string,
  assigneeId: string,
  taskTitle: string,
): void {
  try {
    const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
    const assignee = members.find((m) => m.id === assigneeId);
    const name = assignee?.displayName ?? 'an agent';
    writeTaskEvent(corpRoot, `"${taskTitle}" assigned to ${name}`);
  } catch {
    // Non-fatal
  }
}

/**
 * Dispatch a task to an agent's DM channel for immediate work.
 * Writes a system message to the agent's DM — the router picks it up and dispatches.
 */
export function dispatchTaskToDm(
  daemon: Daemon,
  assigneeId: string,
  taskTitle: string,
  taskId: string,
): void {
  try {
    const corpRoot = daemon.corpRoot;
    const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));

    const assignee = members.find((m) => m.id === assigneeId);
    if (!assignee) return;

    // If agent is busy, enqueue in the priority task queue instead
    const agentStatus = daemon.getAgentWorkStatus(assigneeId);
    if (agentStatus === 'busy') {
      try {
        const { task } = readTask(taskPath(corpRoot, taskId));
        daemon.inbox.enqueueTask(assigneeId, {
          taskId: task.id,
          taskTitle: task.title,
          taskPriority: task.priority,
          assigneeId,
          timestamp: new Date().toISOString(),
          blockedBy: task.blockedBy ?? null,
        });
        log(`[task-events] Agent ${assignee.displayName} is busy — queued "${taskTitle}"`);
      } catch {
        // If task file can't be read, still try to enqueue with basic info
        daemon.inbox.enqueueTask(assigneeId, {
          taskId,
          taskTitle,
          taskPriority: 'normal',
          assigneeId,
          timestamp: new Date().toISOString(),
          blockedBy: null,
        });
      }
      return;
    }

    const channels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));

    // Find the agent's DM channel (kind=direct, includes assignee)
    const founder = members.find((m) => m.rank === 'owner');
    const dmChannel = channels.find(
      (c) =>
        c.kind === 'direct' &&
        c.memberIds.includes(assigneeId) &&
        (founder ? c.memberIds.includes(founder.id) : true),
    );
    if (!dmChannel) {
      logError(`[task-events] No DM channel found for ${assignee.displayName}`);
      return;
    }

    // Build rich task context
    let taskContext = `New task assigned: "${taskTitle}"`;
    try {
      const tp = taskPath(corpRoot, taskId);
      const { task, body } = readTask(tp);
      taskContext = [
        `New task assigned to you:`,
        ``,
        `**${task.title}** (Priority: ${task.priority.toUpperCase()})`,
        `Task file: ${corpRoot.replace(/\\/g, '/')}/tasks/${taskId}.md`,
        ``,
        body.trim() ? body.trim() : '(No description)',
        ``,
        `Read the task file, update status to in_progress, and start working. Narrate what you're doing.`,
      ].join('\n');
    } catch {
      // Fall back to basic message if task file can't be read
    }

    const msg: ChannelMessage = {
      id: generateId(),
      channelId: dmChannel.id,
      senderId: 'system',
      threadId: null,
      content: taskContext,
      kind: 'text',
      mentions: [assigneeId],
      metadata: { source: 'task-dispatch' },
      depth: 0,
      originId: '',
      timestamp: new Date().toISOString(),
    };
    msg.originId = msg.id;
    appendMessage(join(corpRoot, dmChannel.path, MESSAGES_JSONL), msg);

    // Poke router to process (Windows fs.watch can miss appends on new files)
    setTimeout(() => daemon.router.pokeChannel(dmChannel.id), 100);

    log(`[task-events] Dispatched task "${taskTitle}" to ${assignee.displayName}'s DM`);
  } catch (err) {
    logError(`[task-events] DM dispatch failed: ${err}`);
  }
}

/**
 * Dispatch a blocker notification to a supervisor's DM.
 */
export function dispatchBlockerToDm(
  daemon: Daemon,
  creatorId: string,
  assigneeName: string,
  taskTitle: string,
): void {
  try {
    const corpRoot = daemon.corpRoot;
    const channels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));
    const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));

    const creator = members.find((m) => m.id === creatorId);
    if (!creator) return;

    const founder = members.find((m) => m.rank === 'owner');
    const dmChannel = channels.find(
      (c) =>
        c.kind === 'direct' &&
        c.memberIds.includes(creatorId) &&
        (founder ? c.memberIds.includes(founder.id) : true),
    );
    if (!dmChannel) return;

    const msg: ChannelMessage = {
      id: generateId(),
      channelId: dmChannel.id,
      senderId: 'system',
      threadId: null,
      content: `Task "${taskTitle}" is BLOCKED by ${assigneeName}. Read the task file for details and help unblock.`,
      kind: 'text',
      mentions: [creatorId],
      metadata: { source: 'task-blocker' },
      depth: 0,
      originId: '',
      timestamp: new Date().toISOString(),
    };
    msg.originId = msg.id;
    appendMessage(join(corpRoot, dmChannel.path, MESSAGES_JSONL), msg);
    setTimeout(() => daemon.router.pokeChannel(dmChannel.id), 100);

    log(`[task-events] Blocker notification sent to ${creator.displayName}'s DM`);
  } catch (err) {
    logError(`[task-events] Blocker DM dispatch failed: ${err}`);
  }
}

/**
 * Dispatch a task completion/failure notification to the CEO's DM.
 */
export function dispatchCompletionToCeo(
  daemon: Daemon,
  taskTitle: string,
  taskStatus: string,
  assigneeName: string,
): void {
  try {
    const corpRoot = daemon.corpRoot;
    const channels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));
    const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));

    const ceo = members.find((m) => m.rank === 'master' && m.type === 'agent');
    if (!ceo) return;

    const founder = members.find((m) => m.rank === 'owner');
    const dmChannel = channels.find(
      (c) =>
        c.kind === 'direct' &&
        c.memberIds.includes(ceo.id) &&
        (founder ? c.memberIds.includes(founder.id) : true),
    );
    if (!dmChannel) return;

    const msg: ChannelMessage = {
      id: generateId(),
      channelId: dmChannel.id,
      senderId: 'system',
      threadId: null,
      content: `Task "${taskTitle}" has been marked as ${taskStatus} by ${assigneeName}. Review and report to the Founder.`,
      kind: 'text',
      mentions: [ceo.id],
      metadata: { source: 'task-completion' },
      depth: 0,
      originId: '',
      timestamp: new Date().toISOString(),
    };
    msg.originId = msg.id;
    appendMessage(join(corpRoot, dmChannel.path, MESSAGES_JSONL), msg);
    setTimeout(() => daemon.router.pokeChannel(dmChannel.id), 100);

    log(`[task-events] Completion notification for "${taskTitle}" sent to CEO's DM`);
  } catch (err) {
    logError(`[task-events] CEO notification failed: ${err}`);
  }
}

/**
 * Notify the task's hander (sponsor) that their handed task completed, failed, or got blocked.
 * Different from CEO notification — this is for the person who delegated the work.
 */
export function dispatchToHander(
  daemon: Daemon,
  handerId: string,
  taskTitle: string,
  taskStatus: string,
  assigneeName: string,
): void {
  try {
    const corpRoot = daemon.corpRoot;
    const channels = readConfig<Channel[]>(join(corpRoot, CHANNELS_JSON));
    const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));

    const hander = members.find((m) => m.id === handerId);
    if (!hander) return;

    const founder = members.find((m) => m.rank === 'owner');
    const dmChannel = channels.find(
      (c) =>
        c.kind === 'direct' &&
        c.memberIds.includes(handerId) &&
        (founder ? c.memberIds.includes(founder.id) : true),
    );
    if (!dmChannel) return;

    // Craft hander-specific message (different tone from CEO notification)
    let content: string;
    if (taskStatus === 'completed') {
      content = `Your handed task "${taskTitle}" was completed by ${assigneeName}. Review the deliverables and verify acceptance criteria.`;
    } else if (taskStatus === 'failed') {
      content = `Your handed task "${taskTitle}" FAILED. ${assigneeName} could not complete it. Check the task file for details and decide next steps.`;
    } else if (taskStatus === 'blocked') {
      content = `Your handed task "${taskTitle}" is BLOCKED by ${assigneeName}. They need help — check the task file for Tried/Failed/Need details.`;
    } else {
      content = `Task "${taskTitle}" status changed to ${taskStatus} by ${assigneeName}.`;
    }

    const msg: ChannelMessage = {
      id: generateId(),
      channelId: dmChannel.id,
      senderId: 'system',
      threadId: null,
      content,
      kind: 'text',
      mentions: [handerId],
      metadata: { source: 'task-hander-notify' },
      depth: 0,
      originId: '',
      timestamp: new Date().toISOString(),
    };
    msg.originId = msg.id;
    appendMessage(join(corpRoot, dmChannel.path, MESSAGES_JSONL), msg);
    setTimeout(() => daemon.router.pokeChannel(dmChannel.id), 100);

    log(`[task-events] Hander notification for "${taskTitle}" (${taskStatus}) sent to ${hander.displayName}'s DM`);
  } catch (err) {
    logError(`[task-events] Hander notification failed: ${err}`);
  }
}
