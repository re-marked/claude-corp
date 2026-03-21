import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { type Member, type TaskStatus, listTasks } from '@claudecorp/shared';
import { COLORS, TASK_STATUS, PRIORITY, BORDER_STYLE } from '../theme.js';
import type { View } from '../navigation.js';
import { useCorp } from '../context/corp-context.js';

const FILTERS: (TaskStatus | 'all')[] = ['all', 'pending', 'assigned', 'in_progress', 'completed', 'failed', 'blocked'];

interface Props {
  onNavigate: (view: View) => void;
  onBack: () => void;
}

export function TaskBoard({ onNavigate, onBack }: Props) {
  const { corpRoot, members, daemonClient } = useCorp();
  const [filterIndex, setFilterIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filter = FILTERS[filterIndex]!;
  const allTasks = listTasks(corpRoot, filter === 'all' ? undefined : { status: filter as TaskStatus });

  // Sort: in_progress first, then assigned, then pending, then rest
  const statusOrder: Record<string, number> = {
    in_progress: 0, assigned: 1, pending: 2, blocked: 3, failed: 4, completed: 5, cancelled: 6,
  };
  const sorted = [...allTasks].sort((a, b) =>
    (statusOrder[a.task.status] ?? 9) - (statusOrder[b.task.status] ?? 9),
  );

  const memberMap = new Map(members.map((m) => [m.id, m]));

  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(sorted.length - 1, i + 1));
    } else if (key.return) {
      const task = sorted[selectedIndex];
      if (task) {
        onNavigate({ type: 'task-detail', taskId: task.task.id });
      }
    } else if (key.tab) {
      setFilterIndex((i) => (i + 1) % FILTERS.length);
      setSelectedIndex(0);
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle={BORDER_STYLE} borderColor={COLORS.border} paddingX={1} justifyContent="space-between">
        <Text bold color={COLORS.primary}>Tasks</Text>
        <Box gap={2}>
          <Text color={COLORS.muted}>Filter: <Text color={COLORS.secondary}>{filter}</Text></Text>
          <Text color={COLORS.muted}>{sorted.length} task{sorted.length !== 1 ? 's' : ''}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        {sorted.length === 0 ? (
          <Text color={COLORS.muted}>No tasks{filter !== 'all' ? ` with status "${filter}"` : ''}.</Text>
        ) : (
          sorted.map((t, i) => {
            const isSelected = i === selectedIndex;
            const statusInfo = TASK_STATUS[t.task.status as keyof typeof TASK_STATUS] ?? TASK_STATUS.pending;
            const priorityColor = PRIORITY[t.task.priority as keyof typeof PRIORITY] ?? COLORS.text;
            const assignee = t.task.assignedTo ? memberMap.get(t.task.assignedTo)?.displayName ?? '?' : '—';

            return (
              <Box key={t.task.id} gap={1}>
                <Text color={isSelected ? COLORS.primary : COLORS.muted}>{isSelected ? '▸' : ' '}</Text>
                <Text color={statusInfo.color}>{statusInfo.icon}</Text>
                <Text color={priorityColor} bold={t.task.priority === 'high' || t.task.priority === 'critical'}>
                  {t.task.priority.slice(0, 4).toUpperCase().padEnd(4)}
                </Text>
                <Text color={isSelected ? COLORS.text : COLORS.subtle} wrap="truncate">
                  {t.task.title}
                </Text>
                <Text color={COLORS.muted}>{assignee}</Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
