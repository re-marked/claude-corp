export class DaemonClient {
  private baseUrl: string;

  constructor(port: number) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async status(): Promise<{ ok: boolean; agents: { memberId: string; displayName: string; port: number; status: string }[] }> {
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

  async sendMessage(channelId: string, content: string): Promise<{ dispatching: boolean }> {
    const resp = await fetch(`${this.baseUrl}/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, content }),
    });
    const data = await resp.json() as { dispatching?: boolean };
    return { dispatching: data.dispatching ?? false };
  }
}
