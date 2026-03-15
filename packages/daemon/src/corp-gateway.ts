import { execa, type ResultPromise } from 'execa';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import {
  type GlobalConfig,
  readConfig,
  writeConfig,
  generateId,
} from '@agentcorp/shared';

export interface CorpGatewayAgent {
  id: string;
  name: string;
  workspace: string;
  agentDir?: string;
  model?: { primary: string };
}

export class CorpGateway {
  private corpRoot: string;
  private globalConfig: GlobalConfig;
  private gatewayDir: string;
  private configPath: string;
  private _port: number;
  private _token: string;
  private process: ResultPromise | null = null;
  private _status: 'stopped' | 'starting' | 'ready' | 'restarting' = 'stopped';

  constructor(corpRoot: string, globalConfig: GlobalConfig) {
    this.corpRoot = corpRoot;
    this.globalConfig = globalConfig;
    this.gatewayDir = join(corpRoot, '.gateway');
    this.configPath = join(this.gatewayDir, 'openclaw.json');
    // Allocate port from the top of the range (CEO local fallback uses bottom)
    this._port = globalConfig.daemon.portRange[0];
    this._token = generateId() + generateId();
  }

  getPort(): number { return this._port; }
  getToken(): string { return this._token; }
  getStatus(): string { return this._status; }

  /** Create .gateway/ dir and write initial openclaw.json if it doesn't exist. */
  initialize(): void {
    mkdirSync(this.gatewayDir, { recursive: true });

    if (existsSync(this.configPath)) {
      // Read existing config to preserve port and token
      const existing = readConfig<Record<string, unknown>>(this.configPath);
      const gw = existing.gateway as Record<string, unknown> | undefined;
      if (gw?.port) this._port = gw.port as number;
      const auth = gw?.auth as Record<string, unknown> | undefined;
      if (auth?.token) this._token = auth.token as string;
      return;
    }

    const config = this.buildConfig([]);
    writeConfig(this.configPath, config);
  }

  /** Add an agent to agents.list and write its auth-profiles. */
  addAgent(agent: CorpGatewayAgent): void {
    const config = readConfig<Record<string, unknown>>(this.configPath);
    const agents = (config.agents ?? {}) as Record<string, unknown>;
    const list = (agents.list ?? []) as CorpGatewayAgent[];

    // Don't duplicate
    if (list.some((a) => a.id === agent.id)) return;

    list.push(agent);
    agents.list = list;
    config.agents = agents;
    writeConfig(this.configPath, config);

    // Write auth-profiles for this agent
    this.writeAgentAuth(agent.id);
  }

  /** Remove an agent from agents.list. */
  removeAgent(agentId: string): void {
    const config = readConfig<Record<string, unknown>>(this.configPath);
    const agents = (config.agents ?? {}) as Record<string, unknown>;
    const list = (agents.list ?? []) as CorpGatewayAgent[];

    agents.list = list.filter((a) => a.id !== agentId);
    config.agents = agents;
    writeConfig(this.configPath, config);
  }

  /** Write auth-profiles.json for a specific agent into the gateway state dir. */
  private writeAgentAuth(agentId: string): void {
    const agentDir = join(this.gatewayDir, 'agents', agentId, 'agent');
    mkdirSync(agentDir, { recursive: true });

    // Write auth for all configured providers
    const profiles: Record<string, unknown> = {};
    for (const [provider, key] of Object.entries(this.globalConfig.apiKeys)) {
      if (key) {
        profiles[`${provider}:default`] = {
          type: 'token',
          provider,
          token: key,
        };
      }
    }

    writeConfig(join(agentDir, 'auth-profiles.json'), {
      version: 1,
      profiles,
    });
  }

  /** Check if any agents are registered. */
  hasAgents(): boolean {
    if (!existsSync(this.configPath)) return false;
    const config = readConfig<Record<string, unknown>>(this.configPath);
    const agents = (config.agents ?? {}) as Record<string, unknown>;
    const list = (agents.list ?? []) as unknown[];
    return list.length > 0;
  }

  /** List current agents in the config. */
  listAgents(): CorpGatewayAgent[] {
    if (!existsSync(this.configPath)) return [];
    const config = readConfig<Record<string, unknown>>(this.configPath);
    const agents = (config.agents ?? {}) as Record<string, unknown>;
    return (agents.list ?? []) as CorpGatewayAgent[];
  }

  /** Start the gateway process. */
  async start(): Promise<void> {
    if (this._status === 'ready' || this._status === 'starting') return;
    if (!this.hasAgents()) {
      console.log('[gateway] No agents registered, skipping start');
      return;
    }

    this._status = 'starting';

    const normalizedStateDir = this.gatewayDir.replace(/\\/g, '/');

    const proc = execa('openclaw', [
      'gateway', 'run',
      '--port', String(this._port),
      '--bind', 'loopback',
      '--allow-unconfigured',
    ], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: normalizedStateDir,
      },
      stdio: 'pipe',
      reject: false,
    });

    this.process = proc;

    // Log output
    proc.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.log(`[gateway] ${line}`);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.error(`[gateway] ${line}`);
    });

    // Handle exit
    proc.then((result) => {
      if (this._status !== 'stopped' && this._status !== 'restarting') {
        this._status = 'stopped';
        console.error(`[gateway] Corp gateway exited with code ${result.exitCode}`);
      }
      this.process = null;
    }).catch(() => {
      this._status = 'stopped';
      this.process = null;
    });

    // Health check
    await this.healthCheck();
    this._status = 'ready';
    console.log(`[gateway] Corp gateway ready on port ${this._port} with ${this.listAgents().length} agents`);
  }

  /** Stop the gateway process. */
  async stop(): Promise<void> {
    const prev = this._status;
    if (prev !== 'restarting') this._status = 'stopped';

    if (this.process) {
      this.process.kill('SIGTERM');
      const timeout = setTimeout(() => {
        if (this.process) this.process.kill('SIGKILL');
      }, 5000);
      try {
        await this.process;
      } catch {
        // Expected
      }
      clearTimeout(timeout);
      this.process = null;
    }
  }

  /** Restart the gateway (stop + start). */
  async restart(): Promise<void> {
    this._status = 'restarting';
    await this.stop();
    this._status = 'stopped';
    await this.start();
  }

  private async healthCheck(): Promise<void> {
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const resp = await fetch(`http://127.0.0.1:${this._port}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this._token}`,
          },
          body: JSON.stringify({ model: 'openclaw:main', messages: [] }),
          signal: AbortSignal.timeout(2000),
        });
        if (resp.status < 500) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Corp gateway failed to start on port ${this._port}`);
  }

  private buildConfig(agentsList: CorpGatewayAgent[]): Record<string, unknown> {
    const defaultModel = `${this.globalConfig.defaults.provider}/${this.globalConfig.defaults.model}`;
    return {
      agents: {
        defaults: {
          model: { primary: defaultModel },
          compaction: { mode: 'safeguard' },
          blockStreamingDefault: 'on',
        },
        list: agentsList,
      },
      gateway: {
        port: this._port,
        mode: 'local',
        bind: 'loopback',
        auth: { mode: 'token', token: this._token },
        http: {
          endpoints: {
            chatCompletions: { enabled: true },
          },
        },
      },
    };
  }
}
