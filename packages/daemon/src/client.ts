export class DaemonClient {
  private baseUrl: string;

  constructor(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async status(): Promise<{ ok: boolean; corpRoot: string; agents: { memberId: string; displayName: string; port: number; status: string }[] }> {
    const resp = await fetch(`${this.baseUrl}/status`);
    return resp.json() as Promise<any>;
  }

  async listAgents(): Promise<{ memberId: string; displayName: string; port: number; status: string }[]> {
    const resp = await fetch(`${this.baseUrl}/agents`);
    return resp.json() as Promise<any>;
  }

  async startAgent(memberId: string): Promise<{ ok: boolean; port: number; status: string }> {
    const resp = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(memberId)}/start`, {
      method: 'POST',
    });
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

  async sendMessage(channelId: string, content: string): Promise<{ dispatching: boolean; dispatchTargets: string[] }> {
    const resp = await fetch(`${this.baseUrl}/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, content }),
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
}
