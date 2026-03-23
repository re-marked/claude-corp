import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ChannelMessage, Member } from '@claudecorp/shared';
import { SpriteRenderer, spriteForRole } from '../sprites/index.js';
import type { SpriteState } from '../sprites/types.js';
import { COLORS } from '../theme.js';

const COPPER = '#CD7F32';
const BRASS = '#DAA520';

interface Props {
  agent: Member;
  messages: ChannelMessage[];
  members: Member[];
  streamData?: { agentName: string; content: string; channelId: string } | null;
  thinking: boolean;
  thinkingAgents: string[];
  dispatchingAgents: string[];
}

export function DialogueRenderer({
  agent,
  messages,
  streamData,
  thinking,
  thinkingAgents,
  dispatchingAgents,
}: Props) {
  const isWorking =
    thinking ||
    dispatchingAgents.includes(agent.displayName) ||
    thinkingAgents.includes(agent.displayName);
  const isStreaming = !!streamData?.content;

  // Stash the last stream content so it persists until the real message lands
  const lastStreamRef = useRef<string | null>(null);
  if (isStreaming) {
    lastStreamRef.current = streamData!.content;
  }

  const spriteState: SpriteState = isStreaming
    ? 'talking'
    : isWorking
      ? 'working'
      : 'idle';

  const sprite = spriteForRole(agent.rank);

  // Latest agent message — don't filter by kind, just exclude system
  const agentMessages = messages.filter(
    (m) => m.senderId === agent.id && m.kind !== 'system' && m.kind !== 'task_event',
  );
  const latestAgentMsg = agentMessages[agentMessages.length - 1];

  // Clear stashed stream once a real message arrives that matches it
  useEffect(() => {
    if (latestAgentMsg && lastStreamRef.current) {
      lastStreamRef.current = null;
    }
  }, [latestAgentMsg?.id]);

  // What to show in the bubble: stream > real message > stashed stream > nothing
  const bubbleContent = isStreaming
    ? streamData!.content
    : latestAgentMsg?.content ?? lastStreamRef.current;

  return (
    <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
      {/* Portrait centered */}
      <SpriteRenderer sprite={sprite} state={spriteState} />

      {/* Agent name + status */}
      <Box marginTop={1} gap={2}>
        <Text bold color={COPPER}>{agent.displayName}</Text>
        <Text color={isWorking || isStreaming ? COLORS.info : COLORS.success}>
          {isWorking ? '◆ working' : isStreaming ? '◆ talking' : '◆ active'}
        </Text>
      </Box>

      {/* Speech bubble */}
      <Box
        borderStyle="round"
        borderColor={isStreaming ? COPPER : BRASS}
        paddingX={2}
        paddingY={1}
        marginTop={1}
        width="80%"
        flexGrow={1}
      >
        {isStreaming ? (
          <Box flexDirection="column" width="100%">
            <Box gap={1} marginBottom={1}>
              <Text color={COLORS.primary}>
                <Spinner type="dots" />
              </Text>
              <Text color={COLORS.subtle}>{streamData!.agentName} is speaking...</Text>
            </Box>
            <Text wrap="wrap" color={COLORS.text}>
              {streamData!.content}
            </Text>
          </Box>
        ) : isWorking ? (
          <Box gap={1}>
            <Text color={COLORS.primary}>
              <Spinner type="dots" />
            </Text>
            <Text color={COLORS.subtle}>
              {agent.displayName} is thinking...
            </Text>
          </Box>
        ) : bubbleContent ? (
          <Text wrap="wrap" color={COLORS.text}>
            {bubbleContent}
          </Text>
        ) : (
          <Text color={COLORS.muted} italic>
            Say something to {agent.displayName}...
          </Text>
        )}
      </Box>
    </Box>
  );
}
