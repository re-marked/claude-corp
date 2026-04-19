import React from 'react';
import { Box, Text } from '@claude-code-kit/ink-renderer';
import { COLORS } from '../theme.js';

// ── Types ──────────────────────────────────────────────────────────

export interface FounderAnswer {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export type QuestionType = 'choice' | 'multi' | 'score';

export interface FounderQuestion {
  question: string;
  type: QuestionType;
  answers: FounderAnswer[];
  min?: number;
  max?: number;
  messageId: string;
  index: number;
}

// ── Parser ─────────────────────────────────────────────────────────

/**
 * Scan a message list for answerFor markers and return the set of
 * question message ids that should stay dead.
 *
 * This is the persistence layer for askFounder — answered and
 * dismissed questions each write a message carrying
 * `metadata.answerFor: <questionMessageId>`. A plain jack-mode user
 * reply carries it alongside `source: 'jack'`; a dismissal marker is
 * an empty-content system message that only exists to record the id.
 * Rebuilding from persisted metadata means "answered" survives TUI
 * restart — mirroring how Claude Code pairs a tool_use with its
 * tool_result in history.
 */
export function deriveAnsweredQuestions(
  messages: ReadonlyArray<{ metadata: Record<string, unknown> | null }>,
): Set<string> {
  const answered = new Set<string>();
  for (const m of messages) {
    const ref = m.metadata?.answerFor;
    if (typeof ref === 'string' && ref.length > 0) answered.add(ref);
  }
  return answered;
}

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
        question, type, answers,
        min: minMatch ? parseInt(minMatch[1]!) : 0,
        max: maxMatch ? parseInt(maxMatch[1]!) : 10,
        messageId, index: questionIndex++,
      });
      return '';
    },
  );

  return { cleanContent: cleanContent.trim(), questions };
}

// ── Question Banner (replaces input bar) ───────────────────────────

interface QuestionBannerProps {
  question: FounderQuestion;
  /** Currently focused option index (arrow-key driven) */
  focusedIndex: number;
  /** Multi-select: toggled values */
  multiSelected: Set<string>;
  /** Score: current slider value */
  scoreValue: number;
}

/**
 * Full-width question banner that REPLACES the input bar when a
 * question is pending. Arrow keys navigate, number keys shortcut,
 * Enter confirms. Ephemeral — disappears after answering.
 */
export function QuestionBanner({ question, focusedIndex, multiSelected, scoreValue }: QuestionBannerProps) {
  if (question.type === 'score') {
    return <ScoreBanner question={question} value={scoreValue} />;
  }

  const isMulti = question.type === 'multi';

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={COLORS.info} paddingX={1} flexDirection="column">
        <Box gap={1}>
          <Text bold color={COLORS.info}>?</Text>
          <Text bold color={COLORS.primary} wrap="wrap">{question.question}</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {question.answers.map((a, i) => {
            const isFocused = focusedIndex === i;
            const isToggled = isMulti && multiSelected.has(a.value);
            const bullet = isMulti
              ? (isToggled ? '☑' : '☐')
              : (isFocused ? '▸' : ' ');

            return (
              <Box key={a.value} flexDirection="column">
                <Box gap={1}>
                  <Text color={isFocused ? COLORS.primary : COLORS.muted}>
                    {bullet}
                  </Text>
                  <Text color={COLORS.subtle}>{i + 1}.</Text>
                  <Text color={isFocused ? COLORS.text : COLORS.subtle} bold={isFocused} wrap="wrap">
                    {a.label}
                  </Text>
                </Box>
                {a.description && isFocused && (
                  <Box paddingLeft={5}>
                    <Text color={COLORS.subtle} italic wrap="wrap">{a.description}</Text>
                  </Box>
                )}
              </Box>
            );
          })}

          {/* Other option */}
          <Box gap={1}>
            <Text color={focusedIndex === question.answers.length ? COLORS.primary : COLORS.muted}>
              {focusedIndex === question.answers.length ? '▸' : ' '}
            </Text>
            <Text color={COLORS.subtle}>0.</Text>
            <Text color={focusedIndex === question.answers.length ? COLORS.text : COLORS.subtle}
              bold={focusedIndex === question.answers.length}>
              Other — type a custom answer
            </Text>
          </Box>
        </Box>

        {/* Preview pane */}
        {focusedIndex < question.answers.length && question.answers[focusedIndex]?.preview && (
          <Box marginTop={1} borderStyle="single" borderColor={COLORS.border} paddingX={1}>
            <Text color={COLORS.subtle}>{question.answers[focusedIndex]!.preview}</Text>
          </Box>
        )}
      </Box>

      <Text color={COLORS.info}>
        {' '}QUESTION  ↑↓:navigate  {isMulti ? '1-9:toggle  Enter:confirm' : '1-9:select  Enter:confirm'}  d:dismiss
      </Text>
    </Box>
  );
}

// ── Score Banner (Potentiometer) ───────────────────────────────────

function ScoreBanner({ question, value }: { question: FounderQuestion; value: number }) {
  const min = question.min ?? 0;
  const max = question.max ?? 10;
  const range = max - min;

  const segments: string[] = [];
  for (let i = 0; i <= range; i++) {
    segments.push((min + i) === value ? '●' : '─');
  }

  const fraction = (value - min) / Math.max(range, 1);
  const barColor = fraction < 0.3 ? COLORS.danger
    : fraction < 0.6 ? COLORS.warning
    : fraction < 0.8 ? '#a3e635'
    : COLORS.success;

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={COLORS.info} paddingX={1} flexDirection="column">
        <Box gap={1}>
          <Text bold color={COLORS.info}>?</Text>
          <Text bold color={COLORS.primary} wrap="wrap">{question.question}</Text>
        </Box>

        <Box marginTop={1} gap={1} justifyContent="center">
          <Text color={COLORS.subtle}>{min}</Text>
          <Text color={barColor} bold>{'['}{segments.join('')}{']'}</Text>
          <Text color={COLORS.subtle}>{max}</Text>
          <Text bold color={barColor}>{value}/{max}</Text>
        </Box>
      </Box>

      <Text color={COLORS.info}> SCORE  ←→:adjust  Enter:confirm  d:dismiss</Text>
    </Box>
  );
}
