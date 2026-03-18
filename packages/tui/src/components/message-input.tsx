import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function AnimatedRainbow({ children, offset }: { children: string; offset: number }) {
  const chars = children.split('');
  const len = Math.max(chars.length, 1);
  return (
    <Text bold>
      {chars.map((char, i) => {
        const hue = ((i / len) * 300 + offset) % 360;
        return <Text key={i} color={hslToHex(hue, 80, 65)}>{char}</Text>;
      })}
    </Text>
  );
}

function renderInputText(text: string, cursorPos: number, hueOffset: number, showCursor: boolean) {
  // Build segments: plain text and @mentions
  const segments: { text: string; isMention: boolean; start: number }[] = [];
  const mentionRegex = /@"([^"]+)"|@([A-Za-z0-9][\w-]*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), isMention: false, start: lastIndex });
    }
    segments.push({ text: match[0], isMention: true, start: match.index });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isMention: false, start: lastIndex });
  }
  if (segments.length === 0 && text.length === 0) {
    // Empty — just show cursor
    return showCursor ? <Text inverse> </Text> : null;
  }

  const parts: React.ReactNode[] = [];

  for (const seg of segments) {
    const segEnd = seg.start + seg.text.length;
    const cursorInSeg = cursorPos >= seg.start && cursorPos < segEnd;
    const cursorAtEnd = cursorPos === segEnd;

    if (seg.isMention) {
      if (cursorInSeg && showCursor) {
        // Split mention around cursor
        const before = seg.text.slice(0, cursorPos - seg.start);
        const atCursor = seg.text[cursorPos - seg.start]!;
        const after = seg.text.slice(cursorPos - seg.start + 1);
        const fullLen = Math.max(seg.text.length, 1);
        parts.push(
          <Text key={`m${seg.start}`} bold>
            {before.split('').map((c, i) => (
              <Text key={i} color={hslToHex(((i / fullLen) * 300 + hueOffset) % 360, 80, 65)}>{c}</Text>
            ))}
            <Text inverse color={hslToHex((((cursorPos - seg.start) / fullLen) * 300 + hueOffset) % 360, 80, 65)}>
              {atCursor}
            </Text>
            {after.split('').map((c, i) => {
              const idx = cursorPos - seg.start + 1 + i;
              return <Text key={`a${i}`} color={hslToHex(((idx / fullLen) * 300 + hueOffset) % 360, 80, 65)}>{c}</Text>;
            })}
          </Text>,
        );
      } else {
        parts.push(
          <AnimatedRainbow key={`m${seg.start}`} offset={hueOffset}>
            {seg.text}
          </AnimatedRainbow>,
        );
      }
    } else {
      if (cursorInSeg && showCursor) {
        const before = seg.text.slice(0, cursorPos - seg.start);
        const atCursor = seg.text[cursorPos - seg.start]!;
        const after = seg.text.slice(cursorPos - seg.start + 1);
        parts.push(
          <Text key={`t${seg.start}`}>
            {before}
            <Text inverse>{atCursor}</Text>
            {after}
          </Text>,
        );
      } else {
        parts.push(<Text key={`t${seg.start}`}>{seg.text}</Text>);
      }
    }
  }

  // Cursor at the very end of the text
  if (showCursor && cursorPos >= text.length) {
    parts.push(<Text key="cursor" inverse> </Text>);
  }

  return <>{parts}</>;
}

export function MessageInput({ onSend, disabled, placeholder }: Props) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [hueOffset, setHueOffset] = useState(0);

  const hasMentions = /@\S/.test(value);

  useEffect(() => {
    if (!hasMentions || disabled) return;
    const timer = setInterval(() => {
      setHueOffset((prev) => (prev + 20) % 360);
    }, 100);
    return () => clearInterval(timer);
  }, [hasMentions, disabled]);

  useInput((input, key) => {
    if (disabled) return;
    // Don't handle tab — let it bubble to channel switcher
    if (key.tab || input === '\t') return;

    if (key.return) {
      const trimmed = value.trim();
      if (trimmed) {
        onSend(trimmed);
        setValue('');
        setCursor(0);
      }
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
        setCursor((c) => c - 1);
      }
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(value.length, c + 1));
      return;
    }
    // Ignore control keys
    if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.escape) return;

    if (input) {
      setValue((v) => v.slice(0, cursor) + input + v.slice(cursor));
      setCursor((c) => c + input.length);
    }
  });

  // Show command hints
  const trimmedValue = value.trim();
  const isTypingHire = !disabled && /^\/(h(i(r(e)?)?)?)?$/i.test(trimmedValue);
  const isTypingTask = !disabled && /^\/(t(a(s(k)?)?)?)?$/i.test(trimmedValue) && !isTypingHire;

  return (
    <Box flexDirection="column">
      {isTypingHire && (
        <Box paddingX={2}>
          <Text color="magenta" bold>/hire</Text>
          <Text dimColor> — open the agent hiring wizard (Enter to confirm)</Text>
        </Box>
      )}
      {isTypingTask && (
        <Box paddingX={2}>
          <Text color="yellow" bold>/task</Text>
          <Text dimColor> — create a new task (Enter to confirm)</Text>
        </Box>
      )}
      <Box borderStyle="single" borderColor={disabled ? 'gray' : 'white'} paddingX={1}>
        <Text bold color="green">&gt; </Text>
        {disabled ? (
          <Text dimColor>{placeholder ?? 'Waiting...'}</Text>
        ) : value.length === 0 ? (
          <>
            <Text inverse> </Text>
            <Text dimColor>{placeholder ?? 'Type a message...'}</Text>
          </>
        ) : (
          renderInputText(value, cursor, hueOffset, true)
        )}
      </Box>
    </Box>
  );
}
