import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { getPasteFilter } from '../lib/paste-filter.js';
import { COLORS } from '../theme.js';

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

// --- Paste marker system ---
// Each paste gets a unique Unicode Private Use Area character (U+E001, U+E002, ...)
// embedded in the value string. A Map stores the actual paste content.
// This keeps cursor math simple (1 char = 1 position) while supporting
// multiple pastes mixed with typed text.

const PASTE_MARKER_BASE = 0xE000;
let pasteIdCounter = 0;

interface PasteInfo {
  content: string;
  lineCount: number;
}

function isPasteMarker(char: string | undefined): number | null {
  if (!char) return null;
  const cp = char.codePointAt(0);
  if (cp === undefined) return null;
  return (cp > PASTE_MARKER_BASE && cp < PASTE_MARKER_BASE + 1000)
    ? cp - PASTE_MARKER_BASE
    : null;
}

function placeholderFor(paste: PasteInfo): string {
  return paste.lineCount === 1 ? '[1 line pasted]' : `[${paste.lineCount} lines pasted]`;
}

/** Expand paste markers to their full content for sending. */
function buildSendValue(value: string, pastes: Map<number, PasteInfo>): string {
  let result = '';
  for (const char of value) {
    const id = isPasteMarker(char);
    if (id !== null && pastes.has(id)) {
      result += pastes.get(id)!.content;
    } else {
      result += char;
    }
  }
  return result;
}

// --- Color helpers ---

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

// --- Segment-based rendering ---
// The value string is split into segments: plain text, @mentions, and paste placeholders.
// Each segment knows its display text and its position in the value string,
// so cursor placement works correctly across all segment types.

interface Segment {
  type: 'text' | 'mention' | 'paste';
  display: string;
  valueStart: number;
  valueLen: number;
}

function buildSegments(value: string, pastes: Map<number, PasteInfo>): Segment[] {
  const segments: Segment[] = [];
  let i = 0;

  while (i < value.length) {
    // Check for paste marker
    const pid = isPasteMarker(value[i]!);
    if (pid !== null && pastes.has(pid)) {
      segments.push({
        type: 'paste',
        display: placeholderFor(pastes.get(pid)!),
        valueStart: i,
        valueLen: 1,
      });
      i++;
      continue;
    }

    // Find next paste marker (or end of string)
    let end = i + 1;
    while (end < value.length) {
      const epid = isPasteMarker(value[end]!);
      if (epid !== null && pastes.has(epid)) break;
      end++;
    }

    // Parse this text chunk for @mentions
    const chunk = value.slice(i, end);
    const mentionRe = /@"([^"]+)"|@([A-Za-z0-9][\w-]*)/g;
    let last = 0;
    let m: RegExpExecArray | null;

    while ((m = mentionRe.exec(chunk)) !== null) {
      if (m.index > last) {
        segments.push({
          type: 'text',
          display: chunk.slice(last, m.index),
          valueStart: i + last,
          valueLen: m.index - last,
        });
      }
      segments.push({
        type: 'mention',
        display: m[0],
        valueStart: i + m.index,
        valueLen: m[0].length,
      });
      last = m.index + m[0].length;
    }
    if (last < chunk.length) {
      segments.push({
        type: 'text',
        display: chunk.slice(last),
        valueStart: i + last,
        valueLen: chunk.length - last,
      });
    }

    i = end;
  }

  return segments;
}

function renderInput(
  segments: Segment[],
  cursor: number,
  hueOffset: number,
  showCursor: boolean,
): React.ReactNode {
  if (segments.length === 0) {
    return showCursor ? <Text inverse> </Text> : null;
  }

  const parts: React.ReactNode[] = [];

  for (const seg of segments) {
    const end = seg.valueStart + seg.valueLen;
    const cursorHere = showCursor && cursor >= seg.valueStart && cursor < end;

    if (seg.type === 'paste') {
      // Paste placeholder — inverse when cursor is on it (signals "backspace deletes this")
      parts.push(
        <Text key={`p${seg.valueStart}`} color="#81ECEC" inverse={cursorHere} bold>
          {seg.display}
        </Text>,
      );
    } else if (seg.type === 'mention') {
      if (cursorHere) {
        const off = cursor - seg.valueStart;
        const chars = seg.display.split('');
        const fullLen = Math.max(chars.length, 1);
        parts.push(
          <Text key={`m${seg.valueStart}`} bold>
            {chars.map((c, ci) => {
              const hue = ((ci / fullLen) * 300 + hueOffset) % 360;
              return (
                <Text key={ci} color={hslToHex(hue, 80, 65)} inverse={ci === off}>
                  {c}
                </Text>
              );
            })}
          </Text>,
        );
      } else {
        parts.push(
          <AnimatedRainbow key={`m${seg.valueStart}`} offset={hueOffset}>
            {seg.display}
          </AnimatedRainbow>,
        );
      }
    } else {
      // Plain text
      if (cursorHere) {
        const off = cursor - seg.valueStart;
        const before = seg.display.slice(0, off);
        const atCursor = seg.display[off]!;
        const after = seg.display.slice(off + 1);
        parts.push(
          <Text key={`t${seg.valueStart}`}>
            {before}
            <Text inverse>{atCursor}</Text>
            {after}
          </Text>,
        );
      } else {
        parts.push(<Text key={`t${seg.valueStart}`}>{seg.display}</Text>);
      }
    }
  }

  // Cursor at the very end of the input
  const last = segments[segments.length - 1]!;
  if (showCursor && cursor >= last.valueStart + last.valueLen) {
    parts.push(<Text key="cursor" inverse> </Text>);
  }

  return <>{parts}</>;
}

