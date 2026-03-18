import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { DaemonClient } from '../lib/daemon-client.js';
import { COLORS, BORDER_STYLE } from '../theme.js';

type Step = 'name' | 'type' | 'path' | 'description' | 'creating' | 'done' | 'error';

const PROJECT_TYPES = ['codebase', 'workspace'] as const;

interface Props {
  daemonClient: DaemonClient;
  founderId: string;
  onClose: () => void;
  onCreated: (name: string) => void;
}

export function ProjectWizard({ daemonClient, founderId, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [typeIndex, setTypeIndex] = useState(0);
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  useInput((_input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (step === 'type') {
      if (key.upArrow) {
        setTypeIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setTypeIndex((i) => Math.min(PROJECT_TYPES.length - 1, i + 1));
      } else if (key.return) {
        if (PROJECT_TYPES[typeIndex] === 'codebase') {
          setStep('path');
        } else {
          setStep('description');
        }
      }
    }
  });

  const handleNameSubmit = (val: string) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    setName(trimmed);
    setStep('type');
  };

  const handlePathSubmit = (val: string) => {
    setPath(val.trim());
    setStep('description');
  };

  const handleDescriptionSubmit = async (val: string) => {
    setDescription(val.trim());
    setStep('creating');

    const projectType = PROJECT_TYPES[typeIndex]!;

    try {
      await daemonClient.createProject({
        name,
        type: projectType,
        path: projectType === 'codebase' && path ? path : undefined,
        description: val.trim() || undefined,
        createdBy: founderId,
      });
      setStep('done');
      onCreated(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  return (
    <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.info} paddingX={2} paddingY={1} width={60}>
      <Box marginBottom={1}>
        <Text bold color={COLORS.info}>Create a Project</Text>
        <Text dimColor>  (Esc to cancel)</Text>
      </Box>

      {step === 'name' && (
        <Box flexDirection="column">
          <Text>Project name:</Text>
          <Box>
            <Text bold color={COLORS.success}>&gt; </Text>
            <TextInput
              value={name}
              onChange={setName}
              onSubmit={handleNameSubmit}
              placeholder="my-website"
            />
          </Box>
        </Box>
      )}

      {step === 'type' && (
        <Box flexDirection="column">
          <Text>Name: <Text bold>{name}</Text></Text>
          <Text marginTop={1}>Select type:</Text>
          {PROJECT_TYPES.map((t, i) => (
            <Box key={t} gap={1}>
              <Text color={i === typeIndex ? COLORS.primary : undefined} bold={i === typeIndex}>
                {i === typeIndex ? '>' : ' '} {t}
              </Text>
              <Text dimColor>
                {t === 'codebase' && '— linked to a code repository'}
                {t === 'workspace' && '— general workspace with deliverables'}
              </Text>
            </Box>
          ))}
          <Text dimColor marginTop={1}>up/down to select, Enter to confirm</Text>
        </Box>
      )}

      {step === 'path' && (
        <Box flexDirection="column">
          <Text>Name: <Text bold>{name}</Text>  Type: <Text bold>{PROJECT_TYPES[typeIndex]}</Text></Text>
          <Text marginTop={1}>Codebase path (Enter to skip):</Text>
          <Box>
            <Text bold color={COLORS.success}>&gt; </Text>
            <TextInput
              value={path}
              onChange={setPath}
              onSubmit={handlePathSubmit}
              placeholder="/home/user/my-project"
            />
          </Box>
        </Box>
      )}

      {step === 'description' && (
        <Box flexDirection="column">
          <Text>Name: <Text bold>{name}</Text>  Type: <Text bold>{PROJECT_TYPES[typeIndex]}</Text>
            {path ? <Text>  Path: <Text bold>{path}</Text></Text> : null}
          </Text>
          <Text marginTop={1}>Description (optional, Enter to skip):</Text>
          <Box>
            <Text bold color={COLORS.success}>&gt; </Text>
            <TextInput
              value={description}
              onChange={setDescription}
              onSubmit={handleDescriptionSubmit}
              placeholder="A marketing website for the company"
            />
          </Box>
        </Box>
      )}

      {step === 'creating' && (
        <Text color={COLORS.primary}>Creating project...</Text>
      )}

      {step === 'done' && (
        <Text color={COLORS.success}>Project <Text bold>"{name}"</Text> created! New channels are now available.</Text>
      )}

      {step === 'error' && (
        <Text color={COLORS.danger}>Failed: {error}</Text>
      )}
    </Box>
  );
}
