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
 *
 * Stream tokens are throttled — buffered in a ref and flushed to state
 * at most every 80ms to avoid thousands of Map copies / re-renders.
 */
export function useDaemonEvents(port: number): DaemonEventState {
  const [streams, setStreams] = useState<Map<string, StreamState>>(new Map());
  const [dispatching, setDispatching] = useState<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stream token throttle — buffer writes in a ref, flush to state periodically
  const streamBufferRef = useRef<Map<string, StreamState>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushStreams = useCallback(() => {
    flushTimerRef.current = null;
    setStreams(new Map(streamBufferRef.current));
  }, []);

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
              streamBufferRef.current.set(event.channelId, {
                agentName: event.agentName,
                content: '',
                channelId: event.channelId,
              });
              setStreams(new Map(streamBufferRef.current));
              break;

            case 'stream_token':
              // Buffer — don't create a new Map on every single token
              streamBufferRef.current.set(event.channelId, {
                agentName: event.agentName,
                content: event.content,
                channelId: event.channelId,
              });
              // Throttled flush to React state (max ~12 updates/sec)
              if (!flushTimerRef.current) {
                flushTimerRef.current = setTimeout(flushStreams, 80);
              }
              break;

            case 'stream_end':
            case 'dispatch_end':
              setDispatching((prev) => {
                const next = new Set(prev);
                next.delete(event.agentName);
                return next;
              });
              streamBufferRef.current.delete(event.channelId);
              // Flush immediately on end so UI clears promptly
              if (flushTimerRef.current) {
                clearTimeout(flushTimerRef.current);
                flushTimerRef.current = null;
              }
              setStreams(new Map(streamBufferRef.current));
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
  }, [port, flushStreams]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { streams, dispatching };
}
