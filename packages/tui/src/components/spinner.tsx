import React, { useState, useEffect } from 'react';
import { Text } from '@claude-code-kit/ink-renderer';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL = 80;

export function Spinner({ color }: { color?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), INTERVAL);
    return () => clearInterval(timer);
  }, []);
  return <Text color={color}>{FRAMES[frame]}</Text>;
}
