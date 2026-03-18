import { execa, type ResultPromise } from 'execa';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  type Member,
  type GlobalConfig,
  readConfig,
  writeConfig,
  MEMBERS_JSON,
} from '@agentcorp/shared';
import { CorpGateway } from './corp-gateway.js';
import { log, logError } from './logger.js';

export type AgentProcessStatus = 'starting' | 'ready' | 'stopped' | 'crashed';

export interface AgentProcess {
  memberId: string;
  displayName: string;
  port: number;
  status: AgentProcessStatus;
  gatewayToken: string;
  process: ResultPromise | null;
  /** 'remote' = CEO on user's OpenClaw, 'gateway' = worker on shared corp gateway, 'local' = standalone process */
  mode: 'local' | 'remote' | 'gateway';
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
  corpGateway: CorpGateway | null = null;
  /** Callback for CEO stdout — tool call forwarding */
  onCeoOutput: ((line: string) => void) | null = null;

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

  /** Initialize the shared corp gateway. Call before spawnAgent(). */
  async initCorpGateway(): Promise<void> {
    const gw = new CorpGateway(this.corpRoot, this.globalConfig);
    gw.initialize();
    this.corpGateway = gw;

    // Reserve the gateway port from the allocation pool
    this.nextPort = gw.getPort() + 1;

    // Populate agents.list from existing non-CEO agent members
    const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
    const workers = members.filter(
      (m) => m.type === 'agent' && m.rank !== 'master' && m.status !== 'archived' && m.agentDir,
    );

    for (const worker of workers) {
      const agentName = worker.agentDir!.replace(/^agents\//, '').replace(/\/$/, '');
      const workspace = join(this.corpRoot, worker.agentDir!).replace(/\\/g, '/');
      const agentDir = join(this.corpRoot, '.gateway', 'agents', agentName, 'agent').replace(/\\/g, '/');

      gw.addAgent({
        id: agentName,
        name: worker.displayName,
        workspace,
        agentDir,
      });
    }

    // Start the gateway if there are agents
    if (gw.hasAgents()) {
      await gw.start();
    }
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

    // CEO (rank master) with user's OpenClaw → spawn from ~/.openclaw (own the process)
    if (member.rank === 'master' && this.globalConfig.userGateway) {
      return this.spawnCeoFromUserConfig(memberId, member);
    }

    // CEO without user's OpenClaw → local fallback
    if (member.rank === 'master') {
      const agentAbsDir = join(this.corpRoot, member.agentDir);
      const openclawStateDir = join(agentAbsDir, '.openclaw');
      return this.spawnLocalAgent(memberId, member, agentAbsDir, openclawStateDir, gatewayToken);
    }

    // All other agents → shared corp gateway
    return this.registerGatewayAgent(memberId, member);
  }

  /** Register an agent that runs on the shared corp gateway. */
  registerGatewayAgent(memberId: string, member?: Member): AgentProcess {
    if (!this.corpGateway) {
      throw new Error('Corp gateway not initialized. Call initCorpGateway() first.');
    }

    if (!member) {
      const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
      member = members.find((m) => m.id === memberId);
      if (!member) throw new Error(`Member ${memberId} not found`);
    }

    const agentName = member.agentDir!.replace(/^agents\//, '').replace(/\/$/, '');

    const agentProc: AgentProcess = {
      memberId,
      displayName: member.displayName,
      port: this.corpGateway.getPort(),
      status: this.corpGateway.getStatus() === 'ready' ? 'ready' : 'starting',
      gatewayToken: this.corpGateway.getToken(),
      process: null,
      mode: 'gateway',
      model: `openclaw:${agentName}`,
    };

    this.agents.set(memberId, agentProc);
    return agentProc;
  }

  /** Spawn the CEO by taking over the user's OpenClaw gateway process.
   *  Kills the existing gateway, respawns from ~/.openclaw so we own the process
   *  and can pipe stdout for tool call streaming. Same personal AI, same config. */
  private async spawnCeoFromUserConfig(memberId: string, member: Member): Promise<AgentProcess> {
    const gw = this.globalConfig.userGateway;
    if (!gw) {
      throw new Error(`No user OpenClaw gateway detected`);
    }

    const openclawHome = join(homedir(), '.openclaw').replace(/\\/g, '/');

    // Force-kill the existing gateway so we can take over the port
    log(`[daemon] Stopping existing OpenClaw gateway to take over port ${gw.port}...`);
    try {
      await execa('openclaw', ['gateway', 'stop'], { reject: false, timeout: 5000 });
      await new Promise((r) => setTimeout(r, 1000));

      // Check if port still in use — force kill the PID
      try {
        const check = await execa('cmd', ['/c', `netstat -ano | findstr :${gw.port} | findstr LISTENING`], { reject: false, timeout: 5000 });
        if (check.stdout) {
          const match = check.stdout.trim().match(/\s(\d+)\s*$/m);
          if (match?.[1]) {
            log(`[daemon] Force-killing old gateway PID ${match[1]} on port ${gw.port}`);
            await execa('taskkill', ['/F', '/PID', match[1]], { reject: false, timeout: 5000 });
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      } catch {}

      // Remove scheduled task to prevent auto-restart
      await execa('schtasks', ['/End', '/TN', 'OpenClaw Gateway'], { reject: false, timeout: 3000 }).catch(() => {});
      await execa('schtasks', ['/Delete', '/TN', 'OpenClaw Gateway', '/F'], { reject: false, timeout: 3000 }).catch(() => {});
    } catch {
      // Best effort
    }

    const agentProc: AgentProcess = {
      memberId,
      displayName: member.displayName,
      port: gw.port,
      status: 'starting',
      gatewayToken: gw.token,
      process: null,
      mode: 'local',
      model: 'openclaw:main',
    };

    this.agents.set(memberId, agentProc);

    // Spawn from user's OpenClaw config — same personal AI, we just own the process
    const proc = execa(this.openclawBinary, [
      'gateway', 'run',
      '--port', String(gw.port),
      '--bind', 'loopback',
      '--allow-unconfigured',
    ], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: openclawHome,
      },
      stdio: 'pipe',
      reject: false,
    });

    agentProc.process = proc;

    // Pipe stdout — this is how tool calls get into the chat
    proc.stdout?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        log(`[CEO] ${line}`);
        if (this.onCeoOutput) this.onCeoOutput(line);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) logError(`[CEO] ${line}`);
    });

