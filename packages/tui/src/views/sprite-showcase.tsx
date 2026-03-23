import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { COLORS } from '../theme.js';
import { SpriteRenderer } from '../sprites/SpriteRenderer.js';
import { CEO, PM, WORKER, ADVISER } from '../sprites/crab-sprites.js';
import type { SpriteState } from '../sprites/types.js';

const COPPER = '#CD7F32';
const BRASS = '#DAA520';
const IRON = '#8B7355';

type DemoMode = 'gallery' | 'dialogue' | 'factory';

const MODE_LABELS: Record<DemoMode, string> = {
  gallery: 'Sprite Gallery',
  dialogue: 'RPG Dialogue',
  factory: 'Factory Floor',
};

export function SpriteShowcase({ onBack }: { onBack: () => void }) {
  const [mode, setMode] = useState<DemoMode>('gallery');

  useInput((input, key) => {
    if (input === '1') setMode('gallery');
    if (input === '2') setMode('dialogue');
    if (input === '3') setMode('factory');
    if (key.escape) onBack();
  });

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
      {/* Header */}
      <Box
        borderStyle="round"
        borderColor={COPPER}
        paddingX={1}
        justifyContent="space-between"
      >
        <Text bold color={COPPER}>
          {'⚙ STEAMPUNK SPRITE SHOWCASE ⚙'}
        </Text>
        <Text color={COLORS.subtle}>
          {MODE_LABELS[mode]}
        </Text>
      </Box>

      {/* Mode tabs */}
      <Box gap={2} marginTop={1}>
        {(['gallery', 'dialogue', 'factory'] as DemoMode[]).map((m, i) => (
          <Text
            key={m}
            bold={mode === m}
            color={mode === m ? BRASS : COLORS.muted}
          >
            [{i + 1}] {MODE_LABELS[m]}
          </Text>
        ))}
      </Box>

      {/* Active demo */}
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {mode === 'gallery' && <GalleryDemo />}
        {mode === 'dialogue' && <DialogueDemo />}
        {mode === 'factory' && <FactoryDemo />}
      </Box>

      {/* Controls */}
      <Box marginTop={1}>
        <Text color={COLORS.muted}>
          1/2/3: switch mode  {mode === 'gallery' ? 'Tab: cycle state  ' : ''}Esc: back
        </Text>
      </Box>
    </Box>
  );
}

// ─── GALLERY DEMO ───────────────────────────────────────────────────
const STATES: SpriteState[] = ['idle', 'working', 'walking', 'talking'];

function GalleryDemo() {
  const [stateIdx, setStateIdx] = useState(0);
  const state = STATES[stateIdx]!;

  useInput((_input, key) => {
    if (key.tab) setStateIdx((i) => (i + 1) % STATES.length);
  });

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={COLORS.subtle}>
          State: <Text bold color={BRASS}>{state}</Text>
          <Text color={COLORS.muted}> (Tab to cycle)</Text>
        </Text>
      </Box>
      <Box flexDirection="row" justifyContent="space-around" gap={6}>
        <SpriteRenderer sprite={CEO} state={state} label="CEO" />
        <SpriteRenderer sprite={PM} state={state} label="PM" />
        <SpriteRenderer sprite={WORKER} state={state} label="Worker" />
        <SpriteRenderer sprite={ADVISER} state={state} label="Adviser" />
      </Box>
    </Box>
  );
}

// ─── RPG DIALOGUE DEMO ─────────────────────────────────────────────
const DIALOGUE_LINES = [
  `"The quarterly analysis is complete, Founder.\n Revenue projections show a 23% increase."`,
  `"I've dispatched the Analytics team to dig\n deeper into the consumer segment data."`,
  `"Three new tasks created and assigned.\n Estimated completion: 2 hours."`,
  `"Is there anything else you'd like me\n to prioritize, Founder?"`,
];

