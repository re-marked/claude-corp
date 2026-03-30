import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { Clock } from '@claudecorp/shared';
import { COLORS, BORDER_STYLE } from '../theme.js';
import { useCorp } from '../context/corp-context.js';

interface Props {
  onBack: () => void;
}

// Spinning square frames — rotates through quadrant arcs
const SQUARE_FRAMES = ['\u25F0', '\u25F3', '\u25F2', '\u25F1']; // ◰ ◳ ◲ ◱
const PAUSED_ICON = '\u25A1'; // □
const ERROR_ICON = '\u25A0';  // ■
const STOPPED_ICON = '\u25A1'; // □

const TYPE_ORDER = ['heartbeat', 'timer', 'system', 'loop', 'cron'];
const TYPE_LABELS: Record<string, string> = {
  heartbeat: 'HEARTBEATS',
  timer: 'TIMERS',
  system: 'SYSTEM',
  loop: 'LOOPS',
  cron: 'CRONS',
};

/** Get color based on progress through interval: green → primary → warning → danger */
function progressColor(progress: number): string {
  if (progress < 0.3) return COLORS.success;    // Just fired, healthy green
  if (progress < 0.7) return COLORS.primary;    // Middle, coral
  if (progress < 0.9) return COLORS.warning;    // Getting close, yellow
  return COLORS.danger;                          // About to fire, red
}

