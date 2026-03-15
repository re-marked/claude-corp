import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { type Channel, type Member, readConfig, MEMBERS_JSON } from '@agentcorp/shared';
import { join } from 'node:path';
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
  corpRoot: string;
  onSwitchChannel?: () => void;
}

export function ChatView({ channel, members: initialMembers, messagesPath, daemonClient, corpRoot, onSwitchChannel }: Props) {
  const messages = useMessages(messagesPath);
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [members, setMembers] = useState(initialMembers);
  const lastMsgCount = useRef(messages.length);

  // Refresh members when new messages arrive (new agents may have been hired)
  useEffect(() => {
    if (messages.length > lastMsgCount.current) {
      try {
        const fresh = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
        if (fresh.length !== members.length) {
          setMembers(fresh);
        }
      } catch {
        // Non-fatal
      }
    }
  }, [messages.length]);

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

  useInput((input, key) => {
    if (key.tab || input === '\t') {
      onSwitchChannel?.();
    }
  });

  const handleSend = useCallback(async (text: string) => {
    // Handle /hire command: /hire <agentName> "<displayName>" <rank> [description]
    const hireMatch = text.match(/^\/hire\s+(\S+)\s+"([^"]+)"\s+(leader|worker|subagent)(?:\s+(.+))?$/);
    if (hireMatch) {
      setSending(true);
      const founder = members.find((m) => m.rank === 'owner');
      if (!founder) {
        setSending(false);
        return;
      }
      try {
        const [, agentName, displayName, rank, description] = hireMatch;
        const soulContent = description
          ? `# Identity\n\nYou are ${displayName}. ${description}\n\n# Communication Style\n\nClear, professional, focused on results.`
          : undefined;
        await daemonClient.hireAgent({
          creatorId: founder.id,
          agentName: agentName!,
          displayName: displayName!,
          rank: rank!,
          soulContent,
        });
        // Refresh members
        try {
          const fresh = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
          setMembers(fresh);
        } catch {}
      } catch (err) {
        console.error('[tui] Hire failed:', err);
      }
      setSending(false);
      return;
    }

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
  }, [channel.id, daemonClient, members, corpRoot]);

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
