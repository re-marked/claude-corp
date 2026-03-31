import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { getPasteFilter } from '../lib/paste-filter.js';
import { COLORS } from '../theme.js';

interface AgentInfo {
  slug: string;
  displayName: string;
}

interface Props {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
  agents?: AgentInfo[];
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

const COMMANDS = [
  // Management
  { name: '/hire', syntax: '/hire', desc: 'Open agent hiring wizard' },
  { name: '/task', syntax: '/task', desc: 'Create a new task (planning)' },
  { name: '/hand', syntax: '/hand <task-id> @agent', desc: 'Hand a task to an agent (start work)' },
  { name: '/project', syntax: '/project', desc: 'Create a new project' },
  { name: '/team', syntax: '/team', desc: 'Create a new team' },
  { name: '/model', syntax: '/model', desc: 'View and change AI models' },

  // Automation
  { name: '/loop', syntax: '/loop <interval> [command or @agent prompt]', desc: 'Create a recurring loop' },
  { name: '/loop list', syntax: '/loop list', desc: 'Show all active loops' },
  { name: '/loop info', syntax: '/loop info <name>', desc: 'Detail view for a specific loop' },
  { name: '/loop complete', syntax: '/loop complete <name>', desc: 'Mark loop as done (linked task completes)' },
  { name: '/loop stop', syntax: '/loop stop <name>', desc: 'Delete a loop permanently' },
  { name: '/cron', syntax: '/cron <schedule> [command or @agent prompt]', desc: 'Create a scheduled cron job' },
  { name: '/clock', syntax: '/clock', desc: 'View all clocks, loops, and crons' },

  // Communication
  { name: '/jack', syntax: '/jack', desc: 'Enter live persistent session (DM only)' },
  { name: '/unjack', syntax: '/unjack', desc: 'Switch to async mode (deprecated)' },

  // Navigation
  { name: '/home', syntax: '/home', desc: 'Corp home — agent grid + activity' },
  { name: '/h', syntax: '/h', desc: 'Hierarchy — org chart' },
  { name: '/t', syntax: '/t', desc: 'Task board — all tasks by status' },
  { name: '/tm', syntax: '/tm', desc: 'Time Machine — rewind any snapshot' },

  // Info
  { name: '/who', syntax: '/who', desc: 'Member roster with online/offline' },
  { name: '/status', syntax: '/status', desc: 'Agent work statuses inline' },
  { name: '/stats', syntax: '/stats', desc: 'Comprehensive corp statistics' },
  { name: '/channels', syntax: '/channels', desc: 'List all channels' },
  { name: '/uptime', syntax: '/uptime', desc: 'Daemon uptime + message count' },
  { name: '/logs', syntax: '/logs', desc: 'Recent daemon logs' },
  { name: '/version', syntax: '/version', desc: 'Package versions + runtime' },

  // Utility
  { name: '/theme', syntax: '/theme [name]', desc: 'Switch color palette' },
  { name: '/dogfood', syntax: '/dogfood', desc: 'Setup dev team + task' },
  { name: '/ping', syntax: '/ping', desc: 'Pong!' },
  { name: '/help', syntax: '/help', desc: 'Show all available commands' },
];

export function MessageInput({ onSend, disabled, placeholder, agents = [] }: Props) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [pastes, setPastes] = useState<Map<number, PasteInfo>>(new Map());
  const [hueOffset, setHueOffset] = useState(0);
  const [acIndex, setAcIndex] = useState(0); // Autocomplete selection index
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
    // Tab — autocomplete selected item
    if (key.tab || input === '\t') {
      const ac = getAutocomplete();
      if (ac && ac.items.length > 0) {
        const selected = ac.items[Math.min(acIndex, ac.items.length - 1)]!;
        const completion = selected.label + ' ';
        const beforeCursor = value.slice(0, cursor);
        const prefixStart = beforeCursor.length - ac.prefix.length;
        const newValue = value.slice(0, prefixStart) + completion + value.slice(cursor);
        setValue(newValue);
        setCursor(prefixStart + completion.length);
        setAcIndex(0);
      }
      return;
    }

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

    // Up/down: autocomplete navigation OR input history
    if (key.upArrow) {
      const ac = getAutocomplete();
      if (ac && ac.items.length > 0) {
        setAcIndex(i => Math.max(0, i - 1));
        return;
      }
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
      const ac = getAutocomplete();
      if (ac && ac.items.length > 0) {
        setAcIndex(i => Math.min(ac.items.length - 1, i + 1));
        return;
      }
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
      setAcIndex(0); // Reset autocomplete selection on new input
    }
  });

  // Build display segments
  const segments = buildSegments(value, pastes);
  const hasPastes = pastes.size > 0;

  // Autocomplete: detect @mention or /command being typed
  const getAutocomplete = (): { type: 'agent' | 'command'; items: { label: string; desc: string }[]; prefix: string } | null => {
    if (disabled || value.length === 0) return null;

    // Find the word being typed at cursor position
    const beforeCursor = value.slice(0, cursor);

    // @mention autocomplete — find last @ before cursor
    const atIdx = beforeCursor.lastIndexOf('@');
    if (atIdx !== -1 && (atIdx === 0 || beforeCursor[atIdx - 1] === ' ')) {
      const partial = beforeCursor.slice(atIdx + 1).toLowerCase();
      const matches = agents
        .filter(a => a.slug.includes(partial) || a.displayName.toLowerCase().includes(partial))
        .slice(0, 8)
        .map(a => ({ label: `@${a.slug}`, desc: a.displayName }));
      if (matches.length > 0) return { type: 'agent', items: matches, prefix: beforeCursor.slice(atIdx) };
    }

    // /command autocomplete — only at start of input
    if (beforeCursor.startsWith('/')) {
      const partial = beforeCursor.toLowerCase();
      const matches = COMMANDS
        .filter(c => c.name.startsWith(partial))
        .slice(0, 10)
        .map(c => ({ label: c.name, desc: c.desc, syntax: (c as any).syntax }));
      if (matches.length > 0) return { type: 'command', items: matches, prefix: beforeCursor };
    }

    return null;
  };

  const autocomplete = getAutocomplete();

  return (
    <Box flexDirection="column">
      {autocomplete && (
        <Box paddingX={2} flexDirection="column">
          {autocomplete.items.map((item, i) => {
            const selected = i === Math.min(acIndex, autocomplete.items.length - 1);
            const syntax = (item as any).syntax;
            return (
              <Box key={item.label} gap={1}>
                <Text color={selected ? COLORS.primary : COLORS.muted}>{selected ? '\u25B8' : ' '}</Text>
                <Text color={selected ? COLORS.primary : COLORS.subtle} bold={selected}>
                  {selected && syntax ? syntax : item.label}
                </Text>
                <Text color={COLORS.muted}>{'\u2014'} {item.desc}</Text>
                {selected && <Text color={COLORS.border} dimColor> Tab</Text>}
              </Box>
            );
          })}
        </Box>
      )}
      <Box borderStyle="round" borderColor={disabled ? '#3D3A36' : '#5C5751'} paddingX={1} marginTop={1}>
        <Text bold color="#C2785C">&gt; </Text>
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
