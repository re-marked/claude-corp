import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from '@claude-code-kit/ink-renderer';
import { TextInput } from '../components/text-input.js';
import type { DaemonClient } from '../lib/daemon-client.js';
import { KNOWN_MODELS, ensureGlobalConfig, type ModelEntry } from '@claudecorp/shared';
import { COLORS } from '../theme.js';
import { detectAvailableHarnesses, type HarnessOption } from '../utils/harness-detect.js';

type Step = 'name' | 'rank' | 'model' | 'harness' | 'description' | 'hiring' | 'done' | 'error';

const RANKS = ['worker', 'leader', 'subagent'] as const;

const MODEL_OPTIONS: { entry: ModelEntry | null; label: string }[] = [
  { entry: null, label: 'Corp default' },
  ...KNOWN_MODELS.map(m => ({ entry: m, label: m.displayName })),
];

/**
 * Harness options shown in the hire wizard. The first entry is always
 * "Use corp default" — so most hires just hit Enter and inherit whatever
 * the corp was set to at onboarding. Specific choices are offered for
 * per-agent overrides (e.g., an Opus planner on openclaw in a mostly
 * claude-code corp, or vice-versa).
 */
const HARNESS_DISPLAY: Record<string, string> = {
  'claude-code': 'Claude Code',
  'openclaw': 'OpenClaw',
};

interface Props {
  daemonClient: DaemonClient;
  founderId: string;
  /** Corp-wide harness default read from corp.json. "Use corp default" inherits this. */
  corpDefaultHarness?: string;
  onClose: () => void;
  onHired: (agentName: string, displayName: string) => void;
}

export function HireWizard({ daemonClient, founderId, corpDefaultHarness, onClose, onHired }: Props) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [rankIndex, setRankIndex] = useState(0);
  const [modelIndex, setModelIndex] = useState(0);
  const [harnessIndex, setHarnessIndex] = useState(0); // 0 = use corp default
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [hiredName, setHiredName] = useState('');

  const corpDefaultLabel = corpDefaultHarness
    ? (HARNESS_DISPLAY[corpDefaultHarness] ?? corpDefaultHarness)
    : 'openclaw';

  // Run detection once per wizard mount. The 3s claude --version probe
  // is behind a useMemo so picking through the wizard steps doesn't
  // re-run it. Detection result is used to annotate each specific
  // harness option + surface a fix hint when the selection is unavailable.
  const detected = useMemo<HarnessOption[]>(() => {
    try {
      return detectAvailableHarnesses(ensureGlobalConfig());
    } catch {
      return [];
    }
  }, []);
  const detectedById = (id: string) => detected.find(d => d.id === id) ?? null;

  const HARNESS_OPTIONS = [
    { id: null, label: `Use corp default (${corpDefaultLabel})`, detail: null as HarnessOption | null },
    { id: 'claude-code' as const, label: HARNESS_DISPLAY['claude-code']!, detail: detectedById('claude-code') },
    { id: 'openclaw' as const, label: HARNESS_DISPLAY['openclaw']!, detail: detectedById('openclaw') },
  ];

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
      else if (key.return) setStep('harness');
    }

    if (step === 'harness') {
      if (key.upArrow) setHarnessIndex(i => Math.max(0, i - 1));
      else if (key.downArrow) setHarnessIndex(i => Math.min(HARNESS_OPTIONS.length - 1, i + 1));
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

    // harnessIndex 0 = use corp default (omit the field so the daemon's
    // hireAgent resolves it from Corporation.harness). Indexes 1+ are
    // explicit per-agent overrides.
    const harnessChoice = HARNESS_OPTIONS[harnessIndex]!;
    const harness = harnessChoice.id ?? undefined;

    try {
      await daemonClient.hireAgent({
        creatorId: founderId,
        agentName,
        displayName,
        rank,
        soulContent,
        model: selectedModel.entry?.id,
        provider: selectedModel.entry?.provider,
        ...(harness ? { harness } : {}),
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
  const selectedHarnessLabel = HARNESS_OPTIONS[harnessIndex]!.label;

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

      {step === 'harness' && (() => {
        const selectedOpt = HARNESS_OPTIONS[harnessIndex]!;
        const selectedFixHint = selectedOpt.detail && !selectedOpt.detail.available
          ? selectedOpt.detail.fixHint
          : null;
        return (
          <Box flexDirection="column">
            <Text>Name: <Text bold>{name}</Text>  Rank: <Text bold>{RANKS[rankIndex]}</Text>  Model: <Text bold>{selectedModelLabel}</Text></Text>
            <Box marginTop={1}><Text>Pick an engine for {name}:</Text></Box>
            {HARNESS_OPTIONS.map((opt, i) => (
              <Box key={opt.label} gap={1}>
                <Text color={i === harnessIndex ? COLORS.primary : COLORS.muted} bold={i === harnessIndex}>
                  {i === harnessIndex ? '>' : ' '} {opt.label}
                </Text>
                {i === 0 && <Text dimColor>(most agents use this)</Text>}
                {opt.detail && (
                  <Text color={opt.detail.available ? COLORS.success : COLORS.warning}>
                    {opt.detail.note}
                  </Text>
                )}
              </Box>
            ))}
            {selectedFixHint && (
              <Box marginTop={1}>
                <Text color={COLORS.warning}>→ {selectedFixHint}</Text>
              </Box>
            )}
            <Box marginTop={1}><Text dimColor>{'\u2191\u2193'} select  Enter confirm</Text></Box>
          </Box>
        );
      })()}

      {step === 'description' && (
        <Box flexDirection="column">
          <Text>Name: <Text bold>{name}</Text>  Rank: <Text bold>{RANKS[rankIndex]}</Text>  Model: <Text bold>{selectedModelLabel}</Text>  Engine: <Text bold>{selectedHarnessLabel}</Text></Text>
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
