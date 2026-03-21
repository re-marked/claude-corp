import { watch, type FSWatcher, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Member,
  type Channel,
  type ChannelMessage,
  readConfig,
  readNewLines,
  getFileSize,
  tailMessages,
  appendMessage,
  generateId,
  resolveMentions,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
  MAX_DEPTH,
  COOLDOWN_MS,
} from '@claudecorp/shared';
import { dispatchToAgent, type DispatchContext } from './dispatch.js';
import type { Daemon } from './daemon.js';
import { log, logError } from './logger.js';

export class MessageRouter {
  private watchers = new Map<string, FSWatcher>();
  private offsets = new Map<string, number>();
  private dispatched = new Set<string>();
  private lastDispatch = new Map<string, number>();
  private daemon: Daemon;
  private channelsDirWatcher: FSWatcher | null = null;
  private dedupClearInterval: ReturnType<typeof setInterval> | null = null;
  /** Currently dispatching — agent displayNames that are actively processing. */
  activeDispatches = new Set<string>();
  /** Queued dispatches per agent — when agent is busy, messages wait here. */
  private dispatchQueue = new Map<string, { msg: ChannelMessage; channel: Channel; targetId: string; members: Member[]; sender: Member }[]>();

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  start(): void {
    const channels = this.loadChannels();

    // Watch all existing channel JSONL files
    for (const channel of channels) {
      this.watchChannel(channel);
    }

    // Watch for new channel directories
    const channelsDir = join(this.daemon.corpRoot, 'channels');
    if (existsSync(channelsDir)) {
      this.channelsDirWatcher = watch(channelsDir, (event, filename) => {
        if (event === 'rename' && filename) {
          const msgPath = join(channelsDir, filename, MESSAGES_JSONL);
          if (existsSync(msgPath) && !this.watchers.has(filename)) {
            const freshChannels = this.loadChannels();
            const ch = freshChannels.find((c) => c.path.includes(filename));
            if (ch) this.watchChannel(ch);
          }
        }
      });
      this.channelsDirWatcher.on('error', () => {
        // Non-fatal — new channels won't auto-watch until restart
      });
    }

    // Clear dedup set every 5 minutes
    this.dedupClearInterval = setInterval(() => {
      this.dispatched.clear();
      this.processedMsgIds.clear();
    }, 5 * 60 * 1000);

    log(`[router] Watching ${channels.length} channels`);
  }

  stop(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.channelsDirWatcher?.close();
    if (this.dedupClearInterval) clearInterval(this.dedupClearInterval);
  }

  private loadChannels(): Channel[] {
    try {
      return readConfig<Channel[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
    } catch {
      return [];
    }
  }

  private loadMembers(): Member[] {
    try {
      return readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
    } catch {
      return [];
    }
  }

  watchChannel(channel: Channel): void {
    const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);
    if (!existsSync(msgPath)) return;
    if (this.watchers.has(channel.id)) return;

    // Initialize offset to end of file (only process NEW messages)
    this.offsets.set(msgPath, getFileSize(msgPath));

    const watcher = watch(msgPath, () => {
      this.onFileChange(channel, msgPath);
    });
    watcher.on('error', () => {
      // Windows EPERM on external file modification — re-watch
      this.watchers.delete(channel.id);
      setTimeout(() => this.watchChannel(channel), 1000);
    });

    this.watchers.set(channel.id, watcher);
  }

  /** Message-level dedup — prevents double dispatch regardless of fs.watch timing */
  private processedMsgIds = new Set<string>();

  private onFileChange(channel: Channel, msgPath: string): void {
    const currentOffset = this.offsets.get(msgPath) ?? 0;
    const { messages, newOffset } = readNewLines(msgPath, currentOffset);
    if (newOffset === currentOffset) return; // No new bytes
    this.offsets.set(msgPath, newOffset);

    for (const msg of messages) {
      if (this.processedMsgIds.has(msg.id)) continue;
      this.processedMsgIds.add(msg.id);

      // Ignore agent messages not written by our router (external OpenClaw writes)
      const meta = msg.metadata as Record<string, unknown> | null;
      if (msg.kind === 'text' && msg.senderId !== 'system' && !meta?.source) {
        const members = this.loadMembers();
        const sender = members.find((m) => m.id === msg.senderId);
        if (sender?.type === 'agent') {
          log(`[router] IGNORED external agent write from ${sender.displayName}`);
          continue;
        }
      }

      this.processMessage(msg, channel);
    }
  }

