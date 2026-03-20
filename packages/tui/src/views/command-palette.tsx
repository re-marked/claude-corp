import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { join } from 'node:path';
import { type Channel, type Member, tailMessages, MESSAGES_JSONL } from '@claudecorp/shared';
import { COLORS, BORDER_STYLE } from '../theme.js';
import type { View } from '../navigation.js';

interface PaletteItem {
  id: string;
  label: string;
  kind: 'channel' | 'agent' | 'view' | 'command' | 'project';
  icon: string;
  action: () => void;
}

interface Props {
  channels: Channel[];
  members: Member[];
  corpRoot: string;
  lastVisited: Map<string, string>;
  onNavigate: (view: View) => void;
  onSelectChannel: (channel: Channel) => void;
  onCommand: (cmd: string) => void;
  onClose: () => void;
}

export function CommandPalette({ channels, members, corpRoot, lastVisited, onNavigate, onSelectChannel, onCommand, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const agents = members.filter((m) => m.type === 'agent');

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
    } catch {
      // Channel may not have messages yet
    }
  }

  // Build all items
  const items: PaletteItem[] = [
    // Views
    { id: 'v-home', label: 'Corp Home', kind: 'view', icon: '◆', action: () => onNavigate({ type: 'corp-home' }) },
    { id: 'v-hierarchy', label: 'Hierarchy', kind: 'view', icon: '◇', action: () => onNavigate({ type: 'hierarchy' }) },
    { id: 'v-tasks', label: 'Task Board', kind: 'view', icon: '◆', action: () => onNavigate({ type: 'task-board' }) },
    // Commands
    { id: 'c-hire', label: '/hire', kind: 'command', icon: '▸', action: () => onCommand('hire') },
    { id: 'c-task', label: '/task', kind: 'command', icon: '▸', action: () => onCommand('task') },
    { id: 'c-project', label: '/project', kind: 'project', icon: '▸', action: () => onCommand('project') },
    { id: 'c-team', label: '/team', kind: 'command', icon: '▸', action: () => onCommand('team') },
    { id: 'c-dogfood', label: '/dogfood', kind: 'command', icon: '▸', action: () => onCommand('dogfood') },
    // Channels
    ...channels.map((ch) => ({
      id: `ch-${ch.id}`,
      label: unreadChannels.has(ch.id) ? `#${ch.name} ●` : `#${ch.name}`,
      kind: 'channel' as const,
      icon: ch.kind === 'direct' ? '◆' : '#',
      action: () => onSelectChannel(ch),
    })),
    // Agents
    ...agents.map((m) => ({
      id: `ag-${m.id}`,
      label: m.displayName,
      kind: 'agent' as const,
      icon: '◆',
      action: () => onNavigate({ type: 'agent-inspector', memberId: m.id }),
    })),
  ];

  // Filter
  const q = query.toLowerCase();
  const filtered = q
    ? items.filter((item) => item.label.toLowerCase().includes(q) || item.kind.includes(q))
    : items;

  useInput((input, key) => {
    if (key.escape || key.tab || input === '\t') {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const selected = filtered[selectedIndex];
      if (selected) selected.action();
      return;
    }
  });

  const handleQueryChange = (v: string) => {
    setQuery(v);
    setSelectedIndex(0);
  };

  const kindColor: Record<string, string> = {
    channel: COLORS.primary,
    agent: COLORS.secondary,
    view: COLORS.subtle,
    command: COLORS.success,
    project: COLORS.info,
  };

  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER_STYLE}
      borderColor={COLORS.primary}
      paddingX={2}
      paddingY={1}
      width={60}
      alignSelf="center"
    >
      <Box>
        <Text bold color={COLORS.primary}>&gt; </Text>
        <TextInput
          value={query}
          onChange={handleQueryChange}
          placeholder="Search channels, agents, views..."
        />
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {(() => {
          const maxVisible = 20;
          let start = 0;
          if (selectedIndex >= maxVisible) {
            start = selectedIndex - maxVisible + 1;
          }
          return filtered.slice(start, start + maxVisible);
        })().map((item, i) => {
          const maxVisible = 20;
          const start = selectedIndex >= maxVisible ? selectedIndex - maxVisible + 1 : 0;
          const actualIndex = start + i;
          const isSelected = actualIndex === selectedIndex;
          return (
            <Box key={item.id} gap={1}>
              <Text color={isSelected ? COLORS.primary : COLORS.muted}>
                {isSelected ? '▸' : ' '}
              </Text>
              <Text
                bold={isSelected}
                color={isSelected ? COLORS.text : COLORS.subtle}
              >
                {item.label}
              </Text>
              <Text color={kindColor[item.kind] ?? COLORS.muted}>{item.kind}</Text>
            </Box>
          );
        })}
        {filtered.length === 0 && (
          <Text color={COLORS.muted}>  No results</Text>
        )}
        {filtered.length > 20 && (
          <Text color={COLORS.muted}>  +{filtered.length - 20} more — type to filter</Text>
        )}
      </Box>
    </Box>
  );
}
