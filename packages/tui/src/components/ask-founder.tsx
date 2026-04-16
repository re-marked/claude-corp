import React from 'react';
import { Box, Text } from '@claude-code-kit/ink-renderer';
import { COLORS } from '../theme.js';

// ── Types ──────────────────────────────────────────────────────────

export interface FounderAnswer {
  value: string;
  label: string;
  description?: string;
  /** Monospace preview content shown when this option is focused */
  preview?: string;
}

export type QuestionType = 'choice' | 'multi' | 'score';

export interface FounderQuestion {
  question: string;
  type: QuestionType;
  answers: FounderAnswer[];
  /** Score questions: min/max range (default 0-10) */
  min?: number;
  max?: number;
  /** The message ID containing this question — used to prevent re-answering */
  messageId: string;
  /** Index within the message (for batched questions) */
  index: number;
}

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Parse <askFounder> blocks from message content. Returns the cleaned
 * content (with tags removed) and any questions found.
 *
 * Supported formats:
 *
 * Choice (default):
 *   <askFounder>
 *     <question>Which database?</question>
 *     <answers>
 *       <answer value="pg" description="Concurrent writes" preview="CREATE TABLE...">Postgres</answer>
 *       <answer value="sqlite" description="File-based">SQLite</answer>
 *     </answers>
 *   </askFounder>
 *
 * Multi-select:
 *   <askFounder type="multi">
 *     <question>Which features?</question>
 *     <answers>
 *       <answer value="auth">Authentication</answer>
 *       <answer value="search">Search</answer>
 *     </answers>
 *   </askFounder>
 *
 * Score (potentiometer):
 *   <askFounder type="score" min="0" max="10">
 *     <question>How much do you trust agents?</question>
 *   </askFounder>
 */
export function parseAskFounder(content: string, messageId: string): {
  cleanContent: string;
  questions: FounderQuestion[];
} {
  const questions: FounderQuestion[] = [];
  let questionIndex = 0;
  const cleanContent = content.replace(
    /<askFounder([^>]*)>\s*([\s\S]*?)\s*<\/askFounder>/g,
    (_match, attrs: string, inner: string) => {
      const qMatch = inner.match(/<question>\s*([\s\S]*?)\s*<\/question>/);
      const question = qMatch?.[1]?.trim() ?? '';
      if (!question) return '';

      // Parse attributes
      const typeMatch = attrs.match(/type="([^"]*)"/);
      const minMatch = attrs.match(/min="(\d+)"/);
      const maxMatch = attrs.match(/max="(\d+)"/);
      const type: QuestionType = (typeMatch?.[1] as QuestionType) ?? 'choice';

      const answers: FounderAnswer[] = [];
      const answerRe = /<answer\s+value="([^"]*)"([^>]*)>([\s\S]*?)<\/answer>/g;
      let aMatch;
      while ((aMatch = answerRe.exec(inner)) !== null) {
        const answerAttrs = aMatch[2]!;
        const descMatch = answerAttrs.match(/description="([^"]*)"/);
        const prevMatch = answerAttrs.match(/preview="([^"]*)"/);
        answers.push({
          value: aMatch[1]!,
          label: aMatch[3]!.trim(),
          description: descMatch?.[1]?.trim() || undefined,
          preview: prevMatch?.[1]?.trim().replace(/\\n/g, '\n') || undefined,
        });
      }

      questions.push({
        question,
        type,
        answers,
        min: minMatch ? parseInt(minMatch[1]!) : 0,
        max: maxMatch ? parseInt(maxMatch[1]!) : 10,
        messageId,
        index: questionIndex++,
      });
      return '';
    },
  );

  return { cleanContent: cleanContent.trim(), questions };
}

// ── Question Card ──────────────────────────────────────────────────

interface QuestionCardProps {
  question: FounderQuestion;
  answered?: boolean;
  selectedValue?: string;
  /** Multi-select: currently toggled values */
  selectedValues?: Set<string>;
  /** Score: current slider position */
  scoreValue?: number;
  /** Whether this question is the active one (for input capture) */
  active?: boolean;
  /** Score: focused position (arrow-key driven before confirm) */
  scoreFocused?: number;
}

/**
 * Renders a question card inline in the chat. Amber border when
 * pending, muted when answered. Supports three modes:
 *
 * - **choice**: numbered options, press 1-9 to select
 * - **multi**: togglable options, press 1-9 to toggle, Enter to confirm
 * - **score**: horizontal potentiometer, arrow keys to adjust, Enter to confirm
 */
