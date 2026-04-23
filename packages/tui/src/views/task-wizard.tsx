import React, { useState } from 'react';
import { Box, Text, useInput } from '@claude-code-kit/ink-renderer';
import { TextInput } from '../components/text-input.js';
import type { DaemonClient } from '../lib/daemon-client.js';
import type { Member } from '@claudecorp/shared';

type Step = 'title' | 'priority' | 'complexity' | 'description' | 'criteria' | 'creating' | 'done' | 'error';

const PRIORITIES = ['normal', 'high', 'critical', 'low'] as const;

const COMPLEXITIES = [
  { value: 'medium', hint: 'multi-file, tests expected' },
  { value: 'small', hint: 'bounded, one file, no design questions' },
  { value: 'trivial', hint: 'one-liner, typo, rename' },
  { value: 'large', hint: 'decompose into a Contract — don\'t ship standalone' },
  { value: 'unassessed', hint: 'leave null, the agent will size it' },
] as const;

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
  const [complexityIndex, setComplexityIndex] = useState(0);
  const [description, setDescription] = useState('');
  const [criteriaInput, setCriteriaInput] = useState('');
  const [criteria, setCriteria] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [createdId, setCreatedId] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (step === 'priority') {
      if (key.upArrow) setPriorityIndex((i) => Math.max(0, i - 1));
      if (key.downArrow) setPriorityIndex((i) => Math.min(PRIORITIES.length - 1, i + 1));
      if (key.return) setStep('complexity');
    }

    if (step === 'complexity') {
      if (key.upArrow) setComplexityIndex((i) => Math.max(0, i - 1));
      if (key.downArrow) setComplexityIndex((i) => Math.min(COMPLEXITIES.length - 1, i + 1));
      if (key.return) setStep('description');
    }
  });

  const handleTitleSubmit = (val: string) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    setTitle(trimmed);
    setStep('priority');
  };

  const handleDescriptionSubmit = (val: string) => {
    setDescription(val.trim());
    setStep('criteria');
  };

  const handleCriteriaSubmit = async (val: string) => {
    const trimmed = val.trim();

    // Non-empty = add another criterion and stay on this step
    if (trimmed) {
      setCriteria(prev => [...prev, trimmed]);
      setCriteriaInput('');
      return;
    }

    // Empty enter = done adding criteria, create the task
    setStep('creating');
    const allCriteria = criteria.length > 0 ? criteria : undefined;

    try {
      const chosenComplexity = COMPLEXITIES[complexityIndex]!.value;
      const result = await daemonClient.createTask({
        title,
        description: description || undefined,
        priority: PRIORITIES[priorityIndex]!,
        complexity: chosenComplexity === 'unassessed' ? undefined : chosenComplexity as 'trivial' | 'small' | 'medium' | 'large',
        acceptanceCriteria: allCriteria,
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
          <Text dimColor>Creating a task is planning. Use /hand to start work.</Text>
          <Box marginTop={1}><Text>Task title:</Text></Box>
          <Box>
            <Text bold color="green">&gt; </Text>
            <TextInput value={title} onChange={setTitle} onSubmit={handleTitleSubmit} placeholder="Research competitor pricing" />
          </Box>
        </Box>
      )}

      {step === 'priority' && (
        <Box flexDirection="column">
          <Text>Title: <Text bold>{title}</Text></Text>
          <Box marginTop={1}><Text>Priority:</Text></Box>
          {PRIORITIES.map((p, i) => (
            <Box key={p} gap={1}>
              <Text color={i === priorityIndex ? 'cyan' : undefined} bold={i === priorityIndex}>
                {i === priorityIndex ? '>' : ' '} {p}
              </Text>
            </Box>
          ))}
          <Box marginTop={1}><Text dimColor>up/down, Enter to confirm</Text></Box>
        </Box>
      )}

      {step === 'complexity' && (
        <Box flexDirection="column">
          <Text>Title: <Text bold>{title}</Text>  Priority: <Text bold>{PRIORITIES[priorityIndex]}</Text></Text>
          <Box marginTop={1}><Text>Complexity (effort + decomposition signal):</Text></Box>
          {COMPLEXITIES.map((c, i) => (
            <Box key={c.value} gap={1}>
              <Text color={i === complexityIndex ? 'cyan' : undefined} bold={i === complexityIndex}>
                {i === complexityIndex ? '>' : ' '} {c.value.padEnd(11)}
              </Text>
              <Text dimColor>{c.hint}</Text>
            </Box>
          ))}
          <Box marginTop={1}><Text dimColor>up/down, Enter to confirm</Text></Box>
        </Box>
      )}

      {step === 'description' && (
        <Box flexDirection="column">
          <Text>Title: <Text bold>{title}</Text>  Priority: <Text bold>{PRIORITIES[priorityIndex]}</Text>  Complexity: <Text bold>{COMPLEXITIES[complexityIndex]!.value}</Text></Text>
          <Box marginTop={1}><Text>Description (optional, Enter to skip):</Text></Box>
          <Box>
            <Text bold color="green">&gt; </Text>
            <TextInput value={description} onChange={setDescription} onSubmit={handleDescriptionSubmit} placeholder="Analyze top 5 competitors..." />
          </Box>
        </Box>
      )}

      {step === 'criteria' && (
        <Box flexDirection="column">
          <Text>Title: <Text bold>{title}</Text>  Priority: <Text bold>{PRIORITIES[priorityIndex]}</Text>  Complexity: <Text bold>{COMPLEXITIES[complexityIndex]!.value}</Text></Text>
          <Box marginTop={1}><Text>Acceptance criteria (the Warden checks these):</Text></Box>
          <Text dimColor>Type each criterion + Enter. Empty Enter when done.</Text>
          {criteria.map((c, i) => (
            <Text key={i} color="green">  {'\u2713'} {c}</Text>
          ))}
          <Box>
            <Text bold color="green">&gt; </Text>
            <TextInput value={criteriaInput} onChange={setCriteriaInput} onSubmit={handleCriteriaSubmit} placeholder={criteria.length === 0 ? 'Login form renders correctly' : 'Add another or Enter to finish'} />
          </Box>
        </Box>
      )}

      {step === 'creating' && (
        <Text color="cyan">Creating task...</Text>
      )}

      {step === 'done' && (
        <Box flexDirection="column">
          <Text color="green">Task created: <Text bold>{createdId}</Text></Text>
          {criteria.length > 0 && <Text dimColor>{criteria.length} acceptance criteria set</Text>}
          <Text dimColor>To start work:</Text>
          <Text color="cyan">  /hand {createdId} @agent-name</Text>
        </Box>
      )}

      {step === 'error' && (
        <Text color="red">Failed: {error}</Text>
      )}
    </Box>
  );
}
