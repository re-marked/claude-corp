import React, { useState, useEffect, useMemo, useContext, useCallback } from 'react';
import { Box, Text, useInput, ScrollBox, TerminalSizeContext } from '@claude-code-kit/ink-renderer';
import {
  getCorpFeedbackIntel,
  type CorpFeedbackIntel,
  type AgentFeedbackIntel,
  type CultureCandidate,
  type PendingFeedbackEntry,
  type FeedbackBrainEntry,
} from '@claudecorp/shared';
import { useCorp } from '../context/corp-context.js';
import { COLORS, BORDER_STYLE } from '../theme.js';

interface Props {
  onBack: () => void;
}

type Pane = 'agents' | 'detail' | 'culture';

// ── Polarity + strength visuals ─────────────────────────────────────

function polarityColor(polarity: string): string {
  if (polarity === 'correction') return COLORS.danger;
  if (polarity === 'confirmation') return COLORS.success;
  if (polarity === 'mixed') return COLORS.warning;
  return COLORS.muted;
}

function strengthColor(strength: CultureCandidate['strength']): string {
  if (strength === 'strong') return COLORS.success;
  if (strength === 'moderate') return COLORS.warning;
  return COLORS.muted;
}

function relativeTime(ms: number | null): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Main view ───────────────────────────────────────────────────────

export function FeedbackView({ onBack }: Props) {
  const { corpRoot } = useCorp();
  const termSize = useContext(TerminalSizeContext);
  const termWidth = termSize?.columns ?? 120;
  const termHeight = termSize?.rows ?? 40;

  const [intel, setIntel] = useState<CorpFeedbackIntel | null>(null);
  const [agentIdx, setAgentIdx] = useState(0);
  const [pane, setPane] = useState<Pane>('agents');
  const [showFullCulture, setShowFullCulture] = useState(false);
  const [candidateIdx, setCandidateIdx] = useState(0);

  // Initial + interval refresh. fs.watch across multiple agent dirs is
  // more complex than we need; 3s polling is cheap and keeps the code
  // simple. The intel function is pure disk reads.
  const refresh = useCallback(() => {
    try {
      setIntel(getCorpFeedbackIntel(corpRoot));
    } catch {
      // If disk reads fail mid-refresh, keep the last good snapshot.
    }
  }, [corpRoot]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3_000);
    return () => clearInterval(t);
  }, [refresh]);

  const agents = intel?.agents ?? [];
  const selected = agents[agentIdx] ?? null;
  const candidates = intel?.candidates ?? [];

  // Keyboard routing.
  useInput((input, key) => {
    if (key.escape || input === 'q') {
      if (showFullCulture) { setShowFullCulture(false); return; }
      onBack();
      return;
    }

    if (input === 'r') { refresh(); return; }

    if (input === 'c') {
      setShowFullCulture(prev => !prev);
      return;
    }

    if (key.tab) {
      setPane(prev => prev === 'agents' ? 'culture' : prev === 'culture' ? 'detail' : 'agents');
      return;
    }

    if (pane === 'agents') {
      if (key.upArrow) setAgentIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setAgentIdx(i => Math.min(Math.max(agents.length - 1, 0), i + 1));
    } else if (pane === 'culture') {
      if (key.upArrow) setCandidateIdx(i => Math.max(0, i - 1));
      if (key.downArrow) setCandidateIdx(i => Math.min(Math.max(candidates.length - 1, 0), i + 1));
    }
  });

  if (!intel) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={COLORS.subtle}>Loading feedback intel…</Text>
      </Box>
    );
  }

  // Full-screen CULTURE.md reader (press 'c' to toggle)
  if (showFullCulture) {
    return (
      <CultureFullscreen
        content={intel.cultureContent}
        path={intel.culturePath}
        termHeight={termHeight}
      />
    );
  }

  const leftWidth = Math.max(28, Math.min(36, Math.floor(termWidth * 0.28)));
  const rightWidth = Math.max(40, termWidth - leftWidth - 2);

  return (
    <Box flexDirection="column" height={termHeight}>
      <Header intel={intel} />

      <Box flexDirection="row" flexGrow={1}>
        <Box width={leftWidth} flexDirection="column" flexShrink={0}>
          <AgentColumn
            agents={agents}
            selectedIdx={agentIdx}
            isActive={pane === 'agents'}
          />
        </Box>

        <Box width={rightWidth} flexDirection="column">
          <DetailPane
            agent={selected}
            isActive={pane === 'detail'}
            height={Math.floor(termHeight * 0.55)}
          />

          <CulturePane
            intel={intel}
            candidateIdx={candidateIdx}
            isActive={pane === 'culture'}
          />
        </Box>
      </Box>

      <Footer pane={pane} />
    </Box>
  );
}

// ── Header ──────────────────────────────────────────────────────────

