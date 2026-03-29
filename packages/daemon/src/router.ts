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
  /** Retry counters for empty responses — key is "msgId:targetId" */
  private retryCount = new Map<string, number>();
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

    // Depth guard — 0 = unlimited (default)
    if (MAX_DEPTH > 0 && msg.depth >= MAX_DEPTH) {
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

    // Resolve channel mode: dm (auto-dispatch), mention (@only), all (everyone)
    const channelMode = channel.mode ?? (channel.kind === 'direct' ? 'dm' : 'mention');

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
      participantIds.delete(msg.senderId);
      targetIds = [...participantIds].filter((id) => {
        const m = members.find((mem) => mem.id === id);
        return m && m.type === 'agent';
      });
      log(`[router] Thread dispatch: ${targetIds.length} participants`);
    } else if (channelMode === 'dm') {
      // DM: auto-route to the other member
      const otherId = channel.memberIds.find((id) => id !== msg.senderId);
      if (otherId) {
        const other = members.find((m) => m.id === otherId);
        if (other && other.type === 'agent') {
          targetIds = [otherId];
        }
      }
    } else if (channelMode === 'all') {
      // All: every agent in the channel wakes up
      targetIds = channel.memberIds.filter((id) => {
        if (id === msg.senderId) return false;
        const m = members.find((mem) => mem.id === id);
        return m && m.type === 'agent';
      });
      log(`[router] All-mode dispatch: ${targetIds.length} agents in #${channel.name}`);
    } else {
      // Mention: always resolve from content — one path, no shortcuts
      const mentionedIds = resolveMentions(msg.content, members);
      targetIds = mentionedIds.filter((id) => {
        const m = members.find((mem) => mem.id === id);
        return m && m.type === 'agent';
      });
    }

    if (targetIds.length === 0) return;

    // Human/system @mentions → immediate dispatch (bypass inbox)
    // Agent @mentions → record in inbox, wait for heartbeat or idle transition
    const isHumanOrSystem = senderOrSystem.type === 'user' || msg.senderId === 'system';

    for (const targetId of targetIds) {
      if (isHumanOrSystem) {
        this.dispatchToTarget(msg, channel, targetId, members, senderOrSystem);
      } else {
        // Agent mention → inbox
        const target = members.find(m => m.id === targetId);
        const isMention = true;
        this.daemon.inbox.recordMessage(channel.id, channel.name, targetId, isMention, senderOrSystem.displayName);
        log(`[router] Inbox: ${target?.displayName ?? targetId} has new mention in #${channel.name} from ${senderOrSystem.displayName}`);
      }
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
      this.daemon.setAgentWorkStatus(targetId, target.displayName, 'busy');

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

      // Track text segments between tool calls — flush text before each tool event
      let lastFlushedLength = 0;
      const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);

      const result = await dispatchToAgent(
        agentProc,
        messageContent,
        context,
        `agent:${agentProc.model.replace('openclaw:', '')}:channel-${channel.id}-${msg.id}`,
        (accumulated) => {
          this.daemon.streaming.set(targetId, {
            agentName: target.displayName,
            content: accumulated.slice(lastFlushedLength),
            channelId: channel.id,
          });
          this.daemon.events.broadcast({
            type: 'stream_token',
            agentName: target.displayName,
            channelId: channel.id,
            content: accumulated.slice(lastFlushedLength),
          });
        },
        wsClient,
        {
          onToolStart: (tool) => {
            // Flush any accumulated text BEFORE the tool event
            const streaming = this.daemon.streaming.get(targetId);
            if (streaming?.content?.trim()) {
              const segText = streaming.content.trim();
              lastFlushedLength += streaming.content.length;
              const segMsg: ChannelMessage = {
                id: generateId(),
                channelId: channel.id,
                senderId: targetId,
                threadId: msg.threadId,
                content: segText,
                kind: 'text',
                mentions: resolveMentions(segText, members),
                metadata: { source: 'router', segment: true },
                depth: msg.depth + 1,
                originId: msg.originId,
                timestamp: new Date().toISOString(),
              };
              appendMessage(msgPath, segMsg);
              this.daemon.streaming.delete(targetId);
            }
            this.daemon.events.broadcast({
              type: 'tool_start',
              agentName: target.displayName,
              channelId: channel.id,
              toolName: tool.name,
              args: tool.args,
            });
          },
          onToolEnd: (tool) => {
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
            appendMessage(msgPath, toolMsg);
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
      this.daemon.setAgentWorkStatus(targetId, target.displayName, 'idle');
      this.daemon.events.broadcast({
        type: 'stream_end',
        agentName: target.displayName,
        channelId: channel.id,
      });

      // Only the unflushed remainder goes into the final message
      const remainingContent = result.content.slice(lastFlushedLength).trim();

      // Skip if everything was already flushed via text segments
      if (!remainingContent && lastFlushedLength > 0) {
        log(`[router] ${target.displayName} — all text flushed as segments, no final message`);
        this.daemon.events.broadcast({ type: 'dispatch_end', agentName: target.displayName, channelId: channel.id });
        this.daemon.gitManager.markDirty(target.displayName);
        this.drainQueue(targetId);
        return;
      }

      // Empty response — retry up to 3 times with visible status
      if (!remainingContent && lastFlushedLength === 0) {
        const maxRetries = 3;
        const retryKey = `${msg.id}:${targetId}`;
        const attempt = (this.retryCount.get(retryKey) ?? 0) + 1;

        if (attempt <= maxRetries) {
          this.retryCount.set(retryKey, attempt);
          log(`[router] ${target.displayName} returned empty — retry ${attempt}/${maxRetries} in 5s`);

          // Write visible retry message
          const retryMsg: ChannelMessage = {
            id: generateId(),
            channelId: channel.id,
            senderId: 'system',
            threadId: msg.threadId,
            content: `${target.displayName} didn't respond. Retrying... (${attempt}/${maxRetries})`,
            kind: 'system',
            mentions: [],
            metadata: { source: 'router' },
            depth: msg.depth,
            originId: msg.originId,
            timestamp: new Date().toISOString(),
          };
          appendMessage(msgPath, retryMsg);

          // Retry after delay
          this.daemon.streaming.delete(targetId);
          this.activeDispatches.delete(target.displayName);
      this.daemon.setAgentWorkStatus(targetId, target.displayName, 'idle');
          this.daemon.events.broadcast({ type: 'dispatch_end', agentName: target.displayName, channelId: channel.id });
          // Clear dedup so retry can go through
          this.dispatched.delete(`${msg.id}:${targetId}`);
          setTimeout(() => {
            this.dispatchToTarget(msg, channel, targetId, members, sender);
          }, 5000);
          return;
        }

        // All retries exhausted
        this.retryCount.delete(retryKey);
        log(`[router] ${target.displayName} returned empty after ${maxRetries} retries — giving up`);
        const failMsg: ChannelMessage = {
          id: generateId(),
          channelId: channel.id,
          senderId: 'system',
          threadId: msg.threadId,
          content: `${target.displayName} failed to respond after ${maxRetries} attempts.`,
          kind: 'system',
          mentions: [],
          metadata: { source: 'router' },
          depth: msg.depth,
          originId: msg.originId,
          timestamp: new Date().toISOString(),
        };
        appendMessage(msgPath, failMsg);
        this.daemon.streaming.delete(targetId);
        this.activeDispatches.delete(target.displayName);
        this.daemon.setAgentWorkStatus(targetId, target.displayName, 'broken');
        this.daemon.events.broadcast({ type: 'dispatch_end', agentName: target.displayName, channelId: channel.id });
        this.daemon.gitManager.markDirty(target.displayName);
        this.drainQueue(targetId);
        return;
      }

      // Parse [thread] marker on remaining content
      const threadMarkerIdx = remainingContent.indexOf('[thread]');
      let mainContent = remainingContent;
      let threadContent: string | null = null;
      let responseThreadId = msg.threadId;

      if (threadMarkerIdx !== -1) {
        mainContent = remainingContent.slice(0, threadMarkerIdx).trim();
        threadContent = remainingContent.slice(threadMarkerIdx + '[thread]'.length).trim();
        responseThreadId = msg.threadId ?? msg.id;
        log(`[router] ${target.displayName} split response: main=${mainContent.length} chars, thread=${threadContent.length} chars`);
      }

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
      this.daemon.setAgentWorkStatus(targetId, target.displayName, 'idle');
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

      // Clear dispatch state IMMEDIATELY so TUI stops showing "Agent is working..."
      // before the response triggers new dispatches via fs.watch
      this.daemon.streaming.delete(targetId);
      this.activeDispatches.delete(target.displayName);
      this.daemon.setAgentWorkStatus(targetId, target.displayName, 'idle');
      this.daemon.events.broadcast({ type: 'stream_end', agentName: target.displayName, channelId: channel.id });
      this.daemon.events.broadcast({ type: 'dispatch_end', agentName: target.displayName, channelId: channel.id });

      // Mark corp as dirty for git commit
      this.daemon.gitManager.markDirty(target.displayName);

      // Drain queue — dispatch next waiting message for this agent
      this.drainQueue(targetId);
    } catch (err) {
      // Model fallback is now handled natively by OpenClaw via agents.defaults.model.fallbacks
      // in the gateway config (exponential backoff, profile rotation, session-sticky).
      this.daemon.streaming.delete(targetId);
      this.activeDispatches.delete(target.displayName);
      this.daemon.setAgentWorkStatus(targetId, target.displayName, 'idle');
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
