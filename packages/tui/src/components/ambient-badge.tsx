import React from 'react';
import { Box, Text } from '@claude-code-kit/ink-renderer';
import type { AmbientKind } from '@claudecorp/shared';
import { useKindIcon, useHeartbeatPulse } from '../hooks/use-kind-icon.js';
import { sparkline, binTimestamps } from '../lib/sparkline.js';
import { COLORS } from '../theme.js';

/**
 * Collapsed view of an ambient stack — one line, clickable.
 *
 * Shows: animated kind icon · summary · count (if >1) · activity
 * sparkline (if >1) · relative time since last · pin control.
 *
 * Hover brightens the color. Click anywhere except the pin area
 * toggles expansion. Clicking the pin glyph toggles pinning without
 * also triggering expansion (stopImmediatePropagation inside the
 * child onClick keeps the bubble from reaching the parent row).
 */

interface Props {
  ambientKind: AmbientKind;
  /** Human summary (e.g., "heartbeat", "daily-brief"). */
  summary: string;
  /** How many turns are in the stack. */
  count: number;
  /** Timestamps (ms) of each turn's end — fuels the sparkline. */
  turnTimestampsMs: number[];
  /** ms since epoch when the most recent turn ended. */
  lastMs: number;
  /** ms since epoch when the first turn started (for sparkline window). */
  firstMs: number;
  /** Pinned stacks stay expanded forever — visual marker here. */
  pinned: boolean;
  /** Hovered state comes from the parent's onMouseEnter/Leave. */
  hovered: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onToggleExpand: () => void;
  onTogglePin: () => void;
}

export function AmbientBadge({
  ambientKind,
  summary,
  count,
  turnTimestampsMs,
  lastMs,
  firstMs,
  pinned,
  hovered,
  onMouseEnter,
  onMouseLeave,
  onToggleExpand,
  onTogglePin,
}: Props) {
  const icon = useKindIcon(ambientKind);
  // Heartbeat-specific: color pulse syncs to roughly-resting human
  // pulse rate. Only runs while the stack is visible (React unmount
  // clears the interval).
  const pulseOn = useHeartbeatPulse(ambientKind === 'heartbeat');

  // Color gets brighter on hover. Heartbeat adds the pulse on top.
  const baseColor = hovered ? COLORS.subtle : COLORS.muted;
  const iconColor = ambientKind === 'heartbeat'
    ? (pulseOn ? (hovered ? COLORS.info : COLORS.subtle) : COLORS.muted)
    : (hovered ? COLORS.info : COLORS.subtle);

  // Sparkline only when there's actually something to chart.
  const spark = count > 1 && turnTimestampsMs.length > 1
    ? sparkline(
        binTimestamps(
          turnTimestampsMs,
          firstMs,
          Math.max(lastMs, firstMs + 1),
          Math.min(10, count + 2),
        ),
        Math.min(10, count + 2),
      )
    : null;

  const relTime = relativeTime(lastMs);
  const countLabel = count > 1 ? ` (${count})` : '';

  return (
    <Box
      paddingLeft={1}
      flexDirection="row"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Main row → expand on click. */}
      <Box onClick={onToggleExpand} flexGrow={1}>
        <Text color={baseColor}>
          {' '}
          <Text color={iconColor}>{icon}</Text>
          {' '}
          <Text color={hovered ? COLORS.text : baseColor}>{summary}</Text>
          <Text color={baseColor}>{countLabel}</Text>
          {spark && (
            <>
              <Text color={baseColor}>{'  '}</Text>
              <Text color={hovered ? COLORS.info : COLORS.subtle}>{spark}</Text>
            </>
          )}
          <Text color={COLORS.muted}>  ·  {relTime}</Text>
        </Text>
      </Box>
      {/*
        Pin control — its own click target. Yokai bubbles ClickEvent
        upward; we stopImmediatePropagation inside this handler so the
        parent's expand click doesn't also fire. A single tap here
        just toggles the pin.
      */}
      <Box
        onClick={(e) => {
          e.stopImmediatePropagation();
          onTogglePin();
        }}
      >
        <Text color={pinned ? COLORS.warning : (hovered ? COLORS.subtle : COLORS.muted)}>
          {pinned ? '  📌' : '  ·'}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * "2m ago" / "just now" / "3h ago" — one-glance recency.
 * Handles negative (future timestamps) defensively.
 */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0 || diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
