import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from '@claude-code-kit/ink-renderer';
import { TextInput } from '../components/text-input.js';
import type { DaemonClient } from '../lib/daemon-client.js';
import type { Member } from '@claudecorp/shared';
import { COLORS } from '../theme.js';

type Step = 'select' | 'action' | 'cascade-warn' | 'cascade-confirm' | 'review' | 'firing' | 'done' | 'error';
type Action = 'fire' | 'remove';

const CASCADE_PHRASE = 'remove all workers';

interface Props {
  daemonClient: DaemonClient;
  requesterId: string;
  members: Member[];
  onClose: () => void;
  onFired: (displayName: string) => void;
}

export function FireWizard({ daemonClient, requesterId, members, onClose, onFired }: Props) {
  // Only show agents the requester has authority to fire.
  // Workers can't fire anyone; leaders only their direct reports;
  // master/owner can fire anyone except CEO (sacred — enforced by backend too).
  const requester = members.find((m) => m.id === requesterId);
  const fireable = members.filter((m) => {
    if (!requester) return false;
    if (m.id === requesterId) return false; // can't fire yourself
    if (m.rank === 'master') return false;  // CEO is sacred
    if (requester.rank === 'owner' || requester.rank === 'master') return true;
    if (requester.rank === 'leader') return m.supervisorId === requesterId;
    return false; // workers can't fire
  });

  const [step, setStep] = useState<Step>(fireable.length === 0 ? 'error' : 'select');
  const [agentIndex, setAgentIndex] = useState(0);
  const [action, setAction] = useState<Action>('fire');
  const [actionIndex, setActionIndex] = useState(0);
  const [cascadePhrase, setCascadePhrase] = useState('');
  const [error, setError] = useState('');
  const [resultMessage, setResultMessage] = useState('');

  const selected = fireable[agentIndex];

  // Workers this agent manages (for cascade warning)
  const subordinates = selected
    ? members.filter((m) => m.supervisorId === selected.id)
    : [];
  const hasWorkers = subordinates.length > 0;

  const ACTIONS: { label: string; value: Action; detail: string }[] = [
    { value: 'fire', label: 'Archive (offline)', detail: 'Agent goes offline, history preserved' },
    { value: 'remove', label: 'Remove (delete)', detail: 'Permanent — no recovery' },
  ];

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }

    if (step === 'select') {
      if (key.upArrow) setAgentIndex(i => Math.max(0, i - 1));
      else if (key.downArrow) setAgentIndex(i => Math.min(fireable.length - 1, i + 1));
      else if (key.return) setStep(hasWorkers ? 'cascade-warn' : 'action');
    }

    if (step === 'cascade-warn') {
      if (key.upArrow || key.downArrow) {
        // Only one real option: proceed with cascade or abort
        // Left/right not applicable — see rendering below
      }
      if (key.return) setStep('cascade-confirm');
      if (key.escape) { onClose(); return; }
    }

    if (step === 'action') {
      if (key.upArrow) setActionIndex(i => Math.max(0, i - 1));
      else if (key.downArrow) setActionIndex(i => Math.min(ACTIONS.length - 1, i + 1));
      else if (key.return) {
        setAction(ACTIONS[actionIndex]!.value);
        setStep('review');
      }
    }

    if (step === 'review') {
      if (key.return) doFire();
      if (key.escape) setStep('action');
    }

    if (step === 'done' || step === 'error') {
      if (key.return || key.escape) onClose();
    }
  });

  const handleCascadeSubmit = (val: string) => {
    if (val.toLowerCase() === CASCADE_PHRASE) {
      setStep('action');
    } else {
      setError(`Type exactly: ${CASCADE_PHRASE}`);
    }
  };

  const doFire = async () => {
    if (!selected) return;
    setStep('firing');

    try {
      const result = await daemonClient.fireAgent({
        targetId: selected.id,
        requesterId,
        action,
        cascade: subordinates.length > 0,
      });

      if ((result as any).error) {
        setError((result as any).error);
        setStep('error');
        return;
      }

      setResultMessage(result.message);
      setStep('done');
      onFired(selected.displayName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  };

  const selectedLabel = selected?.displayName ?? '—';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLORS.danger} paddingX={2} paddingY={1} width={62}>
      <Box marginBottom={1}>
        <Text bold color={COLORS.danger}>Fire an Agent</Text>
        <Text dimColor>  (Esc to cancel)</Text>
      </Box>

      {step === 'select' && (
        <Box flexDirection="column">
          <Text>Select agent:</Text>
          <Box flexDirection="column" marginTop={1}>
            {fireable.map((m, i) => {
              const subs = members.filter(s => s.supervisorId === m.id).length;
              return (
                <Box key={m.id} gap={1}>
                  <Text color={i === agentIndex ? COLORS.danger : COLORS.muted} bold={i === agentIndex}>
                    {i === agentIndex ? '▸' : ' '} {m.displayName}
                  </Text>
                  <Text dimColor>[{m.rank}]</Text>
                  {subs > 0 && <Text color={COLORS.warning}>{subs} worker{subs !== 1 ? 's' : ''}</Text>}
                </Box>
              );
            })}
          </Box>
          <Box marginTop={1}><Text dimColor>↑↓ select  Enter confirm</Text></Box>
        </Box>
      )}

      {step === 'cascade-warn' && (
        <Box flexDirection="column">
          <Text>Target: <Text bold color={COLORS.danger}>{selectedLabel}</Text></Text>
          <Box flexDirection="column" borderStyle="round" borderColor={COLORS.warning} paddingX={2} paddingY={1} marginTop={1}>
            <Text bold color={COLORS.warning}>⚠ This leader has {subordinates.length} active worker{subordinates.length !== 1 ? 's' : ''}</Text>
            <Box flexDirection="column" marginTop={1}>
              {subordinates.map(s => (
                <Text key={s.id} dimColor>  · {s.displayName}</Text>
              ))}
            </Box>
            <Box marginTop={1}>
              <Text color={COLORS.warning}>Proceeding will fire all of them first.</Text>
            </Box>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text>To proceed with cascade, type the confirmation phrase below.</Text>
            <Text dimColor>Or Esc to cancel.</Text>
          </Box>
          <Box marginTop={1}><Text dimColor>Enter → confirm screen</Text></Box>
        </Box>
      )}

      {step === 'cascade-confirm' && (
        <Box flexDirection="column">
          <Text>Target: <Text bold color={COLORS.danger}>{selectedLabel}</Text>  + {subordinates.length} worker{subordinates.length !== 1 ? 's' : ''}</Text>
          <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={COLORS.danger} paddingX={2} paddingY={1}>
            <Text bold color={COLORS.danger}>CASCADE — THIS CANNOT BE UNDONE</Text>
            <Box marginTop={1}>
              <Text>Type <Text bold color={COLORS.warning}>"{CASCADE_PHRASE}"</Text> to enable cascade:</Text>
            </Box>
            <Box marginTop={1}>
              <Text bold color={COLORS.danger}>▸ </Text>
              <TextInput
                value={cascadePhrase}
                onChange={(v) => { setCascadePhrase(v); setError(''); }}
                onSubmit={handleCascadeSubmit}
                placeholder={CASCADE_PHRASE}
              />
            </Box>
            {error && <Text color={COLORS.danger}>{error}</Text>}
          </Box>
        </Box>
      )}

      {step === 'action' && (
        <Box flexDirection="column">
          <Text>
            Target: <Text bold color={COLORS.danger}>{selectedLabel}</Text>
            {subordinates.length > 0 && <Text color={COLORS.warning}>  + {subordinates.length} worker{subordinates.length !== 1 ? 's' : ''}</Text>}
          </Text>
          <Box marginTop={1}><Text>Choose action:</Text></Box>
          <Box flexDirection="column" marginTop={1}>
            {ACTIONS.map((a, i) => (
              <Box key={a.value} gap={1}>
                <Text color={i === actionIndex ? COLORS.danger : COLORS.muted} bold={i === actionIndex}>
                  {i === actionIndex ? '▸' : ' '} {a.label}
                </Text>
                <Text dimColor>— {a.detail}</Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}><Text dimColor>↑↓ select  Enter confirm</Text></Box>
        </Box>
      )}

      {step === 'review' && (
        <Box flexDirection="column">
          <Text>Agent: <Text bold color={COLORS.danger}>{selectedLabel}</Text></Text>
          <Text>Action: <Text bold color={action === 'remove' ? COLORS.danger : COLORS.warning}>
            {action === 'remove' ? 'Remove (permanent deletion)' : 'Archive (offline)'}
          </Text></Text>
          {subordinates.length > 0 && (
            <Text color={COLORS.warning}>Cascade: <Text bold>{subordinates.length} worker{subordinates.length !== 1 ? 's' : ''} will be fired first</Text></Text>
          )}
          <Box marginTop={1}>
            <Text dimColor>Enter to confirm  Esc to go back</Text>
          </Box>
        </Box>
      )}

      {step === 'firing' && (
        <Text color={COLORS.warning}>
          {action === 'remove' ? 'Removing' : 'Archiving'} {selectedLabel}
          {subordinates.length > 0 ? ` and ${subordinates.length} worker${subordinates.length !== 1 ? 's' : ''}` : ''}...
        </Text>
      )}

      {step === 'done' && (
        <Text color={COLORS.success}>{resultMessage}</Text>
      )}

      {step === 'error' && fireable.length === 0 && (
        <Text color={COLORS.muted}>You don't have authority to fire anyone.</Text>
      )}

      {step === 'error' && fireable.length > 0 && (
        <Text color={COLORS.danger}>Failed: {error}</Text>
      )}
    </Box>
  );
}
