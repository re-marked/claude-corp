import React from 'react';
import { Box, Text, useInput } from 'ink';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Member, type Channel, listTasks } from '@claudecorp/shared';
import { COLORS, STATUS, TASK_STATUS, BORDER_STYLE } from '../theme.js';
import type { View } from '../navigation.js';
import { useCorp } from '../context/corp-context.js';

interface Props {
  memberId: string;
  onNavigate: (view: View) => void;
  onBack: () => void;
}

export function AgentInspector({ memberId, onNavigate, onBack }: Props) {
  const { corpRoot, members, channels } = useCorp();
  const member = members.find((m) => m.id === memberId);

  // Navigation handled globally by Ctrl shortcuts in app.tsx

  if (!member) {
    return <Text color={COLORS.danger}>Agent not found</Text>;
  }

  const statusInfo = STATUS[member.status as keyof typeof STATUS] ?? STATUS.idle;

  // Read SOUL.md excerpt
  let soulExcerpt = '';
  if (member.agentDir) {
    const soulPath = join(corpRoot, member.agentDir, 'SOUL.md');
    if (existsSync(soulPath)) {
      const full = readFileSync(soulPath, 'utf-8');
      const lines = full.split('\n').slice(0, 10);
      soulExcerpt = lines.join('\n');
    }
  }

  // Tasks assigned to this agent
  const tasks = listTasks(corpRoot, { assignedTo: member.id });

  // Brain files
  let brainFiles: string[] = [];
  if (member.agentDir) {
    const brainDir = join(corpRoot, member.agentDir, 'brain');
    if (existsSync(brainDir)) {
      brainFiles = readdirSync(brainDir).filter((f) => f.endsWith('.md'));
    }
  }

  // Find who created this agent
  const creator = members.find((m) => m.id === member.spawnedBy);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle={BORDER_STYLE} borderColor={COLORS.border} paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          <Text bold color={COLORS.primary}>{member.displayName}</Text>
          <Text color={statusInfo.color}>{statusInfo.icon} {member.status}</Text>
        </Box>
        <Text color={COLORS.muted}>{member.rank}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        {/* Meta */}
        <Box gap={2} marginBottom={1}>
          <Text color={COLORS.muted}>Created by: <Text color={COLORS.subtle}>{creator?.displayName ?? '?'}</Text></Text>
          <Text color={COLORS.muted}>Scope: <Text color={COLORS.subtle}>{member.scope}</Text></Text>
        </Box>

        {/* SOUL excerpt */}
        {soulExcerpt && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color={COLORS.secondary}>SOUL.md</Text>
            <Text color={COLORS.subtle}>{soulExcerpt}</Text>
          </Box>
        )}

        {/* Tasks */}
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={COLORS.secondary}>Tasks ({tasks.length})</Text>
          {tasks.length === 0 ? (
            <Text color={COLORS.muted}>No tasks assigned.</Text>
          ) : (
            tasks.map((t) => {
              const si = TASK_STATUS[t.task.status as keyof typeof TASK_STATUS] ?? TASK_STATUS.pending;
              return (
                <Box key={t.task.id} gap={1}>
                  <Text color={si.color}>{si.icon}</Text>
                  <Text color={COLORS.text}>{t.task.title}</Text>
                  <Text color={COLORS.muted}>({t.task.status})</Text>
                </Box>
              );
            })
          )}
        </Box>

        {/* Brain */}
        {brainFiles.length > 0 && (
          <Box flexDirection="column">
            <Text bold color={COLORS.secondary}>Brain ({brainFiles.length} files)</Text>
            {brainFiles.map((f) => (
              <Text key={f} color={COLORS.subtle}>  {f}</Text>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}
