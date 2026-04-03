/**
 * SleepingBanner — dreamy visual for DMs with sleeping autoemon agents.
 *
 * Shows ASCII art with stars and a moon, sleep reason, remaining time,
 * and a hint that typing will wake the agent. Animated with cycling
 * stars that twinkle.
 *
 * Displayed at the bottom of the chat view (above the input) when
 * the DM agent is enrolled in autoemon and currently sleeping.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../theme.js';

interface Props {
  /** Agent display name */
  agentName: string;
  /** Why the agent went to sleep */
  sleepReason: string;
  /** Milliseconds remaining until natural wake */
  remainingMs: number;
  /** Agent's rank for color theming */
  rank?: string;
}

// ── ASCII Night Sky ────────────────────────────────────────────────

const STAR_FRAMES = [
  // Frame 0: quiet sky with wispy clouds
  [
    '    ·  ✦      ·    ☁   ·    ',
    '  ·       ·      ✧  ·      ',
    '    ☁· ·     ☽       ·   · ',
    '  ·  ✧    ·     ·    ☁  ·  ',
    '     ·       ·    ✦  ·     ',
  ],
  // Frame 1: twinkling, clouds drift
  [
    '    ✧  ·   ☁  ✦        ·   ',
    '  ·       ✧      ·  ✦      ',
    '       ·     ☽    ☁  ✧   · ',
    '  ✦  ·    ✧     ·       ·  ',
    '   ☁ ✧       ·    ·  ✦     ',
  ],
  // Frame 2: different pattern, clouds shifted
  [
    '    ·  ✧      ·        ✦   ',
    '  ✦    ☁  ·      ✧  ·      ',
    '       ✦     ☽       ·   ✧ ',
    '  ·  ✦    ·  ☁  ✧       ·  ',
    '     ·       ✦    ✧  · ☁   ',
  ],
  // Frame 3: shooting star moment
  [
    '    ·  ✦  ━━✧  ·        ·  ',
    '  ·       ·      ✧  · ☁    ',
    '    ☁  ·     ☽       ·   · ',
    '  ·  ✧    ·     ·       ·  ',
    '     ·    ☁  ·    ✦  ·     ',
  ],
];

const ZZZ_FRAMES = [
  '  z  ',
  '  zz ',
  '  zzz',
  ' zzz ',
  'zzz  ',
  'zz   ',
  'z    ',
];

// ── Helpers ────────────────────────────────────────────────────────

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'waking up...';
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return remainMin > 0 ? `${hr}h ${remainMin}m` : `${hr}h`;
}

// ── Component ──────────────────────────────────────────────────────

export function SleepingBanner({ agentName, sleepReason, remainingMs, rank }: Props) {
  const [frame, setFrame] = useState(0);
  const [zzzFrame, setZzzFrame] = useState(0);
  const [remaining, setRemaining] = useState(remainingMs);

  // Animate stars every 2 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % STAR_FRAMES.length);
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  // Animate zzz every 500ms
  useEffect(() => {
    const timer = setInterval(() => {
      setZzzFrame(f => (f + 1) % ZZZ_FRAMES.length);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // Countdown remaining time every second
  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(r => Math.max(0, r - 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const stars = STAR_FRAMES[frame]!;
  const zzz = ZZZ_FRAMES[zzzFrame]!;
  const timeLeft = formatRemaining(remaining);

  // Night theme palette
  const colors = {
    dimStar: '#4b5563',    // Grey-500 — faint dots
    brightStar: '#a5b4fc', // Indigo-300 — bright stars
    specialStar: '#e0e7ff',// Indigo-100 — sparkle stars (✦✧)
    moon: '#fbbf24',       // Amber-400 — the moon
    cloud: '#374151',      // Grey-700 — wispy clouds
    shootingStar: '#fde68a',// Amber-200 — streak
    zzz: '#818cf8',        // Indigo-400
    text: '#a5b4fc',       // Indigo-300
    border: '#4338ca',     // Indigo-700 — deeper border
  };

  /** Color a single character based on what it is. */
  const colorChar = (ch: string): string => {
    switch (ch) {
      case '☽': return colors.moon;
      case '✦': case '✧': return colors.specialStar;
      case '☁': return colors.cloud;
      case '━': return colors.shootingStar;
      case '·': return colors.dimStar;
      default: return colors.dimStar;
    }
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.border}
      paddingX={1}
      marginBottom={1}
    >
      {/* Night sky — each character colored individually */}
      {stars.map((line, i) => (
        <Text key={i}>
          {line.split('').map((ch, j) => (
            <Text key={j} color={ch === ' ' ? undefined : colorChar(ch)}>{ch}</Text>
          ))}
        </Text>
      ))}

      {/* Agent info + zzz */}
      <Box marginTop={1} gap={1}>
        <Text color={colors.text} bold>{agentName}</Text>
        <Text color={colors.zzz} bold>{zzz}</Text>
      </Box>

      {/* Sleep reason + remaining */}
      <Box gap={1}>
        <Text color={COLORS.muted} dimColor>
          {sleepReason ? `"${sleepReason}"` : 'Sleeping...'}
        </Text>
        <Text color={colors.text}>· waking in {timeLeft}</Text>
      </Box>

      {/* Wake hint */}
      <Box marginTop={1}>
        <Text color={COLORS.muted} italic>
          type a message to wake {agentName} instantly ↵
        </Text>
      </Box>
    </Box>
  );
}
