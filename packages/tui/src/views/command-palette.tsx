import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { join } from 'node:path';
import { type Channel, tailMessages, MESSAGES_JSONL } from '@claudecorp/shared';
import { COLORS, BORDER_STYLE } from '../theme.js';
import type { View } from '../navigation.js';
import { useCorp } from '../context/corp-context.js';

type PaletteItemKind = 'view' | 'channel' | 'agent';

interface PaletteItem {
  id: string;
  label: string;
  kind: PaletteItemKind;
  icon: string;
  action: () => void;
  isHeader?: boolean;
}

interface Props {
  lastVisited: Map<string, string>;
  onNavigate: (view: View) => void;
  onSelectChannel: (channel: Channel) => void;
  onCommand: (cmd: string) => void;
  onClose: () => void;
}

export function CommandPalette({ lastVisited, onNavigate, onSelectChannel, onClose }: Props) {
  const { channels, members, corpRoot } = useCorp();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Check which channels have unread messages
  const unreadChannels = new Set<string>();
  for (const ch of channels) {
    try {
      const msgs = tailMessages(join(corpRoot, ch.path, MESSAGES_JSONL), 1);
      if (msgs.length > 0) {
        const lastMsgTime = msgs[0]!.timestamp;
        const visitedTime = lastVisited.get(ch.id);
        if (!visitedTime || lastMsgTime > visitedTime) {
          unreadChannels.add(ch.id);
        }
      }
    } catch {}
  }

  // Non-DM channels only
  const corpChannels = channels.filter(ch => ch.kind !== 'direct');

  // Build sectioned items
  const allItems: PaletteItem[] = [];

  // --- Views ---
  allItems.push({ id: 'h-views', label: 'Views', kind: 'view', icon: '', action: () => {}, isHeader: true });
  allItems.push({ id: 'v-home', label: 'Corp Home', kind: 'view', icon: '\u25C6', action: () => onNavigate({ type: 'corp-home' }) });
  allItems.push({ id: 'v-tasks', label: 'Task Board', kind: 'view', icon: '\u25C6', action: () => onNavigate({ type: 'task-board' }) });

  // --- Channels ---
  allItems.push({ id: 'h-channels', label: 'Channels', kind: 'channel', icon: '', action: () => {}, isHeader: true });
  for (const ch of corpChannels) {
    const unread = unreadChannels.has(ch.id) ? ' \u25CF' : '';
    allItems.push({
      id: `ch-${ch.id}`,
      label: `#${ch.name}${unread}`,
      kind: 'channel',
      icon: '#',
      action: () => onSelectChannel(ch),
    });
  }

  // --- Agents ---
  allItems.push({ id: 'h-agents', label: 'Agents', kind: 'agent', icon: '', action: () => {}, isHeader: true });
  allItems.push({
    id: 'v-hierarchy',
    label: 'Agent Hierarchy \u2192',
    kind: 'agent',
    icon: '\u25C7',
    action: () => onNavigate({ type: 'hierarchy' }),
  });

  // Filter
  const q = query.toLowerCase();
  const filtered = q
    ? allItems.filter(item => !item.isHeader && item.label.toLowerCase().includes(q))
    : allItems;

  // Get selectable items (skip headers)
  const selectableIndices = filtered.map((item, i) => item.isHeader ? -1 : i).filter(i => i >= 0);

  // Map selectedIndex to actual filtered array index
  const actualIndex = selectableIndices[selectedIndex] ?? 0;

  useInput((input, key) => {
    if (key.ctrl && input === 'k') { onClose(); return; }
    if (key.escape || key.tab || input === '\t') { onClose(); return; }
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(i => Math.min(selectableIndices.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const selected = filtered[actualIndex];
      if (selected && !selected.isHeader) selected.action();
      return;
    }
  });

  const handleQueryChange = (v: string) => {
    setQuery(v);
    setSelectedIndex(0);
  };

  const kindColor: Record<string, string> = {
    view: COLORS.subtle,
    channel: COLORS.primary,
    agent: COLORS.secondary,
  };

  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER_STYLE}
      borderColor={COLORS.primary}
      paddingX={2}
      paddingY={1}
      width={50}
      alignSelf="center"
    >
      <Box>
        <Text bold color={COLORS.primary}>&gt; </Text>
        <TextInput
          value={query}
          onChange={handleQueryChange}
          placeholder="Search..."
        />
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {filtered.slice(0, 20).map((item, i) => {
          if (item.isHeader) {
            return (
              <Box key={item.id} marginTop={i > 0 ? 1 : 0}>
                <Text bold color={COLORS.muted}>  {item.label}</Text>
              </Box>
            );
          }
          const isSelected = i === actualIndex;
          return (
            <Box key={item.id} gap={1}>
              <Text color={isSelected ? COLORS.primary : COLORS.muted}>
                {isSelected ? '\u25B8' : ' '}
              </Text>
              <Text color={isSelected ? COLORS.text : COLORS.subtle}>
                {item.icon} {item.label}
              </Text>
            </Box>
          );
        })}
        {filtered.length === 0 && (
          <Text color={COLORS.muted}>  No results</Text>
        )}
      </Box>
    </Box>
  );
}
