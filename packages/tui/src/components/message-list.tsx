import React from 'react';
import { Box, Text } from 'ink';
import type { ChannelMessage, Member } from '@agentcorp/shared';

interface Props {
  messages: ChannelMessage[];
  members: Member[];
}

function RainbowText({ children }: { children: string }) {
  // Use hex colors for a smooth gradient that looks good at any length
  const chars = children.split('');
  const len = Math.max(chars.length, 1);
  return (
    <Text bold>
      {chars.map((char, i) => {
        const hue = (i / len) * 300; // 0-300 range (red → magenta, skip wrapping back to red)
        const hex = hslToHex(hue, 80, 65);
        return <Text key={i} color={hex}>{char}</Text>;
      })}
    </Text>
  );
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Split message content into plain text and @mention segments. */
function renderContent(content: string, members: Map<string, Member>) {
  const parts: React.ReactNode[] = [];
  const mentionRegex = /@"([^"]+)"|@(\S+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(content)) !== null) {
    // Text before the mention
    if (match.index > lastIndex) {
      parts.push(<Text key={`t${lastIndex}`} wrap="wrap">{content.slice(lastIndex, match.index)}</Text>);
    }

    const mentionName = match[1] ?? match[2]!;
    const mentionedMember = [...members.values()].find(
      (m) => m.displayName.toLowerCase() === mentionName.toLowerCase(),
    );
    const isCeo = mentionedMember?.rank === 'master';

    if (isCeo) {
      parts.push(<RainbowText key={`m${match.index}`}>@{mentionName}</RainbowText>);
    } else {
      parts.push(<Text key={`m${match.index}`} bold color="yellow">@{mentionName}</Text>);
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < content.length) {
    parts.push(<Text key={`t${lastIndex}`} wrap="wrap">{content.slice(lastIndex)}</Text>);
  }

  return parts.length > 0 ? parts : <Text wrap="wrap">{content}</Text>;
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
        const isCeo = sender?.rank === 'master';

        return (
          <Box key={msg.id} flexDirection="column" marginBottom={1}>
            <Box gap={1}>
              {isCeo ? (
                <RainbowText>{name}</RainbowText>
              ) : (
                <Text bold color={isAgent ? 'cyan' : 'green'}>
                  {name}
                </Text>
              )}
              <Text dimColor>{time}</Text>
            </Box>
            <Text wrap="wrap">{renderContent(msg.content, memberMap)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