function Header({ intel }: { intel: CorpFeedbackIntel }) {
  const t = intel.totals;
  return (
    <Box flexDirection="row" paddingX={1}>
      <Text bold color={COLORS.primary}>Feedback</Text>
      <Text color={COLORS.muted}>  ·  </Text>
      <Text color={COLORS.warning}>{t.totalPendingEntries} pending</Text>
      <Text color={COLORS.muted}>  ·  </Text>
      <Text color={COLORS.info}>{t.totalFeedbackBrainEntries} BRAIN</Text>
      <Text color={COLORS.muted}>  ·  </Text>
      <Text color={COLORS.success}>{t.totalTimesHeard}x heard</Text>
      <Text color={COLORS.muted}>  ·  </Text>
      <Text color={COLORS.success}>{t.strongCandidates} strong</Text>
      <Text color={COLORS.muted}> / </Text>
      <Text color={COLORS.warning}>{t.moderateCandidates} moderate</Text>
      <Text color={COLORS.muted}> candidates</Text>
    </Box>
  );
}

// ── Agent column (left) ─────────────────────────────────────────────

function AgentColumn({
  agents, selectedIdx, isActive,
}: {
  agents: AgentFeedbackIntel[];
  selectedIdx: number;
  isActive: boolean;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER_STYLE}
      borderColor={isActive ? COLORS.borderActive : COLORS.border}
      paddingX={1}
      flexGrow={1}
    >
      <Text bold color={isActive ? COLORS.primary : COLORS.subtle}>Agents</Text>
      <Box marginBottom={1} />
      {agents.length === 0 ? (
        <Text color={COLORS.muted}>no agents</Text>
      ) : (
        agents.map((a, i) => {
          const sel = i === selectedIdx;
          const pendingLabel = a.stats.pendingCount > 0
            ? `${a.stats.pendingCount}p`
            : '·';
          const repeatLabel = a.stats.repeatedEntryCount > 0
            ? `${a.stats.repeatedEntryCount}r`
            : '';
          return (
            <Box key={a.agentName} flexDirection="row">
              <Text color={sel ? COLORS.primary : COLORS.muted}>{sel ? '▸ ' : '  '}</Text>
              <Text bold={sel} color={sel ? COLORS.text : COLORS.subtle}>{a.agentName.padEnd(12).slice(0, 12)}</Text>
              <Text color={a.stats.pendingCount > 0 ? COLORS.warning : COLORS.muted}>
                {' '}{pendingLabel.padStart(3)}
              </Text>
              <Text color={COLORS.info}>
                {' '}{String(a.brainEntries.length).padStart(2)}b
              </Text>
              {repeatLabel && (
                <Text color={COLORS.success}>{' '}{repeatLabel}</Text>
              )}
            </Box>
          );
        })
      )}
    </Box>
  );
}

// ── Detail pane (middle-top) ────────────────────────────────────────

function DetailPane({
  agent, isActive, height,
}: {
  agent: AgentFeedbackIntel | null;
  isActive: boolean;
  height: number;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER_STYLE}
      borderColor={isActive ? COLORS.borderActive : COLORS.border}
      paddingX={1}
      height={height}
    >
      {!agent ? (
        <Text color={COLORS.muted}>(no agent selected)</Text>
      ) : (
        <ScrollBox stickyScroll={false}>
          <Box flexDirection="column">
            <Box>
              <Text bold color={COLORS.primary}>{agent.agentName}</Text>
              <Text color={COLORS.muted}>  {agent.agentDir}</Text>
            </Box>
            <Box marginBottom={1} />

            <Text bold color={COLORS.warning}>
              Pending {agent.stats.pendingCount > 0
                ? `(${agent.stats.pendingCount} · ${relativeTime(agent.pendingMtimeMs)})`
                : '(none)'}
            </Text>
            {agent.pending.length === 0 ? (
              <Text color={COLORS.muted}>  nothing awaiting next dream</Text>
            ) : (
              agent.pending.map((p, i) => <PendingEntryRow key={i} entry={p} />)
            )}

            <Box marginBottom={1} />
            <Text bold color={COLORS.info}>
              BRAIN entries ({agent.brainEntries.length})
            </Text>
            {agent.brainEntries.length === 0 ? (
              <Text color={COLORS.muted}>  no feedback-sourced entries yet</Text>
            ) : (
              agent.brainEntries.map((e) => <BrainEntryRow key={e.name} entry={e} />)
            )}
          </Box>
        </ScrollBox>
      )}
    </Box>
  );
}

function PendingEntryRow({ entry }: { entry: PendingFeedbackEntry }) {
  const when = entry.timestamp?.slice(11, 16) ?? '??:??';
  const quote = entry.quote.replace(/\n/g, ' ');
  const quoteDisplay = quote.length > 200 ? quote.slice(0, 197) + '…' : quote;
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={1}>
      <Box>
        <Text color={COLORS.subtle}>{when} </Text>
        <Text bold color={polarityColor(entry.polarity)}>{entry.polarity}</Text>
        {entry.channel && (
          <Text color={COLORS.muted}> · {entry.channel}</Text>
        )}
      </Box>
      {entry.matchedPatterns.length > 0 && (
        <Text color={COLORS.muted}>  matched: {entry.matchedPatterns.slice(0, 5).join(', ')}</Text>
      )}
      <Text color={COLORS.text} wrap="wrap">  &gt; {quoteDisplay}</Text>
    </Box>
  );
}

