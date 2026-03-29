import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { DaemonClient } from '../lib/daemon-client.js';
import { KNOWN_MODELS, type ModelEntry } from '@claudecorp/shared';
import { COLORS } from '../theme.js';

type Step = 'name' | 'rank' | 'model' | 'description' | 'hiring' | 'done' | 'error';

const RANKS = ['worker', 'leader', 'subagent'] as const;

const MODEL_OPTIONS: { entry: ModelEntry | null; label: string }[] = [
  { entry: null, label: 'Corp default' },
  ...KNOWN_MODELS.map(m => ({ entry: m, label: m.displayName })),
];

interface Props {
  daemonClient: DaemonClient;
  founderId: string;
  onClose: () => void;
  onHired: (agentName: string, displayName: string) => void;
}

export function HireWizard({ daemonClient, founderId, onClose, onHired }: Props) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [rankIndex, setRankIndex] = useState(0);
  const [modelIndex, setModelIndex] = useState(0);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [hiredName, setHiredName] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (step === 'rank') {
      if (key.upArrow) setRankIndex(i => Math.max(0, i - 1));
      else if (key.downArrow) setRankIndex(i => Math.min(RANKS.length - 1, i + 1));
      else if (key.return) setStep('model');
    }

    if (step === 'model') {
      if (key.upArrow) setModelIndex(i => Math.max(0, i - 1));
      else if (key.downArrow) setModelIndex(i => Math.min(MODEL_OPTIONS.length - 1, i + 1));
      else if (key.return) setStep('description');
    }
  });

  const handleNameSubmit = (val: string) => {
    const trimmed = val.trim();
    if (!trimmed) return;
    setName(trimmed);
    setStep('rank');
  };

  const handleDescriptionSubmit = async (val: string) => {
    setDescription(val.trim());
    setStep('hiring');

    const agentName = name.toLowerCase().replace(/\s+/g, '-');
    const displayName = name;
    const rank = RANKS[rankIndex]!;
    const desc = val.trim();
    const selectedModel = MODEL_OPTIONS[modelIndex]!;

    const soulContent = desc
      ? `# Identity\n\nYou are ${displayName}. ${desc}\n\n# Communication Style\n\nClear, professional, focused on results.`
      : `# Identity\n\nYou are ${displayName}, a ${rank}-rank agent.\n\n# Communication Style\n\nClear, professional, focused on results.`;

    try {
      await daemonClient.hireAgent({
        creatorId: founderId,
        agentName,
        displayName,
        rank,
        soulContent,
        model: selectedModel.entry?.id,
        provider: selectedModel.entry?.provider,
      });
      setHiredName(displayName);
      setStep('done');
      onHired(agentName, displayName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  const selectedModelLabel = MODEL_OPTIONS[modelIndex]!.label;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={2} paddingY={1} width={60}>
      <Box marginBottom={1}>
        <Text bold color="magenta">Hire a New Agent</Text>
        <Text dimColor>  (Esc to cancel)</Text>
      </Box>

      {step === 'name' && (
        <Box flexDirection="column">
          <Text>Agent name:</Text>
          <Box>
            <Text bold color="green">&gt; </Text>
            <TextInput
              value={name}
              onChange={setName}
              onSubmit={handleNameSubmit}
              placeholder="Researcher"
            />
          </Box>
        </Box>
      )}

      {step === 'rank' && (
        <Box flexDirection="column">
          <Text>Name: <Text bold>{name}</Text></Text>
          <Box marginTop={1}><Text>Select rank:</Text></Box>
          {RANKS.map((r, i) => (
            <Box key={r} gap={1}>
              <Text color={i === rankIndex ? 'cyan' : undefined} bold={i === rankIndex}>
                {i === rankIndex ? '>' : ' '} {r}
              </Text>
              <Text dimColor>
                {r === 'worker' && '— does tasks, cannot hire'}
                {r === 'leader' && '— manages team, can hire workers'}
                {r === 'subagent' && '— temporary helper, limited scope'}
              </Text>
            </Box>
          ))}
          <Box marginTop={1}><Text dimColor>{'\u2191\u2193'} select  Enter confirm</Text></Box>
        </Box>
      )}

      {step === 'model' && (
        <Box flexDirection="column">
          <Text>Name: <Text bold>{name}</Text>  Rank: <Text bold>{RANKS[rankIndex]}</Text></Text>
          <Box marginTop={1}><Text>Select model:</Text></Box>
          {MODEL_OPTIONS.map((opt, i) => (
            <Box key={opt.label} gap={1}>
              <Text color={i === modelIndex ? COLORS.primary : COLORS.muted} bold={i === modelIndex}>
                {i === modelIndex ? '>' : ' '} {opt.label}
              </Text>
              {opt.entry && <Text dimColor>{opt.entry.id}</Text>}
            </Box>
          ))}
          <Box marginTop={1}><Text dimColor>{'\u2191\u2193'} select  Enter confirm</Text></Box>
        </Box>
      )}

      {step === 'description' && (
        <Box flexDirection="column">
          <Text>Name: <Text bold>{name}</Text>  Rank: <Text bold>{RANKS[rankIndex]}</Text>  Model: <Text bold>{selectedModelLabel}</Text></Text>
          <Box marginTop={1}><Text>What does this agent do? (optional, Enter to skip)</Text></Box>
          <Box>
            <Text bold color="green">&gt; </Text>
            <TextInput
              value={description}
              onChange={setDescription}
              onSubmit={handleDescriptionSubmit}
              placeholder="Finds information and analyzes data"
            />
          </Box>
        </Box>
      )}

      {step === 'hiring' && (
        <Text color="cyan">Hiring {name}...</Text>
      )}

      {step === 'done' && (
        <Text color="green">Hired <Text bold>{hiredName}</Text>! You can now @mention them in any channel.</Text>
      )}

      {step === 'error' && (
        <Text color="red">Failed to hire: {error}</Text>
      )}
    </Box>
  );
}
