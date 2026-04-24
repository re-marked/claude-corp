import { watch, type FSWatcher, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Member,
  type Channel,
  type ChannelMessage,
  readConfig,
  readNewLines,
  getFileSize,
  tailMessages,
  post,
  resolveMentions,
  generateId,
  detectFeedback,
  agentSessionKey,
  createInboxItem,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
  MAX_DEPTH,
} from '@claudecorp/shared';
import { type DispatchContext } from './dispatch.js';
import type { Daemon } from './daemon.js';
import { formatToolMessage } from './format-tool.js';
import { log, logError } from './logger.js';

export class MessageRouter {
  private watchers = new Map<string, FSWatcher>();
  private offsets = new Map<string, number>();
  private dispatched = new Set<string>();
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

    // Register dedup cleanup as a Clock
    this.dedupClearInterval = this.daemon.clocks.register({
      id: 'dedup-cleanup',
      name: 'Dedup Cleanup',
      type: 'system',
      intervalMs: 5 * 60 * 1000,
      target: 'router',
      description: 'Clears dispatch dedup sets to prevent memory growth and allow re-dispatch',
      callback: () => { this.dispatched.clear(); this.processedMsgIds.clear(); },
    });

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

  /** Force-process a channel's messages (bypasses fs.watch — for Windows reliability). */
  pokeChannel(channelId: string): void {
    const channels = this.loadChannels();
    const channel = channels.find(c => c.id === channelId);
    if (!channel) return;
    const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);
    if (!existsSync(msgPath)) return;
    // Ensure we're watching this channel
    if (!this.watchers.has(channel.id)) {
      this.watchChannel(channel);
      // For newly watched channels, reset offset to 0 so we read ALL existing messages
      // (watchChannel defaults to end-of-file, which would skip the message that triggered the poke)
      this.offsets.set(msgPath, 0);
    }
    this.onFileChange(channel, msgPath);
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
    // Skip Jack-mode messages — already dispatched via say() with persistent session
    const meta = msg.metadata as Record<string, unknown> | null;
    if (meta?.source === 'jack') return;

