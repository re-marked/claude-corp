export class DaemonClient {
  private baseUrl: string;

  constructor(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  /** Generic GET request to any daemon API path. */
  async get(path: string): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}${path}`);
    return resp.json();
  }

  /** Generic POST request to any daemon API path. */
  async post(path: string, body?: Record<string, unknown>): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return resp.json();
  }

  async status(): Promise<{ ok: boolean; corpRoot: string; agents: { memberId: string; displayName: string; port: number; status: string }[] }> {
    const resp = await fetch(`${this.baseUrl}/status`);
    return resp.json() as Promise<any>;
  }

  async listAgents(): Promise<{ memberId: string; displayName: string; port: number; status: string; workStatus?: string; harness?: string }[]> {
    const resp = await fetch(`${this.baseUrl}/agents`);
    return resp.json() as Promise<any>;
  }

  async startAgent(memberId: string): Promise<{ ok: boolean; port: number; status: string }> {
    const resp = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(memberId)}/start`, {
      method: 'POST',
    });
    return resp.json() as Promise<any>;
  }

  async restartAgent(memberId: string): Promise<{ ok: boolean; status: string }> {
    const resp = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(memberId)}/restart`, { method: 'POST' });
    return resp.json() as Promise<any>;
  }

  async stopAgent(memberId: string): Promise<{ ok: boolean }> {
    const resp = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(memberId)}/stop`, {
      method: 'POST',
    });
    return resp.json() as Promise<any>;
  }

  async hireAgent(opts: {
    creatorId: string;
    agentName: string;
    displayName: string;
    rank: string;
    scope?: string;
    scopeId?: string;
    soulContent?: string;
    model?: string;
    provider?: string;
  }): Promise<{ ok: boolean; member: unknown; dmChannel: unknown }> {
    const resp = await fetch(`${this.baseUrl}/agents/hire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return resp.json() as Promise<any>;
  }

  async createTask(opts: {
    title: string;
    description?: string;
    priority?: string;
    acceptanceCriteria?: string[];
    assignedTo?: string;
    createdBy: string;
  }): Promise<{ ok: boolean; task: unknown }> {
    const resp = await fetch(`${this.baseUrl}/tasks/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return resp.json() as Promise<any>;
  }

  async listTasks(filter?: { status?: string; assignedTo?: string }): Promise<{ id: string; title: string; status: string; priority: string; assignedTo: string | null; createdBy: string }[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.assignedTo) params.set('assignedTo', filter.assignedTo);
    const resp = await fetch(`${this.baseUrl}/tasks?${params}`);
    return resp.json() as Promise<any>;
  }

  async createProject(opts: {
    name: string;
    type: string;
    path?: string;
    lead?: string;
    description?: string;
    createdBy: string;
  }): Promise<{ ok: boolean; project: unknown }> {
    const resp = await fetch(`${this.baseUrl}/projects/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return resp.json() as Promise<any>;
  }

  async listProjects(): Promise<unknown[]> {
    const resp = await fetch(`${this.baseUrl}/projects`);
    return resp.json() as Promise<any>;
  }

  async createTeam(opts: {
    projectId: string;
    name: string;
    description?: string;
    leaderId: string;
    createdBy: string;
  }): Promise<{ ok: boolean; team: unknown }> {
    const resp = await fetch(`${this.baseUrl}/teams/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return resp.json() as Promise<any>;
  }

  async listTeams(projectId?: string): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    const resp = await fetch(`${this.baseUrl}/teams?${params}`);
    return resp.json() as Promise<any>;
  }

  async sendMessage(channelId: string, content: string, senderId?: string): Promise<{ dispatching: boolean; dispatchTargets: string[] }> {
    const resp = await fetch(`${this.baseUrl}/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, content, senderId }),
    });
    const data = await resp.json() as { dispatching?: boolean; dispatchTargets?: string[] };
    return { dispatching: data.dispatching ?? false, dispatchTargets: data.dispatchTargets ?? [] };
  }

  async getUptime(): Promise<{ uptime: string; totalMessages: number; startedAt: number }> {
    const resp = await fetch(`${this.baseUrl}/uptime`);
    return resp.json() as Promise<{ uptime: string; totalMessages: number; startedAt: number }>;
  }

  async getStreaming(): Promise<Record<string, { agentName: string; content: string; channelId: string }>> {
    const resp = await fetch(`${this.baseUrl}/streaming`);
    return resp.json() as Promise<Record<string, { agentName: string; content: string; channelId: string }>>;
  }

  async getGitLog(count = 20): Promise<{ hash: string; message: string; date: string }[]> {
    const resp = await fetch(`${this.baseUrl}/git/log?count=${count}`);
    return resp.json() as Promise<{ hash: string; message: string; date: string }[]>;
  }

  async showGitCommit(hash: string): Promise<{ detail: string }> {
    const resp = await fetch(`${this.baseUrl}/git/show/${hash}`);
    return resp.json() as Promise<{ detail: string }>;
  }

  async rewindTo(hash: string): Promise<{ result: string }> {
    const resp = await fetch(`${this.baseUrl}/git/rewind/${hash}`, { method: 'POST' });
    return resp.json() as Promise<{ result: string }>;
  }

  async forward(): Promise<{ result: string }> {
    const resp = await fetch(`${this.baseUrl}/git/forward`, { method: 'POST' });
    return resp.json() as Promise<{ result: string }>;
  }

  // --- Model management ---

  async getModels(): Promise<{
    corpDefault: { model: string; provider: string };
    fallbackChain: string[];
    agents: { id: string; name: string; model: string | null }[];
    availableModels: { id: string; provider: string; alias: string; displayName: string }[];
  }> {
    const resp = await fetch(`${this.baseUrl}/models`);
    return resp.json() as Promise<any>;
  }

  async setDefaultModel(model: string, provider = 'anthropic'): Promise<{ ok: boolean; model: string; provider: string }> {
    const resp = await fetch(`${this.baseUrl}/models/default`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, provider }),
    });
    return resp.json() as Promise<any>;
  }

  async setAgentModel(agentName: string, model: string, provider = 'anthropic'): Promise<{ ok: boolean }> {
    const resp = await fetch(`${this.baseUrl}/models/agent/${encodeURIComponent(agentName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, provider }),
    });
    return resp.json() as Promise<any>;
  }

  async clearAgentModel(agentName: string): Promise<{ ok: boolean }> {
    const resp = await fetch(`${this.baseUrl}/models/agent/${encodeURIComponent(agentName)}`, {
      method: 'DELETE',
    });
    return resp.json() as Promise<any>;
  }

  async setFallbackChain(chain: string[]): Promise<{ ok: boolean }> {
    const resp = await fetch(`${this.baseUrl}/models/fallback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain }),
    });
    return resp.json() as Promise<any>;
  }

  // --- Channel management ---

  async updateChannel(channelId: string, updates: { name?: string; mode?: string }): Promise<{ ok: boolean; channel: unknown }> {
    const resp = await fetch(`${this.baseUrl}/channels/${encodeURIComponent(channelId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    return resp.json() as Promise<any>;
  }

  // --- Contracts ---

  async createContract(opts: Record<string, unknown>): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/contracts/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return resp.json() as Promise<any>;
  }

  async listContracts(project?: string, status?: string): Promise<any[]> {
    const params = new URLSearchParams();
    if (project) params.set('project', project);
    if (status) params.set('status', status);
    const resp = await fetch(`${this.baseUrl}/contracts?${params}`);
    return resp.json() as Promise<any>;
  }

  async getContract(project: string, id: string): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/contracts/${encodeURIComponent(project)}/${encodeURIComponent(id)}`);
    return resp.json() as Promise<any>;
  }

  async updateContract(project: string, id: string, updates: Record<string, unknown>): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/contracts/${encodeURIComponent(project)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    return resp.json() as Promise<any>;
  }

  // --- Analytics ---

  async getAnalytics(): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/analytics`);
    return resp.json() as Promise<any>;
  }

  async getCorpStats(): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/analytics/stats`);
    return resp.json() as Promise<any>;
  }

  // --- Clocks ---

  async listClocks(): Promise<any[]> {
    const resp = await fetch(`${this.baseUrl}/clocks`);
    return resp.json() as Promise<any>;
  }

  async getClock(id: string): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/clocks/${encodeURIComponent(id)}`);
    return resp.json() as Promise<any>;
  }

  async pauseClock(id: string): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/clocks/${encodeURIComponent(id)}/pause`, { method: 'POST' });
    return resp.json() as Promise<any>;
  }

  async resumeClock(id: string): Promise<any> {
    const resp = await fetch(`${this.baseUrl}/clocks/${encodeURIComponent(id)}/resume`, { method: 'POST' });
    return resp.json() as Promise<any>;
  }

  // --- Hand (task assignment) ---

  async handTask(taskId: string, toSlug: string): Promise<{ ok: boolean; task: unknown; handedTo: string }> {
    const resp = await fetch(`${this.baseUrl}/tasks/${encodeURIComponent(taskId)}/hand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: toSlug }),
    });
    return resp.json() as Promise<any>;
  }

  // --- Loops & Crons ---

  async createPlan(opts: { goal: string; type?: 'sketch' | 'plan'; agent?: string; channelId?: string; projectName?: string }): Promise<{ ok: boolean; planId?: string; planPath?: string; planType?: string; verb?: string; author?: string; response?: string; error?: string }> {
    const resp = await fetch(`${this.baseUrl}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return resp.json() as Promise<any>;
  }

  async triggerDream(agentSlug: string): Promise<{ ok: boolean; summary?: string; error?: string }> {
    const resp = await fetch(`${this.baseUrl}/dream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agentSlug }),
    });
    return resp.json() as Promise<any>;
  }

  async createLoop(opts: { interval: string; command: string; targetAgent?: string; name?: string; maxRuns?: number; channelId?: string; taskId?: string }): Promise<{ ok: boolean; loop: any }> {
    const resp = await fetch(`${this.baseUrl}/loops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return resp.json() as Promise<any>;
  }

  async createCron(opts: { schedule: string; command: string; targetAgent?: string; name?: string; maxRuns?: number; channelId?: string; spawnTask?: boolean; taskTitle?: string; assignTo?: string; taskPriority?: string }): Promise<{ ok: boolean; cron: any }> {
    const resp = await fetch(`${this.baseUrl}/crons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return resp.json() as Promise<any>;
  }

  async completeClock(slug: string): Promise<{ ok: boolean }> {
    const resp = await fetch(`${this.baseUrl}/clocks/${encodeURIComponent(slug)}/complete`, { method: 'POST' });
    return resp.json() as Promise<any>;
  }

  async dismissClock(slug: string): Promise<{ ok: boolean }> {
    const resp = await fetch(`${this.baseUrl}/clocks/${encodeURIComponent(slug)}/dismiss`, { method: 'POST' });
    return resp.json() as Promise<any>;
  }

  async deleteClock(slug: string): Promise<{ ok: boolean }> {
    const resp = await fetch(`${this.baseUrl}/clocks/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    return resp.json() as Promise<any>;
  }

  // --- cc say (direct agent-to-agent) ---

  async say(agentSlug: string, message: string, sessionKey?: string, channelId?: string): Promise<{ ok: boolean; from: string; response: string }> {
    const payload: Record<string, string> = { target: agentSlug, message };
    if (sessionKey) payload.sessionKey = sessionKey;
    if (channelId) payload.channelId = channelId;
    const resp = await fetch(`${this.baseUrl}/cc/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return resp.json() as Promise<any>;
  }
}
