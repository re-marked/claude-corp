import type { AgentProcess } from './process-manager.js';
import { log, logError } from './logger.js';
import { composeSystemMessage, type FragmentContext } from './fragments/index.js';

/** Context for agent dispatch — passed to the fragment compositor. */
export type DispatchContext = FragmentContext;

export interface DispatchResult {
  content: string;
  model: string;
}

/** SSE chunk shape from OpenAI-compatible streaming */
interface StreamChunk {
  model?: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string | null };
    finish_reason: string | null;
  }>;
}

/**
 * Consume an OpenAI-compatible SSE stream and return accumulated content.
 * Calls onToken for each token so the caller can update live preview state.
 */
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

      // Split on SSE message boundary (\n\n)
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
    // Flush decoder
    const tail = decoder.decode();
    if (tail) buffer += tail;
  } finally {
    reader.releaseLock();
  }

  return { content: accumulated, model };
}

export async function dispatchToAgent(
  agent: AgentProcess,
  message: string,
  context: DispatchContext,
  sessionUser?: string,
  onToken?: (accumulated: string) => void,
): Promise<DispatchResult> {
  // System message composed from fragments based on agent context
  const systemMessage = composeSystemMessage(context);

  const body: Record<string, unknown> = {
    model: agent.model,
    stream: true,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: message },
    ],
  };

  if (sessionUser) {
    body.user = sessionUser;
  }

  // Try dispatch with one retry on transient failures (connection error, 401, 502-504)
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = `http://127.0.0.1:${agent.port}/v1/chat/completions`;
      log(`[dispatch] >>> HTTP POST to ${agent.displayName} (attempt ${attempt + 1}, port ${agent.port}, model ${agent.model})`);
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

      // Retryable HTTP errors
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
