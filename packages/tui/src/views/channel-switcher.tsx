import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { Channel } from '@agentcorp/shared';

interface Props {
  channels: Channel[];
  currentChannelId: string;
  onSelect: (channel: Channel) => void;
  onClose: () => void;
}

export function ChannelSwitcher({ channels, currentChannelId, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = channels.filter((c) =>
    c.name.toLowerCase().includes(query.toLowerCase()),
  );

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
      if (selected) {
        onSelect(selected);
      }
      return;
    }
  });

  // Reset selection when filter changes
  const handleQueryChange = (v: string) => {
    setQuery(v);
    setSelectedIndex(0);
  };

  const kindLabel = (kind: Channel['kind']) => {
    switch (kind) {
      case 'direct': return 'dm';
      case 'broadcast': return 'all';
      case 'team': return 'team';
      case 'system': return 'sys';
    }
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={0}
      width={50}
    >
      <Box marginBottom={0}>
        <Text bold color="cyan">Switch Channel</Text>
        <Text dimColor>  (Esc to close)</Text>
      </Box>
      <Box>
        <Text bold color="green">&gt; </Text>
        <TextInput
          value={query}
          onChange={handleQueryChange}
          placeholder="Search channels..."
        />
      </Box>
      <Box flexDirection="column" marginTop={0}>
        {filtered.map((ch, i) => {
          const isCurrent = ch.id === currentChannelId;
          const isSelected = i === selectedIndex;
          return (
            <Box key={ch.id} gap={1}>
              <Text
                color={isSelected ? 'cyan' : isCurrent ? 'green' : undefined}
                bold={isSelected}
              >
                {isSelected ? '>' : ' '} # {ch.name}
              </Text>
              <Text dimColor>{kindLabel(ch.kind)}</Text>
            </Box>
          );
        })}
        {filtered.length === 0 && (
          <Text dimColor>  No channels match</Text>
        )}
      </Box>
    </Box>
  );
}