    // Handle /uptime slash command
    if (msg.kind === 'text' && msg.content.trim() === '/uptime') {
      const uptime = this.daemon.getUptime();
      const totalMessages = this.daemon.countAllMessages();
      const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);
      post(channel.id, msgPath, {
        senderId: 'system',
        content: `⏱ Uptime: ${uptime} | 📨 Messages: ${totalMessages} total across all channels`,
        source: 'router',
        kind: 'system',
        threadId: msg.threadId,
        originId: msg.originId || msg.id,
      });
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
      // DM: auto-route to the agent member in this channel
      // For system messages (task dispatch, etc.), senderId='system' is NOT a channel member.
      // So we find the agent member directly, not "the other member".
      const agentMember = channel.memberIds
        .map(id => members.find(m => m.id === id))
        .find(m => m && m.type === 'agent' && m.id !== msg.senderId);
      if (agentMember) {
        targetIds = [agentMember.id];
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

    log(`[router] @mentions in msg ${msg.id}: ${targetIds.join(', ')} (from ${senderOrSystem.displayName})`);

    // Emit inbox-item chits for each target BEFORE dispatch. Runs
    // regardless of online/offline status so the chit-store always
    // reflects "who was notified about what," and 0.7.3's audit gate
    // can read the same data. Per REFACTOR.md 0.7.4:
    //   - DM channel from the founder → Tier 3 (critical)
    //   - DM channel from an agent    → Tier 2 (direct)
    //   - @mention in shared channel  → Tier 2 (peer-level, by convention)
    //   - 'all'-mode broadcasts       → skip (would spam every agent's
    //                                   inbox on every channel chatter)
    // Failures are non-fatal — dispatch continues even if chit creation
    // throws, so one bad write never blocks an @mention from reaching
    // its target.
    if (channelMode !== 'all') {
      for (const targetId of targetIds) {
        try {
          const isFounder = senderOrSystem.type === 'user';
          const isDmChannel = channelMode === 'dm';
          const tier = isFounder && isDmChannel ? 3 : 2;
          const subject = (msg.content ?? '').split(/\r?\n/)[0]!.slice(0, 80) || '(no content)';
          createInboxItem({
            corpRoot: this.daemon.corpRoot,
            recipient: targetId,
            tier,
            from: senderOrSystem.id,
            subject,
            source: isDmChannel ? 'dm' : 'channel',
            sourceRef: channel.name,
            references: [`${channel.name}:${msg.id}`],
          });
        } catch (err) {
          logError(
            `[router] inbox-item chit creation failed for ${targetId}: ${(err as Error).message}`,
          );
        }
      }
    }

    // ALL @mentions → immediate dispatch, regardless of sender type.
    // Previously agent→agent mentions were routed to the inbox to wait
    // for the next heartbeat (~3min latency), to prevent runaway loops
    // where A pings B, B pings A back, A pings B... User experience:
    // Mark @mentions Failsafe in #general, Failsafe responds with
    // @Herald — and Herald just sits silent for 3 minutes. Felt broken.
    //
    // Loop protection moves from system enforcement to agent training:
    // rules.ts now teaches agents to take action after a clarification
    // exchange instead of pinging back. The depth guard (MAX_DEPTH) at
    // the top of this function remains as a hard backstop if an agent
    // pair ignores the rule.
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

    // Cooldown removed — agent→agent @mentions used to be gated by
    // COOLDOWN_MS as a loop dampener. We now trust agents to follow
    // the rule (rules.ts → "Mentioning other agents") which says:
    // don't ping back unless you genuinely need more from them. The
    // depth guard at the top of dispatchMentions remains as a hard
    // backstop if an agent pair runs away.
    const agentProc = this.daemon.processManager.getAgent(targetId);
    if (!agentProc || agentProc.status !== 'ready') {
      // Target offline / starting / crashed — can't dispatch right now.
      // Fall back to inbox so the mention isn't silently lost: the
      // agent will pick it up on its next pulse heartbeat once it's
      // back online. Only do this for non-self mentions to avoid
      // recording an agent's own outgoing chatter into its own inbox.
      if (targetId !== msg.senderId) {
        const target = members.find(m => m.id === targetId);
        this.daemon.inbox.recordMessage(channel.id, channel.name, targetId, true, sender.displayName);
        log(`[router] ${target?.displayName ?? targetId} offline — mention queued in inbox`);
      }
      return;
    }

    // Queue if agent is busy (one dispatch at a time per agent)
    if (this.activeDispatches.has(agentProc.displayName)) {
      const queue = this.dispatchQueue.get(targetId) ?? [];
      queue.push({ msg, channel, targetId, members, sender });
      this.dispatchQueue.set(targetId, queue);
      log(`[router] ${agentProc.displayName} busy — queued dispatch from ${sender.displayName} (${queue.length} waiting)`);
      return;
    }

    const target = members.find((m) => m.id === targetId);
    if (!target) return;

    // Load recent channel history for context — thread-aware
    const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);
    const allRecent = tailMessages(msgPath, 100);

    // Feedback capture: if the founder just sent this message and it
    // matches a correction/confirmation pattern, stamp the agent's
    // .pending-feedback.md. Dreams consume the file during their next
    // reflection cycle — agent work stays uninterrupted, but the
    // correction doesn't evaporate with the session.
    this.maybeCaptureFeedback(msg, target, sender, channel, allRecent);
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

    // Resolve sessionKey upfront so buildContext can scope the usage
    // snapshot lookup to THIS session (Codex P2, PR #170).
    const routerSessionKey = agentSessionKey(target.displayName);

    // Build context with history
    const context = this.buildContext(target, channel, members, recentHistory, routerSessionKey);

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

      // Track text segments between tool calls — flush text before each tool event
      let lastFlushedLength = 0;
      const msgPath = join(this.daemon.corpRoot, channel.path, MESSAGES_JSONL);
      // Cache tool args from start events — end events often lack args
      const toolArgsCache = new Map<string, Record<string, unknown>>();
      // Per-dispatch turn id stamped on every text segment + tool event.
      // The TUI groups consecutive same-sender messages with the same
      // turnId into a single bubble (one header, multiple inline rows)
      // so a multi-segment claude turn doesn't render as N disjoint
      // timestamped messages.
      const turnId = generateId();

