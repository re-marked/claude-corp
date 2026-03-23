import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { Member } from '@claudecorp/shared';
import { SpriteRenderer, spriteForRole } from '../sprites/index.js';
import type { SpriteState } from '../sprites/types.js';
import { COLORS, TASK_STATUS } from '../theme.js';

const COPPER = '#CD7F32';
const BRASS = '#DAA520';
const IRON = '#8B7355';

interface AgentInfo {
  member: Member;
  processStatus: string;
  lastActive: Date | null;
}

interface TaskCounts {
  pending: number;
  assigned: number;
  in_progress: number;
  completed: number;
  failed: number;
  blocked: number;
}

interface ActivityItem {
  channelName: string;
  channelId: string;
  senderName: string;
  content: string;
  timestamp: Date;
}

interface Props {
  agents: AgentInfo[];
  taskCounts: TaskCounts;
  activity: ActivityItem[];
}

function toSpriteState(status: string): SpriteState {
  switch (status) {
    case 'working':
      return 'working';
    case 'starting':
      return 'walking';
    case 'ready':
      return 'idle';
    default:
      return 'idle';
  }
}

/** Get a truncated "micro-talk" from recent activity for an agent. */
function microTalk(agent: AgentInfo, activity: ActivityItem[]): string {
  const msg = activity.find(
    (a) => a.senderName === agent.member.displayName,
  );
  if (!msg) return agent.processStatus;
  const preview = msg.content.replace(/\n/g, ' ').slice(0, 14);
  return `"${preview}${msg.content.length > 14 ? '…' : ''}"`;
}

const BELT_PATTERN = '═══◆═══════◆═══════◇═══════';

function renderBelt(offset: number, width: number): string {
  const extended = BELT_PATTERN.repeat(4);
  const start = offset % BELT_PATTERN.length;
  return extended.slice(start, start + width) + '▶';
}

export function FactoryFloor({ agents, taskCounts, activity }: Props) {
  const [beltOffset, setBeltOffset] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setBeltOffset((o) => o + 1), 400);
    return () => clearInterval(t);
  }, []);

  const totalTasks = Object.values(taskCounts).reduce((a, b) => a + b, 0);

  // Cap visible agents at 5 for terminal width
  const visibleAgents = agents.slice(0, 5);
  const overflow = agents.length - visibleAgents.length;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Foundry header */}
      <Box
        borderStyle="round"
        borderColor={COPPER}
        paddingX={1}
        justifyContent="space-between"
      >
        <Text bold color={COPPER}>
          {'⚙ THE FOUNDRY ⚙'}
        </Text>
        <Box gap={2}>
          <Text color={agents.some((a) => a.processStatus === 'ready') ? COLORS.success : COLORS.muted}>
            {agents.filter((a) => a.processStatus === 'ready' || a.processStatus === 'working').length}/
            {agents.length} online
          </Text>
          <Text color={totalTasks > 0 ? COLORS.subtle : COLORS.muted}>
            {totalTasks} task{totalTasks !== 1 ? 's' : ''}
          </Text>
        </Box>
      </Box>

      {/* Pipe header — gears connected by pipes */}
      {visibleAgents.length > 0 && (
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          <Text color={IRON}>
            {visibleAgents.map((_, i) => (i === 0 ? '⚙' : '═══════════⚙')).join('')}
          </Text>
          <Text color={IRON}>
            {visibleAgents.map((_, i) => (i === 0 ? '║' : '            ║')).join('')}
          </Text>
        </Box>
      )}

      {/* Agent stations */}
      {visibleAgents.length === 0 ? (
        <Box marginTop={1} paddingX={2}>
          <Text color={COLORS.muted}>No agents yet. Use /hire to recruit workers for your factory.</Text>
        </Box>
      ) : (
        <Box flexDirection="row" marginTop={0}>
          {visibleAgents.map((agent, i) => (
            <React.Fragment key={agent.member.id}>
              <Box flexDirection="column" alignItems="center" width={13}>
                <SpriteRenderer
                  sprite={spriteForRole(agent.member.rank)}
                  state={toSpriteState(agent.processStatus)}
                />
                <Text bold color={BRASS}>{agent.member.displayName}</Text>
                <Text color={COLORS.muted} dimColor>
                  {microTalk(agent, activity)}
                </Text>
              </Box>
              {i < visibleAgents.length - 1 && (
                <Box alignItems="center" justifyContent="center">
                  <Text color={IRON}>═▶</Text>
                </Box>
              )}
            </React.Fragment>
          ))}
          {overflow > 0 && (
            <Box alignItems="center" paddingX={1}>
              <Text color={COLORS.muted}>+{overflow} more</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Conveyor belt */}
      <Box marginTop={1} flexDirection="column" paddingX={1}>
        <Text bold color={IRON}>CONVEYOR</Text>
        <Text color={COPPER}>{renderBelt(beltOffset, 55)}</Text>
      </Box>

      {/* Task summary — same data as regular corp-home */}
      <Box
        borderStyle="round"
        borderColor={COLORS.border}
        paddingX={1}
        gap={1}
        marginTop={1}
      >
        <Text color={COLORS.muted} bold>TASKS</Text>
        {taskCounts.in_progress > 0 && (
          <Text color={TASK_STATUS.in_progress.color}>
            {TASK_STATUS.in_progress.icon} {taskCounts.in_progress} active
          </Text>
        )}
        {taskCounts.assigned > 0 && (
          <Text color={TASK_STATUS.assigned.color}>
            {TASK_STATUS.assigned.icon} {taskCounts.assigned} assigned
          </Text>
        )}
        {taskCounts.pending > 0 && (
          <Text color={TASK_STATUS.pending.color}>
            {TASK_STATUS.pending.icon} {taskCounts.pending} pending
          </Text>
        )}
        {taskCounts.completed > 0 && (
          <Text color={TASK_STATUS.completed.color}>
            {TASK_STATUS.completed.icon} {taskCounts.completed} done
          </Text>
        )}
        {taskCounts.failed > 0 && (
          <Text color={TASK_STATUS.failed.color}>
            {TASK_STATUS.failed.icon} {taskCounts.failed} failed
          </Text>
        )}
        {taskCounts.blocked > 0 && (
          <Text color={TASK_STATUS.blocked.color}>
            {TASK_STATUS.blocked.icon} {taskCounts.blocked} blocked
          </Text>
        )}
        {totalTasks === 0 && <Text color={COLORS.muted}>none yet</Text>}
      </Box>

      {/* Recent micro-activity */}
      {activity.length > 0 && (
        <Box flexDirection="column" paddingX={1} marginTop={1} flexGrow={1}>
          <Text bold color={IRON}>FACTORY LOG</Text>
          {activity.slice(0, 5).map((item, i) => (
            <Box key={i} gap={1}>
              <Text color={COLORS.muted}>
                {item.senderName.slice(0, 8).padEnd(9)}
              </Text>
              <Text color={COLORS.subtle} wrap="truncate">
                {item.content.replace(/\n/g, ' ').slice(0, 50)}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
