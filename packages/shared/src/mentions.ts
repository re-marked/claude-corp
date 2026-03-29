import type { Member } from './types/index.js';

// Matches @"Multi Word Name" or @SingleWord
const MENTION_RE = /@"([^"]+)"|@([A-Za-z0-9][\w-]*)/g;

export function extractMentionNames(content: string): string[] {
  const names: string[] = [];
  let match: RegExpExecArray | null;

  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(content)) !== null) {
    const name = match[1] ?? match[2];
    if (name) names.push(name);
  }

  return names;
}

export function resolveMentions(content: string, members: Member[]): string[] {
  const memberIds: string[] = [];

  // First: regex-extracted names (handles @"Lead Coder" and @CEO)
  const names = extractMentionNames(content);
  for (const name of names) {
    const lower = name.toLowerCase();
    const member = members.find(
      (m) => m.displayName.toLowerCase() === lower && m.status !== 'archived',
    );
    if (member && !memberIds.includes(member.id)) memberIds.push(member.id);
  }

  // Second: unquoted multi-word @mentions by checking against known member names
  // Catches @Lead Coder (without quotes) by matching "@" + memberName in content
  for (const m of members) {
    if (m.status === 'archived') continue;
    if (memberIds.includes(m.id)) continue;
    if (!m.displayName.includes(' ')) continue;
    const pattern = `@${m.displayName}`;
    if (content.toLowerCase().includes(pattern.toLowerCase())) {
      memberIds.push(m.id);
    }
  }

  return memberIds;
}
