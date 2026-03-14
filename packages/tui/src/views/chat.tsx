import React, { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
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
}

export function ChatView({ channel, members, messagesPath, daemonClient }: Props) {
  const messages = useMessages(messagesPath);
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async (text: string) => {
    setSending(true);
    try {
      await daemonClient.sendMessage(channel.id, text);
    } catch (err) {
      // Message send failed — will be visible in the TUI
    }
    setSending(false);
  }, [channel.id, daemonClient]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle="single" borderColor="blue" paddingX={1}>
        <Text bold color="blue"># {channel.name}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        <MessageList messages={messages} members={members} />
      </Box>
      <MessageInput
        onSend={handleSend}
        disabled={sending}
        placeholder={sending ? 'CEO is thinking...' : 'Type a message...'}
      />
    </Box>
  );
}