    // Health check
    try {
      await this.healthCheck(agentProc, 30);
      log(`[daemon] CEO spawned from ~/.openclaw on port ${gw.port}`);
    } catch {
      agentProc.status = 'crashed';
      logError(`[daemon] CEO failed to start from ~/.openclaw on port ${gw.port}`);
      throw new Error(`CEO failed to start from ~/.openclaw on port ${gw.port}`);
    }

    // Handle exit
    proc.then((result) => {
      if (agentProc.status !== 'stopped') {
        agentProc.status = 'crashed';
        logError(`[daemon] CEO exited with code ${result.exitCode}`);
      }
      agentProc.process = null;
    }).catch(() => {
      agentProc.status = 'crashed';
      agentProc.process = null;
    });

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

    const normalizedStateDir = openclawStateDir.replace(/\\/g, '/');

    const openclawConfigPath = join(openclawStateDir, 'openclaw.json');
    const ocConfig = readConfig<Record<string, unknown>>(openclawConfigPath);
    const gw = (ocConfig.gateway ?? {}) as Record<string, unknown>;
    gw.port = port;
    ocConfig.gateway = gw;
    writeConfig(openclawConfigPath, ocConfig);

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

    proc.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.log(`[${member.displayName}] ${line}`);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.error(`[${member.displayName}] ${line}`);
    });

    this.updateMemberPort(memberId, port);

    this.healthCheck(agentProc, 30).catch(() => {
      agentProc.status = 'crashed';
    });

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
    // Stop the corp gateway process
    if (this.corpGateway) {
      await this.corpGateway.stop();
    }
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
