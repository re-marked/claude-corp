import { WebSocketServer, type WebSocket } from 'ws';
import type { Server } from 'node:http';

/** Events the daemon pushes to connected TUI clients. */
export type DaemonEvent =
  | { type: 'stream_token'; agentName: string; channelId: string; content: string }
  | { type: 'stream_end'; agentName: string; channelId: string }
  | { type: 'dispatch_start'; agentName: string; channelId: string }
  | { type: 'dispatch_end'; agentName: string; channelId: string }
  | { type: 'agent_status'; agentName: string; status: string }
  | { type: 'message_written'; channelId: string; messageId: string }
  | { type: 'tool_start'; agentName: string; channelId: string; toolName: string; args?: Record<string, unknown> }
  | { type: 'tool_end'; agentName: string; channelId: string; toolName: string; resultPreview?: string }
  | { type: 'model_changed'; agentName: string | null; model: string };

export class EventBus {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  /** Attach WebSocket server to existing HTTP server. */
  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/events' });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
  }

  /** Broadcast an event to all connected clients. */
  broadcast(event: DaemonEvent): void {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      try {
        if (client.readyState === 1) { // OPEN
          client.send(data);
        }
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** Close all connections. */
  close(): void {
    for (const client of this.clients) {
      try { client.close(); } catch {}
    }
    this.clients.clear();
    this.wss?.close();
  }
}
