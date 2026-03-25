import WebSocket from 'ws';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createPrivateKey, createPublicKey, sign as cryptoSign } from 'crypto';
import { log, logError } from './logger.js';

// --- Device identity ---

interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

interface DeviceAuthToken {
  token: string;
  role: string;
  scopes: string[];
}

function loadDeviceIdentity(): DeviceIdentity | null {
  const path = join(homedir(), '.openclaw', 'identity', 'device.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function loadDeviceAuthToken(): DeviceAuthToken | null {
  const path = join(homedir(), '.openclaw', 'identity', 'device-auth.json');
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  return data?.tokens?.operator ?? null;
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function publicKeyRawBase64Url(pem: string): string {
  const spki = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return base64UrlEncode(spki.subarray(spki.length - 32));
}

function signPayloadV3(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  return base64UrlEncode(cryptoSign(null, Buffer.from(payload, 'utf8'), key));
}

// --- Agent event types ---

export interface AgentEvent {
  runId: string;
  seq: number;
  stream: 'assistant' | 'tool' | 'lifecycle' | 'thinking' | 'error';
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
}

export interface ChatEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: unknown;
  errorMessage?: string;
}

export interface ToolEvent {
  phase: 'start' | 'end';
  name: string;
  toolCallId: string;
  args?: Record<string, unknown>;
  result?: string;
}

// --- WebSocket client ---

export class OpenClawWS {
  private ws: WebSocket | null = null;
  private port: number;
  private token: string;
  private identity: DeviceIdentity | null;
  private deviceToken: DeviceAuthToken | null;
  private reqId = 0;
  private connected = false;
  private pendingRequests = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventListeners = new Map<string, Set<(event: AgentEvent) => void>>(); // runId → listeners
  private chatListeners = new Map<string, Set<(event: ChatEvent) => void>>(); // sessionKey → listeners

  constructor(port: number, token: string) {
    this.port = port;
    this.token = token;
    this.identity = loadDeviceIdentity();
    this.deviceToken = loadDeviceAuthToken();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${this.port}`;
      log(`[openclaw-ws] Connecting to ${url}...`);

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        log('[openclaw-ws] WebSocket open');
      });

      this.ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleMessage(msg, resolve, reject);
        } catch (e) {
          logError(`[openclaw-ws] Parse error: ${e}`);
        }
      });

      this.ws.on('error', (err: Error) => {
        logError(`[openclaw-ws] Error: ${err.message}`);
        if (!this.connected) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        log(`[openclaw-ws] Closed (${code}): ${reason}`);
        this.connected = false;
        // Reject all pending requests
        for (const [, { reject: rej }] of this.pendingRequests) {
          rej(new Error('WebSocket closed'));
        }
        this.pendingRequests.clear();
      });

      // Timeout connect after 10s
      setTimeout(() => {
        if (!this.connected) reject(new Error('WebSocket connect timeout'));
      }, 10000);
    });
  }

  private handleMessage(msg: any, onConnected?: (v: void) => void, onConnectFail?: (e: Error) => void) {
    // Connect challenge → send auth
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      this.sendConnect(msg.payload.nonce, onConnected, onConnectFail);
      return;
    }

    // Response to a request
    if (msg.type === 'res') {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.ok) {
          // Check if this is the connect response
          if (msg.payload?.protocol) {
            this.connected = true;
            log(`[openclaw-ws] Connected (protocol ${msg.payload.protocol})`);
            onConnected?.();
          }
          pending.resolve(msg.payload);
        } else {
          pending.reject(new Error(msg.error?.message ?? 'Request failed'));
        }
      }
      return;
    }

    // Agent events (tool calls, lifecycle, text)
    if (msg.type === 'event' && msg.event === 'agent') {
      const event = msg.payload as AgentEvent;
      const listeners = this.eventListeners.get(event.runId);
      if (listeners) {
        for (const cb of listeners) cb(event);
      }
      return;
    }

    // Chat events (delta text, final, error)
    if (msg.type === 'event' && msg.event === 'chat') {
      const event = msg.payload as ChatEvent;
      const listeners = this.chatListeners.get(event.sessionKey);
      if (listeners) {
        for (const cb of listeners) cb(event);
      }
      return;
    }
  }

  private sendConnect(nonce: string, onOk?: (v: void) => void, onFail?: (e: Error) => void) {
    if (!this.identity) {
      onFail?.(new Error('No OpenClaw device identity found'));
      return;
    }

    const signedAtMs = Date.now();
    const scopes = this.deviceToken?.scopes ?? ['operator.admin'];
    const role = this.deviceToken?.role ?? 'operator';

    const payload = [
      'v3', this.identity.deviceId, 'gateway-client', 'backend',
      role, scopes.join(','), String(signedAtMs), this.token, nonce,
      process.platform, '',
    ].join('|');

    const id = String(++this.reqId);
    this.pendingRequests.set(id, {
      resolve: () => onOk?.(),
      reject: (e) => onFail?.(e),
    });

    this.ws?.send(JSON.stringify({
      type: 'req', id, method: 'connect',
      params: {
        minProtocol: 3, maxProtocol: 3,
        auth: {
          token: this.token,
          deviceToken: this.deviceToken?.token,
        },
        client: {
          id: 'gateway-client',
          mode: 'backend',
          version: '0.5.0',
          platform: process.platform,
        },
        role,
        scopes,
        caps: ['tool-events'],
        device: {
          id: this.identity.deviceId,
          publicKey: publicKeyRawBase64Url(this.identity.publicKeyPem),
          signature: signPayloadV3(this.identity.privateKeyPem, payload),
          signedAt: signedAtMs,
          nonce,
        },
      },
    }));
  }

  /** Send a chat message and get back the runId. Events stream via onAgentEvent/onChatEvent. */
  async chatSend(params: {
    sessionKey: string;
    message: string;
    idempotencyKey: string;
  }): Promise<{ runId: string }> {
    if (!this.connected || !this.ws) throw new Error('Not connected');

    const id = String(++this.reqId);
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({
        type: 'req', id, method: 'chat.send',
        params,
      }));
    });
  }

  /** Subscribe to agent events for a specific runId. Returns unsubscribe function. */
  onAgentEvent(runId: string, cb: (event: AgentEvent) => void): () => void {
    if (!this.eventListeners.has(runId)) {
      this.eventListeners.set(runId, new Set());
    }
    this.eventListeners.get(runId)!.add(cb);
    return () => {
      this.eventListeners.get(runId)?.delete(cb);
      if (this.eventListeners.get(runId)?.size === 0) {
        this.eventListeners.delete(runId);
      }
    };
  }

  /** Subscribe to chat events for a specific sessionKey. Returns unsubscribe function. */
  onChatEvent(sessionKey: string, cb: (event: ChatEvent) => void): () => void {
    if (!this.chatListeners.has(sessionKey)) {
      this.chatListeners.set(sessionKey, new Set());
    }
    this.chatListeners.get(sessionKey)!.add(cb);
    return () => {
      this.chatListeners.get(sessionKey)?.delete(cb);
      if (this.chatListeners.get(sessionKey)?.size === 0) {
        this.chatListeners.delete(sessionKey);
      }
    };
  }

  close() {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
