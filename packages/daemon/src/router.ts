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
} from '@agentcorp/shared';
import { dispatchToAgent, type DispatchContext } from './dispatch.js';
import type { Daemon } from './daemon.js';

export class MessageRouter {
  private watchers = new Map<string, FSWatcher>();
  private offsets = new Map<string, number>();
  private dispatched = new Set<string>();
  private lastDispatch = new Map<string, number>();
  private daemon: Daemon;
  private channelsDirWatcher: FSWatcher | null = null;
  private dedupClearInterval: ReturnType<typeof setInterval> | null = null;

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
          // New channel directory may have appeared
          const msgPath = join(channelsDir, filename, MESSAGES_JSONL);
          if (existsSync(msgPath) && !this.watchers.has(filename)) {
            const freshChannels = this.loadChannels();
            const ch = freshChannels.find((c) => c.path.includes(filename));
            if (ch) this.watchChannel(ch);
          }
        }
      });
    }

    // Clear dedup set every 5 minutes
    this.dedupClearInterval = setInterval(() => {
      this.dispatched.clear();
    }, 5 * 60 * 1000);

    console.log(`[router] Watching ${channels.length} channels`);
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

  private watchChannel(channel: Channel): void {
    const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);
    if (!existsSync(msgPath)) return;
    if (this.watchers.has(channel.id)) return;

    // Initialize offset to end of file (only process NEW messages)
    this.offsets.set(msgPath, getFileSize(msgPath));

    const watcher = watch(msgPath, () => {
      this.onFileChange(channel, msgPath);
    });

    this.watchers.set(channel.id, watcher);
  }

  private onFileChange(channel: Channel, msgPath: string): void {
    const currentOffset = this.offsets.get(msgPath) ?? 0;
    const { messages, newOffset } = readNewLines(msgPath, currentOffset);
    this.offsets.set(msgPath, newOffset);

    for (const msg of messages) {
      this.processMessage(msg, channel);
    }
  }

  private processMessage(msg: ChannelMessage, channel: Channel): void {
    // Don't dispatch system messages or task events
    if (msg.kind !== 'text') return;

    // Depth guard
    if (msg.depth >= MAX_DEPTH) {
      console.log(`[router] Depth limit reached (${msg.depth}) for message ${msg.id}`);
      return;
    }

    const members = this.loadMembers();
    const sender = members.find((m) => m.id === msg.senderId);
    if (!sender) return;

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
      this.dispatchToTarget(msg, channel, targetId, members, sender);
    }
  }

  private async dispatchToTarget(
    msg: ChannelMessage,
    channel: Channel,
    targetId: string,
    members: Member[],
    sender: Member,
  ): Promise<void> {
    // Dedup guard (only for agent-to-agent, not user messages)
    if (sender.type === 'agent') {
      const dedupKey = `${msg.originId}:${targetId}`;
      if (this.dispatched.has(dedupKey)) {
        return;
      }
      this.dispatched.add(dedupKey);
    }

    // Cooldown guard (only for agent-to-agent, user messages always go through)
    if (sender.type === 'agent') {
      const lastTime = this.lastDispatch.get(targetId) ?? 0;
      if (Date.now() - lastTime < COOLDOWN_MS) {
        console.log(`[router] Cooldown active for ${targetId}, skipping`);
        return;
      }
    }

    const agentProc = this.daemon.processManager.getAgent(targetId);
    if (!agentProc || agentProc.status !== 'ready') {
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

    // Send the triggering message content (history is in system message)
    const messageContent = msg.content;

    try {
      const result = await dispatchToAgent(
        agentProc,
        messageContent,
        context,
        `channel-${channel.id}`,
      );

      // Write agent response to JSONL
      const responseMsg: ChannelMessage = {
        id: generateId(),
        channelId: channel.id,
        senderId: targetId,
        threadId: msg.threadId,
        content: result.content,
        kind: 'text',
        mentions: resolveMentions(result.content, members),
        metadata: null,
        depth: msg.depth + 1,
        originId: msg.originId,
        timestamp: new Date().toISOString(),
      };

      const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);
      appendMessage(msgPath, responseMsg);

      console.log(`[router] ${target.displayName} responded in #${channel.name}`);
    } catch (err) {
      console.error(`[router] Dispatch to ${target.displayName} failed:`, err);
    }
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
    };
  }
}
