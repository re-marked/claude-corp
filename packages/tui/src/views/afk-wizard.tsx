/**
 * AFK Wizard — interactive SLUMBER configuration.
 *
 * Step 1: Profile picker (arrow keys to browse, Enter to select)
 * Step 2: Duration + goal input
 * Step 3: Confirmation → launch
 *
 * Activated by: /afk (no args) or /slumber wizard
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from '@claude-code-kit/ink-renderer';
import { TextInput } from '../components/text-input.js';
import { parseIntervalExpression } from '@claudecorp/shared';
import { COLORS } from '../theme.js';
import { useCorp } from '../context/corp-context.js';

interface Profile {
  id: string;
  name: string;
  icon: string;
  description: string;
  tickIntervalMs: number;
  durationMs: number | null;
  budgetTicks: number | null;
  conscription: string;
  mood: string;
}

interface Props {
  onLaunch: (profileId: string, durationMs?: number, goal?: string) => void;
  onCancel: () => void;
}

type Step = 'profile' | 'settings' | 'confirm';

function formatMs(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

export function AfkWizard({ onLaunch, onCancel }: Props) {
  const { daemonClient } = useCorp();
  const [step, setStep] = useState<Step>('profile');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [selectedProfile, setSelectedProfile] = useState<Profile | null>(null);
  const [durationInput, setDurationInput] = useState('');
  const [goalInput, setGoalInput] = useState('');
  const [editingField, setEditingField] = useState<'duration' | 'goal'>('duration');

  // Fetch profiles on mount
  useEffect(() => {
    daemonClient.get('/autoemon/profiles').then((data: any) => {
      if (Array.isArray(data)) setProfiles(data);
    }).catch(() => {});
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      if (step === 'settings') { setStep('profile'); return; }
      if (step === 'confirm') { setStep('settings'); return; }
      onCancel();
      return;
    }

    if (step === 'profile') {
      if (key.upArrow) setSelectedIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setSelectedIdx(i => Math.min(profiles.length - 1, i + 1));
      if (key.return && profiles[selectedIdx]) {
        const p = profiles[selectedIdx]!;
        setSelectedProfile(p);
        setDurationInput(p.durationMs ? formatMs(p.durationMs) : '');
        setStep('settings');
      }
      return;
    }

    if (step === 'settings') {
      if (key.tab) {
        setEditingField(f => f === 'duration' ? 'goal' : 'duration');
        return;
      }
      if (key.return) {
        setStep('confirm');
      }
      return;
    }

    if (step === 'confirm') {
      if (key.return) {
        // Parse duration using shared parser (handles 3h, 45m, 1h30m, etc.)
        let durationMs: number | undefined;
        if (durationInput.trim()) {
          const parsed = parseIntervalExpression(durationInput.trim());
          if (parsed) durationMs = parsed;
        }
        onLaunch(selectedProfile!.id, durationMs, goalInput.trim() || undefined);
      }
    }
  });

  // ── Step 1: Profile Picker ──────────────────────────────────────

  if (step === 'profile') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="#4338ca" paddingX={1}>
        <Text bold color="#a5b4fc">Choose a SLUMBER Profile</Text>
        <Text color={COLORS.muted}>↑↓ navigate · Enter select · Esc cancel</Text>
        <Box flexDirection="column" marginTop={1}>
          {profiles.map((p, i) => {
            const selected = i === selectedIdx;
            const intervalLabel = p.tickIntervalMs >= 3_600_000
              ? `${Math.round(p.tickIntervalMs / 3_600_000)}h`
              : `${Math.round(p.tickIntervalMs / 60_000)}m`;
            const durationLabel = p.durationMs ? formatMs(p.durationMs) : '∞';
            const budgetLabel = p.budgetTicks ? `${p.budgetTicks} ticks` : '∞';

            return (
              <Box key={p.id} flexDirection="column" marginBottom={1}
                borderStyle={selected ? 'round' : undefined}
                borderColor={selected ? '#818cf8' : undefined}
                paddingX={selected ? 1 : 0}
              >
                <Box gap={1}>
                  <Text color={selected ? '#e0e7ff' : COLORS.muted}>{selected ? '▸' : ' '}</Text>
                  <Text bold color={selected ? '#e0e7ff' : '#6366f1'}>{p.icon} {p.name}</Text>
                  <Text color={COLORS.muted}>({intervalLabel} ticks · {durationLabel} · {budgetLabel})</Text>
                </Box>
                <Box paddingLeft={3}>
                  <Text color={selected ? '#a5b4fc' : COLORS.muted} wrap="wrap">{p.description}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  }

  // ── Step 2: Settings ────────────────────────────────────────────

  if (step === 'settings' && selectedProfile) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="#4338ca" paddingX={1}>
        <Text bold color="#a5b4fc">{selectedProfile.icon} {selectedProfile.name} — Settings</Text>
        <Text color={COLORS.muted}>Tab switch field · Enter confirm · Esc back</Text>

        <Box flexDirection="column" marginTop={1} gap={1}>
          <Box gap={1}>
            <Text color={editingField === 'duration' ? '#e0e7ff' : COLORS.muted} bold={editingField === 'duration'}>
              Duration:
            </Text>
            {editingField === 'duration' ? (
              <TextInput value={durationInput} onChange={setDurationInput} placeholder={selectedProfile.durationMs ? formatMs(selectedProfile.durationMs) : 'indefinite (leave empty)'} />
            ) : (
              <Text color={COLORS.subtle}>{durationInput || (selectedProfile.durationMs ? formatMs(selectedProfile.durationMs) : 'indefinite')}</Text>
            )}
          </Box>

          <Box gap={1}>
            <Text color={editingField === 'goal' ? '#e0e7ff' : COLORS.muted} bold={editingField === 'goal'}>
              Goal:
            </Text>
            {editingField === 'goal' ? (
              <TextInput value={goalInput} onChange={setGoalInput} placeholder="optional — what should CEO focus on?" />
            ) : (
              <Text color={COLORS.subtle}>{goalInput || '(none)'}</Text>
            )}
          </Box>
        </Box>
      </Box>
    );
  }

  // ── Step 3: Confirmation ────────────────────────────────────────

  if (step === 'confirm' && selectedProfile) {
    const durationLabel = durationInput.trim() || (selectedProfile.durationMs ? formatMs(selectedProfile.durationMs) : 'indefinite');

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="#4338ca" paddingX={1}>
        <Text bold color="#a5b4fc">Launch SLUMBER?</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text color="#e0e7ff">  Profile:  {selectedProfile.icon} {selectedProfile.name}</Text>
          <Text color="#e0e7ff">  Duration: {durationLabel}</Text>
          <Text color="#e0e7ff">  Ticks:    every {Math.round(selectedProfile.tickIntervalMs / 60_000)}m</Text>
          {selectedProfile.budgetTicks && <Text color="#e0e7ff">  Budget:   {selectedProfile.budgetTicks} ticks max</Text>}
          {goalInput && <Text color="#e0e7ff">  Goal:     {goalInput}</Text>}
          <Text color="#e0e7ff">  Agents:   {selectedProfile.conscription}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.muted}>Enter to launch · Esc to go back</Text>
        </Box>
      </Box>
    );
  }

  return <Text color={COLORS.muted}>Loading profiles...</Text>;
}
