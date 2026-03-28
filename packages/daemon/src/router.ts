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

    // Channel mode check — announce channels don't dispatch
    const channelMode = channel.mode ?? (channel.kind === 'direct' ? 'open' : 'mention');
    if (channelMode === 'announce') {
      log(`[router] #${channel.name} is announce-mode — no dispatch`);
      return;
    }

    // Find dispatch targets
    let targetIds: string[] = [];

    if (msg.threadId) {
      // Thread message — dispatch to thread participants + @mentioned only
      const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);
      const recent = tailMessages(msgPath, 100);
      const threadMsgs = recent.filter(
        (m) => m.threadId === msg.threadId || m.id === msg.threadId,
      );
      const participantIds = new Set(threadMsgs.map((m) => m.senderId));
      const mentionedIds = resolveMentions(msg.content, members);
      for (const id of mentionedIds) participantIds.add(id);
      // Remove the sender, keep only agents
      participantIds.delete(msg.senderId);
      targetIds = [...participantIds].filter((id) => {
        const m = members.find((mem) => mem.id === id);
        return m && m.type === 'agent';
      });
      log(`[router] Thread dispatch: ${targetIds.length} participants`);
    } else if (channel.kind === 'direct') {
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

    // Load recent channel history for context — thread-aware
    const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);
    const allRecent = tailMessages(msgPath, 100);
    // If dispatching about a thread, show thread history. Otherwise main channel only.
    const recent = msg.threadId
      ? allRecent.filter((m) => m.threadId === msg.threadId || m.id === msg.threadId)
      : allRecent.filter((m) => !m.threadId);
    const recentHistory = recent.slice(-50).map((m) => {
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

      // Pick WebSocket client based on agent mode (remote = user OpenClaw, gateway = corp gateway)
      const wsClient = agentProc.mode === 'remote'
        ? this.daemon.openclawWS
        : this.daemon.corpGatewayWS;

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
          this.daemon.events.broadcast({
            type: 'stream_token',
            agentName: target.displayName,
            channelId: channel.id,
            content: accumulated,
          });
        },
        wsClient,
        {
          onToolStart: (tool) => {
            this.daemon.events.broadcast({
              type: 'tool_start',
              agentName: target.displayName,
              channelId: channel.id,
              toolName: tool.name,
              args: tool.args,
            });
          },
          onToolEnd: (tool) => {
            // Write tool_event to JSONL AFTER tool completes — permanent history
            const toolMsg: ChannelMessage = {
              id: generateId(),
              channelId: channel.id,
              senderId: targetId,
              threadId: msg.threadId,
              content: this.formatToolMessage(tool.name, tool.args),
              kind: 'tool_event',
              mentions: [],
              metadata: { source: 'router', toolName: tool.name, toolCallId: tool.toolCallId },
              depth: msg.depth + 1,
              originId: msg.originId,
              timestamp: new Date().toISOString(),
            };
            appendMessage(join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL), toolMsg);
            this.daemon.events.broadcast({
              type: 'tool_end',
              agentName: target.displayName,
              channelId: channel.id,
              toolName: tool.name,
            });
          },
        },
      );

      this.daemon.streaming.delete(targetId);
      this.activeDispatches.delete(target.displayName);
      this.daemon.events.broadcast({
        type: 'stream_end',
        agentName: target.displayName,
        channelId: channel.id,
      });

      // Skip empty responses — agent glitched or had nothing to say
      if (!result.content || result.content.trim().length === 0) {
        log(`[router] ${target.displayName} returned empty response — skipping write`);
        this.daemon.events.broadcast({ type: 'dispatch_end', agentName: target.displayName, channelId: channel.id });
        this.daemon.gitManager.markDirty(target.displayName);
        this.drainQueue(targetId);
        return;
      }

      // Parse [thread] marker — split into main channel + thread parts
      const threadMarkerIdx = result.content.indexOf('[thread]');
      let mainContent = result.content;
      let threadContent: string | null = null;
      let responseThreadId = msg.threadId;

      if (threadMarkerIdx !== -1) {
        mainContent = result.content.slice(0, threadMarkerIdx).trim();
        threadContent = result.content.slice(threadMarkerIdx + '[thread]'.length).trim();
        responseThreadId = msg.threadId ?? msg.id;
        log(`[router] ${target.displayName} split response: main=${mainContent.length} chars, thread=${threadContent.length} chars`);
      }

      const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);

      // If agent used [thread] at the very start (no main content), entire response is threaded
      if (threadContent && !mainContent) {
        const threadMsg: ChannelMessage = {
          id: generateId(),
          channelId: channel.id,
          senderId: targetId,
          threadId: responseThreadId,
          content: threadContent,
          kind: 'text',
          mentions: resolveMentions(threadContent, members),
          metadata: { source: 'router' },
          depth: msg.depth + 1,
          originId: msg.originId,
          timestamp: new Date().toISOString(),
        };
        log(`[router] WRITING ${target.displayName}'s threaded response (${threadContent.length} chars)`);
        appendMessage(msgPath, threadMsg);
        const responseMsg = threadMsg;

        log(`[router] ${target.displayName} responded in thread in #${channel.name}`);
        this.daemon.streaming.delete(targetId);
        this.activeDispatches.delete(target.displayName);
        this.daemon.events.broadcast({ type: 'stream_end', agentName: target.displayName, channelId: channel.id });
        this.daemon.gitManager.markDirty(target.displayName);
        this.drainQueue(targetId);
        return;
      }

      // Write main channel response
      const mainMsg: ChannelMessage = {
        id: generateId(),
        channelId: channel.id,
        senderId: targetId,
        threadId: msg.threadId,
        content: mainContent,
        kind: 'text',
        mentions: resolveMentions(mainContent, members),
        metadata: { source: 'router' },
        depth: msg.depth + 1,
        originId: msg.originId,
        timestamp: new Date().toISOString(),
      };

      log(`[router] WRITING ${target.displayName}'s response (${mainContent.length} chars) "${mainContent.substring(0, 80)}"`);
      appendMessage(msgPath, mainMsg);

      // Write thread portion as a separate message if it exists
      if (threadContent && mainContent) {
        const threadMsg: ChannelMessage = {
          id: generateId(),
          channelId: channel.id,
          senderId: targetId,
          threadId: responseThreadId,
          content: threadContent,
          kind: 'text',
          mentions: resolveMentions(threadContent, members),
          metadata: { source: 'router' },
          depth: msg.depth + 1,
          originId: msg.originId,
          timestamp: new Date().toISOString(),
        };
        appendMessage(msgPath, threadMsg);
        log(`[router] WRITING ${target.displayName}'s thread reply (${threadContent.length} chars)`);
      }

      // Use mainMsg as the "responseMsg" for the rest of the flow
      const responseMsg = mainMsg;

      log(`[router] ${target.displayName} responded in #${channel.name}`);

      // Mark corp as dirty for git commit
      this.daemon.gitManager.markDirty(target.displayName);

      // Drain queue — dispatch next waiting message for this agent
      this.drainQueue(targetId);
    } catch (err) {
      // Fallback chain — if model is unavailable/overloaded, try next model
      const errMsg = err instanceof Error ? err.message : String(err);
      const isModelError = /529|503|overloaded|capacity|rate_limit|model.*unavailable/i.test(errMsg);
      const fallbackChain = this.daemon.globalConfig.defaults.fallbackChain ?? [];
      const gw = this.daemon.processManager.corpGateway;

      if (isModelError && fallbackChain.length > 0 && gw && agentProc.mode === 'gateway') {
        const agentName = target.agentDir?.replace(/^agents\//, '').replace(/\/$/, '') ?? '';
        const currentModels = gw.getModels();
        const currentModel = currentModels.agents.find(a => a.id === agentName)?.model
          ?? currentModels.defaultModel;

        // Find next model in fallback chain
        const { parseProviderModel } = await import('@claudecorp/shared');
        const currentId = parseProviderModel(currentModel).model;
        const chainIdx = fallbackChain.indexOf(currentId);
        const nextIdx = chainIdx === -1 ? 0 : chainIdx + 1;

        if (nextIdx < fallbackChain.length) {
          const nextModel = fallbackChain[nextIdx]!;
          log(`[router] Model unavailable for ${target.displayName}, falling back to ${nextModel}`);

          // Temporarily update gateway config
          gw.updateAgentModel(agentName, nextModel, 'anthropic');
          await new Promise(r => setTimeout(r, 1500)); // Wait for hot-reload

          try {
            // Retry dispatch with fallback model
            await dispatchToAgent(agentProc, messageContent, context, `channel-${channel.id}-${msg.id}-fallback`,
              (accumulated) => {
                this.daemon.streaming.set(targetId, { agentName: target.displayName, content: accumulated, channelId: channel.id });
                this.daemon.events.broadcast({ type: 'stream_token', agentName: target.displayName, channelId: channel.id, content: accumulated });
              },
              this.daemon.corpGatewayWS,
            );

            // Restore original model after successful fallback
            if (chainIdx === -1) {
              gw.updateAgentModel(agentName, null); // Was using default
            } else {
              gw.updateAgentModel(agentName, currentId, 'anthropic');
            }

            log(`[router] Fallback dispatch to ${target.displayName} succeeded with ${nextModel}`);
            this.daemon.streaming.delete(targetId);
            this.activeDispatches.delete(target.displayName);
            this.daemon.events.broadcast({ type: 'dispatch_end', agentName: target.displayName, channelId: channel.id });
            this.drainQueue(targetId);
            return; // Fallback succeeded
          } catch (fallbackErr) {
            // Restore original model
            if (chainIdx === -1) {
              gw.updateAgentModel(agentName, null);
            } else {
              gw.updateAgentModel(agentName, currentId, 'anthropic');
            }
            logError(`[router] Fallback dispatch also failed: ${fallbackErr}`);
          }
        }
      }

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

  /** Format a tool call into a human-readable message for the chat history. */
  private formatToolMessage(toolName: string, args?: Record<string, unknown>): string {
    const name = toolName.toLowerCase();

    // File operations
    if (name === 'write' || name === 'create' || name === 'write_file') {
      const path = args?.path ?? args?.file_path ?? args?.filePath;
      return path ? `wrote ${path}` : 'wrote a file';
    }
    if (name === 'edit' || name === 'edit_file' || name === 'patch') {
      const path = args?.path ?? args?.file_path ?? args?.filePath;
      return path ? `edited ${path}` : 'edited a file';
    }
    if (name === 'read' || name === 'read_file') {
      const path = args?.path ?? args?.file_path ?? args?.filePath;
      return path ? `read ${path}` : 'read a file';
    }

    // Commands / exec
    if (name === 'bash' || name === 'execute' || name === 'exec' || name === 'shell' || name === 'run') {
      const cmd = String(args?.command ?? args?.cmd ?? args?.input ?? '').trim();
      if (cmd) {
        const short = cmd.split('\n')[0]!.substring(0, 80);
        return `ran \`${short}\``;
      }
      return 'ran a command';
    }

    // Search
    if (name === 'glob' || name === 'search' || name === 'find') {
      return `searched ${args?.pattern ?? args?.query ?? 'files'}`;
    }
    if (name === 'grep') {
      return `searched for "${args?.pattern ?? args?.query ?? '...'}"`;
    }

    // Web
    if (name === 'web_search' || name === 'websearch') {
      return `searched web: "${args?.query ?? '...'}"`;
    }
    if (name === 'web_fetch' || name === 'fetch' || name === 'curl') {
      return `fetched ${args?.url ?? 'a URL'}`;
    }

    // Fallback — try to extract something useful from args
    const path = args?.path ?? args?.file_path ?? args?.filePath;
    if (path) return `${name} ${path}`;
    const cmd = args?.command ?? args?.cmd;
    if (cmd) return `${name}: ${String(cmd).substring(0, 60)}`;

    log(`[router] Unknown tool format: ${toolName} args=${JSON.stringify(args)}`);
    return `used ${toolName}`;
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

    // Resolve supervisor name (who spawned this agent)
    let supervisorName: string | null = null;
    if (targetAgent.spawnedBy) {
      const supervisor = members.find((m) => m.id === targetAgent.spawnedBy);
      supervisorName = supervisor?.displayName ?? null;
    }

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
      agentDisplayName: targetAgent.displayName,
      channelKind: channel.kind,
      supervisorName,
    };
  }
}
