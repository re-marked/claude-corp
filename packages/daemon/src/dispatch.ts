import type { AgentProcess } from './process-manager.js';
import { log, logError } from './logger.js';
import { composeSystemMessage, type FragmentContext } from './fragments/index.js';
import type { OpenClawWS, AgentEvent } from './openclaw-ws.js';

/** Context for agent dispatch — passed to the fragment compositor. */
export type DispatchContext = FragmentContext;

export interface DispatchResult {
  content: string;
  model: string;
}

export interface ToolCallInfo {
  name: string;
  toolCallId: string;
  args?: Record<string, unknown>;
}

export interface DispatchCallbacks {
  onToken?: (accumulated: string) => void;
  onToolStart?: (tool: ToolCallInfo) => void;
  onToolEnd?: (tool: ToolCallInfo & { result?: string }) => void;
  onLifecycle?: (phase: string) => void;
}

// --- WebSocket-based dispatch (preferred — gives tool events) ---

export async function dispatchViaWebSocket(
  ws: OpenClawWS,
  agent: AgentProcess,
  message: string,
  context: DispatchContext,
  sessionKey: string,
  callbacks: DispatchCallbacks = {},
): Promise<DispatchResult> {
  const systemMessage = composeSystemMessage(context);
  const fullMessage = `[System instructions — do not repeat these]\n${systemMessage}\n\n[User message]\n${message}`;

  log(`[dispatch] >>> WS chat.send to ${agent.displayName} (session ${sessionKey})`);

  const { runId } = await ws.chatSend({
    sessionKey,
    message: fullMessage,
    idempotencyKey: `dispatch-${sessionKey}-${Date.now()}`,
  });

  log(`[dispatch] Run started: ${runId}`);

  return new Promise((resolve, reject) => {
    let accumulated = '';
    let model = agent.model;
    let resolved = false;

    const cleanup = () => {
      unsubAgent();
      unsubChat();
    };

    // Listen for agent events (tool calls, lifecycle)
    const unsubAgent = ws.onAgentEvent(runId, (event: AgentEvent) => {
      if (event.stream === 'assistant') {
        const delta = (event.data as any).delta ?? (event.data as any).text ?? '';
        if (typeof delta === 'string' && delta) {
          accumulated += delta;
          callbacks.onToken?.(accumulated);
        }
      }

      if (event.stream === 'tool') {
        const data = event.data as any;
        const toolInfo: ToolCallInfo = {
          name: data.name ?? data.toolName ?? 'unknown',
          toolCallId: data.toolCallId ?? data.id ?? '',
          args: data.args ?? data.input,
        };

        const phase = data.phase ?? data.type ?? '';
        log(`[dispatch] Tool event: ${toolInfo.name} phase=${phase}`);

        if (phase === 'start' || phase === 'call') {
          callbacks.onToolStart?.(toolInfo);
        }
        if (phase === 'end' || phase === 'result' || phase === 'complete' || phase === 'done') {
          callbacks.onToolEnd?.({ ...toolInfo, result: data.result ?? data.output });
        }

        // If no phase distinction, treat every tool event as start+end
        // (OpenClaw might send a single event per tool call)
        if (!phase) {
          callbacks.onToolStart?.(toolInfo);
          callbacks.onToolEnd?.(toolInfo);
        }
      }

      if (event.stream === 'lifecycle') {
        const phase = (event.data as any).phase as string;
        callbacks.onLifecycle?.(phase);

        if (phase === 'end' && !resolved) {
          resolved = true;
          cleanup();
          resolve({ content: accumulated, model });
        }
        if (phase === 'error' && !resolved) {
          resolved = true;
          cleanup();
          const errMsg = (event.data as any).error ?? 'Agent run failed';
          reject(new Error(String(errMsg)));
        }
      }
    });

    // Listen for chat events (text deltas via chat stream)
    // Use the agent's name from model (openclaw:lead-coder → lead-coder, openclaw:main → main)
    const agentName = agent.model.replace('openclaw:', '') || 'main';
    const agentSessionKey = `agent:${agentName}:${sessionKey}`;
    const unsubChat = ws.onChatEvent(agentSessionKey, (event) => {
      if (event.state === 'final' && !resolved) {
        resolved = true;
        cleanup();
        resolve({ content: accumulated, model });
      }
      if (event.state === 'error' && !resolved) {
        resolved = true;
        cleanup();
        reject(new Error(event.errorMessage ?? 'Chat error'));
      }
    });

    // Timeout after 15 minutes
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error(`Dispatch to ${agent.displayName} timed out after 15 minutes`));
      }
    }, 15 * 60 * 1000);
  });
}