function BrainEntryRow({ entry }: { entry: FeedbackBrainEntry }) {
  return (
    <Box flexDirection="column" marginTop={1} marginLeft={1}>
      <Box>
        <Text bold color={entry.timesHeard >= 2 ? COLORS.success : COLORS.subtle}>
          ×{entry.timesHeard}
        </Text>
        <Text color={COLORS.text} bold> {entry.name}</Text>
        <Text color={COLORS.muted}> · {entry.source} · {entry.type} · conf={entry.confidence}</Text>
      </Box>
      {entry.tags.length > 0 && (
        <Text color={COLORS.muted}>  tags: {entry.tags.slice(0, 8).join(', ')}</Text>
      )}
      <Text color={COLORS.subtle} wrap="wrap">  {entry.excerpt.slice(0, 200)}</Text>
    </Box>
  );
}

// ── Culture pane (middle-bottom) ────────────────────────────────────

function CulturePane({
  intel, candidateIdx, isActive,
}: {
  intel: CorpFeedbackIntel;
  candidateIdx: number;
  isActive: boolean;
}) {
  const candidates = intel.candidates;
  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER_STYLE}
      borderColor={isActive ? COLORS.borderActive : COLORS.border}
      paddingX={1}
      flexGrow={1}
    >
      <Box>
        <Text bold color={isActive ? COLORS.primary : COLORS.subtle}>CULTURE.md</Text>
        {intel.cultureContent === null ? (
          <Text color={COLORS.muted}>  (not yet written)</Text>
        ) : (
          <>
            <Text color={COLORS.muted}>  {intel.cultureSizeChars} chars</Text>
            <Text color={COLORS.info}>  · press </Text>
            <Text bold color={COLORS.primary}>c</Text>
            <Text color={COLORS.info}> to read</Text>
          </>
        )}
      </Box>

      <Box marginTop={1}>
        <Text bold color={COLORS.warning}>
          Promotion queue ({candidates.length})
        </Text>
      </Box>

      {candidates.length === 0 ? (
        <Text color={COLORS.muted}>  nothing queued — feedback hasn't compounded enough yet</Text>
      ) : (
        <ScrollBox stickyScroll={false}>
          <Box flexDirection="column">
            {candidates.map((c, i) => (
              <CandidateRow key={i} cand={c} selected={isActive && i === candidateIdx} />
            ))}
          </Box>
        </ScrollBox>
      )}
    </Box>
  );
}

function CandidateRow({ cand, selected }: { cand: CultureCandidate; selected: boolean }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={selected ? COLORS.primary : COLORS.muted}>{selected ? '▸ ' : '  '}</Text>
        <Text bold color={strengthColor(cand.strength)}>[{cand.strength}]</Text>
        <Text color={COLORS.text} bold> {cand.sharedTags.slice(0, 4).join(', ')}</Text>
        <Text color={COLORS.muted}>  · {cand.agents.length} agent(s) · heard {cand.totalTimesHeard}x</Text>
      </Box>
      <Text color={COLORS.subtle}>    agents: {cand.agents.join(', ')}</Text>
      {cand.entries.slice(0, 2).map(e => (
        <Text key={`${e.agent}/${e.file}`} color={COLORS.muted} wrap="wrap">
          {`    ${e.agent}/${e.file} (×${e.timesHeard}): ${e.excerpt.slice(0, 100)}`}
        </Text>
      ))}
    </Box>
  );
}

// ── Full-screen CULTURE.md viewer ───────────────────────────────────

function CultureFullscreen({
  content, path, termHeight,
}: {
  content: string | null;
  path: string;
  termHeight: number;
}) {
  return (
    <Box flexDirection="column" height={termHeight} padding={1}>
      <Box>
        <Text bold color={COLORS.primary}>CULTURE.md</Text>
        <Text color={COLORS.muted}>  {path}</Text>
      </Box>
      <Box marginBottom={1} />
      <Box borderStyle={BORDER_STYLE} borderColor={COLORS.border} paddingX={1} flexGrow={1}>
        <ScrollBox stickyScroll={false}>
          {content === null ? (
            <Text color={COLORS.muted}>(not yet written — next CEO dream will populate it)</Text>
          ) : (
            <Text color={COLORS.text}>{content}</Text>
          )}
        </ScrollBox>
      </Box>
      <Box marginTop={1}>
        <Text color={COLORS.subtle}>c/Esc: back</Text>
      </Box>
    </Box>
  );
}

// ── Footer ──────────────────────────────────────────────────────────

function Footer({ pane }: { pane: Pane }) {
  const hintByPane: Record<Pane, string> = {
    agents: '↑↓ agent  tab: next pane',
    detail: 'tab: next pane',
    culture: '↑↓ candidate  tab: next pane',
  };
  return (
    <Box paddingX={1}>
      <Text color={COLORS.subtle}>{hintByPane[pane]}  ·  c: CULTURE.md  ·  r: refresh  ·  q/Esc: back</Text>
    </Box>
  );
}
