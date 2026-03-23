import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { SpriteDefinition, SpriteState } from './types.js';
import { STATE_INTERVALS } from './types.js';

/** Characters that render in the accent color (eyes, gears, speech). */
const ACCENT_CHARS = new Set(['⊙', '⊛', '◎', '▸', '♪']);

interface SpriteRendererProps {
  sprite: SpriteDefinition;
  state?: SpriteState;
  bodyColor?: string;
  accentColor?: string;
  label?: string;
  labelColor?: string;
}

export function SpriteRenderer({
  sprite,
  state = 'idle',
  bodyColor = '#CD7F32',
  accentColor = '#FFEAA7',
  label,
  labelColor = '#DAA520',
}: SpriteRendererProps) {
  const frames = sprite.states[state];
  const [frameIndex, setFrameIndex] = useState(0);
  const interval = STATE_INTERVALS[state];

  // Reset frame on state change
  useEffect(() => {
    setFrameIndex(0);
  }, [state]);

  // Animate
  useEffect(() => {
    if (frames.length <= 1) return;
    const timer = setInterval(() => {
      setFrameIndex((i) => (i + 1) % frames.length);
    }, interval);
    return () => clearInterval(timer);
  }, [frames.length, interval, state]);

  const frame = frames[frameIndex % frames.length]!;

  return (
    <Box flexDirection="column" alignItems="center">
      {frame.lines.map((line, i) => (
        <Text key={i}>
          {colorize(line, bodyColor, accentColor)}
        </Text>
      ))}
      {label && (
        <Text color={labelColor} bold>{label}</Text>
      )}
    </Box>
  );
}

/** Split a sprite line into colored segments. */
function colorize(
  line: string,
  bodyColor: string,
  accentColor: string,
): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  let seg = '';
  let segColor: string | undefined;

  const flush = () => {
    if (!seg) return;
    result.push(
      <Text key={result.length} color={segColor}>{seg}</Text>,
    );
    seg = '';
  };

  for (const ch of line) {
    let color: string | undefined;
    if (ch === ' ') {
      color = undefined;
    } else if (ACCENT_CHARS.has(ch)) {
      color = accentColor;
    } else {
      color = bodyColor;
    }

    if (color !== segColor) {
      flush();
      segColor = color;
    }
    seg += ch;
  }
  flush();

  return result;
}
