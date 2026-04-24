import React, { useState, useEffect, useContext, useCallback } from 'react';
import { Box, Text, useInput, ScrollBox, TerminalSizeContext } from '@claude-code-kit/ink-renderer';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { DAEMON_LOG_PATH } from '@claudecorp/shared';
import { COLORS, BORDER_STYLE } from '../theme.js';

interface Props {
  onBack: () => void;
}

interface LogEntry {
  timestamp: string;
  time: string;  // HH:MM:SS
  source: string;
  level: 'info' | 'error';
  message: string;
  raw: string;
}

// Known log sources → colors
const SOURCE_COLORS: Record<string, string> = {
  router:    '#60a5fa', // Blue-400
  harness:   '#a78bfa', // Violet-400
  pulse:     '#f472b6', // Pink-400
  dreams:    '#818cf8', // Indigo-400
  autoemon:  '#c084fc', // Purple-400
  models:    '#fbbf24', // Amber-400
  status:    '#34d399', // Emerald-400
  dispatch:  '#22d3ee', // Cyan-400
  recovery:  '#fb923c', // Orange-400
  gateway:   '#f87171', // Red-400
  daemon:    '#94a3b8', // Slate-400
  hire:      '#a3e635', // Lime-400
  sexton:    '#f472b6', // Pink
  herald:    '#60a5fa', // Blue
  'cc-say':  '#38bdf8', // Sky-400
  'corp-gw': '#fb923c', // Orange
  workspace: '#94a3b8', // Slate
};

const ALL_SOURCES = Object.keys(SOURCE_COLORS);

function parseLine(line: string): LogEntry | null {
  if (!line.trim()) return null;

  // Format: "2026-04-15T14:30:00.000Z [source] message" or "2026-04-15T14:30:00.000Z ERROR [source] message"
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(ERROR\s+)?(.*)/);
  if (!match) return { timestamp: '', time: '', source: 'unknown', level: 'info', message: line, raw: line };

  const timestamp = match[1]!;
  const isError = !!match[2];
  const rest = match[3]!;

  // Extract time portion for display
  const time = timestamp.slice(11, 19);

  // Extract source from [brackets]
  const sourceMatch = rest.match(/^\[([^\]]+)\]/);
  const source = sourceMatch?.[1]?.split(':')[0] ?? 'daemon'; // [harness:claude-code] → harness
  const message = sourceMatch ? rest.slice(sourceMatch[0].length).trim() : rest;

  return { timestamp, time, source, level: isError ? 'error' : 'info', message, raw: line };
}

function sourceColor(source: string): string {
  return SOURCE_COLORS[source] ?? COLORS.muted;
}

