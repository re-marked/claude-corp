import { execa, type ResultPromise } from 'execa';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  type Member,
  type GlobalConfig,
  readConfig,
  writeConfig,
  MEMBERS_JSON,
} from '@agentcorp/shared';

export type AgentProcessStatus = 'starting' | 'ready' | 'stopped' | 'crashed';

export interface AgentProcess {
  memberId: string;
  displayName: string;
  port: number;
  status: AgentProcessStatus;
  gatewayToken: string;
  process: ResultPromise | null;
  /** 'remote' = connected to external gateway (e.g. CEO on user's OpenClaw), 'local' = daemon-spawned */
  mode: 'local' | 'remote';
  /** Model identifier for dispatch (e.g. 'openclaw:main', 'openclaw:hr-manager') */
  model: string;
}

export class ProcessManager {
  private agents = new Map<string, AgentProcess>();
  private nextPort: number;
  private portMax: number;
  private corpRoot: string;
  private globalConfig: GlobalConfig;
  private openclawBinary: string;

  constructor(corpRoot: string, globalConfig: GlobalConfig) {
    this.corpRoot = corpRoot;
    this.globalConfig = globalConfig;
    this.nextPort = globalConfig.daemon.portRange[0];
    this.portMax = globalConfig.daemon.portRange[1];
    this.openclawBinary = 'openclaw';
  }

  private allocatePort(): number {
    const usedPorts = new Set([...this.agents.values()].map((a) => a.port));
    let port = this.nextPort;
    while (usedPorts.has(port) && port <= this.portMax) {
      port++;
    }
    if (port > this.portMax) {
      throw new Error(`No available ports in range ${this.nextPort}-${this.portMax}`);
    }
    this.nextPort = port + 1;
    return port;
  }

  async spawnAgent(memberId: string, gatewayToken?: string): Promise<AgentProcess> {
    if (this.agents.has(memberId)) {
      const existing = this.agents.get(memberId)!;
      if (existing.status === 'ready' || existing.status === 'starting') {
        return existing;
      }
    }

    // Read member info
    const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
    const member = members.find((m) => m.id === memberId);
    if (!member) throw new Error(`Member ${memberId} not found`);
    if (member.type !== 'agent') throw new Error(`Member ${memberId} is not an agent`);
    if (!member.agentDir) throw new Error(`Member ${memberId} has no agentDir`);

    const agentAbsDir = join(this.corpRoot, member.agentDir);
    const openclawStateDir = join(agentAbsDir, '.openclaw');

    // Detect remote agents: no .openclaw/openclaw.json means they use an external gateway
    const isRemote = !existsSync(join(openclawStateDir, 'openclaw.json'));

    if (isRemote) {
      return this.connectRemoteAgent(memberId, member);
    }

    return this.spawnLocalAgent(memberId, member, agentAbsDir, openclawStateDir, gatewayToken);
  }

  private async connectRemoteAgent(memberId: string, member: Member): Promise<AgentProcess> {
    const gw = this.globalConfig.userGateway;
    if (!gw) {
      throw new Error(`Agent ${member.displayName} is remote but no user OpenClaw gateway detected`);
    }

    const agentProc: AgentProcess = {
      memberId,
      displayName: member.displayName,
      port: gw.port,
      status: 'starting',
      gatewayToken: gw.token,
      process: null,
      mode: 'remote',
      model: 'openclaw:main',
    };

    this.agents.set(memberId, agentProc);

    // Health check the user's gateway
    try {
      await this.healthCheck(agentProc, 5); // 5 attempts, not 30
      console.log(`[daemon] CEO connected to OpenClaw gateway on port ${gw.port}`);
    } catch {
      agentProc.status = 'crashed';
      throw new Error(
        `Cannot reach OpenClaw gateway at 127.0.0.1:${gw.port}. ` +
        'Make sure OpenClaw is running: openclaw gateway run',
      );
    }

    return agentProc;
  }

