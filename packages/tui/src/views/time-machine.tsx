import React, { useState, useEffect, useContext } from 'react';
import { Box, Text, useInput, TerminalSizeContext } from '@claude-code-kit/ink-renderer';
import { Spinner } from '../components/spinner.js';
import { COLORS, BORDER_STYLE } from '../theme.js';
import { useCorp } from '../context/corp-context.js';

interface Commit {
  hash: string;
  message: string;
  date: string;
}

interface Props {
  onBack: () => void;
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Make git commit messages human-readable. */
function humanize(msg: string): string {
  // "CEO: update channels/dm-ceo-mark/messages.jsonl" → "CEO sent a message in #dm-ceo-mark"
  const channelMatch = msg.match(/^(.+?): update channels\/(.+?)\/messages\.jsonl/);
  if (channelMatch) return `${channelMatch[1]} sent a message in #${channelMatch[2]}`;

  // "system: update 4 agent file(s)" → "Agent files updated"
  if (msg.includes('agent file(s)')) return 'Agent files updated';

  // "system: update 2 channel(s), 1 task(s)" → "Channels and tasks updated"
  if (msg.includes('channel(s)') && msg.includes('task(s)')) return 'Channels and tasks updated';
  if (msg.includes('channel(s)')) return 'Channel activity';
  if (msg.includes('task(s)')) return 'Task status changed';

  // "Mark: update ..." → "You made a change"
  if (msg.startsWith('Mark:') || msg.startsWith('Tester:')) return 'You made a change';

  // "system: update deliverables/..." → "Deliverable updated"
  if (msg.includes('deliverables/')) return 'Deliverable file updated';

  // "system: update agents/ceo/MEMORY.md" → "CEO memory updated"
  const memoryMatch = msg.match(/update agents\/(.+?)\/MEMORY\.md/);
  if (memoryMatch) return `${memoryMatch[1]} memory updated`;

  // Fallback: just clean it up
  return msg.replace(/^(system|Mark|Tester): /, '');
}

export function TimeMachine({ onBack }: Props) {
  const { daemonClient } = useCorp();
  const termSize = useContext(TerminalSizeContext);
  const termHeight = termSize?.rows ?? 30;

  const [commits, setCommits] = useState<Commit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [headIdx, setHeadIdx] = useState(0); // Which commit is HEAD (current state)
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');

  const loadLog = async () => {
    setLoading(true);
    try {
      const log = await daemonClient.getGitLog(50);
      setCommits(log);
      setHeadIdx(0); // HEAD is always the first (newest) commit after load
      setCursor(0);
    } catch {
      setCommits([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadLog();
  }, []);

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setCursor((i) => Math.max(0, i - 1));
    }
    if (key.downArrow || input === 'j') {
      setCursor((i) => Math.min(commits.length - 1, i + 1));
    }

    // Enter — travel to selected point
    if (key.return && commits[cursor]) {
      if (cursor === headIdx) {
        setStatus('Already here.');
        return;
      }
      const hash = commits[cursor]!.hash;
      setStatus('Traveling...');
      daemonClient.rewindTo(hash).then(({ result }) => {
        setHeadIdx(cursor);
        setStatus(cursor > headIdx ? '\u23EA Went back in time' : '\u23E9 Went forward in time');
      }).catch(() => {
        setStatus('Travel failed');
      });
    }

    // R — refresh
    if (input === 'r' || input === 'R') {
      loadLog();
      setStatus('Refreshed');
    }
  });

  const visibleCount = Math.max(termHeight - 8, 5);
  let startIdx = 0;
  if (cursor >= visibleCount) {
    startIdx = cursor - visibleCount + 1;
  }
  const visibleCommits = commits.slice(startIdx, startIdx + visibleCount);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box
        borderStyle={BORDER_STYLE}
        borderColor={COLORS.primary}
        paddingX={1}
        justifyContent="space-between"
      >
        <Text color={COLORS.primary} bold>
          {'\u23F0'} Time Machine
        </Text>
        <Text color={COLORS.subtle}>
          {commits.length} snapshots {headIdx > 0 ? `\u2022 rewound ${headIdx} back` : ''}
        </Text>
      </Box>

      {loading ? (
        <Box paddingX={2} paddingY={1}>
          <Spinner />
          <Text color={COLORS.subtle}> Loading timeline...</Text>
        </Box>
      ) : commits.length === 0 ? (
        <Box paddingX={2} paddingY={1}>
          <Text color={COLORS.muted}>No snapshots yet.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {visibleCommits.map((c, i) => {
            const actualIdx = startIdx + i;
            const selected = actualIdx === cursor;
            const isHead = actualIdx === headIdx;
            const time = timeAgo(new Date(c.date));
            const label = humanize(c.message);
            const isFuture = actualIdx < headIdx; // Above HEAD = "future" (rewound past this)

            return (
              <Box key={c.hash}>
                <Text color={isHead ? COLORS.success : selected ? COLORS.primary : COLORS.muted}>
                  {isHead ? '\u25C6 ' : selected ? '\u25B8 ' : '  '}
                </Text>
                <Text color={isHead ? COLORS.success : isFuture ? COLORS.muted : COLORS.subtle}>
                  {time.padEnd(9)}
                </Text>
                <Text
                  color={
                    isHead
                      ? COLORS.text
                      : isFuture
                        ? COLORS.muted
                        : selected
                          ? COLORS.text
                          : COLORS.subtle
                  }
                  bold={isHead || selected}
                  wrap="truncate"
                >
                  {label}
                  {isHead ? '  \u2190 YOU ARE HERE' : ''}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {status && (
        <Box paddingX={1}>
          <Text color={COLORS.info}>{status}</Text>
        </Box>
      )}

      <Box
        borderStyle={BORDER_STYLE}
        borderColor={COLORS.border}
        paddingX={1}
        justifyContent="space-between"
      >
        <Text color={COLORS.muted}>
          {'\u2191\u2193'}:navigate  Enter:travel here  R:refresh  Esc:back
        </Text>
        <Text color={COLORS.muted}>
          {cursor + 1}/{commits.length}
        </Text>
      </Box>
    </Box>
  );
}