export function ClockView({ onBack }: Props) {
  const { daemonClient } = useCorp();
  const [clocks, setClocks] = useState<Clock[]>([]);
  const [frame, setFrame] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [now, setNow] = useState(Date.now());
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 40;

  // Fetch clocks from daemon
  const fetchClocks = async () => {
    try {
      const data = await daemonClient.listClocks();
      setClocks(data);
    } catch {}
  };

  // Initial fetch + periodic refresh
  useEffect(() => {
    fetchClocks();
    const refresh = setInterval(() => fetchClocks(), 5000);
    return () => clearInterval(refresh);
  }, []);

  // Animation loop — 2 FPS (500ms) to avoid Yoga WASM memory crash
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => f + 1);
      setNow(Date.now());
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const selectableClocks = clocks.filter(c => c.status !== 'stopped');

  useInput((_input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.upArrow) setSelectedIndex(i => Math.max(0, i - 1));
    if (key.downArrow) setSelectedIndex(i => Math.min(selectableClocks.length - 1, i + 1));
    if (_input === 'p' || _input === 'P') {
      const clock = selectableClocks[selectedIndex];
      if (!clock) return;
      if (clock.status === 'paused') {
        daemonClient.resumeClock(clock.id).then(fetchClocks);
      } else if (clock.status === 'running' || clock.status === 'error') {
        daemonClient.pauseClock(clock.id).then(fetchClocks);
      }
    }
  });

  // Group clocks by type
  const groups = new Map<string, Clock[]>();
  for (const c of clocks) {
    if (c.status === 'stopped') continue;
    const group = groups.get(c.type) ?? [];
    group.push(c);
    groups.set(c.type, group);
  }

  let selectableIdx = 0;

  // Stats
  const running = clocks.filter(c => c.status === 'running').length;
  const errors = clocks.filter(c => c.status === 'error').length;
  const paused = clocks.filter(c => c.status === 'paused').length;
  const totalFires = clocks.reduce((sum, c) => sum + c.fireCount, 0);

  // Live clock display
  const liveTime = new Date(now);
  const timeStr = liveTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  return (
    <Box flexDirection="column" flexGrow={1} height={Math.floor(termHeight * 0.9)}>
      {/* Header with live clock */}
      <Box borderStyle={BORDER_STYLE} borderColor={COLORS.primary} paddingX={1} justifyContent="space-between">
        <Box gap={2}>
          <Text bold color={COLORS.primary}>CLOCKS</Text>
          <Text bold color={COLORS.text}>{timeStr}</Text>
        </Box>
        <Box gap={2}>
          <Text color={running > 0 ? COLORS.success : COLORS.muted}>{running} running</Text>
          {errors > 0 && <Text color={COLORS.danger}>{errors} ERROR</Text>}
          {paused > 0 && <Text color={COLORS.warning}>{paused} paused</Text>}
          <Text color={COLORS.muted}>{'\u00d7'}{formatCount(totalFires)} total</Text>
        </Box>
      </Box>

      {/* Clock groups */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        {TYPE_ORDER.map(type => {
          const group = groups.get(type);
          const label = TYPE_LABELS[type] ?? type.toUpperCase();

          // Placeholder sections for loops and crons
          if (!group || group.length === 0) {
            if (type === 'loop') {
              return (
                <Box key={type} flexDirection="column" marginBottom={1}>
                  <Text bold color={COLORS.muted}>{label}</Text>
                  <Text color={COLORS.border}>  {STOPPED_ICON} No loops yet. Use /loop to create recurring commands.</Text>
                </Box>
              );
            }
            if (type === 'cron') {
              return (
                <Box key={type} flexDirection="column" marginBottom={1}>
                  <Text bold color={COLORS.muted}>{label}</Text>
                  <Text color={COLORS.border}>  {STOPPED_ICON} No cron jobs yet. Scheduled tasks coming soon.</Text>
                </Box>
              );
            }
            return null;
          }

          return (
            <Box key={type} flexDirection="column" marginBottom={1}>
              <Text bold color={COLORS.muted}>{label}</Text>
              {group.map((clock) => {
                const isSelected = selectableIdx === selectedIndex;
                const currentIdx = selectableIdx;
                selectableIdx++;

                // Progress through interval
                let progress = 0;
                let remaining = '';
                let nextFireStr = '';

                if (clock.status === 'paused') {
                  remaining = 'PAUSED';
                  nextFireStr = '--:--:--';
                } else {
                  const ref = clock.lastFiredAt ?? clock.createdAt;
                  const elapsed = now - ref;
                  progress = Math.min(1, elapsed / clock.intervalMs);
                  const remainingMs = Math.max(0, clock.intervalMs - elapsed);
                  remaining = formatRemaining(remainingMs);

                  // Exact next fire time
                  const nextAt = clock.nextFireAt ?? (ref + clock.intervalMs);
                  const nextDate = new Date(nextAt);
                  nextFireStr = nextDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                }

                // Spinning square — spins faster as it approaches fire time
                // Base speed: 1 frame per 3 render ticks. Near fire: 1 frame per tick.
                const speed = progress > 0.9 ? 1 : progress > 0.7 ? 2 : 3;
                const squareIdx = Math.floor(frame / speed + currentIdx) % SQUARE_FRAMES.length;

                let indicator: string;
                let indicatorColor: string;

                if (clock.status === 'running') {
                  indicator = SQUARE_FRAMES[squareIdx]!;
                  indicatorColor = progressColor(progress);
                } else if (clock.status === 'paused') {
                  indicator = PAUSED_ICON;
                  indicatorColor = COLORS.warning;
                } else if (clock.status === 'error') {
                  // Pulse: alternate between error icon and spinning square
                  indicator = frame % 8 < 4 ? ERROR_ICON : SQUARE_FRAMES[squareIdx]!;
                  indicatorColor = COLORS.danger;
                } else {
                  indicator = STOPPED_ICON;
                  indicatorColor = COLORS.muted;
                }

                const fires = formatCount(clock.fireCount);
                const interval = formatInterval(clock.intervalMs);
                const errInfo = clock.consecutiveErrors > 0 ? ` ERR:${clock.consecutiveErrors}` : '';

                // Progress bar (10 chars — compact alongside spinner)
                const barWidth = 10;
                const filled = Math.floor(progress * barWidth);
                const empty = barWidth - filled;
                const barFilled = '\u2501'.repeat(filled);
                const barEmpty = '\u2501'.repeat(empty);

                return (
                  <Box key={clock.id}>
                    <Text color={isSelected ? COLORS.primary : COLORS.muted}>
                      {isSelected ? '\u25B8' : ' '}
                    </Text>
                    <Text color={indicatorColor}> {indicator} </Text>
                    <Text
                      bold={isSelected}
                      color={clock.status === 'error' ? COLORS.danger : isSelected ? COLORS.text : COLORS.subtle}
                    >
                      {clock.name.padEnd(20)}
                    </Text>
                    <Text color={progressColor(progress)}>{barFilled}</Text>
                    <Text color={COLORS.border}>{barEmpty}</Text>
                    <Text color={COLORS.muted}> {interval.padEnd(5)}</Text>
                    <Text color={progressColor(progress)}>{remaining.padEnd(9)}</Text>
                    <Text color={COLORS.subtle}>{'>'}</Text>
                    <Text color={COLORS.text}>{nextFireStr}</Text>
                    <Text color={COLORS.muted}> {'\u00d7'}{fires}</Text>
                    {errInfo && <Text color={COLORS.danger}>{errInfo}</Text>}
                  </Box>
                );
              })}
            </Box>
          );
        })}

        {clocks.length === 0 && (
          <Text color={COLORS.muted}>No clocks registered. Start the daemon first.</Text>
        )}
      </Box>

      {/* Footer */}
      <Box borderStyle={BORDER_STYLE} borderColor={COLORS.border} paddingX={1} justifyContent="space-between">
        <Text color={COLORS.muted}>P:pause/resume  Esc:back</Text>
        <Text color={COLORS.muted}>{clocks.length} clocks</Text>
      </Box>
    </Box>
  );
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'firing';
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1_000);
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatInterval(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(0)}s`;
  return `${ms}ms`;
}

function formatCount(n: number): string {
  if (n >= 100_000) return `${(n / 1_000).toFixed(0)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
