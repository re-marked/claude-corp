import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { Channel, Member } from '@agentcorp/shared';
import { MessageList } from '../components/message-list.js';
import { MessageInput } from '../components/message-input.js';
import { useMessages } from '../hooks/use-messages.js';
import type { DaemonClient } from '../lib/daemon-client.js';

const THINKING_TIMEOUT_MS = 30_000;

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
  const [thinking, setThinking] = useState(false);
  const lastMsgCount = useRef(messages.length);

  // When a new message arrives from someone else, stop thinking
  useEffect(() => {
    if (messages.length > lastMsgCount.current) {
      const newMsg = messages[messages.length - 1];
      const founder = members.find((m) => m.rank === 'owner');
      if (newMsg && founder && newMsg.senderId !== founder.id) {
        setThinking(false);
      }
    }
    lastMsgCount.current = messages.length;
  }, [messages.length]);

  // Timeout the spinner
  useEffect(() => {
    if (!thinking) return;
    const timer = setTimeout(() => setThinking(false), THINKING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [thinking]);

  useInput((_input, key) => {
    if (key.tab) {
      onSwitchChannel?.();
    }
  });

  const handleSend = useCallback(async (text: string) => {
    setSending(true);
    try {
      const { dispatching } = await daemonClient.sendMessage(channel.id, text);
      if (dispatching) {
        setThinking(true);
      }
    } catch (err) {
      // Message send failed
    }
    setSending(false);
  }, [channel.id, daemonClient]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle="single" borderColor="blue" paddingX={1}>
        <Text bold color="blue"># {channel.name}</Text>
        <Text dimColor>  Tab to switch</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        <MessageList messages={messages} members={members} />
        {thinking && (
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