// --- Component ---

export function MessageInput({ onSend, disabled, placeholder }: Props) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [pastes, setPastes] = useState<Map<number, PasteInfo>>(new Map());
  const [hueOffset, setHueOffset] = useState(0);
  // Input history — up/down arrow recalls previous messages
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draft, setDraft] = useState('');

  // Refs for the paste handler (fires from an EventEmitter, not a React callback)
  const cursorRef = useRef(0);
  cursorRef.current = cursor;
  const disabledRef = useRef(false);
  disabledRef.current = disabled ?? false;

  const hasMentions = /@\S/.test(value);

  // Rainbow animation for @mentions
  useEffect(() => {
    if (!hasMentions || disabled) return;
    const timer = setInterval(() => setHueOffset((prev) => (prev + 20) % 360), 100);
    return () => clearInterval(timer);
  }, [hasMentions, disabled]);

  // Shared paste insertion logic — used by both bracketed paste and fallback detection
  function insertPaste(raw: string) {
    const content = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!content) return;

    const id = ++pasteIdCounter;
    const lineCount = content.split('\n').length;
    const marker = String.fromCodePoint(PASTE_MARKER_BASE + id);

    setPastes((prev) => new Map(prev).set(id, { content, lineCount }));
    const c = cursorRef.current;
    cursorRef.current = c + 1;
    setValue((v) => v.slice(0, c) + marker + v.slice(c));
    setCursor(c + 1);
  }

  // Bracketed paste handler — fires when the PasteFilterStdin detects paste sequences
  useEffect(() => {
    const filter = getPasteFilter();
    const handlePaste = (raw: string) => {
      if (disabledRef.current) return;
      insertPaste(raw);
    };
    filter.on('paste', handlePaste);
    return () => {
      filter.off('paste', handlePaste);
    };
  }, []);

  useInput((input, key) => {
    if (disabled) return;
    // Don't handle tab — let it bubble to channel switcher
    if (key.tab || input === '\t') return;

    if (key.return) {
      const sendValue = buildSendValue(value, pastes);
      const trimmed = sendValue.trim();
      if (trimmed) {
        onSend(trimmed);
        setHistory((h) => [...h.slice(-99), trimmed]);
        setHistoryIndex(-1);
        setDraft('');
        setValue('');
        setCursor(0);
        setPastes(new Map());
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor > 0) {
        // If deleting a paste marker, also remove it from the pastes map
        const charBefore = value[cursor - 1]!;
        const pid = isPasteMarker(charBefore);
        if (pid !== null) {
          setPastes((prev) => {
            const next = new Map(prev);
            next.delete(pid);
            return next;
          });
        }
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

    // Readline shortcuts — before the blanket ctrl ignore
    if (key.ctrl) {
      if (input === 'a') { setCursor(0); return; }
      if (input === 'e') { setCursor(value.length); return; }
      if (input === 'w') {
        // Delete word backward
        if (cursor === 0) return;
        const before = value.slice(0, cursor);
        let i = before.length - 1;
        while (i >= 0 && before[i] === ' ') i--;
        while (i >= 0 && before[i] !== ' ') i--;
        const pos = i + 1;
        setValue((v) => v.slice(0, pos) + v.slice(cursor));
        setCursor(pos);
        return;
      }
      if (input === 'u') {
        // Kill to start of line
        setValue((v) => v.slice(cursor));
        setCursor(0);
        return;
      }
    }

    // Input history — up/down arrow recall previous messages
    if (key.upArrow) {
      if (history.length === 0) return;
      if (historyIndex === -1) {
        setDraft(value);
        const idx = history.length - 1;
        setHistoryIndex(idx);
        setValue(history[idx]!);
        setCursor(history[idx]!.length);
      } else if (historyIndex > 0) {
        const idx = historyIndex - 1;
        setHistoryIndex(idx);
        setValue(history[idx]!);
        setCursor(history[idx]!.length);
      }
      return;
    }
    if (key.downArrow) {
      if (historyIndex === -1) return;
      if (historyIndex < history.length - 1) {
        const idx = historyIndex + 1;
        setHistoryIndex(idx);
        setValue(history[idx]!);
        setCursor(history[idx]!.length);
      } else {
        setHistoryIndex(-1);
        setValue(draft);
        setCursor(draft.length);
      }
      return;
    }

    // Ignore remaining control keys
    if (key.ctrl || key.meta || key.escape) return;

    if (input) {
      // Fallback paste detection for terminals without bracketed paste support
      if (input.includes('\n') || input.includes('\r') || input.length > 200) {
        insertPaste(input);
        return;
      }

      setValue((v) => v.slice(0, cursor) + input + v.slice(cursor));
      setCursor((c) => c + input.length);
    }
  });

  // Build display segments
  const segments = buildSegments(value, pastes);
  const hasPastes = pastes.size > 0;

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
      <Box borderStyle="round" borderColor={disabled ? '#4B5257' : '#7B8C94'} paddingX={1}>
        <Text bold color="#E17055">&gt; </Text>
        {disabled ? (
          <Text color="#636E72">{placeholder ?? 'Waiting...'}</Text>
        ) : value.length === 0 ? (
          <>
            <Text inverse> </Text>
            <Text color="#636E72">{placeholder ?? 'Type a message...'}</Text>
          </>
        ) : (
          renderInput(segments, cursor, hueOffset, true)
        )}
      </Box>
      {hasPastes && (
        <Box paddingX={2}>
          <Text color="#636E72">
            {pastes.size} paste{pastes.size > 1 ? 's' : ''} attached — Backspace to remove
          </Text>
        </Box>
      )}
    </Box>
  );
}