  private async spawnLocalAgent(
    memberId: string,
    member: Member,
    agentAbsDir: string,
    openclawStateDir: string,
    gatewayToken?: string,
  ): Promise<AgentProcess> {
    const port = this.allocatePort();

    // Read gateway token from openclaw config if not provided
    if (!gatewayToken) {
      const openclawConfig = readConfig<{ gateway: { auth: { token: string } } }>(
        join(openclawStateDir, 'openclaw.json'),
      );
      gatewayToken = openclawConfig.gateway.auth.token;
    }

    const agentProc: AgentProcess = {
      memberId,
      displayName: member.displayName,
      port,
      status: 'starting',
      gatewayToken,
      process: null,
      mode: 'local',
      model: 'openclaw:main',
    };

    this.agents.set(memberId, agentProc);

    // Normalize paths to forward slashes (OpenClaw on Windows/MSYS2 needs this)
    const normalizedStateDir = openclawStateDir.replace(/\\/g, '/');

    // Write allocated port into openclaw.json (CLI --port flag is ignored when config exists)
    const openclawConfigPath = join(openclawStateDir, 'openclaw.json');
    const ocConfig = readConfig<Record<string, unknown>>(openclawConfigPath);
    const gw = (ocConfig.gateway ?? {}) as Record<string, unknown>;
    gw.port = port;
    ocConfig.gateway = gw;
    writeConfig(openclawConfigPath, ocConfig);

    // Spawn OpenClaw gateway
    const proc = execa(this.openclawBinary, [
      'gateway', 'run',
      '--port', String(port),
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

    agentProc.process = proc;

    // Capture stdout/stderr for debugging
    proc.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.log(`[${member.displayName}] ${line}`);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.error(`[${member.displayName}] ${line}`);
    });

    // Update member port in members.json
    this.updateMemberPort(memberId, port);

    // Health check
    this.healthCheck(agentProc, 30).catch(() => {
      agentProc.status = 'crashed';
    });

    // Handle process exit
    proc.then((result) => {
      if (agentProc.status !== 'stopped') {
        agentProc.status = 'crashed';
        console.error(`[daemon] Agent ${member.displayName} exited with code ${result.exitCode}`);
        if (result.stderr) {
          console.error(`[daemon] stderr: ${result.stderr}`);
        }
      }
      agentProc.process = null;
      this.updateMemberPort(memberId, null);
    }).catch(() => {
      agentProc.status = 'crashed';
      agentProc.process = null;
    });

    return agentProc;
  }

  private async healthCheck(agent: AgentProcess, maxAttempts: number): Promise<void> {
    const interval = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const resp = await fetch(`http://127.0.0.1:${agent.port}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${agent.gatewayToken}`,
          },
          body: JSON.stringify({
            model: agent.model,
            messages: [],
          }),
          signal: AbortSignal.timeout(2000),
        });
        // Any response means the server is up (even 400 for empty messages)
        if (resp.status < 500) {
          agent.status = 'ready';
          return;
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    throw new Error(`Agent ${agent.displayName} failed health check after ${maxAttempts} attempts`);
  }

  async stopAgent(memberId: string): Promise<void> {
    const agent = this.agents.get(memberId);
    if (!agent) return;

    agent.status = 'stopped';

    // Only kill process for locally spawned agents
    if (agent.mode === 'local' && agent.process) {
      agent.process.kill('SIGTERM');
      const timeout = setTimeout(() => {
        if (agent.process) agent.process.kill('SIGKILL');
      }, 5000);
      try {
        await agent.process;
      } catch {
        // Expected
      }
      clearTimeout(timeout);
    }

    this.agents.delete(memberId);
    if (agent.mode === 'local') {
      this.updateMemberPort(memberId, null);
    }
  }

  getAgent(memberId: string): AgentProcess | undefined {
    return this.agents.get(memberId);
  }

  listAgents(): AgentProcess[] {
    return [...this.agents.values()];
  }

  async stopAll(): Promise<void> {
    const ids = [...this.agents.keys()];
    await Promise.all(ids.map((id) => this.stopAgent(id)));
  }

  private updateMemberPort(memberId: string, port: number | null): void {
    try {
      const membersPath = join(this.corpRoot, MEMBERS_JSON);
      const members = readConfig<Member[]>(membersPath);
      const member = members.find((m) => m.id === memberId);
      if (member) {
        member.port = port;
        member.status = port ? 'active' : 'idle';
        writeConfig(membersPath, members);
      }
    } catch {
      // Non-fatal
    }
  }
}
