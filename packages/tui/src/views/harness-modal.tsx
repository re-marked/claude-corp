import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from '@claude-code-kit/ink-renderer';
import { join } from 'node:path';
import {
  readConfig,
  ensureGlobalConfig,
  MEMBERS_JSON,
  type Member,
  type ReconcileAgentWorkspaceResult,
} from '@claudecorp/shared';
import { COLORS, BORDER_STYLE } from '../theme.js';
import { detectAvailableHarnesses, type HarnessOption } from '../utils/harness-detect.js';
import { applyHarnessSwitch } from '../utils/harness-switch.js';

/**
 * /harness — interactive modal for switching an agent's execution
 * substrate. Mirrors what `cc-cli agent set-harness` does server-side
 * but gives the user a live, navigable picker instead of a flag-based
 * invocation.
 *
 * Three screens:
 *   list    — agents + their current harness. Select one.
 *   switch  — pick the new harness for that agent. Preview what the
 *             reconciler will do. Confirm.
 *   result  — show renamed / backed-up / written files. Continue.
 *
 * The actual work mirrors cmdAgentSetHarness exactly: update the
 * Member in members.json, update the agent's config.json, run
 * reconcileAgentWorkspace to migrate legacy filenames + write/remove
 * CLAUDE.md. All filesystem work is synchronous and deterministic, so
 * no network round-trip to the daemon is needed.
 */

type Screen = 'list' | 'switch' | 'result' | 'error';

interface Props {
  corpRoot: string;
  onClose: () => void;
}

const HARNESS_DISPLAY: Record<string, string> = {
  'claude-code': 'Claude Code',
  'openclaw': 'OpenClaw',
};

const HARNESS_CHOICES: { id: 'claude-code' | 'openclaw'; label: string }[] = [
  { id: 'claude-code', label: HARNESS_DISPLAY['claude-code']! },
  { id: 'openclaw', label: HARNESS_DISPLAY['openclaw']! },
];

function harnessLabel(id: string | undefined): string {
  if (!id) return 'openclaw';
  return HARNESS_DISPLAY[id] ?? id;
}

