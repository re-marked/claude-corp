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
  const trimmedValue = value.trim().toLowerCase();
  const isTypingHire = !disabled && /^\/(h(i(r(e)?)?)?)?$/i.test(trimmedValue);
  const isTypingTask = !disabled && /^\/(t(a(s(k(s)?)?)?)?)?$/i.test(trimmedValue) && !isTypingHire;
  const isTypingProject = !disabled && /^\/(p(r(o(j(e(c(t)?)?)?)?)?)?)?$/i.test(trimmedValue);
  const isTypingTeam = !disabled && /^\/(t(e(a(m)?)?)?)?$/i.test(trimmedValue) && !isTypingTask;
  const isTypingHierarchy = !disabled && trimmedValue === '/h';
  const isTypingTasks = !disabled && trimmedValue === '/t';
  const isTypingAgents = !disabled && trimmedValue === '/a';
  const isTypingWho = !disabled && /^\/(w(h(o)?)?|m(e(m(b(e(r(s)?)?)?)?)?)?)?$/i.test(trimmedValue);
  const isTypingUptime = !disabled && /^\/(u(p(t(i(m(e)?)?)?)?)?)?$/i.test(trimmedValue);
  const showNavHint = !disabled && trimmedValue === '/' && !isTypingHire && !isTypingTask;

  return (
    <Box flexDirection="column">
      {showNavHint && (
        <Box paddingX={2} flexDirection="column">
          <Text color="#E17055" bold>/hire</Text>
          <Text color="#FDCB6E" bold>/task</Text>
          <Text color="#E17055" bold>/project</Text>
          <Text color="#FFEAA7" bold>/team</Text>
          <Text color="#00B894" bold>/dogfood</Text>
          <Text color="#B2BEC3" bold>/who <Text color="#636E72">roster</Text>  /uptime  /channels  /ping  /logs  /tm <Text color="#636E72">time-machine</Text></Text>
          <Text color="#B2BEC3" bold>/h <Text color="#636E72">hierarchy</Text>  /t <Text color="#636E72">tasks</Text>  /a <Text color="#636E72">agents</Text>  /home</Text>
        </Box>
      )}
      {isTypingHire && (
        <Box paddingX={2}>
          <Text color="#E17055" bold>/hire</Text>
          <Text color="#636E72"> — open the agent hiring wizard</Text>
        </Box>
      )}
      {isTypingTask && (
        <Box paddingX={2}>
          <Text color="#FDCB6E" bold>/task</Text>
          <Text color="#636E72"> — create a new task</Text>
        </Box>
      )}
      {isTypingHierarchy && !isTypingHire && (
        <Box paddingX={2}>
          <Text color="#B2BEC3" bold>/h</Text>
          <Text color="#636E72"> — view org hierarchy</Text>
        </Box>
      )}
      {isTypingTasks && !isTypingTask && (
        <Box paddingX={2}>
          <Text color="#B2BEC3" bold>/t</Text>
          <Text color="#636E72"> — view task board</Text>
        </Box>
      )}
      {isTypingAgents && (
        <Box paddingX={2}>
          <Text color="#B2BEC3" bold>/a</Text>
          <Text color="#636E72"> — view agents</Text>
        </Box>
      )}
      {isTypingProject && !isTypingHire && (
        <Box paddingX={2}>
          <Text color="#E17055" bold>/project</Text>
          <Text color="#636E72"> — create a new project</Text>
        </Box>
      )}
      {isTypingTeam && !isTypingTask && (
        <Box paddingX={2}>
          <Text color="#FFEAA7" bold>/team</Text>
          <Text color="#636E72"> — create a new team</Text>
        </Box>
      )}
      {isTypingWho && (
        <Box paddingX={2}>
          <Text color="#B2BEC3" bold>/who</Text>
          <Text color="#636E72"> — show member roster (/m, /members)</Text>
        </Box>
      )}
      {isTypingUptime && (
        <Box paddingX={2}>
          <Text color="#B2BEC3" bold>/uptime</Text>
          <Text color="#636E72"> — show daemon uptime and message count</Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor={disabled ? '#636E72' : '#636E72'} paddingX={1}>
        <Text bold color="#E17055">&gt; </Text>
        {disabled ? (
          <Text color="#636E72">{placeholder ?? 'Waiting...'}</Text>
        ) : value.length === 0 ? (
          <>
            <Text inverse> </Text>
            <Text color="#636E72">{placeholder ?? 'Type a message...'}</Text>
          </>
        ) : (
          renderInputText(value, cursor, hueOffset, true)
        )}
      </Box>
    </Box>
  );
}
