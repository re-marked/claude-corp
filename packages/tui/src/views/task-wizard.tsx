import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { DaemonClient } from '../lib/daemon-client.js';
import type { Member } from '@claudecorp/shared';

type Step = 'title' | 'priority' | 'description' | 'creating' | 'done' | 'error';

const PRIORITIES = ['normal', 'high', 'critical', 'low'] as const;

interface Props {
  daemonClient: DaemonClient;
  founderId: string;
  members: Member[];
  onClose: () => void;
  onCreated: (title: string, taskId: string) => void;
}

export function TaskWizard({ daemonClient, founderId, members, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>('title');
  const [title, setTitle] = useState('');
  const [priorityIndex, setPriorityIndex] = useState(0);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [createdId, setCreatedId] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (step === 'priority') {
      if (key.upArrow) {
        setPriorityIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setPriorityIndex((i) => Math.min(PRIORITIES.length - 1, i + 1));
      } else if (key.return) {
        setStep('description');
      }
    }
  });

  const handleTitleSubmit = (val: string) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    setTitle(trimmed);
    setStep('priority');
  };

  const handleDescriptionSubmit = async (val: string) => {
    setDescription(val.trim());
    setStep('creating');

    try {
      const result = await daemonClient.createTask({
        title,
        description: val.trim() || undefined,
        priority: PRIORITIES[priorityIndex]!,
        createdBy: founderId,
      });
      const taskId = (result as any)?.id ?? (result as any)?.task?.id ?? '?';
      setCreatedId(taskId);
      setStep('done');
      onCreated(title, taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1} width={60}>
      <Box marginBottom={1}>
        <Text bold color="yellow">Create a Task</Text>
        <Text dimColor>  (Esc to cancel)</Text>
      </Box>

      {step === 'title' && (
        <Box flexDirection="column">
          <Text>Task title:</Text>
          <Box>
            <Text bold color="green">&gt; </Text>
            <TextInput
              value={title}
              onChange={setTitle}
              onSubmit={handleTitleSubmit}
              placeholder="Research competitor pricing"
            />
          </Box>
        </Box>
      )}

      {step === 'priority' && (
        <Box flexDirection="column">
          <Text>Title: <Text bold>{title}</Text></Text>
          <Box marginTop={1}><Text>Select priority:</Text></Box>
          {PRIORITIES.map((p, i) => (
            <Box key={p} gap={1}>
              <Text color={i === priorityIndex ? 'cyan' : undefined} bold={i === priorityIndex}>
                {i === priorityIndex ? '>' : ' '} {p}
              </Text>
            </Box>
          ))}
          <Box marginTop={1}><Text dimColor>up/down to select, Enter to confirm</Text></Box>
        </Box>
      )}

      {step === 'description' && (
        <Box flexDirection="column">
          <Text>Title: <Text bold>{title}</Text>  Priority: <Text bold>{PRIORITIES[priorityIndex]}</Text></Text>
          <Box marginTop={1}><Text>Description (optional, Enter to skip):</Text></Box>
          <Box>
            <Text bold color="green">&gt; </Text>
            <TextInput
              value={description}
              onChange={setDescription}
              onSubmit={handleDescriptionSubmit}
              placeholder="Analyze top 5 competitors..."
            />
          </Box>
        </Box>
      )}

      {step === 'creating' && (
        <Text color="cyan">Creating task...</Text>
      )}

      {step === 'done' && (
        <Box flexDirection="column">
          <Text color="green">Task created: <Text bold>{createdId}</Text></Text>
          <Text dimColor>Creating a task is planning. To start work:</Text>
          <Text color="cyan">  /hand {createdId} @agent-name</Text>
        </Box>
      )}

      {step === 'error' && (
        <Text color="red">Failed: {error}</Text>
      )}
    </Box>
  );
}