// --- HTTP SSE-based dispatch (fallback — no tool events) ---

interface StreamChunk {
  model?: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string | null };
    finish_reason: string | null;
  }>;
}

async function consumeSSEStream(
  resp: Response,
  agentName: string,
  onToken?: (accumulated: string) => void,
): Promise<{ content: string; model: string }> {
  if (!resp.body) throw new Error(`Agent ${agentName} returned no response body`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let accumulated = '';
  let model = '';
  let done = false;

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;

      if (value) {
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      }

      const messages = buffer.split('\n\n');
      buffer = messages.pop() ?? '';

      for (const message of messages) {
        for (const line of message.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') { done = true; break; }

          try {
            const chunk = JSON.parse(payload) as StreamChunk;
            if (chunk.model && !model) model = chunk.model;
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              accumulated += delta;
              onToken?.(accumulated);
            }
          } catch {
            // Malformed chunk — skip
          }
        }
        if (done) break;
      }
    }
    const tail = decoder.decode();
    if (tail) buffer += tail;
  } finally {
    reader.releaseLock();
  }

  return { content: accumulated, model };
}

export async function dispatchViaHTTP(
  agent: AgentProcess,
  message: string,
  context: DispatchContext,
  sessionUser?: string,
  onToken?: (accumulated: string) => void,
): Promise<DispatchResult> {
  const systemMessage = composeSystemMessage(context);

  const body: Record<string, unknown> = {
    model: agent.model,
    stream: true,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: message },
    ],
  };

  if (sessionUser) body.user = sessionUser;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = `http://127.0.0.1:${agent.port}/v1/chat/completions`;
      log(`[dispatch] >>> HTTP POST to ${agent.displayName} (attempt ${attempt + 1}, port ${agent.port})`);
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${agent.gatewayToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });

      if (resp.ok) {
        const { content, model } = await consumeSSEStream(resp, agent.displayName, onToken);
        return { content, model: model || agent.model };
      }

      if ((resp.status === 401 || resp.status >= 502) && attempt === 0) {
        const text = await resp.text();
        lastError = new Error(`Agent ${agent.displayName} returned ${resp.status}: ${text}`);
        logError(`[dispatch] ${agent.displayName} returned ${resp.status}, retrying in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      const text = await resp.text();
      throw new Error(`Agent ${agent.displayName} returned ${resp.status}: ${text}`);
    } catch (err) {
      if (err instanceof Error && err.message.includes('returned')) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === 0) {
        logError(`[dispatch] ${agent.displayName} unreachable, retrying in 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
    }
  }

  throw lastError ?? new Error(`Dispatch to ${agent.displayName} failed after retry`);
}

// --- Unified dispatch (prefers WebSocket, falls back to HTTP) ---

export async function dispatchToAgent(
  agent: AgentProcess,
  message: string,
  context: DispatchContext,
  sessionUser?: string,
  onToken?: (accumulated: string) => void,
  /** WebSocket client for the agent's gateway (if available) */
  wsClient?: OpenClawWS | null,
  /** Extra callbacks for tool events (only work with WebSocket) */
  toolCallbacks?: { onToolStart?: DispatchCallbacks['onToolStart']; onToolEnd?: DispatchCallbacks['onToolEnd'] },
): Promise<DispatchResult> {
  // Prefer WebSocket dispatch for tool event visibility
  if (wsClient?.isConnected()) {
    const sessionKey = sessionUser ?? `dispatch-${Date.now()}`;
    return dispatchViaWebSocket(wsClient, agent, message, context, sessionKey, {
      onToken,
      onToolStart: toolCallbacks?.onToolStart,
      onToolEnd: toolCallbacks?.onToolEnd,
    });
  }

  // Fallback to HTTP SSE (no tool events)
  return dispatchViaHTTP(agent, message, context, sessionUser, onToken);
}
