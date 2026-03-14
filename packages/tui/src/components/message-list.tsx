import React from 'react';
import { Box, Text } from 'ink';
import type { ChannelMessage, Member } from '@agentcorp/shared';

interface Props {
  messages: ChannelMessage[];
  members: Member[];
}

export function MessageList({ messages, members }: Props) {
  const memberMap = new Map(members.map((m) => [m.id, m]));

  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg) => {
        const sender = memberMap.get(msg.senderId);
        const name = sender?.displayName ?? 'system';
        const time = new Date(msg.timestamp).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        const isAgent = sender?.type === 'agent';

        return (
          <Box key={msg.id} flexDirection="column" marginBottom={1}>
            <Box gap={1}>
              <Text bold color={isAgent ? 'cyan' : 'green'}>
                {name}
              </Text>
              <Text dimColor>{time}</Text>
            </Box>
            <Text wrap="wrap">{msg.content}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
