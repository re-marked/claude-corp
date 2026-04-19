import React from 'react';
import { Box, Text } from '@claude-code-kit/ink-renderer';
import type { AmbientKind, ChannelMessage } from '@claudecorp/shared';
import { AmbientBadge } from './ambient-badge.js';
import { COLORS } from '../theme.js';
import type { AmbientStack, AmbientTurn } from '../lib/ambient-stack.js';

/**
 * Three-state stack rendering.
 *
 *   'collapsed'  → single clickable AmbientBadge (the default)
 *   'items'      → badge + vertical list of turn summaries; each row
 *                  is itself clickable → opens that turn's full content
 *   'item-open'  → badge + full messages of the selected turn, rendered
 *                  via the caller's `renderMessage` so we don't
 *                  duplicate chat.tsx's message formatting
 *
 * Pinned stacks force 'items' whenever they'd otherwise collapse so
 * the founder's pinned ambient stays unfolded across refreshes.
 */

export type StackExpansion =
  | { kind: 'collapsed' }
  | { kind: 'items' }
  | { kind: 'item-open'; turnId: string };

interface Props {
  stack: AmbientStack;
  expansion: StackExpansion;
  pinned: boolean;
  hovered: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  /** Caller tells the stack how to advance its state. */
  onSetExpansion: (next: StackExpansion) => void;
  onTogglePin: () => void;
  /** Delegated message rendering — chat.tsx owns the formatting. */
  renderMessage: (msg: ChannelMessage, prev: ChannelMessage | null) => React.ReactNode;
}

export function AmbientStackView({
  stack,
  expansion,
  pinned,
  hovered,
  onMouseEnter,
  onMouseLeave,
  onSetExpansion,
  onTogglePin,
  renderMessage,
}: Props) {
  // Pin override: a pinned stack that would otherwise be collapsed
  // gets auto-promoted to 'items' so the founder's deliberate pin
  // doesn't snap shut.
  const effectiveExpansion: StackExpansion =
    pinned && expansion.kind === 'collapsed' ? { kind: 'items' } : expansion;

  const turnTimestampsMs = stack.turns.map(t => t.endMs);

  // Always render the badge header. Its onClick toggles between
  // 'collapsed' and 'items' (not touching 'item-open', which has a
  // dedicated back button inside the item view).
  const header = (
    <AmbientBadge
      ambientKind={stack.ambientKind}
      summary={summaryFor(stack)}
      count={stack.turns.length}
      turnTimestampsMs={turnTimestampsMs}
      lastMs={stack.endMs}
      firstMs={stack.startMs}
      pinned={pinned}
      hovered={hovered}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onToggleExpand={() => {
        if (effectiveExpansion.kind === 'collapsed') {
          onSetExpansion({ kind: 'items' });
        } else {
          onSetExpansion({ kind: 'collapsed' });
        }
      }}
      onTogglePin={onTogglePin}
    />
  );

  if (effectiveExpansion.kind === 'collapsed') {
    return <Box flexDirection="column">{header}</Box>;
  }

  if (effectiveExpansion.kind === 'items') {
    return (
      <Box flexDirection="column">
        {header}
        <Box flexDirection="column" paddingLeft={4}>
          {stack.turns.map(turn => (
            <TurnRow
              key={turn.turnId}
              turn={turn}
              ambientKind={stack.ambientKind}
              onOpen={() => onSetExpansion({ kind: 'item-open', turnId: turn.turnId })}
            />
          ))}
        </Box>
      </Box>
    );
  }

  // item-open
  const openTurn = stack.turns.find(t => t.turnId === effectiveExpansion.turnId);
  if (!openTurn) {
    // Stale turnId (shouldn't happen) — fall back to items view.
    return <Box flexDirection="column">{header}</Box>;
  }
  return (
    <Box flexDirection="column">
      {header}
      {/* "Back to list" control — its own clickable Box. */}
      <Box
        paddingLeft={4}
        onClick={() => onSetExpansion({ kind: 'items' })}
      >
        <Text color={COLORS.subtle}>  ← back to {stack.turns.length} {stack.ambientKind} runs</Text>
      </Box>
      <Box flexDirection="column" paddingLeft={4}>
        {openTurn.messages.map((m, i) => (
          <React.Fragment key={m.id}>
            {renderMessage(m, i > 0 ? openTurn.messages[i - 1]! : null)}
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
}

// ── Turn row (in items-view) ───────────────────────────────────────

function TurnRow({
  turn,
  ambientKind,
  onOpen,
}: {
  turn: AmbientTurn;
  ambientKind: AmbientKind;
  onOpen: () => void;
}) {
  const time = new Date(turn.endMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Pull a one-line preview from the first text message's content.
  const preview = (turn.messages
    .find(m => m.kind === 'text')?.content ?? turn.summary)
    .replace(/\n/g, ' ')
    .slice(0, 80);

  return (
    <Box onClick={onOpen}>
      <Text color={COLORS.muted}>
        {'  '}{time}  <Text color={COLORS.subtle}>{preview}</Text>
      </Text>
    </Box>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function summaryFor(stack: AmbientStack): string {
  // Prefer the first turn's summary for consistency — crons, dreams,
  // etc. keep their human name even when stacked.
  return stack.turns[0]?.summary ?? stack.ambientKind;
}
