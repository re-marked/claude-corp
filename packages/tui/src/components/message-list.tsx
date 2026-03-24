import React from 'react';
import { Box, Text } from 'ink';
import type { ChannelMessage, Member } from '@claudecorp/shared';
import { COLORS } from '../theme.js';

interface Props {
  messages: ChannelMessage[];
  members: Member[];
}

function RainbowText({ children }: { children: string }) {
  const text = typeof children === 'string' ? children : String(children);
  const chars = text.split('');
  const len = Math.max(chars.length, 1);
  return (
    <Text bold>
      {chars.map((char, i) => {
        const hue = (i / len) * 300;
        const hex = hslToHex(hue, 80, 65);
        return <Text key={i} color={hex}>{char}</Text>;
      })}
    </Text>
  );
}

export function hslToHex(h: number, s: number, l: number): string {
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

/** Wrap a URL in OSC 8 hyperlink escapes. Clickable in supporting terminals. */
function linkify(url: string): string {
  return `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
}

/** Render message content with @mentions highlighted and URLs clickable. */
export function renderContent(content: string | undefined | null, members: Map<string, Member>) {
  if (!content) return <Text wrap="wrap">{''}</Text>;
  const parts: React.ReactNode[] = [];
  // Combined regex: URLs or @mentions
  const combined = /https?:\/\/[^\s<>"'\)\]]+|@"([^"]+)"|@([A-Za-z0-9][\w-]*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = combined.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<Text key={`t${lastIndex}`} wrap="wrap">{content.slice(lastIndex, match.index)}</Text>);
    }

    if (match[0].startsWith('http')) {
      // URL — clickable via OSC 8
      parts.push(
        <Text key={`u${match.index}`} color={COLORS.info} underline>
          {linkify(match[0])}
        </Text>,
      );
    } else {
      // @mention
      const mentionName = match[1] ?? match[2]!;
      const mentionedMember = [...members.values()].find(
        (m) => m.displayName.toLowerCase() === mentionName.toLowerCase(),
      );
      const isCeo = mentionedMember?.rank === 'master';

      if (isCeo) {
        parts.push(<RainbowText key={`m${match.index}`}>{`@${mentionName}`}</RainbowText>);
      } else {
        parts.push(<Text key={`m${match.index}`} bold color={COLORS.secondary}>@{mentionName}</Text>);
      }
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push(<Text key={`t${lastIndex}`} wrap="wrap">{content.slice(lastIndex)}</Text>);
  }

  return parts.length > 0 ? parts : <Text wrap="wrap">{content}</Text>;
}

/** Get sender display color based on type/rank. */
function senderColor(sender: Member | undefined, senderId: string): string | undefined {
  if (!sender || senderId === 'system') return COLORS.system;
  if (sender.rank === 'master') return undefined; // rainbow handled separately
  if (sender.type === 'agent') return COLORS.agent;
  return COLORS.user;
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
        const isCeo = sender?.rank === 'master';
        const isSystem = msg.senderId === 'system' || msg.kind === 'system' || msg.kind === 'task_event';

        // System messages: dim, indented with ┊
        if (isSystem) {
          return (
            <Box key={msg.id} flexDirection="column" marginBottom={0}>
              <Text color={COLORS.muted}> ┊ {name} {time}</Text>
              <Text color={COLORS.muted}> ┊ {msg.content}</Text>
            </Box>
          );
        }

        return (
          <Box key={msg.id} flexDirection="column" marginBottom={1}>
            <Box gap={1}>
              {isCeo ? (
                <RainbowText>{name}</RainbowText>
              ) : (
                <Text bold color={senderColor(sender, msg.senderId)}>
                  {name}
                </Text>
              )}
              <Text color={COLORS.subtle}>{time}</Text>
            </Box>
            <Text wrap="wrap">{renderContent(msg.content, memberMap)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