  private processMessage(msg: ChannelMessage, channel: Channel): void {
    // Handle /uptime slash command
    if (msg.kind === 'text' && msg.content.trim() === '/uptime') {
      const uptime = this.daemon.getUptime();
      const totalMessages = this.daemon.countAllMessages();
      const responseMsg: ChannelMessage = {
        id: generateId(),
        channelId: channel.id,
        senderId: 'system',
        threadId: msg.threadId,
        content: `⏱ Uptime: ${uptime} | 📨 Messages: ${totalMessages} total across all channels`,
        kind: 'system',
        mentions: [],
        metadata: null,
        depth: 0,
        originId: msg.originId || msg.id,
        timestamp: new Date().toISOString(),
      };
      const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);
      appendMessage(msgPath, responseMsg);
      return;
    }

    // Don't dispatch system messages or task events
    if (msg.kind !== 'text') return;

    // Depth guard
    if (msg.depth >= MAX_DEPTH) {
      log(`[router] Depth limit reached (${msg.depth}) for message ${msg.id}`);
      return;
    }

    const members = this.loadMembers();
    const sender = members.find((m) => m.id === msg.senderId);
    // Allow 'system' sender for automated notifications (task assignments, etc.)
    const senderOrSystem: Member = sender ?? {
      id: msg.senderId,
      displayName: 'system',
      rank: 'owner',
      status: 'active',
      type: 'user',
      scope: 'corp',
      scopeId: '',
      agentDir: null,
      port: null,
      spawnedBy: null,
      createdAt: '',
    };
    if (!sender && msg.senderId !== 'system') return;

    // Find dispatch targets
    let targetIds: string[] = [];

    if (channel.kind === 'direct') {
      // DM: auto-route to the other member
      const otherId = channel.memberIds.find((id) => id !== msg.senderId);
      if (otherId) {
        const other = members.find((m) => m.id === otherId);
        if (other && other.type === 'agent') {
          targetIds = [otherId];
        }
      }
    } else {
      // Broadcast/team/system: route to @mentioned agents only
      const mentionedIds = resolveMentions(msg.content, members);
      targetIds = mentionedIds.filter((id) => {
        const m = members.find((mem) => mem.id === id);
        return m && m.type === 'agent';
      });
    }

    if (targetIds.length === 0) return;

