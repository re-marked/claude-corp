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
  resolveMentions,
  MEMBERS_JSON,
  CHANNELS_JSON,
  DAEMON_PID_PATH,
  DAEMON_PORT_PATH,
} from '@agentcorp/shared';
import { ProcessManager } from './process-manager.js';
import { MessageRouter } from './router.js';
import { createApi } from './api.js';

export class Daemon {
  corpRoot: string;
  globalConfig: GlobalConfig;
  processManager: ProcessManager;
  router: MessageRouter;
  private server: Server | null = null;
  private port = 0;

  constructor(corpRoot: string, globalConfig: GlobalConfig) {
    this.corpRoot = corpRoot;
    this.globalConfig = globalConfig;
    this.processManager = new ProcessManager(corpRoot, globalConfig);
    this.router = new MessageRouter(this);
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

  /** Start the router after all agents are spawned */
  startRouter(): void {
    this.router.start();
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

  /**
   * Write a user message to a channel. Returns immediately.
   * The router will pick it up via fs.watch and dispatch to agents.
   * Returns the message + whether an agent dispatch is expected.
   */
  async sendMessage(
    channelId: string,
    content: string,
  ): Promise<{ message: ChannelMessage; dispatching: boolean }> {
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

    // Predict whether the router will dispatch to an agent
    let dispatching = false;
    if (channel.kind === 'direct') {
      // DM: will dispatch if the other member is a ready agent
      const otherId = channel.memberIds.find((id) => id !== founder.id);
      if (otherId) {
        const proc = this.processManager.getAgent(otherId);
        dispatching = !!(proc && proc.status === 'ready');
      }
    } else {
      // Non-DM: will dispatch if @mentions resolve to ready agents
      const mentionedIds = resolveMentions(content, members);
      dispatching = mentionedIds.some((id) => {
        const m = members.find((mem) => mem.id === id);
        if (!m || m.type !== 'agent') return false;
        const proc = this.processManager.getAgent(id);
        return proc && proc.status === 'ready';
      });
    }

    return { message: userMsg, dispatching };
  }

  async stop(): Promise<void> {
    this.router.stop();
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
