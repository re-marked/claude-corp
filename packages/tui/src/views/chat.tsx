import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { Channel, Member } from '@agentcorp/shared';
import { MessageList } from '../components/message-list.js';
import { MessageInput } from '../components/message-input.js';
import { useMessages } from '../hooks/use-messages.js';
import type { DaemonClient } from '../lib/daemon-client.js';

interface Props {
  channel: Channel;
  members: Member[];
  messagesPath: string;
  daemonClient: DaemonClient;
  onSwitchChannel?: () => void;
}

export function ChatView({ channel, members, messagesPath, daemonClient, onSwitchChannel }: Props) {
  const messages = useMessages(messagesPath);
  const [sending, setSending] = useState(false);

  // Show thinking indicator only in DM channels when last message is from user
  const lastMsg = messages[messages.length - 1];
  const founder = members.find((m) => m.rank === 'owner');
  const waiting = channel.kind === 'direct' && lastMsg && founder && lastMsg.senderId === founder.id;

  useInput((input, key) => {
    if (key.ctrl && input === 'k') {
      onSwitchChannel?.();
    }
  });

  const handleSend = useCallback(async (text: string) => {
    setSending(true);
    try {
      await daemonClient.sendMessage(channel.id, text);
    } catch (err) {
      // Message send failed
    }
    setSending(false);
  }, [channel.id, daemonClient]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle="single" borderColor="blue" paddingX={1}>
        <Text bold color="blue"># {channel.name}</Text>
        <Text dimColor>  Ctrl+K to switch</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        <MessageList messages={messages} members={members} />
        {waiting && !sending && (
          <Box gap={1} marginTop={1}>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text dimColor>Thinking...</Text>
          </Box>
        )}
      </Box>
      <MessageInput
        onSend={handleSend}
        disabled={sending}
        placeholder="Type a message..."
      />
    </Box>
  );
}