      // Session key is deterministic per agent + channel so consecutive
      // @mentions in the same channel accumulate into ONE continuing
      // conversation — the agent remembers prior mentions in that
      // channel, tools it already ran, what it was working on. The
      // previous `channel-${id}-${msg.id}` key minted a brand-new
      // claude session for every single mention, so each @mention
      // started from zero. Now agent-global (one brain per agent) —
      // the agent's @mention replies share memory with its DM thread,
      // crons, loops, dreams, and heartbeats. Collapsing scoping
      // surfaces the one-brain principle: same agent, same memory,
      // regardless of how the turn got triggered.
      log(`[router] DISPATCHING to ${target.displayName} for msg ${msg.id.slice(0,8)} from ${sender.displayName}`);
      const result = await this.daemon.harness.dispatch({
        agentId: agentProc.memberId,
        message: messageContent,
        sessionKey: routerSessionKey,
        context,
        callbacks: {
          onToken: (accumulated) => {
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
          // Cache tool args from start events — end events often don't include them
          onToolStart: (tool) => {
            // Cache args by toolCallId so onToolEnd can use them
            if (tool.toolCallId && tool.args) {
              toolArgsCache.set(tool.toolCallId, tool.args);
            }

            // Flush any accumulated text BEFORE the tool event
            const streaming = this.daemon.streaming.get(targetId);
            if (streaming?.content?.trim()) {
              const segText = streaming.content.trim();
              lastFlushedLength += streaming.content.length;
              post(channel.id, msgPath, {
                senderId: targetId,
                content: segText,
                source: 'router',
                threadId: msg.threadId,
                mentions: resolveMentions(segText, members),
                depth: msg.depth + 1,
                originId: msg.originId,
                metadata: { segment: true, turnId },
              });
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
            // Use cached args from start event if end event doesn't have them
            const args = tool.args ?? toolArgsCache.get(tool.toolCallId);
            toolArgsCache.delete(tool.toolCallId); // Clean up

            post(channel.id, msgPath, {
              senderId: targetId,
              content: formatToolMessage(tool.name, args),
              source: 'router',
              kind: 'tool_event',
              threadId: msg.threadId,
              depth: msg.depth + 1,
              originId: msg.originId,
              metadata: {
                toolName: tool.name,
                toolCallId: tool.toolCallId,
                toolArgs: args,
                toolResult: tool.result
                  ? (typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result)).slice(0, 300)
                  : undefined,
                turnId,
              },
            });
            this.daemon.events.broadcast({
              type: 'tool_end',
              agentName: target.displayName,
              channelId: channel.id,
              toolName: tool.name,
            });
          },
          onUsage: (usage, model) => {
            // Record per-(agent, session) token count for Project 1.7
            // pre-compact signal. Fires on message_start (early) +
            // message_delta (final); latest wins. sessionKey scope keeps
            // concurrent flows from clobbering each other's token state.
            this.daemon.recordAgentUsage(targetId, routerSessionKey, usage, model);
          },
        },
      });

      this.daemon.streaming.delete(targetId);
      this.activeDispatches.delete(target.displayName);
      this.daemon.setAgentWorkStatus(targetId, target.displayName, 'idle');
      this.daemon.events.broadcast({
        type: 'stream_end',
        agentName: target.displayName,
        channelId: channel.id,
      });

      // Clean retry counter on successful dispatch (prevents slow map leak)
      this.retryCount.delete(`${msg.id}:${targetId}`);

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
          post(channel.id, msgPath, {
            senderId: 'system',
            content: `${target.displayName} didn't respond. Retrying... (${attempt}/${maxRetries})`,
            source: 'router',
            kind: 'system',
            threadId: msg.threadId,
            depth: msg.depth,
            originId: msg.originId,
          });

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
        post(channel.id, msgPath, {
          senderId: 'system',
          content: `${target.displayName} failed to respond after ${maxRetries} attempts.`,
          source: 'router',
          kind: 'system',
          threadId: msg.threadId,
          depth: msg.depth,
          originId: msg.originId,
        });
        this.daemon.streaming.delete(targetId);
        this.activeDispatches.delete(target.displayName);
        this.daemon.setAgentWorkStatus(targetId, target.displayName, 'broken');
        this.daemon.analytics.trackError(targetId);
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
        log(`[router] WRITING ${target.displayName}'s threaded response (${threadContent.length} chars)`);
        const responseMsg = post(channel.id, msgPath, {
          senderId: targetId,
          content: threadContent,
          source: 'router',
          threadId: responseThreadId,
          mentions: resolveMentions(threadContent, members),
          depth: msg.depth + 1,
          originId: msg.originId,
          metadata: { turnId },
        });

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
      log(`[router] WRITING ${target.displayName}'s response (${mainContent.length} chars) "${mainContent.substring(0, 80)}"`);
      post(channel.id, msgPath, {
        senderId: targetId,
        content: mainContent,
        source: 'router',
        threadId: msg.threadId,
        mentions: resolveMentions(mainContent, members),
        depth: msg.depth + 1,
        originId: msg.originId,
        metadata: { turnId },
      });

      // Write thread portion as a separate message if it exists
      if (threadContent && mainContent) {
        post(channel.id, msgPath, {
          senderId: targetId,
          content: threadContent,
          source: 'router',
          threadId: responseThreadId,
          mentions: resolveMentions(threadContent, members),
          depth: msg.depth + 1,
          originId: msg.originId,
          metadata: { turnId },
        });
        log(`[router] WRITING ${target.displayName}'s thread reply (${threadContent.length} chars)`);
      }

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
      // Dispatch failed — track error in analytics
      this.daemon.analytics.trackError(targetId);
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

  // formatToolMessage extracted to format-tool.ts (shared with api.ts)

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
    sessionKey: string = agentSessionKey(targetAgent.displayName),
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

    const lastUsage = this.daemon.getLastAgentUsage(targetAgent.id, sessionKey);

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
      agentKind: targetAgent.kind,
      agentRole: targetAgent.role,
      agentDisplayName: targetAgent.displayName,
      channelKind: channel.kind,
      supervisorName,
      autoemonEnrolled: this.daemon.autoemon.isEnrolled(targetAgent.id),
      harness: this.resolveHarness(targetAgent),
      sessionTokens: lastUsage?.usage.inputTokens,
      sessionModel: lastUsage?.model,
    };
  }

  private resolveHarness(agent: Member): 'openclaw' | 'claude-code' {
    if (agent.harness === 'claude-code') return 'claude-code';
    const proc = this.daemon.processManager.getAgent(agent.id);
    return proc?.mode === 'harness' ? 'claude-code' : 'openclaw';
  }

  /**
   * If the incoming message is a founder correction or confirmation
   * targeted at this agent, append an entry to the agent's
   * `.pending-feedback.md` file. Dreams consume the file during their
   * next reflection cycle — the agent's current turn stays
   * uninterrupted.
   *
   * Rules:
   * - Only founder-authored messages (rank: owner). Agent-to-agent
   *   corrections stay in-conversation; they don't compound into BRAIN.
   * - Only when detectFeedback() matches. Conservative regex catches
   *   clear signal; dreams handle interpretation from the quote.
   * - One entry per founder message (timestamped). Multiple corrections
   *   between dreams accumulate as separate entries in the same file.
   */
  private maybeCaptureFeedback(
    msg: ChannelMessage,
    target: Member,
    sender: Member,
    channel: Channel,
    recent: ChannelMessage[],
  ): void {
    if (sender.rank !== 'owner') return;
    if (!target.agentDir) return;

    const match = detectFeedback(msg.content ?? '');
    if (!match) return;

    // Find the agent's most recent text message before this one —
    // gives dreams the context of what the agent just did/said that
    // prompted the correction.
    const priorAgentMsg = recent
      .filter(m => m.senderId === target.id && m.kind === 'text' && m.timestamp < msg.timestamp)
      .slice(-1)[0];
    const priorContext = priorAgentMsg
      ? `Your message at ${new Date(priorAgentMsg.timestamp).toISOString().slice(11, 19)}: "${(priorAgentMsg.content ?? '').slice(0, 200)}${(priorAgentMsg.content ?? '').length > 200 ? '...' : ''}"`
      : '(no recent agent message before this correction)';

    const feedbackPath = join(this.daemon.corpRoot, target.agentDir, '.pending-feedback.md');
    const entryTime = new Date(msg.timestamp).toISOString();
    const channelLabel = channel.kind === 'direct' ? `DM (${channel.name})` : `#${channel.name}`;

    // Build the entry — rich enough for a dream to write a meaningful
    // observation, not just "Mark said don't."
    const entry = [
      '',
      `## ${entryTime}`,
      '',
      `**Channel:** ${channelLabel}`,
      `**Signal:** ${match.polarity} (matched: ${match.matchedPatterns.slice(0, 5).join(', ')}${match.matchedPatterns.length > 5 ? `, +${match.matchedPatterns.length - 5} more` : ''})`,
      '',
      '**Quote:**',
      '> ' + (msg.content ?? '').replace(/\n/g, '\n> '),
      '',
      '**Prior context:**',
      priorContext,
      '',
      '---',
      '',
    ].join('\n');

    // Create header on first entry
    const header = existsSync(feedbackPath) ? '' : [
      '# Pending Feedback',
      '',
      'Corrections and confirmations captured from the founder. Consumed and cleared during your next dream cycle.',
      '',
      '---',
    ].join('\n');

    try {
      appendFileSync(feedbackPath, header + entry, 'utf-8');
      log(`[router] Captured ${match.polarity} feedback for ${target.displayName} (${match.matchedPatterns.length} pattern(s))`);
    } catch (err) {
      logError(`[router] Failed to write pending-feedback for ${target.displayName}: ${err}`);
    }
  }
}
