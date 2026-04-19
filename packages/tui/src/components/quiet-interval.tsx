import React from 'react';
import { Box, Text } from '@claude-code-kit/ink-renderer';
import { COLORS } from '../theme.js';

/**
 * Atmospheric indicator between two chat messages with a large time
 * gap. Instead of the chat jumping silently from 09:17 to 14:02 (and
 * leaving the founder squinting at timestamps), we render a faint
 * centered row:
 *
 *     · · · 4h 45m quiet · · ·
 *
 * It communicates "the corp rested here" rather than "something
 * may have been hidden."
 *
 * Threshold chosen so normal conversation flow isn't interrupted —
 * 10 minutes between messages is the default, overridable.
 */

interface Props {
  gapMs: number;
}

export function QuietInterval({ gapMs }: Props) {
  return (
    <Box justifyContent="center" paddingY={0}>
      <Text color={COLORS.muted} dimColor>
        · · · {humanize(gapMs)} quiet · · ·
      </Text>
    </Box>
  );
}

/**
 * Pure — exported for tests.
 * "1h 5m", "25m", "3d 4h", "just now" for edges.
 */
export function humanize(ms: number): string {
  if (ms < 60_000) return 'a moment';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hours < 24) return remM > 0 ? `${hours}h ${remM}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
}

/** Default quiet threshold: 10 min between consecutive chat messages. */
export const QUIET_THRESHOLD_MS = 10 * 60 * 1000;
