import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import {
  type Channel,
  type Member,
  type ChannelMessage,
  readConfig,
  appendMessage,
  generateId,
  MEMBERS_JSON,
  MESSAGES_JSONL,
} from '@agentcorp/shared';
import { join } from 'node:path';
import { MessageList } from '../components/message-list.js';
import { MessageInput } from '../components/message-input.js';
import { useMessages } from '../hooks/use-messages.js';
import { HireWizard } from './hire-wizard.js';
import { TaskWizard } from './task-wizard.js';
import type { DaemonClient } from '../lib/daemon-client.js';

const THINKING_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes — agents can work long

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
  const [thinkingAgents, setThinkingAgents] = useState<string[]>([]);
  const [members, setMembers] = useState(initialMembers);
  const [showHireWizard, setShowHireWizard] = useState(false);
  const [showTaskWizard, setShowTaskWizard] = useState(false);
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
    if (showHireWizard) return;
    if (key.tab || input === '\t') {
      onSwitchChannel?.();
    }
  });

  const writeSystemMessage = (content: string) => {
    const sysMsg: ChannelMessage = {
      id: generateId(),
      channelId: channel.id,
      senderId: 'system',
      threadId: null,
      content,
      kind: 'system',
      mentions: [],
      metadata: null,
      depth: 0,
      originId: '',
      timestamp: new Date().toISOString(),
    };
    sysMsg.originId = sysMsg.id;
    appendMessage(join(corpRoot, channel.path, MESSAGES_JSONL), sysMsg);
  };

  const handleHired = (agentName: string, displayName: string) => {
    // Write system message to current channel
    writeSystemMessage(`${displayName} has been hired as ${agentName}. You can now @mention them.`);
    // Refresh members
    try {
      const fresh = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
      setMembers(fresh);
    } catch {}
    // Close wizard after a moment
    setTimeout(() => setShowHireWizard(false), 1500);
  };

  const handleSend = useCallback(async (text: string) => {
    // /hire opens the wizard
    if (text.trim().toLowerCase() === '/hire') {
      setShowHireWizard(true);
      return;
    }

    // /task opens the task wizard
    if (text.trim().toLowerCase() === '/task') {
      setShowTaskWizard(true);
      return;
    }

    setSending(true);
    try {
      const { dispatching, dispatchTargets } = await daemonClient.sendMessage(channel.id, text);
      if (dispatching) {
        setThinking(true);
        setThinkingAgents(dispatchTargets);
      }
    } catch (err) {
      // Message send failed
    }
    setSending(false);
  }, [channel.id, daemonClient]);

  const founder = members.find((m) => m.rank === 'owner');

  const handleTaskCreated = (title: string) => {
    writeSystemMessage(`Task "${title}" created. Check #tasks for details.`);
    setTimeout(() => setShowTaskWizard(false), 1500);
  };

  if (showTaskWizard) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <TaskWizard
          daemonClient={daemonClient}
          founderId={founder?.id ?? ''}
          members={members}
          onClose={() => setShowTaskWizard(false)}
          onCreated={handleTaskCreated}
        />
      </Box>
    );
  }

  if (showHireWizard) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <HireWizard
          daemonClient={daemonClient}
          founderId={founder?.id ?? ''}
          onClose={() => setShowHireWizard(false)}
          onHired={handleHired}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle="single" borderColor="blue" paddingX={1}>
        <Text bold color="blue"># {channel.name}</Text>
        <Text dimColor>  Tab to switch  /hire  /task</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        <MessageList messages={messages} members={members} />
        {thinking && (
          <Box gap={1} marginTop={1}>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text dimColor>
              {thinkingAgents.length > 0
                ? `${thinkingAgents.join(', ')} ${thinkingAgents.length === 1 ? 'is' : 'are'} typing...`
                : 'Thinking...'}
            </Text>
          </Box>
        )}
      </Box>
      <MessageInput
        onSend={handleSend}
        disabled={sending}
        placeholder="Type a message... (/hire to add agents)"
      />
    </Box>
  );
}
