import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { DaemonClient } from '../lib/daemon-client.js';
import type { Member } from '@agentcorp/shared';

type Step = 'title' | 'priority' | 'assignee' | 'description' | 'creating' | 'done' | 'error';

const PRIORITIES = ['normal', 'high', 'critical', 'low'] as const;

interface Props {
  daemonClient: DaemonClient;
  founderId: string;
  members: Member[];
  onClose: () => void;
  onCreated: (title: string) => void;
}

export function TaskWizard({ daemonClient, founderId, members, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>('title');
  const [title, setTitle] = useState('');
  const [priorityIndex, setPriorityIndex] = useState(0);
  const [assignee, setAssignee] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const agents = members.filter((m) => m.type === 'agent');

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
        setStep('assignee');
      }
    }
  });

  const handleTitleSubmit = (val: string) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    setTitle(trimmed);
    setStep('priority');
  };

  const handleAssigneeSubmit = (val: string) => {
    setAssignee(val.trim());
    setStep('description');
  };

  const handleDescriptionSubmit = async (val: string) => {
    setDescription(val.trim());
    setStep('creating');

    // Resolve assignee name to member ID
    let assignedTo: string | undefined;
    if (assignee) {
      const match = agents.find(
        (m) => m.displayName.toLowerCase() === assignee.toLowerCase(),
      );
      if (match) assignedTo = match.id;
    }

    try {
      await daemonClient.createTask({
        title,
        description: val.trim() || undefined,
        priority: PRIORITIES[priorityIndex]!,
        assignedTo,
        createdBy: founderId,
      });
      setStep('done');
      onCreated(title);
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
          <Text marginTop={1}>Select priority:</Text>
          {PRIORITIES.map((p, i) => (
            <Box key={p} gap={1}>
              <Text color={i === priorityIndex ? 'cyan' : undefined} bold={i === priorityIndex}>
                {i === priorityIndex ? '>' : ' '} {p}
              </Text>
            </Box>
          ))}
          <Text dimColor marginTop={1}>↑↓ to select, Enter to confirm</Text>
        </Box>
      )}

      {step === 'assignee' && (
        <Box flexDirection="column">
          <Text>Title: <Text bold>{title}</Text>  Priority: <Text bold>{PRIORITIES[priorityIndex]}</Text></Text>
          <Text marginTop={1}>Assign to agent (optional, Enter to skip):</Text>
          {agents.length > 0 && (
            <Text dimColor>Available: {agents.map((a) => a.displayName).join(', ')}</Text>
          )}
          <Box>
            <Text bold color="green">&gt; </Text>
            <TextInput
              value={assignee}
              onChange={setAssignee}
              onSubmit={handleAssigneeSubmit}
              placeholder="Researcher"
            />
          </Box>
        </Box>
      )}

      {step === 'description' && (
        <Box flexDirection="column">
          <Text>Title: <Text bold>{title}</Text>  Priority: <Text bold>{PRIORITIES[priorityIndex]}</Text>
            {assignee ? <Text>  Assignee: <Text bold>{assignee}</Text></Text> : null}
          </Text>
          <Text marginTop={1}>Description (optional, Enter to skip):</Text>
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
        <Text color="green">Task <Text bold>"{title}"</Text> created! Check #tasks for the event.</Text>
      )}

      {step === 'error' && (
        <Text color="red">Failed: {error}</Text>
      )}
    </Box>
  );
}