export function QuestionCard({
  question,
  answered,
  selectedValue,
  selectedValues,
  scoreValue,
  active,
  scoreFocused,
}: QuestionCardProps) {
  const borderColor = answered ? COLORS.muted : '#fbbf24';
  const headerColor = answered ? COLORS.muted : COLORS.primary;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginY={1}
    >
      {/* Question header */}
      <Box gap={1}>
        <Text bold color={borderColor}>{'?'}</Text>
        <Text bold color={headerColor} wrap="wrap">{question.question}</Text>
        {question.type !== 'choice' && (
          <Text color={COLORS.subtle}>({question.type})</Text>
        )}
      </Box>

      {/* Mode-specific rendering */}
      {question.type === 'score'
        ? renderScore(question, answered, scoreValue, scoreFocused)
        : renderOptions(question, answered, selectedValue, selectedValues, active)}

      {/* Preview pane — show focused option's preview if any */}
      {!answered && question.answers.some(a => a.preview) && selectedValue && (
        <Box marginTop={1} borderStyle="single" borderColor={COLORS.border} paddingX={1}>
          <Text color={COLORS.subtle}>
            {question.answers.find(a => a.value === selectedValue)?.preview ?? ''}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ── Score Renderer (Potentiometer) ─────────────────────────────────

function renderScore(
  q: FounderQuestion,
  answered?: boolean,
  scoreValue?: number,
  scoreFocused?: number,
) {
  const min = q.min ?? 0;
  const max = q.max ?? 10;
  const range = max - min;
  const value = answered ? (scoreValue ?? min) : (scoreFocused ?? Math.floor((min + max) / 2));
  const barWidth = Math.min(range + 1, 30);

  // Build the slider bar
  const segments: string[] = [];
  for (let i = 0; i <= range; i++) {
    const pos = min + i;
    if (pos === value) {
      segments.push('●');
    } else {
      segments.push('─');
    }
  }

  // Color gradient: red(0) → yellow(5) → green(10)
  const fraction = (value - min) / Math.max(range, 1);
  const barColor = answered
    ? COLORS.muted
    : fraction < 0.3 ? COLORS.danger
    : fraction < 0.6 ? '#fbbf24'
    : fraction < 0.8 ? '#a3e635'
    : COLORS.success;

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      <Box gap={1}>
        <Text color={COLORS.subtle}>{min}</Text>
        <Text color={barColor} bold>
          {'['}{segments.join('')}{']'}
        </Text>
        <Text color={COLORS.subtle}>{max}</Text>
        <Text bold color={answered ? COLORS.muted : barColor}>{value}/{max}</Text>
      </Box>
      {!answered && (
        <Box marginTop={1}>
          <Text color={COLORS.subtle}>← → to adjust · Enter to confirm</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Options Renderer (Choice + Multi) ──────────────────────────────

function renderOptions(
  q: FounderQuestion,
  answered?: boolean,
  selectedValue?: string,
  selectedValues?: Set<string>,
  _active?: boolean,
) {
  const isMulti = q.type === 'multi';

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      {q.answers.map((a, i) => {
        const num = `${i + 1}`;
        const isChosen = isMulti
          ? (selectedValues?.has(a.value) ?? false)
          : selectedValue === a.value;
        const isSelected = answered && isChosen;

        const bulletColor = isSelected
          ? COLORS.success
          : answered ? COLORS.muted : '#fbbf24';
        const textColor = isSelected
          ? COLORS.success
          : answered ? COLORS.muted : undefined;

        const bullet = isMulti
          ? (isChosen ? '☑' : '☐')
          : (isSelected ? '●' : '○');

        return (
          <Box key={a.value} flexDirection="column" marginBottom={a.description ? 1 : 0}>
            <Box gap={1}>
              <Text color={bulletColor} bold={isSelected}>
                {bullet} {num}.
              </Text>
              <Text color={textColor} bold={isSelected} wrap="wrap">
                {a.label}
              </Text>
            </Box>
            {a.description && (
              <Box paddingLeft={4}>
                <Text color={answered ? COLORS.muted : COLORS.subtle} italic wrap="wrap">
                  {a.description}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}

      {/* Auto-Other option */}
      {!answered && (
        <Box gap={1} marginTop={q.answers.length > 0 ? 1 : 0}>
          <Text color={COLORS.subtle}>○ 0.</Text>
          <Text color={COLORS.subtle} italic>Other — type your answer in the input</Text>
        </Box>
      )}

      {/* Hint */}
      {!answered && (
        <Box marginTop={1}>
          <Text color={COLORS.subtle}>
            {isMulti
              ? `Press 1-${q.answers.length} to toggle · Enter to confirm · 0 for other`
              : `Press 1-${q.answers.length} to select · 0 for other`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
