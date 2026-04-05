import { useState, useEffect, useRef, useCallback } from 'react';
import WebSocket from 'ws';

interface StreamState {
  agentName: string;
  content: string;
  channelId: string;
}

interface ToolState {
  agentName: string;
  channelId: string;
  toolName: string;
}

interface DaemonEventState {
  /** Active streaming content keyed by agent name */
  streams: Map<string, StreamState>;
  /** Agent names currently dispatching */
  dispatching: Set<string>;
  /** Active tool calls per agent */
  toolActivity: Map<string, ToolState>;
}

/**
 * WebSocket hook that connects to the daemon's event bus.
 * Streams keyed by agentName (not channelId) so multiple agents
 * can stream simultaneously in the same channel.
 */
export function useDaemonEvents(port: number): DaemonEventState {
  const [streams, setStreams] = useState<Map<string, StreamState>>(new Map());
  const [dispatching, setDispatching] = useState<Set<string>>(new Set());
  const [toolActivity, setToolActivity] = useState<Map<string, ToolState>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const streamBufferRef = useRef<Map<string, StreamState>>(new Map());
  /** Tracks how much accumulated text to skip per agent — reset on tool_start */
  const streamOffsetRef = useRef<Map<string, number>>(new Map());
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
              streamBufferRef.current.set(event.agentName, {
                agentName: event.agentName,
                content: '',
                channelId: event.channelId,
              });
              setStreams(new Map(streamBufferRef.current));
              break;

            case 'stream_token': {
              // Show only text after the last tool call — prevents accumulation
              // of stale checkpoints across the entire turn.
              const offset = streamOffsetRef.current.get(event.agentName) ?? 0;
              streamBufferRef.current.set(event.agentName, {
                agentName: event.agentName,
                content: event.content.slice(offset),
                channelId: event.channelId,
              });
              if (!flushTimerRef.current) {
                flushTimerRef.current = setTimeout(flushStreams, 30);
              }
              break;
            }

            case 'tool_start':
              // Save current accumulated length — preview will only show text after this point
              if (streamBufferRef.current.has(event.agentName)) {
                const current = streamBufferRef.current.get(event.agentName)!;
                const fullLength = (streamOffsetRef.current.get(event.agentName) ?? 0) + current.content.length;
                streamOffsetRef.current.set(event.agentName, fullLength);
              }
              setToolActivity((prev) => {
                const next = new Map(prev);
                next.set(event.agentName, {
                  agentName: event.agentName,
                  channelId: event.channelId,
                  toolName: event.toolName,
                });
                return next;
              });
              break;

            case 'tool_end':
              setToolActivity((prev) => {
                const next = new Map(prev);
                next.delete(event.agentName);
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
              streamBufferRef.current.delete(event.agentName);
              streamOffsetRef.current.delete(event.agentName);
              setToolActivity((prev) => {
                const next = new Map(prev);
                next.delete(event.agentName);
                return next;
              });
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

  return { streams, dispatching, toolActivity };
}
