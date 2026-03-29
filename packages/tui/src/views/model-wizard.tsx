import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DaemonClient } from '../lib/daemon-client.js';
import { COLORS } from '../theme.js';

type Step = 'loading' | 'overview' | 'select-model' | 'applying' | 'done' | 'error';

interface AgentModel {
  id: string;
  name: string;
  model: string | null;
}

interface AvailableModel {
  id: string;
  alias: string;
  displayName: string;
}

interface Props {
  daemonClient: DaemonClient;
  onClose: () => void;
  onChanged: (target: string, model: string) => void;
}

export function ModelWizard({ daemonClient, onClose, onChanged }: Props) {
  const [step, setStep] = useState<Step>('loading');
  const [corpDefault, setCorpDefault] = useState({ model: '', provider: '' });
  const [agents, setAgents] = useState<AgentModel[]>([]);
  const [available, setAvailable] = useState<AvailableModel[]>([]);
  const [fallbackChain, setFallbackChain] = useState<string[]>([]);
  const [error, setError] = useState('');

  // Overview: target selection (corp default + each agent)
  const [targetIndex, setTargetIndex] = useState(0);
  const targets = ['Corp default', ...agents.map(a => a.name)];

  // Model selection
  const [modelIndex, setModelIndex] = useState(0);
  const [selectedTarget, setSelectedTarget] = useState('');

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }

    if (step === 'overview') {
      if (key.upArrow) setTargetIndex(i => Math.max(0, i - 1));
      if (key.downArrow) setTargetIndex(i => Math.min(targets.length - 1, i + 1));
      if (key.return) {
        setSelectedTarget(targets[targetIndex] ?? '');
        setModelIndex(0);
        setStep('select-model');
      }
    }

    if (step === 'select-model') {
      if (key.upArrow) setModelIndex(i => Math.max(0, i - 1));
      if (key.downArrow) setModelIndex(i => Math.min(available.length - 1, i + 1));
      if (key.return) {
        applyModel(selectedTarget, available[modelIndex]!);
      }
    }
  });

  useEffect(() => {
    (async () => {
      try {
        const data = await daemonClient.getModels();
        setCorpDefault(data.corpDefault);
        setAgents(data.agents);
        setAvailable(data.availableModels);
        setFallbackChain(data.fallbackChain);
        setStep('overview');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStep('error');
      }
    })();
  }, []);

  async function applyModel(target: string, model: AvailableModel) {
    setStep('applying');
    try {
      if (target === 'Corp default') {
        await daemonClient.setDefaultModel(model.id);
        setCorpDefault({ model: model.id, provider: 'anthropic' });
      } else {
        const agent = agents.find(a => a.name === target);
        if (agent) {
          await daemonClient.setAgentModel(agent.id, model.id);
          setAgents(prev => prev.map(a =>
            a.id === agent.id ? { ...a, model: `anthropic/${model.id}` } : a,
          ));
        }
      }
      onChanged(target, model.displayName);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  }

  function getEffectiveModel(agent: AgentModel): string {
    if (agent.model) {
      const parts = agent.model.split('/');
      return parts[parts.length - 1] ?? agent.model;
    }
    return `${corpDefault.model} (default)`;
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={2} paddingY={1} width={65}>
      <Box marginBottom={1}>
        <Text bold color={COLORS.primary}>Model Selector</Text>
        <Text dimColor>  (Esc to cancel)</Text>
      </Box>

      {step === 'loading' && (
        <Text color={COLORS.subtle}>Loading model config...</Text>
      )}

      {step === 'overview' && (
        <Box flexDirection="column">
          <Text dimColor>Current configuration:</Text>
          <Box marginTop={1} flexDirection="column">
            {targets.map((t, i) => {
              const isCorp = t === 'Corp default';
              const agent = !isCorp ? agents.find(a => a.name === t) : null;
              const modelLabel = isCorp
                ? corpDefault.model
                : agent ? getEffectiveModel(agent) : '?';
              const isOverride = !isCorp && agent?.model != null;

              return (
                <Box key={t} gap={1}>
                  <Text color={i === targetIndex ? COLORS.primary : COLORS.muted} bold={i === targetIndex}>
                    {i === targetIndex ? '\u25B8' : ' '}
                  </Text>
                  <Text bold={i === targetIndex} color={i === targetIndex ? COLORS.text : COLORS.subtle}>
                    {t.padEnd(22)}
                  </Text>
                  <Text color={isOverride ? COLORS.info : COLORS.muted}>
                    {modelLabel}
                  </Text>
                  {isOverride && <Text color={COLORS.warning}> [override]</Text>}
                </Box>
              );
            })}
          </Box>
          {fallbackChain.length > 0 && (
            <Box marginTop={1}>
              <Text dimColor>Fallback: {fallbackChain.join(' \u2192 ')}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>{'\u2191\u2193'} select  Enter change model  Esc close</Text>
          </Box>
        </Box>
      )}

      {step === 'select-model' && (
        <Box flexDirection="column">
          <Text>Select model for <Text bold color={COLORS.primary}>{selectedTarget}</Text>:</Text>
          <Box marginTop={1} flexDirection="column">
            {available.map((m, i) => (
              <Box key={m.id} gap={1}>
                <Text color={i === modelIndex ? COLORS.primary : COLORS.muted} bold={i === modelIndex}>
                  {i === modelIndex ? '\u25B8' : ' '}
                </Text>
                <Text bold={i === modelIndex} color={i === modelIndex ? COLORS.text : COLORS.subtle}>
                  {m.displayName.padEnd(22)}
                </Text>
                <Text dimColor>{m.id}</Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{'\u2191\u2193'} select  Enter confirm  Esc cancel</Text>
          </Box>
        </Box>
      )}

      {step === 'applying' && (
        <Text color={COLORS.info}>Applying model change...</Text>
      )}

      {step === 'done' && (
        <Text color={COLORS.success}>Model updated. Gateway will hot-reload in ~1.5s.</Text>
      )}

      {step === 'error' && (
        <Text color={COLORS.danger}>Error: {error}</Text>
      )}
    </Box>
  );
}