    // Dispatch to each target
    for (const targetId of targetIds) {
      this.dispatchToTarget(msg, channel, targetId, members, senderOrSystem);
    }
  }

  private async dispatchToTarget(
    msg: ChannelMessage,
    channel: Channel,
    targetId: string,
    members: Member[],
    sender: Member,
  ): Promise<void> {
    // Universal dedup: never dispatch the same message to the same target twice
    const dispatchKey = `${msg.id}:${targetId}`;
    if (this.dispatched.has(dispatchKey)) {
      log(`[router] DEDUP blocked dispatch to ${targetId} for msg ${msg.id}`);
      return;
    }
    this.dispatched.add(dispatchKey);

    // Cooldown guard (only for agent-to-agent, user messages always go through)
    if (sender.type === 'agent') {
      const lastTime = this.lastDispatch.get(targetId) ?? 0;
      if (Date.now() - lastTime < COOLDOWN_MS) {
        log(`[router] Cooldown active for ${targetId}, skipping`);
        return;
      }
    }

    const agentProc = this.daemon.processManager.getAgent(targetId);
    if (!agentProc || agentProc.status !== 'ready') {
      return;
    }

    // Queue if agent is busy (one dispatch at a time per agent)
    if (this.activeDispatches.has(agentProc.displayName)) {
      const queue = this.dispatchQueue.get(targetId) ?? [];
      queue.push({ msg, channel, targetId, members, sender });
      this.dispatchQueue.set(targetId, queue);
      log(`[router] ${agentProc.displayName} is busy — queued (${queue.length} waiting)`);
      return;
    }

    const target = members.find((m) => m.id === targetId);
    if (!target) return;

    // Track cooldown for all dispatches
    this.lastDispatch.set(targetId, Date.now());

    // Load recent channel history for context
    const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);
    const recent = tailMessages(msgPath, 50);
    const recentHistory = recent.map((m) => {
      const s = members.find((mem) => mem.id === m.senderId);
      const name = s?.displayName ?? 'Unknown';
      const rank = s?.rank ?? '';
      const time = new Date(m.timestamp).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
      return `[${name} (${rank})] ${time}: ${m.content}`;
    });

    // Build context with history
    const context = this.buildContext(target, channel, members, recentHistory);

    // If message is just a bare @mention, use the previous message as content
    const strippedContent = msg.content.replace(/@"[^"]+"|@[A-Za-z0-9][\w-]*/g, '').trim();
    let messageContent = msg.content;
    if (!strippedContent && recent.length >= 2) {
      // Find the last message before the bare mention
      const prev = recent[recent.length - 2];
      if (prev) {
        const prevSender = members.find((mem) => mem.id === prev.senderId);
        messageContent = `[${prevSender?.displayName ?? 'Unknown'}]: ${prev.content}`;
      }
    }

    try {
      this.activeDispatches.add(target.displayName);

      // Broadcast dispatch start + set streaming state
      this.daemon.events.broadcast({
        type: 'dispatch_start',
        agentName: target.displayName,
        channelId: channel.id,
      });
      this.daemon.streaming.set(targetId, {
        agentName: target.displayName,
        content: '',
        channelId: channel.id,
      });

      const result = await dispatchToAgent(
        agentProc,
        messageContent,
        context,
        `channel-${channel.id}-${msg.id}`,
        (accumulated) => {
          this.daemon.streaming.set(targetId, {
            agentName: target.displayName,
            content: accumulated,
            channelId: channel.id,
          });
          // Push streaming tokens to TUI via WebSocket
          this.daemon.events.broadcast({
            type: 'stream_token',
            agentName: target.displayName,
            channelId: channel.id,
            content: accumulated,
          });
        },
      );

      this.daemon.streaming.delete(targetId);
      this.activeDispatches.delete(target.displayName);
      this.daemon.events.broadcast({
        type: 'stream_end',
        agentName: target.displayName,
        channelId: channel.id,
      });

      // Write agent response to JSONL
      log(`[router] WRITING ${target.displayName}'s response (${result.content.length} chars) "${result.content.substring(0, 80)}"`);
      const responseMsg: ChannelMessage = {
        id: generateId(),
        channelId: channel.id,
        senderId: targetId,
        threadId: msg.threadId,
        content: result.content,
        kind: 'text',
        mentions: resolveMentions(result.content, members),
        metadata: { source: 'router' },
        depth: msg.depth + 1,
        originId: msg.originId,
        timestamp: new Date().toISOString(),
      };

      const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);
      appendMessage(msgPath, responseMsg);

      log(`[router] ${target.displayName} responded in #${channel.name}`);

      // Mark corp as dirty for git commit
      this.daemon.gitManager.markDirty(target.displayName);

      // Drain queue — dispatch next waiting message for this agent
      this.drainQueue(targetId);
    } catch (err) {
      this.daemon.streaming.delete(targetId);
      this.activeDispatches.delete(target.displayName);
      this.daemon.events.broadcast({
        type: 'dispatch_end',
        agentName: target.displayName,
        channelId: channel.id,
      });
      logError(`[router] Dispatch to ${target.displayName} failed: ${err}`);

      // Still drain queue on error — next task might succeed
      this.drainQueue(targetId);
    }
  }

  /** Process the next queued message for an agent after their current dispatch finishes. */
  private drainQueue(agentId: string): void {
    const queue = this.dispatchQueue.get(agentId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    if (queue.length === 0) this.dispatchQueue.delete(agentId);

    log(`[router] Draining queue for ${next.sender.displayName ?? agentId} — ${queue.length} remaining`);
    this.dispatchToTarget(next.msg, next.channel, next.targetId, next.members, next.sender);
  }

  private buildContext(
    targetAgent: Member,
    channel: Channel,
    members: Member[],
    recentHistory: string[] = [],
  ): DispatchContext {
    const corpRootDisplay = this.daemon.corpRoot.replace(/\\/g, '/');
    const agentDirDisplay = targetAgent.agentDir
      ? join(this.daemon.corpRoot, targetAgent.agentDir).replace(/\\/g, '/')
      : corpRootDisplay;

    const channelMembers = channel.memberIds
      .map((id) => members.find((m) => m.id === id))
      .filter(Boolean)
      .map((m) => `${m!.displayName} (${m!.rank})`);

    const corpMembers = members.map((m) => ({
      name: m.displayName,
      rank: m.rank,
      type: m.type,
      status: m.status,
    }));

    return {
      agentDir: agentDirDisplay,
      corpRoot: corpRootDisplay,
      channelName: channel.name,
      channelMembers,
      corpMembers,
      recentHistory,
      daemonPort: this.daemon.getPort(),
      agentMemberId: targetAgent.id,
      agentRank: targetAgent.rank,
    };
  }
}
