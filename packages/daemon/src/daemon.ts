import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
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
  MESSAGES_JSONL,
  DAEMON_PID_PATH,
  DAEMON_PORT_PATH,
} from '@claudecorp/shared';
import { ProcessManager } from './process-manager.js';
import { MessageRouter } from './router.js';
import { GitManager } from './git-manager.js';
import { HeartbeatManager } from './heartbeat.js';
import { TaskWatcher } from './task-watcher.js';
import { createApi } from './api.js';

export class Daemon {
  corpRoot: string;
  globalConfig: GlobalConfig;
  processManager: ProcessManager;
  router: MessageRouter;
  gitManager: GitManager;
  heartbeat: HeartbeatManager;
  taskWatcher: TaskWatcher;
  readonly startedAt: number = Date.now();
  /** Per-agent partial streaming content — updated as SSE tokens arrive. */
  streaming = new Map<string, { agentName: string; content: string; channelId: string }>();
  private server: Server | null = null;
  private port = 0;

  constructor(corpRoot: string, globalConfig: GlobalConfig) {
    this.corpRoot = corpRoot;
    this.globalConfig = globalConfig;
    this.processManager = new ProcessManager(corpRoot, globalConfig);
    this.router = new MessageRouter(this);
    this.gitManager = new GitManager(corpRoot);
    this.heartbeat = new HeartbeatManager(this);
    this.taskWatcher = new TaskWatcher(this);
  }

  async start(): Promise<number> {
    // Kill any stale daemon from a previous session (prevents double dispatch)
    await this.killStaleDaemon();

    // Ensure .gateway/ is gitignored (older corps may lack this)
    this.ensureGatewayGitignored();

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

  /** Start the router, git manager, heartbeat, and task watcher */
  startRouter(): void {
    this.router.start();
    this.gitManager.start();
    this.heartbeat.start();
    this.taskWatcher.start();
  }

  async spawnAllAgents(): Promise<void> {
    // Initialize the shared corp gateway — if it fails, CEO may still work via remote
    try {
      await this.processManager.initCorpGateway();
    } catch (err) {
      console.error(`[daemon] Corp gateway init failed (agents may start later):`, err);
    }

    let members: Member[];
    try {
      members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
    } catch (err) {
      console.error(`[daemon] Failed to read members.json:`, err);
      return;
    }

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
  ): Promise<{ message: ChannelMessage; dispatching: boolean; dispatchTargets: string[] }> {
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
      metadata: { source: 'user' },
      depth: 0,
      originId: '',
      timestamp: new Date().toISOString(),
    };
    userMsg.originId = userMsg.id;
    appendMessage(messagesPath, userMsg);

    // Mark for git commit
    this.gitManager.markDirty(founder.displayName);

    // Predict which agents the router will dispatch to
    const dispatchTargets: string[] = [];
    if (channel.kind === 'direct') {
      const otherId = channel.memberIds.find((id) => id !== founder.id);
      if (otherId) {
        const other = members.find((m) => m.id === otherId);
        const proc = this.processManager.getAgent(otherId);
        if (other && proc && proc.status === 'ready') {
          dispatchTargets.push(other.displayName);
        }
      }
    } else {
      const mentionedIds = resolveMentions(content, members);
      for (const id of mentionedIds) {
        const m = members.find((mem) => mem.id === id);
        if (!m || m.type !== 'agent') continue;
        const proc = this.processManager.getAgent(id);
        if (proc && proc.status === 'ready') {
          dispatchTargets.push(m.displayName);
        }
      }
    }

    return { message: userMsg, dispatching: dispatchTargets.length > 0, dispatchTargets };
  }

  async stop(): Promise<void> {
    this.heartbeat.stop();
    this.taskWatcher.stop();
    this.router.stop();
    await this.gitManager.stop();
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

  /** Kill any daemon left over from a previous session. */
  private async killStaleDaemon(): Promise<void> {
    try {
      if (!existsSync(DAEMON_PID_PATH)) return;
      const oldPid = parseInt(readFileSync(DAEMON_PID_PATH, 'utf-8').trim(), 10);
      if (!oldPid || oldPid === process.pid) return;

      console.log(`[daemon] Killing stale daemon (PID ${oldPid})...`);

      // Try SIGTERM first (works same-process-tree)
      try { process.kill(oldPid, 'SIGTERM'); } catch {}

      // On Windows, also use taskkill (works cross-process-tree)
      if (process.platform === 'win32') {
        try {
          const { execa: run } = await import('execa');
          await run('taskkill', ['/F', '/PID', String(oldPid)], { reject: false, timeout: 5000 });
        } catch {}
      }

      // Wait for it to die
      await new Promise((r) => setTimeout(r, 1500));

      // Clean up stale files
      try { unlinkSync(DAEMON_PID_PATH); } catch {}
      try { unlinkSync(DAEMON_PORT_PATH); } catch {}
    } catch {}
  }

  /** Get formatted uptime string like "12m 34s" or "1h 5m 12s" */
  getUptime(): string {
    const ms = Date.now() - this.startedAt;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  /** Count total messages across all channel JSONL files */
  countAllMessages(): number {
    let total = 0;
    try {
      const channelsDir = join(this.corpRoot, 'channels');
      if (!existsSync(channelsDir)) return 0;
      const dirs = readdirSync(channelsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const msgPath = join(channelsDir, dir.name, MESSAGES_JSONL);
        try {
          const content = readFileSync(msgPath, 'utf-8');
          const lines = content.trim().split('\n').filter((l: string) => l.trim());
          total += lines.length;
        } catch {
          // File doesn't exist or empty
        }
      }
    } catch {
      // channels dir doesn't exist
    }
    return total;
  }

  /** Get uptime info for API endpoint */
  getUptimeInfo(): { uptime: string; totalMessages: number; startedAt: number } {
    return {
      uptime: this.getUptime(),
      totalMessages: this.countAllMessages(),
      startedAt: this.startedAt,
    };
  }

  /** Patch .gitignore to exclude .gateway/ if not already present. */
  private ensureGatewayGitignored(): void {
    try {
      const gitignorePath = join(this.corpRoot, '.gitignore');
      if (!existsSync(gitignorePath)) return;
      const content = readFileSync(gitignorePath, 'utf-8');
      if (!content.includes('.gateway/')) {
        writeFileSync(gitignorePath, content.trimEnd() + '\n\n# Corp gateway runtime state\n.gateway/\n', 'utf-8');
      }
    } catch {}
  }
}

export function isDaemonRunning(): { running: boolean; port: number | null } {
  try {
    if (!existsSync(DAEMON_PID_PATH) || !existsSync(DAEMON_PORT_PATH)) {
      return { running: false, port: null };
    }
    const pid = parseInt(readFileSync(DAEMON_PID_PATH, 'utf-8').trim(), 10);
    const port = parseInt(readFileSync(DAEMON_PORT_PATH, 'utf-8').trim(), 10);

    // Check if process is alive (works same-process-tree on all platforms)
    try {
      process.kill(pid, 0);
      return { running: true, port };
    } catch {
      // On Windows, process.kill(pid, 0) fails across process trees.
      // Fall back to checking if the port is actually responding.
      if (process.platform === 'win32' && port > 0) {
        return { running: true, port }; // Trust the port file; HTTP call will verify
      }
      return { running: false, port: null };
    }
  } catch {
    return { running: false, port: null };
  }
}
