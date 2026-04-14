import { type ResultPromise } from 'execa';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  type Member,
  type Corporation,
  type GlobalConfig,
  readConfig,
  writeConfig,
  MEMBERS_JSON,
  CORP_JSON,
} from '@claudecorp/shared';
import { CorpGateway } from './corp-gateway.js';
import { log, logError } from './logger.js';

/**
 * Resolve the corp-wide default harness from corp.json. Returns the
 * raw value (e.g. 'claude-code', 'openclaw') or undefined when the
 * field isn't set or the file is unreadable. Callers combine this with
 * per-member harness to decide routing.
 */
function readCorpDefaultHarness(corpRoot: string): string | undefined {
  try {
    const corp = readConfig<Corporation>(join(corpRoot, CORP_JSON));
    return corp.harness;
  } catch {
    return undefined;
  }
}

export type AgentProcessStatus = 'starting' | 'ready' | 'stopped' | 'crashed';

/**
 * Extract agent slug from agentDir path.
 * Handles both corp-scoped (agents/<name>/) and project-scoped (projects/<proj>/agents/<name>/) paths.
 */
export function extractAgentSlug(agentDir: string): string {
  const parts = agentDir.replace(/\/$/, '').split('/');
  return parts[parts.length - 1]!;
}

export interface AgentProcess {
  memberId: string;
  displayName: string;
  port: number;
  status: AgentProcessStatus;
  gatewayToken: string;
  process: ResultPromise | null;
  /**
   * 'remote' = CEO on user's OpenClaw, 'gateway' = worker on shared corp
   * gateway, 'local' = standalone process, 'harness' = dispatched
   * directly through an AgentHarness (e.g., claude-code) with no
   * persistent process or gateway port.
   */
  mode: 'local' | 'remote' | 'gateway' | 'harness';
  /** Model identifier for dispatch (e.g. 'openclaw:main', 'openclaw:hr-manager', 'claude-code') */
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

    // Resolve corp-level harness default once. Per-agent member.harness
    // wins; the corp default is the fallback. Anything that isn't openclaw
    // routes through its own harness (no gateway involvement) and is
    // skipped here entirely.
    const corpHarness = readCorpDefaultHarness(this.corpRoot);

    const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
    const workers = members.filter(
      (m) => m.type === 'agent' && m.status !== 'archived' && m.agentDir,
    );

    let openclawCount = 0;
    for (const worker of workers) {
      // Skip non-openclaw agents — they don't need a gateway slot. Spawning
      // the OpenClaw process tree just to register a claude-code agent
      // wastes a port + ~50MB RSS + adds startup latency, all for an
      // entry the dispatch path will never read.
      const harness = worker.harness ?? corpHarness;
      if (harness && harness !== 'openclaw') continue;

      const agentName = extractAgentSlug(worker.agentDir!);
      const workspace = join(this.corpRoot, worker.agentDir!).replace(/\\/g, '/');
      const agentDir = join(this.corpRoot, '.gateway', 'agents', agentName, 'agent').replace(/\\/g, '/');

      // Read agent config for model override (e.g., Planner uses Opus)
      let modelOverride: { primary: string } | undefined;
      try {
        const agentConfig = readConfig<{ model?: string; provider?: string }>(
          join(this.corpRoot, worker.agentDir!, 'config.json'),
        );
        const defaultModel = this.globalConfig.defaults.model;
        if (agentConfig.model && agentConfig.model !== defaultModel) {
          const provider = agentConfig.provider ?? this.globalConfig.defaults.provider;
          modelOverride = { primary: `${provider}/${agentConfig.model}` };
        }
      } catch {}

      gw.addAgent({
        id: agentName,
        name: worker.displayName,
        workspace,
        agentDir,
        model: modelOverride,
      });
      openclawCount++;
    }

    // Only start the gateway if at least one agent actually needs it.
    // Future hires of openclaw agents go through hire.ts which calls
    // gw.start() lazily when status === 'stopped'.
    if (openclawCount > 0 && gw.hasAgents()) {
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

    // Resolve effective harness: per-member > corp default > 'openclaw'.
    // Non-openclaw agents (claude-code, future harnesses) don't need a
    // gateway slot — they dispatch through their own harness directly,
    // so we register them in the agents map as 'harness' mode and skip
    // the gateway registration path entirely.
    const corpHarness = readCorpDefaultHarness(this.corpRoot);
    const harness = member.harness ?? corpHarness ?? 'openclaw';
    if (harness !== 'openclaw') {
      return this.registerHarnessAgent(memberId, member, harness);
    }
    return this.registerGatewayAgent(memberId, member);
  }

  /**
   * Register an agent that runs through an AgentHarness directly (no
   * gateway, no listening port, no spawned process). The dispatch path
   * just looks up the agent by id, finds 'ready' status, and the
   * HarnessRouter delegates to the configured harness.
   */
  registerHarnessAgent(memberId: string, member: Member, harness: string): AgentProcess {
    const agentProc: AgentProcess = {
      memberId,
      displayName: member.displayName,
      port: 0,
      status: 'ready',
      gatewayToken: '',
      process: null,
      mode: 'harness',
      model: harness,
    };
    this.agents.set(memberId, agentProc);
    return agentProc;
  }

  /** Register an agent that runs on the shared corp gateway. */
  registerGatewayAgent(memberId: string, member?: Member): AgentProcess {
    if (!this.corpGateway) {
      // Gateway not ready yet — register with stopped status, will become ready when gateway starts
      if (!member) {
        const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
        member = members.find((m) => m.id === memberId);
        if (!member) throw new Error(`Member ${memberId} not found`);
      }
      const agentName = extractAgentSlug(member.agentDir!);
      const agentProc: AgentProcess = {
        memberId,
        displayName: member.displayName,
        port: 0,
        status: 'stopped',
        gatewayToken: '',
        process: null,
        mode: 'gateway',
        model: `openclaw:${agentName}`,
      };
      this.agents.set(memberId, agentProc);
      return agentProc;
    }

    if (!member) {
      const members = readConfig<Member[]>(join(this.corpRoot, MEMBERS_JSON));
      member = members.find((m) => m.id === memberId);
      if (!member) throw new Error(`Member ${memberId} not found`);
    }

    const agentName = extractAgentSlug(member.agentDir!);

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

  // connectRemoteAgent and spawnLocalAgent removed in v0.16.6 —
  // all agents now use the corp gateway with per-agent model overrides.

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