function DialogueDemo() {
  const [msgIdx, setMsgIdx] = useState(0);

  // Auto-cycle dialogue every 4s
  useEffect(() => {
    const t = setInterval(() => {
      setMsgIdx((i) => (i + 1) % DIALOGUE_LINES.length);
    }, 4000);
    return () => clearInterval(t);
  }, []);

  return (
    <Box flexDirection="column">
      {/* Portrait + info row */}
      <Box flexDirection="row" gap={4}>
        <SpriteRenderer sprite={CEO} state="talking" />
        <Box flexDirection="column" justifyContent="center" gap={0}>
          <Text bold color={COPPER}>CEO</Text>
          <Text color={COLORS.subtle}>rank: <Text color={BRASS}>master</Text></Text>
          <Text color={COLORS.subtle}>status: <Text color={COLORS.success}>◆ active</Text></Text>
          <Text color={COLORS.subtle}>uptime: <Text color={COLORS.text}>3h 42m</Text></Text>
        </Box>
      </Box>

      {/* Speech bubble */}
      <Box
        borderStyle="round"
        borderColor={BRASS}
        paddingX={2}
        paddingY={1}
        marginTop={1}
        width={50}
      >
        <Text color={COLORS.text} wrap="wrap">
          {DIALOGUE_LINES[msgIdx]}
        </Text>
      </Box>

      {/* Fake input prompt */}
      <Box marginTop={1} gap={1} paddingX={1}>
        <Text color={BRASS}>▸</Text>
        <Text color={COLORS.muted}>Type your response...</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={COLORS.subtle} italic>
          Dialogue auto-cycles every 4s — in real mode you'd type responses
        </Text>
      </Box>
    </Box>
  );
}

// ─── FACTORY FLOOR DEMO ─────────────────────────────────────────────
const BELT_PATTERN = '═══◆═══════◆═══════◇═══════';

function renderBelt(offset: number, width: number): string {
  // Repeat the pattern and slice a window that shifts over time
  const extended = BELT_PATTERN.repeat(4);
  const start = offset % BELT_PATTERN.length;
  return extended.slice(start, start + width) + '▶';
}

const MICRO_TALKS = [
  ['"delegating..."', '"planning..."', '"coding..."', '"reviewing..."'],
  ['"assigning..."', '"scheduling..."', '"building..."', '"testing..."'],
  ['"dispatched"', '"in progress"', '"compiling..."', '"✓ approved"'],
];

function FactoryDemo() {
  const [beltOffset, setBeltOffset] = useState(0);
  const [talkIdx, setTalkIdx] = useState(0);

  useEffect(() => {
    const belt = setInterval(() => setBeltOffset((o) => o + 1), 400);
    const talk = setInterval(() => setTalkIdx((i) => (i + 1) % MICRO_TALKS.length), 3000);
    return () => { clearInterval(belt); clearInterval(talk); };
  }, []);

  const talks = MICRO_TALKS[talkIdx]!;

  return (
    <Box flexDirection="column">
      {/* Pipe header connecting stations */}
      <Text color={IRON}>{'⚙═══════════⚙═══════════⚙═══════════⚙'}</Text>
      <Text color={IRON}>{'║            ║            ║            ║'}</Text>

      {/* Agent stations */}
      <Box flexDirection="row" gap={0}>
        <Box flexDirection="column" alignItems="center" width={14}>
          <SpriteRenderer sprite={CEO} state="working" />
          <Text color={BRASS} dimColor>{talks[0]}</Text>
        </Box>
        <Box alignItems="center" justifyContent="center">
          <Text color={IRON}>═▶</Text>
        </Box>
        <Box flexDirection="column" alignItems="center" width={14}>
          <SpriteRenderer sprite={PM} state="working" />
          <Text color={BRASS} dimColor>{talks[1]}</Text>
        </Box>
        <Box alignItems="center" justifyContent="center">
          <Text color={IRON}>═▶</Text>
        </Box>
        <Box flexDirection="column" alignItems="center" width={14}>
          <SpriteRenderer sprite={WORKER} state="working" />
          <Text color={BRASS} dimColor>{talks[2]}</Text>
        </Box>
        <Box alignItems="center" justifyContent="center">
          <Text color={IRON}>═▶</Text>
        </Box>
        <Box flexDirection="column" alignItems="center" width={14}>
          <SpriteRenderer sprite={ADVISER} state="idle" />
          <Text color={BRASS} dimColor>{talks[3]}</Text>
        </Box>
      </Box>

      {/* Conveyor belt */}
      <Box marginTop={1} flexDirection="column">
        <Text color={IRON} bold>{'CONVEYOR'}</Text>
        <Text color={COPPER}>{renderBelt(beltOffset, 55)}</Text>
        <Box gap={3}>
          <Text color={COLORS.subtle}>  ◆ = in progress</Text>
          <Text color={COLORS.subtle}>◇ = pending</Text>
          <Text color={COLORS.success}>✓ = done</Text>
        </Box>
      </Box>
    </Box>
  );
}
