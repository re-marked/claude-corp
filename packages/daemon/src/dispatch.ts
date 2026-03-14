import type { AgentProcess } from './process-manager.js';

export interface DispatchResult {
  content: string;
  model: string;
}

export async function dispatchToAgent(
  agent: AgentProcess,
  message: string,
  sessionUser?: string,
): Promise<DispatchResult> {
  const url = `http://127.0.0.1:${agent.port}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model: agent.model,
    messages: [{ role: 'user', content: message }],
  };

  // Use stable session key for conversation continuity
  if (sessionUser) {
    body.user = sessionUser;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${agent.gatewayToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Agent ${agent.displayName} returned ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as {
    choices: { message: { content: string } }[];
    model: string;
  };

  const content = data.choices?.[0]?.message?.content ?? '';
  return { content, model: data.model ?? 'unknown' };
}
