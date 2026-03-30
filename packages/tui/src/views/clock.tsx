import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { Clock } from '@claudecorp/shared';
import { COLORS, BORDER_STYLE } from '../theme.js';
import { useCorp } from '../context/corp-context.js';

interface Props {
  onBack: () => void;
}

// Braille spinner frames — each clock offsets to avoid visual sync
const SPINNER = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];
const PAUSED_ICON = '\u25CB'; // ○
const ERROR_ICON = '\u2717';  // ✗
const STOPPED_ICON = '\u2013'; // –

const BAR_WIDTH = 20;
const BAR_FILLED = '\u2588'; // █
const BAR_EMPTY = '\u2591';  // ░

const TYPE_ORDER = ['heartbeat', 'timer', 'system', 'loop', 'cron'];
const TYPE_LABELS: Record<string, string> = {
  heartbeat: 'HEARTBEATS',
  timer: 'TIMERS',
  system: 'SYSTEM',
  loop: 'LOOPS',
  cron: 'CRONS',
};

export function ClockView({ onBack }: Props) {
  const { daemonClient } = useCorp();
  const [clocks, setClocks] = useState<Clock[]>([]);
  const [frame, setFrame] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 40;
  const fetchRef = useRef(0);

  // Fetch clocks from daemon
  const fetchClocks = async () => {
    try {
      const data = await daemonClient.listClocks();
      setClocks(data);
    } catch {
      // Daemon might be down
    }
  };

  // Initial fetch + periodic refresh (every 5s for fire count accuracy)
  useEffect(() => {
    fetchClocks();
    const refresh = setInterval(() => fetchClocks(), 5000);
    return () => clearInterval(refresh);
  }, []);

  // Animation loop — 10 FPS (100ms)
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => f + 1);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  // Selectable clocks (flat list, no headers)
  const selectableClocks = clocks.filter(c => c.status !== 'stopped');

  useInput((_input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.upArrow) setSelectedIndex(i => Math.max(0, i - 1));
    if (key.downArrow) setSelectedIndex(i => Math.min(selectableClocks.length - 1, i + 1));

    // P = pause/resume selected clock
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

  const now = Date.now();
  let selectableIdx = 0;

  // Stats
  const running = clocks.filter(c => c.status === 'running').length;
  const errors = clocks.filter(c => c.status === 'error').length;
  const paused = clocks.filter(c => c.status === 'paused').length;
  const totalFires = clocks.reduce((sum, c) => sum + c.fireCount, 0);

  return (
    <Box flexDirection="column" flexGrow={1} height={Math.floor(termHeight * 0.9)}>
      {/* Header */}
      <Box borderStyle={BORDER_STYLE} borderColor={COLORS.primary} paddingX={1} justifyContent="space-between">
        <Text bold color={COLORS.primary}>CLOCKS</Text>
        <Box gap={2}>
          <Text color={running > 0 ? COLORS.success : COLORS.muted}>
            {running} running
          </Text>
          {errors > 0 && <Text color={COLORS.danger}>{errors} ERROR</Text>}
          {paused > 0 && <Text color={COLORS.warning}>{paused} paused</Text>}
          <Text color={COLORS.muted}>
            {formatCount(totalFires)} total fires
          </Text>
        </Box>
      </Box>

      {/* Clock groups */}
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        {TYPE_ORDER.map(type => {
          const group = groups.get(type);
          if (!group || group.length === 0) return null;

          return (
            <Box key={type} flexDirection="column" marginBottom={1}>
              <Text bold color={COLORS.muted}>{TYPE_LABELS[type] ?? type.toUpperCase()}</Text>
              {group.map((clock, clockIdx) => {
                const isSelected = selectableIdx === selectedIndex;
                const currentSelectableIdx = selectableIdx;
                selectableIdx++;

                // Spinner — each clock offset by its index
                const spinnerIdx = (frame + currentSelectableIdx * 3) % SPINNER.length;
                let indicator: string;
                let indicatorColor: string;

                if (clock.status === 'running') {
                  indicator = SPINNER[spinnerIdx]!;
                  indicatorColor = COLORS.success;
                } else if (clock.status === 'paused') {
                  indicator = PAUSED_ICON;
                  indicatorColor = COLORS.warning;
                } else if (clock.status === 'error') {
                  // Pulse red: alternate between error icon and spinner
                  indicator = frame % 10 < 5 ? ERROR_ICON : SPINNER[spinnerIdx]!;
                  indicatorColor = COLORS.danger;
                } else {
                  indicator = STOPPED_ICON;
                  indicatorColor = COLORS.muted;
                }

                // Progress bar
                let progress = 0;
                let remaining = '';
                if (clock.lastFiredAt && clock.status !== 'paused') {
                  const elapsed = now - clock.lastFiredAt;
                  progress = Math.min(1, elapsed / clock.intervalMs);
                  const remainingMs = Math.max(0, clock.intervalMs - elapsed);
                  remaining = formatRemaining(remainingMs);
                } else if (clock.status === 'paused') {
                  remaining = 'PAUSED';
                }

                const filledCount = Math.floor(progress * BAR_WIDTH);
                const emptyCount = BAR_WIDTH - filledCount;
                const bar = BAR_FILLED.repeat(filledCount) + BAR_EMPTY.repeat(emptyCount);

                // Bar color: gradient from primary to success as it fills
                const barColor = progress > 0.9 ? COLORS.warning : COLORS.primary;

                // Fire count
                const fires = formatCount(clock.fireCount);

                // Error info
                const errInfo = clock.consecutiveErrors > 0
                  ? ` ERR:${clock.consecutiveErrors}`
                  : '';

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
                      {clock.name.padEnd(22)}
                    </Text>
                    <Text color={barColor}>[{bar}]</Text>
                    <Text color={COLORS.subtle}> {remaining.padEnd(8)}</Text>
                    <Text color={COLORS.muted}> \u00D7{fires}</Text>
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
        <Text color={COLORS.muted}>
          Last refresh: {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
        </Text>
        <Text color={COLORS.muted}>
          P:pause/resume  Esc:back
        </Text>
      </Box>
    </Box>
  );
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'now';
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1_000);
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatCount(n: number): string {
  if (n >= 100_000) return `${(n / 1_000).toFixed(0)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
