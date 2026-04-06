import React, { useState, useEffect } from 'react';
import { Box, Text } from '@claude-code-kit/ink-renderer';
import { COLORS } from '../theme.js';

/** Moon phase emojis mapped to progress fraction (0→1). */
const MOON_PHASES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];

function moonPhase(fraction: number): string {
  const index = Math.floor(fraction * MOON_PHASES.length) % MOON_PHASES.length;
  return MOON_PHASES[index]!;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'ending...';
  const totalMin = Math.ceil(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export interface SlumberInfo {
  active: boolean;
  fraction: number;    // 0→1 progress (or cycling for indefinite)
  endsAt: number | null;
  totalTicks: number;
  enrolledCount: number;
  productiveTicks: number;
  profileIcon?: string;  // 🦉🎒⚡🛡️ — from active profile
  profileName?: string;
}

interface Props {
  breadcrumbs: string[];
  hints: string;
  slumber?: SlumberInfo | null;
}

export function StatusBar({ breadcrumbs, hints, slumber }: Props) {
  const crumbText = breadcrumbs.join(' › ');
  const [now, setNow] = useState(Date.now());

  // Update countdown every 30s
  useEffect(() => {
    if (!slumber?.active) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [slumber?.active]);

  // SLUMBER indicator — profile icon overrides moon phase when active
  let slumberText = '';
  if (slumber?.active) {
    const icon = slumber.profileIcon ?? moonPhase(slumber.fraction);
    const label = slumber.profileName ? `${slumber.profileName}` : 'SLUMBER';
    const countdown = slumber.endsAt ? formatCountdown(slumber.endsAt - now) : '';
    const tickLabel = `${slumber.totalTicks} ticks`;
    slumberText = countdown
      ? `${label} ${icon} ${countdown} · ${tickLabel}`
      : `${label} ${icon} ${tickLabel}`;
  }

  return (
    <Box borderStyle="round" borderColor={slumber?.active ? '#4338ca' : COLORS.border} paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        {slumberText && (
          <Text color="#a5b4fc" bold>{slumberText}</Text>
        )}
        <Text color={COLORS.subtle}>{crumbText}</Text>
      </Box>
      <Text color={COLORS.muted}>{hints}</Text>
    </Box>
  );
}
