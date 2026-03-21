import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  type Member,
  type Channel,
  type Corporation,
  type ChannelMessage,
  readConfig,
  readConfigOr,
  tailMessages,
  listTasks,
  MEMBERS_JSON,
  CHANNELS_JSON,
  CORP_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import { COLORS, TASK_STATUS, BORDER_STYLE } from '../theme.js';
import { CLAUDE_CORP_LOGO } from '../ascii.js';
import { useCorp } from '../context/corp-context.js';
import type { View } from '../navigation.js';

interface Props {
  onNavigate: (view: View) => void;
}

interface ActivityItem {
  channelName: string;
  channelId: string;
  senderName: string;
  content: string;
  kind: ChannelMessage['kind'];
  timestamp: Date;
}

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

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function truncate(s: string, max: number): string {
  const cleaned = s.replace(/\n/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1) + '\u2026';
}

export function CorpHome({ onNavigate }: Props) {
  const { corpRoot, daemonClient, members: ctxMembers, channels: ctxChannels } = useCorp();
  const [members, setMembers] = useState<Member[]>(ctxMembers);
  const [channels, setChannels] = useState<Channel[]>(ctxChannels);
  const [corp, setCorp] = useState<Corporation | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [taskCounts, setTaskCounts] = useState<TaskCounts>({
    pending: 0, assigned: 0, in_progress: 0, completed: 0, failed: 0, blocked: 0,
  });
  const [cursor, setCursor] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const m = readConfigOr<Member[]>(join(corpRoot, MEMBERS_JSON), []);
      const c = readConfigOr<Channel[]>(join(corpRoot, CHANNELS_JSON), []);
      setMembers(m);
      setChannels(c);

      try {
        setCorp(readConfig<Corporation>(join(corpRoot, CORP_JSON)));
      } catch {}

      // Build last-active map from recent messages across all channels
      const lastActive = new Map<string, Date>();
      const items: ActivityItem[] = [];

      for (const ch of c) {
        try {
          const msgPath = join(corpRoot, ch.path, MESSAGES_JSONL);
          if (!existsSync(msgPath)) continue;
          const recent = tailMessages(msgPath, 5);
          for (const msg of recent) {
            // Track last active per sender
            const msgTime = new Date(msg.timestamp);
            const existing = lastActive.get(msg.senderId);
            if (!existing || msgTime > existing) {
              lastActive.set(msg.senderId, msgTime);
            }

            const sender = m.find((mem) => mem.id === msg.senderId);
            items.push({
              channelName: ch.name,
              channelId: ch.id,
              senderName: sender?.displayName ?? (msg.senderId === 'system' ? 'System' : '?'),
              content: msg.content,
              kind: msg.kind,
              timestamp: msgTime,
            });
          }
        } catch {}
      }

      items.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      setActivity(items.slice(0, 15));

      // Get live agent status + active dispatches from daemon
      let procStatuses: Record<string, string> = {};
      let dispatchingNames: string[] = [];
      try {
        const statusResult = await daemonClient.status();
        for (const a of statusResult.agents) {
          procStatuses[a.memberId] = a.status;
        }
        dispatchingNames = (statusResult as any).dispatching ?? [];
      } catch {}

      const agentInfos: AgentInfo[] = m
        .filter((mem) => mem.type === 'agent')
        .map((mem) => ({
          member: mem,
          processStatus: dispatchingNames.includes(mem.displayName)
            ? 'working'
            : procStatuses[mem.id] ?? (mem.status === 'active' ? 'ready' : 'stopped'),
          lastActive: lastActive.get(mem.id) ?? null,
        }));
      setAgents(agentInfos);

      // Task counts
      try {
        const tasks = listTasks(corpRoot);
        const counts: TaskCounts = {
          pending: 0, assigned: 0, in_progress: 0, completed: 0, failed: 0, blocked: 0,
        };
        for (const t of tasks) {
          const s = t.task.status as keyof TaskCounts;
          if (s in counts) counts[s]++;
        }
        setTaskCounts(counts);
      } catch {}
    } catch {}
  }, [corpRoot, daemonClient]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Update tab title with live status
  useEffect(() => {
    const online = agents.filter((a) => a.processStatus === 'ready').length;
    const name = corp?.displayName ?? 'Claude Corp';
    const icon = online > 0 ? '\u25C6' : '\u25C7';
    process.stdout.write(`\x1b]0;${name} ${icon} ${online} online\x07`);
  }, [agents, corp]);

  useInput((_input, key) => {
    if (key.upArrow) {
      setCursor((i) => Math.max(0, i - 1));
    }
    if (key.downArrow) {
      setCursor((i) => Math.min(activity.length - 1, i + 1));
    }
    if (key.return) {
      const item = activity[cursor];
      if (item) {
        onNavigate({ type: 'chat', channelId: item.channelId });
      }
    }
    // Ctrl+D, Ctrl+K, Ctrl+T, Ctrl+H, Escape handled globally in app.tsx
  });

  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 40;

  const totalTasks = Object.values(taskCounts).reduce((a, b) => a + b, 0);
  const onlineCount = agents.filter((a) => a.processStatus === 'ready').length;

  const PROC_STATUS: Record<string, { icon: string; color: string; label: string }> = {
    ready: { icon: '\u25C6', color: COLORS.success, label: 'online' },
    working: { icon: '\u25C6', color: COLORS.info, label: 'working...' },
    starting: { icon: '\u25C6', color: COLORS.warning, label: 'starting' },
    stopped: { icon: '\u25C7', color: COLORS.muted, label: 'offline' },
    crashed: { icon: '\u25C7', color: COLORS.danger, label: 'crashed' },
  };

  return (
    <Box flexDirection="column" flexGrow={1} height={Math.floor(termHeight * 0.9)}>
      {/* ASCII logo */}
      <Box justifyContent="center" paddingY={0}>
        <Text color={COLORS.primary}>{CLAUDE_CORP_LOGO}</Text>
      </Box>
      {/* Corp header */}
      <Box
        borderStyle={BORDER_STYLE}
        borderColor={COLORS.primary}
        paddingX={1}
        justifyContent="space-between"
      >
        <Text color={COLORS.primary} bold>
          {corp?.displayName ?? 'Corp'}
        </Text>
        <Box gap={2}>
          <Text color={onlineCount > 0 ? COLORS.success : COLORS.muted}>
            {onlineCount}/{agents.length} online
          </Text>
          <Text color={totalTasks > 0 ? COLORS.subtle : COLORS.muted}>
            {totalTasks} task{totalTasks !== 1 ? 's' : ''}
          </Text>
        </Box>
      </Box>

      {/* Agent grid */}
      <Box
        borderStyle={BORDER_STYLE}
        borderColor={COLORS.border}
        flexDirection="column"
        paddingX={1}
      >
        <Text color={COLORS.muted} bold>
          AGENTS
        </Text>
        {agents.length === 0 ? (
          <Text color={COLORS.muted}> No agents yet. Use /hire to recruit.</Text>
        ) : (
          <Box flexDirection="column">
            {Array.from({ length: Math.ceil(agents.length / 2) }, (_, i) => {
              const a1 = agents[i * 2]!;
              const a2 = agents[i * 2 + 1];
              return (
                <Box key={i}>
                  <AgentChip agent={a1} statusMap={PROC_STATUS} />
                  {a2 && <AgentChip agent={a2} statusMap={PROC_STATUS} />}
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* Activity feed */}
      <Box
        borderStyle={BORDER_STYLE}
        borderColor={COLORS.border}
        flexDirection="column"
        paddingX={1}
        flexGrow={1}
      >
        <Text color={COLORS.muted} bold>
          ACTIVITY
        </Text>
        {activity.length === 0 ? (
          <Text color={COLORS.muted}> No activity yet. Press d to chat with your CEO.</Text>
        ) : (
          <Box flexDirection="column">
            {activity.map((item, i) => {
              const selected = i === cursor;
              const isEvent = item.kind === 'task_event';
              const isSys = item.kind === 'system';
              return (
                <Box key={`${item.channelId}-${item.timestamp.getTime()}-${i}`}>
                  <Text color={selected ? COLORS.primary : COLORS.muted}>
                    {selected ? '\u25B8 ' : '  '}
                  </Text>
                  <Text color={COLORS.muted}>
                    {`#${item.channelName}`.substring(0, 15).padEnd(16)}
                  </Text>
                  <Text
                    color={
                      isEvent
                        ? COLORS.warning
                        : isSys
                          ? COLORS.muted
                          : COLORS.subtle
                    }
                    bold={!isSys && !isEvent}
                  >
                    {item.senderName.substring(0, 11).padEnd(12)}
                  </Text>
                  <Text color={COLORS.muted}>
                    {timeAgo(item.timestamp).padStart(4)}{' '}
                  </Text>
                  <Text
                    color={selected ? COLORS.text : COLORS.subtle}
                    wrap="truncate"
                  >
                    {truncate(item.content, 50)}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* Task summary bar */}
      <Box
        borderStyle={BORDER_STYLE}
        borderColor={COLORS.border}
        paddingX={1}
        gap={1}
      >
        <Text color={COLORS.muted} bold>
          TASKS
        </Text>
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
    </Box>
  );
}

function AgentChip({
  agent,
  statusMap,
}: {
  agent: AgentInfo;
  statusMap: Record<string, { icon: string; color: string; label: string }>;
}) {
  const s = statusMap[agent.processStatus] ?? statusMap['stopped']!;
  const lastStr = agent.lastActive ? timeAgo(agent.lastActive) : '';

  return (
    <Box width="50%" paddingX={1}>
      <Text color={s.color}>{s.icon} </Text>
      <Text color={COLORS.text} bold>
        {agent.member.displayName}
      </Text>
      <Text color={s.color}> {s.label}</Text>
      {lastStr && (
        <Text color={COLORS.muted}> ({lastStr})</Text>
      )}
    </Box>
  );
}
