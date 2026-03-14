import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import {
  type Member,
  type Channel,
  type ChannelMessage,
  type GlobalConfig,
  readConfig,
  appendMessage,
  generateId,
  MEMBERS_JSON,
  CHANNELS_JSON,
  DAEMON_PID_PATH,
  DAEMON_PORT_PATH,
} from '@agentcorp/shared';
import { ProcessManager } from './process-manager.js';
import { dispatchToAgent, type DispatchContext } from './dispatch.js';
import { createApi } from './api.js';

export class Daemon {
  corpRoot: string;
  globalConfig: GlobalConfig;
  processManager: ProcessManager;
  private server: Server | null = null;
  private port = 0;

  constructor(corpRoot: string, globalConfig: GlobalConfig) {
    this.corpRoot = corpRoot;
    this.globalConfig = globalConfig;
    this.processManager = new ProcessManager(corpRoot, globalConfig);
  }

  async start(): Promise<number> {
    // Start HTTP API
    this.server = createApi(this);

    return new Promise((resolve, reject) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (typeof addr === 'object' && addr) {
          this.port = addr.port;
        }

        // Write PID and port files
        writeFileSync(DAEMON_PID_PATH, String(process.pid), 'utf-8');
        writeFileSync(DAEMON_PORT_PATH, String(this.port), 'utf-8');

        console.log(`[daemon] API listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });

      this.server!.on('error', reject);
    });
  }

  async spawnAllAgents(): Promise<void> {
    const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
    const agents = members.filter((m) => m.type === 'agent' && m.status !== 'archived');

    for (const agent of agents) {
      try {
        await this.processManager.spawnAgent(agent.id);
      } catch (err) {
        console.error(`[daemon] Failed to spawn ${agent.displayName}:`, err);
      }
    }
  }

  async sendMessage(
    channelId: string,
    content: string,
  ): Promise<{ userMessage: ChannelMessage; agentMessage: ChannelMessage | null }> {
    const channels = readConfig<Channel[]>(join(this.corpRoot, CHANNELS_JSON));
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) throw new Error(`Channel ${channelId} not found`);

    const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
    const founder = members.find((m) => m.rank === 'owner');
    if (!founder) throw new Error('No founder found');

    const messagesPath = join(this.corpRoot, channel.path, 'messages.jsonl');

    // Write user message
    const userMsg: ChannelMessage = {
      id: generateId(),
      channelId,
      senderId: founder.id,
      threadId: null,
      content,
      kind: 'text',
      mentions: [],
      metadata: null,
      depth: 0,
      originId: '',
      timestamp: new Date().toISOString(),
    };
    userMsg.originId = userMsg.id;
    appendMessage(messagesPath, userMsg);

    // Find which agent to dispatch to
    let targetAgent: Member | undefined;

    if (channel.kind === 'direct') {
      // DM: dispatch to the other member
      targetAgent = members.find(
        (m) => channel.memberIds.includes(m.id) && m.id !== founder.id && m.type === 'agent',
      );
    }

    if (!targetAgent) {
      return { userMessage: userMsg, agentMessage: null };
    }

    // Dispatch to agent
    const agentProc = this.processManager.getAgent(targetAgent.id);
    if (!agentProc || agentProc.status !== 'ready') {
      return { userMessage: userMsg, agentMessage: null };
    }

    try {
      // Build corp context for the agent
      const context = this.buildDispatchContext(targetAgent, channel, members);

      const result = await dispatchToAgent(
        agentProc,
        content,
        context,
        `channel-${channelId}`,
      );

      // Write agent response
      const agentMsg: ChannelMessage = {
        id: generateId(),
        channelId,
        senderId: targetAgent.id,
        threadId: null,
        content: result.content,
        kind: 'text',
        mentions: [],
        metadata: null,
        depth: 1,
        originId: userMsg.id,
        timestamp: new Date().toISOString(),
      };
      appendMessage(messagesPath, agentMsg);

      return { userMessage: userMsg, agentMessage: agentMsg };
    } catch (err) {
      console.error(`[daemon] Dispatch to ${targetAgent.displayName} failed:`, err);
      return { userMessage: userMsg, agentMessage: null };
    }
  }

  private buildDispatchContext(
    targetAgent: Member,
    channel: Channel,
    members: Member[],
  ): DispatchContext {
    // Normalize paths to forward slashes for display
    const corpRootDisplay = this.corpRoot.replace(/\\/g, '/');
    const agentDirDisplay = targetAgent.agentDir
      ? join(this.corpRoot, targetAgent.agentDir).replace(/\\/g, '/')
      : corpRootDisplay;

    // Channel members by name
    const channelMembers = channel.memberIds
      .map((id) => members.find((m) => m.id === id))
      .filter(Boolean)
      .map((m) => `${m!.displayName} (${m!.rank})`);

    // All corp members
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
    };
  }

  async stop(): Promise<void> {
    await this.processManager.stopAll();
    if (this.server) {
      this.server.close();
    }
    // Clean up PID/port files
    try { unlinkSync(DAEMON_PID_PATH); } catch {}
    try { unlinkSync(DAEMON_PORT_PATH); } catch {}
  }

  getPort(): number {
    return this.port;
  }
}

export function isDaemonRunning(): { running: boolean; port: number | null } {
  try {
    if (!existsSync(DAEMON_PID_PATH) || !existsSync(DAEMON_PORT_PATH)) {
      return { running: false, port: null };
    }
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const pid = parseInt(readFileSync(DAEMON_PID_PATH, 'utf-8').trim(), 10);
    const port = parseInt(readFileSync(DAEMON_PORT_PATH, 'utf-8').trim(), 10);

    // Check if process is alive
    try {
      process.kill(pid, 0);
      return { running: true, port };
    } catch {
      return { running: false, port: null };
    }
  } catch {
    return { running: false, port: null };
  }
}
