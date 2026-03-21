import React from 'react';
import { Box, Text, useInput } from 'ink';
import { type Member, readTask, taskPath } from '@claudecorp/shared';
import { COLORS, TASK_STATUS, PRIORITY, BORDER_STYLE } from '../theme.js';
import { useCorp } from '../context/corp-context.js';

interface Props {
  taskId: string;
  onBack: () => void;
}

export function TaskDetail({ taskId, onBack }: Props) {
  const { corpRoot, members } = useCorp();
  // Navigation handled globally by Ctrl shortcuts in app.tsx

  let task, body;
  try {
    const result = readTask(taskPath(corpRoot, taskId));
    task = result.task;
    body = result.body;
  } catch {
    return <Text color={COLORS.danger}>Task not found: {taskId}</Text>;
  }

  const statusInfo = TASK_STATUS[task.status as keyof typeof TASK_STATUS] ?? TASK_STATUS.pending;
  const priorityColor = PRIORITY[task.priority as keyof typeof PRIORITY] ?? COLORS.text;
  const assignee = task.assignedTo ? members.find((m) => m.id === task.assignedTo)?.displayName ?? '?' : '—';
  const creator = members.find((m) => m.id === task.createdBy)?.displayName ?? '?';

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle={BORDER_STYLE} borderColor={COLORS.border} paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          <Text color={statusInfo.color}>{statusInfo.icon}</Text>
          <Text bold color={COLORS.primary}>{task.title}</Text>
        </Box>
        <Text color={priorityColor}>{task.priority.toUpperCase()}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
        {/* Meta */}
        <Box gap={2} marginBottom={1}>
          <Text color={COLORS.muted}>Status: <Text color={statusInfo.color}>{task.status}</Text></Text>
          <Text color={COLORS.muted}>Assignee: <Text color={COLORS.subtle}>{assignee}</Text></Text>
          <Text color={COLORS.muted}>Created by: <Text color={COLORS.subtle}>{creator}</Text></Text>
        </Box>

        <Box gap={2} marginBottom={1}>
          <Text color={COLORS.muted}>ID: <Text color={COLORS.subtle}>{task.id}</Text></Text>
          <Text color={COLORS.muted}>Created: <Text color={COLORS.subtle}>{new Date(task.createdAt).toLocaleString()}</Text></Text>
          {task.dueAt && <Text color={COLORS.muted}>Due: <Text color={COLORS.warning}>{new Date(task.dueAt).toLocaleString()}</Text></Text>}
        </Box>

        {/* Body */}
        {body && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={COLORS.secondary} bold>Description</Text>
            <Text color={COLORS.text} wrap="wrap">{body}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
