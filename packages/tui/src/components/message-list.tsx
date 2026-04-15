import React from 'react';
import { Text } from '@claude-code-kit/ink-renderer';
import type { ChannelMessage, Member } from '@claudecorp/shared';
import { COLORS } from '../theme.js';

function RainbowText({ children }: { children: string }) {
  const text = typeof children === 'string' ? children : String(children);
  const chars = text.split('');
  const len = Math.max(chars.length, 1);
  return (
    <Text bold>
      {chars.map((char, i) => {
        const hue = (i / len) * 300;
        const hex = hslToHex(hue, 80, 65);
        return <Text key={i} color={hex}>{char}</Text>;
      })}
    </Text>
  );
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

/** Wrap a URL in OSC 8 hyperlink escapes. Clickable in supporting terminals. */
function linkify(url: string): string {
  return `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
}

/** Render message content with @mentions highlighted and URLs clickable. */
export function renderContent(content: string | undefined | null, members: Map<string, Member>) {
  if (!content) return <Text wrap="wrap">{''}</Text>;

  // Build a list of all highlight ranges: URLs and @mentions (both slug and display name)
  const ranges: { start: number; end: number; type: 'url' | 'mention'; text: string; member?: Member }[] = [];

  // Find URLs
  const urlRe = /https?:\/\/[^\s<>"'\)\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(content)) !== null) {
    ranges.push({ start: m.index, end: m.index + m[0].length, type: 'url', text: m[0] });
  }

  // Find @mentions — check every member's display name and slug against content
  const lower = content.toLowerCase();
  const allMembers = [...members.values()].sort((a, b) => b.displayName.length - a.displayName.length);
  for (const member of allMembers) {
    // Check display name: @Lead Strategist
    const dnPattern = `@${member.displayName.toLowerCase()}`;
    let idx = lower.indexOf(dnPattern);
    while (idx !== -1) {
      const end = idx + 1 + member.displayName.length;
      if (!ranges.some(r => idx >= r.start && idx < r.end)) {
        ranges.push({ start: idx, end, type: 'mention', text: content.slice(idx, end), member });
      }
      idx = lower.indexOf(dnPattern, idx + 1);
    }
    // Check slug: @lead-strategist
    const slug = member.displayName.toLowerCase().replace(/\s+/g, '-');
    const slugPattern = `@${slug}`;
    idx = lower.indexOf(slugPattern);
    while (idx !== -1) {
      const end = idx + 1 + slug.length;
      if (!ranges.some(r => idx >= r.start && idx < r.end)) {
        ranges.push({ start: idx, end, type: 'mention', text: content.slice(idx, end), member });
      }
      idx = lower.indexOf(slugPattern, idx + 1);
    }
  }

  // Sort by position
  ranges.sort((a, b) => a.start - b.start);

  // Render
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const range of ranges) {
    if (range.start < lastIndex) continue; // Skip overlapping
    if (range.start > lastIndex) {
      parts.push(<Text key={`t${lastIndex}`} wrap="wrap">{content.slice(lastIndex, range.start)}</Text>);
    }
    if (range.type === 'url') {
      parts.push(<Text key={`u${range.start}`} color={COLORS.info} underline>{linkify(range.text)}</Text>);
    } else {
      const isCeo = range.member?.rank === 'master';
      if (isCeo) {
        parts.push(<RainbowText key={`m${range.start}`}>{range.text}</RainbowText>);
      } else {
        parts.push(<Text key={`m${range.start}`} bold color={COLORS.secondary}>{range.text}</Text>);
      }
    }
    lastIndex = range.end;
  }
  if (lastIndex < content.length) {
    parts.push(<Text key={`t${lastIndex}`} wrap="wrap">{content.slice(lastIndex)}</Text>);
  }

  return parts.length > 0 ? parts : <Text wrap="wrap">{content}</Text>;
}

/**
 * Pull the dispatch turnId out of a message's metadata. All segments
 * (text + tool_event) persisted within one harness dispatch share the
 * same turnId — callers use it to group consecutive same-sender
 * messages into a single visual bubble (one header, multiple inline
 * rows) instead of N timestamped chunks. Messages predating the
 * turnId stamping (or from non-claude-code dispatchers that don't set
 * it) return null, triggering a per-message bubble fallback.
 */
export function getTurnId(msg: ChannelMessage): string | null {
  const meta = msg.metadata as Record<string, unknown> | null;
  const t = meta?.turnId;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

/**
 * True when this message is a continuation of the previous one —
 * same sender AND same turnId. Callers that render message lists
 * use this to skip redundant headers and collapse a multi-block
 * claude-code dispatch into one visual bubble.
 */
export function isTurnContinuation(msg: ChannelMessage, prev: ChannelMessage | null): boolean {
  const turnId = getTurnId(msg);
  if (turnId === null || prev === null) return false;
  if (prev.senderId !== msg.senderId) return false;
  return getTurnId(prev) === turnId;
}