export function LogViewer({ onBack }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [lastSize, setLastSize] = useState(0);
  const [filter, setFilter] = useState<Set<string>>(new Set()); // empty = show all
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [filterCursor, setFilterCursor] = useState(0);
  const [paused, setPaused] = useState(false);
  const termSize = useContext(TerminalSizeContext);
  const termWidth = termSize?.columns ?? 120;

  const MAX_ENTRIES = 500;

  const loadLogs = useCallback(() => {
    if (paused) return;
    if (!existsSync(DAEMON_LOG_PATH)) return;

    try {
      const currentSize = statSync(DAEMON_LOG_PATH).size;
      if (currentSize === lastSize) return;
      setLastSize(currentSize);

      // Read last ~50KB of the file for performance
      const content = readFileSync(DAEMON_LOG_PATH, 'utf-8');
      const lines = content.trim().split('\n');
      const tail = lines.slice(-MAX_ENTRIES);
      const parsed = tail.map(parseLine).filter((e): e is LogEntry => e !== null);
      setEntries(parsed);
    } catch {}
  }, [lastSize, paused]);

  // Initial load + live tail
  useEffect(() => {
    loadLogs();
    const interval = setInterval(loadLogs, 1000);
    return () => clearInterval(interval);
  }, [loadLogs]);

  // Keyboard
  useInput((input, key) => {
    if (key.escape || input === 'q') {
      if (showFilterPanel) {
        setShowFilterPanel(false);
      } else {
        onBack();
      }
      return;
    }

    if (input === 'f') {
      setShowFilterPanel(!showFilterPanel);
      return;
    }

    if (input === 'p' || input === ' ') {
      setPaused(!paused);
      return;
    }

    if (input === 'c') {
      setFilter(new Set());
      return;
    }

    // Filter panel navigation
    if (showFilterPanel) {
      if (key.upArrow) setFilterCursor(Math.max(0, filterCursor - 1));
      if (key.downArrow) setFilterCursor(Math.min(ALL_SOURCES.length - 1, filterCursor + 1));
      if (key.return || input === ' ') {
        const src = ALL_SOURCES[filterCursor]!;
        setFilter(prev => {
          const next = new Set(prev);
          if (next.has(src)) next.delete(src);
          else next.add(src);
          return next;
        });
      }
    }
  });

  // Filter entries
  const visible = filter.size === 0
    ? entries
    : entries.filter(e => filter.has(e.source));

  // Source stats
  const sourceCounts = new Map<string, number>();
  for (const e of entries) {
    sourceCounts.set(e.source, (sourceCounts.get(e.source) ?? 0) + 1);
  }
  const errorCount = entries.filter(e => e.level === 'error').length;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Header */}
      <Box borderStyle={BORDER_STYLE} borderColor={COLORS.border} paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          <Text bold color={COLORS.primary}>{'◉'} Daemon Logs</Text>
          <Text color={COLORS.muted}>({entries.length} entries{errorCount > 0 ? `, ${errorCount} errors` : ''})</Text>
          {paused && <Text bold color={COLORS.warning}> PAUSED</Text>}
        </Box>
        <Box gap={2}>
          <Text color={COLORS.subtle}>f:filter</Text>
          <Text color={COLORS.subtle}>p:pause</Text>
          <Text color={COLORS.subtle}>c:clear-filter</Text>
          <Text color={COLORS.subtle}>Esc:back</Text>
        </Box>
      </Box>

      <Box flexGrow={1} flexDirection="row">
        {/* Filter panel (toggle) */}
        {showFilterPanel && (
          <Box flexDirection="column" width={22} borderStyle={BORDER_STYLE} borderColor={COLORS.border} paddingX={1}>
            <Text bold color={COLORS.secondary}>Sources</Text>
            {ALL_SOURCES.map((src, i) => {
              const count = sourceCounts.get(src) ?? 0;
              if (count === 0) return null;
              const active = filter.size === 0 || filter.has(src);
              const selected = filterCursor === i;
              return (
                <Box key={src} gap={1}>
                  <Text color={selected ? COLORS.primary : COLORS.muted}>
                    {selected ? '>' : ' '}{active ? '●' : '○'}
                  </Text>
                  <Text color={active ? sourceColor(src) : COLORS.muted}>
                    {src}
                  </Text>
                  <Text color={COLORS.subtle}>({count})</Text>
                </Box>
              );
            })}
          </Box>
        )}

        {/* Log lines */}
        <ScrollBox stickyScroll flexGrow={1} flexDirection="column">
          {visible.map((entry, i) => {
            const isError = entry.level === 'error';
            const srcTag = entry.source.padEnd(10);
            const maxMsg = termWidth - (showFilterPanel ? 22 : 0) - 24; // time(8) + source(12) + padding
            const msg = entry.message.length > maxMsg
              ? entry.message.slice(0, maxMsg - 3) + '...'
              : entry.message;

            return (
              <Box key={i} gap={0}>
                <Text color={COLORS.subtle}>{entry.time} </Text>
                <Text color={isError ? COLORS.danger : sourceColor(entry.source)} bold={isError}>
                  {isError ? 'ERR ' : ''}{srcTag}
                </Text>
                <Text color={isError ? COLORS.danger : undefined} wrap="truncate"> {msg}</Text>
              </Box>
            );
          })}
          {visible.length === 0 && (
            <Box paddingX={2} paddingY={1}>
              <Text color={COLORS.muted}>
                {entries.length === 0
                  ? 'No logs yet. Start the daemon to see activity.'
                  : `No logs matching filter. ${entries.length} total entries hidden.`}
              </Text>
            </Box>
          )}
        </ScrollBox>
      </Box>

      {/* Footer — active filter summary */}
      {filter.size > 0 && (
        <Box paddingX={1}>
          <Text color={COLORS.subtle}>
            Showing: {[...filter].join(', ')} ({visible.length}/{entries.length})
          </Text>
        </Box>
      )}
    </Box>
  );
}
