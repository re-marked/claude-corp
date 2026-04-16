import React from 'react';
import { Box, Text } from '@claude-code-kit/ink-renderer';
import { COLORS } from '../theme.js';

export interface FounderAnswer {
  value: string;
  label: string;
  description?: string;
}

export interface FounderQuestion {
  question: string;
  answers: FounderAnswer[];
  /** The message ID containing this question — used to prevent re-answering */
  messageId: string;
}

/**
 * Parse <askFounder> blocks from message content. Returns the cleaned
 * content (with tags removed) and any questions found.
 *
 * Agent XML format:
 * ```xml
 * <askFounder>
 *   <question>Which database should we use?</question>
 *   <answers>
 *     <answer value="postgres" description="Better for concurrent writes">Postgres</answer>
 *     <answer value="sqlite" description="Simpler, file-based">SQLite</answer>
 *   </answers>
 * </askFounder>
 * ```
 *
 * Description attribute is optional. If no <answers> block, the
 * question is open-ended (founder types freely in the input).
 */
export function parseAskFounder(content: string, messageId: string): {
  cleanContent: string;
  questions: FounderQuestion[];
} {
  const questions: FounderQuestion[] = [];
  const cleanContent = content.replace(
    /<askFounder>\s*([\s\S]*?)\s*<\/askFounder>/g,
    (_match, inner: string) => {
      const qMatch = inner.match(/<question>\s*([\s\S]*?)\s*<\/question>/);
      const question = qMatch?.[1]?.trim() ?? '';
      if (!question) return '';

      const answers: FounderAnswer[] = [];
      const answerRe = /<answer\s+value="([^"]*)"(?:\s+description="([^"]*)")?\s*>([\s\S]*?)<\/answer>/g;
      let aMatch;
      while ((aMatch = answerRe.exec(inner)) !== null) {
        answers.push({
          value: aMatch[1]!,
          label: aMatch[3]!.trim(),
          description: aMatch[2]?.trim() || undefined,
        });
      }

      questions.push({ question, answers, messageId });
      return '';
    },
  );

  return { cleanContent: cleanContent.trim(), questions };
}

interface QuestionCardProps {
  question: FounderQuestion;
  answered?: boolean;
  selectedValue?: string;
}

/**
 * Renders a question card inline in the chat. Amber border when
 * pending, muted when answered. Numbered options with optional
 * descriptions. Founder presses 1-9 to select.
 *
 * Design adapted from Claude Code's AskUserQuestion UI — simplified
 * for terminal rendering (no previews, no multi-select in v1).
 */
export function QuestionCard({ question, answered, selectedValue }: QuestionCardProps) {
  const borderColor = answered ? COLORS.muted : '#fbbf24'; // Amber-400
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
      </Box>

      {/* Answer options */}
      {question.answers.length > 0 && (
        <Box flexDirection="column" marginTop={1} paddingLeft={1}>
          {question.answers.map((a, i) => {
            const isSelected = answered && a.value === selectedValue;
            const num = `${i + 1}`;
            const bulletColor = isSelected
              ? COLORS.success
              : answered ? COLORS.muted : borderColor;
            const textColor = isSelected
              ? COLORS.success
              : answered ? COLORS.muted : undefined;

            return (
              <Box key={a.value} flexDirection="column" marginBottom={a.description ? 1 : 0}>
                <Box gap={1}>
                  <Text color={bulletColor} bold={isSelected}>
                    {isSelected ? '●' : '○'} {num}.
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
        </Box>
      )}

      {/* Hint */}
      {!answered && question.answers.length > 0 && (
        <Box marginTop={1} paddingLeft={1}>
          <Text color={COLORS.subtle}>
            Press {question.answers.map((_, i) => i + 1).join('/')} to answer
            {' · or type freely in the input'}
          </Text>
        </Box>
      )}
      {question.answers.length === 0 && !answered && (
        <Box marginTop={1} paddingLeft={1}>
          <Text color={COLORS.subtle}>Open question — type your answer below</Text>
        </Box>
      )}
    </Box>
  );
}
