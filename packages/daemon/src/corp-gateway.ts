import { execa, type ResultPromise } from 'execa';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';
import {
  type GlobalConfig,
  readConfig,
  writeConfig,
  generateId,
  formatProviderModel,
  parseProviderModel,
} from '@claudecorp/shared';
import { log, logError } from './logger.js';

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

    // Copy auth from user's OpenClaw (source of truth for API keys)
    const userAuthPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
    if (existsSync(userAuthPath)) {
      const userAuth = readConfig<Record<string, unknown>>(userAuthPath);
      writeConfig(join(agentDir, 'auth-profiles.json'), userAuth);
    } else {
      // Fallback: try globalConfig.apiKeys
      const profiles: Record<string, unknown> = {};
      for (const [provider, key] of Object.entries(this.globalConfig.apiKeys)) {
        if (key) {
          profiles[`${provider}:default`] = { type: 'token', provider, token: key };
        }
      }
      writeConfig(join(agentDir, 'auth-profiles.json'), { version: 1, profiles });
    }
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

    // Check if a gateway is already running on our port (e.g. survived a Ctrl+C)
    if (await this.tryAdoptExisting()) {
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
      if (line) log(`[gateway] ${line}`);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) logError(`[gateway] ${line}`);
    });

    // Handle exit
    proc.then((result) => {
      if (this._status !== 'stopped' && this._status !== 'restarting') {
        this._status = 'stopped';
        logError(`[gateway] Corp gateway exited with code ${result.exitCode}`);
      }
      this.process = null;
    }).catch(() => {
      this._status = 'stopped';
      this.process = null;
    });

    // Health check
    await this.healthCheck();
    this._status = 'ready';
    this.startHealthMonitor();
    log(`[gateway] Corp gateway ready on port ${this._port} with ${this.listAgents().length} agents`);
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

  /** Check if an existing gateway is already running on our port and adopt it. */
  private async tryAdoptExisting(): Promise<boolean> {
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
      // Auth passes — adopt the running gateway
      if (resp.status < 400) {
        this._status = 'ready';
        this.startHealthMonitor();
        log(`[gateway] Adopted existing gateway on port ${this._port} with ${this.listAgents().length} agents`);
        return true;
      }
      // Something is running on our port but auth fails — kill it and respawn
      log(`[gateway] Stale gateway on port ${this._port} (status ${resp.status}), killing...`);
      await this.killPortHolder();
    } catch {
      // Port not reachable — but check if something is still holding it (Windows port release delay)
      await this.killPortHolder();
    }
    return false;
  }

  /** Kill whatever process holds our port. */
  private async killPortHolder(): Promise<void> {
    try {
      const { execa: run } = await import('execa');
      const check = await run('cmd', ['/c', `netstat -ano | findstr :${this._port} | findstr LISTENING`], { reject: false, timeout: 5000 });
      if (check.stdout) {
        const match = check.stdout.trim().match(/\s(\d+)\s*$/m);
        if (match?.[1]) {
          await run('taskkill', ['/F', '/PID', match[1]], { reject: false, timeout: 5000 });
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } catch {}
  }

  /** Periodically check if the gateway is still alive. Auto-restart if dead. */
  private startHealthMonitor(): void {
    const interval = setInterval(async () => {
      if (this._status !== 'ready') {
        clearInterval(interval);
        return;
      }
      try {
        await fetch(`http://127.0.0.1:${this._port}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this._token}`,
          },
          body: JSON.stringify({ model: 'openclaw:main', messages: [] }),
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        logError(`[gateway] Corp gateway died — auto-restarting...`);
        this._status = 'stopped';
        this.process = null;
        clearInterval(interval);
        this.autoRestart();
      }
    }, 30_000); // Check every 30s
  }

  /** Re-copy auth profiles for all registered agents (in case keys changed). */
  refreshAllAuth(): void {
    for (const agent of this.listAgents()) {
      this.writeAgentAuth(agent.id);
    }
  }

  /** Attempt to auto-restart with backoff and auth re-copy. */
  private async autoRestart(): Promise<void> {
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        // Wait with exponential backoff
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        // Re-copy auth before restart in case keys changed
        this.refreshAllAuth();
        await this.start();
        log(`[gateway] Auto-restart successful (attempt ${i + 1})`);
        return;
      } catch (err) {
        logError(`[gateway] Auto-restart attempt ${i + 1}/${maxRetries} failed: ${err}`);
      }
    }
    logError('[gateway] Auto-restart exhausted — gateway is down. Restart the TUI to recover.');
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

  /** Update the corp-wide default model. Gateway hot-reloads on config write. */
  updateDefaultModel(model: string, provider: string): void {
    if (!existsSync(this.configPath)) return;
    const config = readConfig<Record<string, unknown>>(this.configPath);
    const agents = (config.agents ?? {}) as Record<string, unknown>;
    const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
    defaults.model = { primary: formatProviderModel(provider, model) };
    agents.defaults = defaults;
    config.agents = agents;
    writeConfig(this.configPath, config);
    log(`[gateway] Default model updated to ${provider}/${model}`);
  }

  /** Set a per-agent model override. Pass null to clear override. */
  updateAgentModel(agentId: string, model: string | null, provider?: string): void {
    if (!existsSync(this.configPath)) return;
    const config = readConfig<Record<string, unknown>>(this.configPath);
    const agents = (config.agents ?? {}) as Record<string, unknown>;
    const list = (agents.list ?? []) as CorpGatewayAgent[];

    const agent = list.find(a => a.id === agentId);
    if (!agent) return;

    if (model && provider) {
      agent.model = { primary: formatProviderModel(provider, model) };
      log(`[gateway] Agent ${agentId} model set to ${provider}/${model}`);
    } else {
      delete agent.model;
      log(`[gateway] Agent ${agentId} model override cleared (using default)`);
    }

    agents.list = list;
    config.agents = agents;
    writeConfig(this.configPath, config);
  }

  /** Get current model config: corp default + per-agent overrides. */
  getModels(): { defaultModel: string; agents: { id: string; name: string; model: string | null }[] } {
    if (!existsSync(this.configPath)) {
      return { defaultModel: formatProviderModel(this.globalConfig.defaults.provider, this.globalConfig.defaults.model), agents: [] };
    }
    const config = readConfig<Record<string, unknown>>(this.configPath);
    const agents = (config.agents ?? {}) as Record<string, unknown>;
    const defaults = (agents.defaults ?? {}) as Record<string, unknown>;
    const modelObj = (defaults.model ?? {}) as Record<string, string>;
    const defaultModel = modelObj.primary ?? formatProviderModel(this.globalConfig.defaults.provider, this.globalConfig.defaults.model);

    const list = (agents.list ?? []) as CorpGatewayAgent[];
    const agentModels = list.map(a => ({
      id: a.id,
      name: a.name,
      model: a.model?.primary ?? null,
    }));

    return { defaultModel, agents: agentModels };
  }

  private buildConfig(agentsList: CorpGatewayAgent[]): Record<string, unknown> {
    const defaultModel = `${this.globalConfig.defaults.provider}/${this.globalConfig.defaults.model}`;
    return {
      agents: {
        defaults: {
          model: { primary: defaultModel },
          compaction: { mode: 'safeguard' },
          verboseDefault: 'full',
          blockStreamingDefault: 'off',
          heartbeat: {
            every: '10m',
            prompt: 'Read your HEARTBEAT.md file. It contains your current tasks and instructions. Follow them. If nothing needs attention, reply HEARTBEAT_OK.',
          },
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