export function HarnessModal({ corpRoot, onClose }: Props) {
  const [screen, setScreen] = useState<Screen>('list');
  const [agents, setAgents] = useState<Member[]>(() => loadAgents(corpRoot));
  const [agentIndex, setAgentIndex] = useState(0);
  const [targetIndex, setTargetIndex] = useState(0);
  const [reconcileResult, setReconcileResult] = useState<ReconcileAgentWorkspaceResult | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const detected = useMemo<HarnessOption[]>(() => {
    try { return detectAvailableHarnesses(ensureGlobalConfig()); }
    catch { return []; }
  }, []);
  const detectedById = (id: string) => detected.find(d => d.id === id) ?? null;

  const selectedAgent = agents[agentIndex];
  const currentHarness = selectedAgent?.harness ?? 'openclaw';

  useInput((input, key) => {
    if (key.escape) {
      if (screen === 'result' || screen === 'error' || screen === 'switch') {
        setScreen('list');
        setReconcileResult(null);
        setErrorMessage('');
        return;
      }
      onClose();
      return;
    }

    if (screen === 'list') {
      if (key.upArrow) setAgentIndex(i => Math.max(0, i - 1));
      else if (key.downArrow) setAgentIndex(i => Math.min(agents.length - 1, i + 1));
      else if (key.return && selectedAgent) {
        // Pre-select the index matching the current harness so confirm
        // with no arrow-keys is a no-op (user can back out with Esc).
        const idx = HARNESS_CHOICES.findIndex(c => c.id === currentHarness);
        setTargetIndex(idx >= 0 ? idx : 0);
        setScreen('switch');
      }
      return;
    }

    if (screen === 'switch') {
      if (key.upArrow) setTargetIndex(i => Math.max(0, i - 1));
      else if (key.downArrow) setTargetIndex(i => Math.min(HARNESS_CHOICES.length - 1, i + 1));
      else if (key.return && selectedAgent) {
        const targetHarness = HARNESS_CHOICES[targetIndex]!.id;
        try {
          const result = applyHarnessSwitch({
            corpRoot,
            member: selectedAgent,
            targetHarness,
          });
          setReconcileResult(result);
          // Reload the member list so the picker reflects the new
          // harness next time the user enters the list screen.
          setAgents(loadAgents(corpRoot));
          setScreen('result');
        } catch (err) {
          setErrorMessage(err instanceof Error ? err.message : String(err));
          setScreen('error');
        }
      }
      return;
    }

    if (screen === 'result' || screen === 'error') {
      if (key.return) {
        setScreen('list');
        setReconcileResult(null);
        setErrorMessage('');
      }
      return;
    }
  });

  if (screen === 'list') {
    if (agents.length === 0) {
      return (
        <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.primary} paddingX={2} paddingY={1} width={60}>
          <Text bold color={COLORS.primary}>Agent engines</Text>
          <Box marginTop={1}><Text color={COLORS.muted}>No agents found in this corp.</Text></Box>
          <Box marginTop={1}><Text dimColor>Esc to close</Text></Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.primary} paddingX={2} paddingY={1} width={72}>
        <Box justifyContent="space-between">
          <Text bold color={COLORS.primary}>Agent engines</Text>
          <Text dimColor>{agents.length} agent{agents.length === 1 ? '' : 's'}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.muted}>Select an agent to change its execution substrate.</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Box gap={2}>
            <Box width={16}><Text dimColor bold>Agent</Text></Box>
            <Box width={10}><Text dimColor bold>Rank</Text></Box>
            <Box width={16}><Text dimColor bold>Engine</Text></Box>
            <Box><Text dimColor bold>Status</Text></Box>
          </Box>
          {agents.map((a, i) => {
            const isSel = i === agentIndex;
            const hLabel = harnessLabel(a.harness);
            return (
              <Box key={a.id} gap={2}>
                <Box width={16}>
                  <Text color={isSel ? COLORS.primary : COLORS.text} bold={isSel}>
                    {isSel ? '▸ ' : '  '}{a.displayName}
                  </Text>
                </Box>
                <Box width={10}><Text color={COLORS.subtle}>{a.rank}</Text></Box>
                <Box width={16}><Text color={isSel ? COLORS.text : COLORS.subtle}>{hLabel}</Text></Box>
                <Box>
                  <Text color={a.status === 'active' ? COLORS.success : COLORS.warning}>
                    ● {a.status}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>↑↓ navigate  Enter change  Esc close</Text>
        </Box>
      </Box>
    );
  }

  if (screen === 'switch' && selectedAgent) {
    const targetId = HARNESS_CHOICES[targetIndex]!.id;
    const detail = detectedById(targetId);
    const isSameAsCurrent = targetId === currentHarness;
    const needsFileWrite = targetId === 'claude-code';
    const needsFileRemove = currentHarness === 'claude-code' && targetId !== 'claude-code';

    return (
      <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.primary} paddingX={2} paddingY={1} width={68}>
        <Text bold color={COLORS.primary}>Switch {selectedAgent.displayName}'s engine</Text>
        <Box marginTop={1}>
          <Text color={COLORS.muted}>Currently: <Text color={COLORS.text}>{harnessLabel(currentHarness)}</Text></Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          {HARNESS_CHOICES.map((c, i) => {
            const isSel = i === targetIndex;
            const isCurrent = c.id === currentHarness;
            const cDetail = detectedById(c.id);
            return (
              <Box key={c.id} gap={1}>
                <Text color={isSel ? COLORS.primary : COLORS.muted}>{isSel ? '▸' : ' '}</Text>
                <Text bold={isSel} color={isSel ? COLORS.text : COLORS.subtle}>{c.label}</Text>
                {isCurrent && <Text dimColor>(current)</Text>}
                {cDetail && (
                  <Text color={cDetail.available ? COLORS.success : COLORS.warning}>{cDetail.note}</Text>
                )}
              </Box>
            );
          })}
        </Box>

        {detail && !detail.available && !isSameAsCurrent && (
          <Box marginTop={1}>
            <Text color={COLORS.warning}>→ {detail.fixHint}</Text>
          </Box>
        )}

        <Box marginTop={1} flexDirection="column">
          <Text color={COLORS.muted}>
            {isSameAsCurrent ? 'No change — press Enter to confirm.' : 'This will migrate the agent\'s workspace:'}
          </Text>
          {!isSameAsCurrent && (
            <>
              <Text color={COLORS.subtle}>  • AGENTS.md / TOOLS.md stay canonical</Text>
              <Text color={COLORS.subtle}>  • legacy RULES.md / ENVIRONMENT.md get backed up if present</Text>
              {needsFileWrite && <Text color={COLORS.subtle}>  • CLAUDE.md will be (re)written</Text>}
              {needsFileRemove && <Text color={COLORS.subtle}>  • CLAUDE.md will be moved to .backup</Text>}
            </>
          )}
        </Box>

        <Box marginTop={1}>
          <Text dimColor>↑↓ select  Enter confirm  Esc back</Text>
        </Box>
      </Box>
    );
  }

  if (screen === 'result' && selectedAgent && reconcileResult) {
    const targetLabel = harnessLabel(HARNESS_CHOICES[targetIndex]!.id);
    return (
      <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.success} paddingX={2} paddingY={1} width={68}>
        <Text bold color={COLORS.success}>✓ Switched {selectedAgent.displayName} to {targetLabel}</Text>
        <Box marginTop={1} flexDirection="column">
          {reconcileResult.renamed.map((r, i) => (
            <Text key={`ren-${i}`} color={COLORS.subtle}>  ✓ {r.from} → {r.to}</Text>
          ))}
          {reconcileResult.conflicts.map((c, i) => (
            <Text key={`conf-${i}`} color={COLORS.warning}>  ⚠ conflict resolved: {c.from} / {c.to} — older backed up</Text>
          ))}
          {reconcileResult.claudeMdWritten && (
            <Text color={COLORS.subtle}>  ✓ CLAUDE.md written</Text>
          )}
          {reconcileResult.claudeMdBackedUp && (
            <Text color={COLORS.subtle}>  ✓ CLAUDE.md moved to .backup</Text>
          )}
          {!reconcileResult.renamed.length &&
           !reconcileResult.conflicts.length &&
           !reconcileResult.claudeMdWritten &&
           !reconcileResult.claudeMdBackedUp && (
            <Text color={COLORS.muted}>  (no file changes — workspace was already in target state)</Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter back to list  Esc close</Text>
        </Box>
      </Box>
    );
  }

  if (screen === 'error') {
    return (
      <Box flexDirection="column" borderStyle={BORDER_STYLE} borderColor={COLORS.danger} paddingX={2} paddingY={1} width={68}>
        <Text bold color={COLORS.danger}>✗ Switch failed</Text>
        <Box marginTop={1}>
          <Text color={COLORS.text}>{errorMessage}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter back to list  Esc close</Text>
        </Box>
      </Box>
    );
  }

  return null;
}

function loadAgents(corpRoot: string): Member[] {
  try {
    const all = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
    return all.filter(m => m.type === 'agent' && m.status === 'active');
  } catch {
    return [];
  }
}
