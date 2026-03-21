import { useState, useEffect, useRef, useCallback } from 'react';
import WebSocket from 'ws';

interface StreamState {
  agentName: string;
  content: string;
  channelId: string;
}

interface DaemonEventState {
  /** Active streaming content per channel */
  streams: Map<string, StreamState>;
  /** Agent names currently dispatching */
  dispatching: Set<string>;
}

/**
 * WebSocket hook that connects to the daemon's event bus.
 * Receives real-time streaming tokens and dispatch notifications.
 */
export function useDaemonEvents(port: number): DaemonEventState {
  const [streams, setStreams] = useState<Map<string, StreamState>>(new Map());
  const [dispatching, setDispatching] = useState<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/events`);
      wsRef.current = ws;

      ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());

          switch (event.type) {
            case 'dispatch_start':
              setDispatching((prev) => new Set(prev).add(event.agentName));
              setStreams((prev) => {
                const next = new Map(prev);
                next.set(event.channelId, {
                  agentName: event.agentName,
                  content: '',
                  channelId: event.channelId,
                });
                return next;
              });
              break;

            case 'stream_token':
              setStreams((prev) => {
                const next = new Map(prev);
                next.set(event.channelId, {
                  agentName: event.agentName,
                  content: event.content,
                  channelId: event.channelId,
                });
                return next;
              });
              break;

            case 'stream_end':
            case 'dispatch_end':
              setDispatching((prev) => {
                const next = new Set(prev);
                next.delete(event.agentName);
                return next;
              });
              setStreams((prev) => {
                const next = new Map(prev);
                next.delete(event.channelId);
                return next;
              });
              break;
          }
        } catch {}
      });

      ws.on('close', () => {
        wsRef.current = null;
        // Reconnect after 2s
        reconnectRef.current = setTimeout(connect, 2000);
      });

      ws.on('error', () => {
        try { ws.close(); } catch {}
      });
    } catch {}
  }, [port]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { streams, dispatching };
}
