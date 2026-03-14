import type { Member } from './types/index.js';

// Matches @Name or @"Multi Word Name"
const MENTION_RE = /@"([^"]+)"|@(\S+)/g;

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
  const names = extractMentionNames(content);
  const memberIds: string[] = [];

  for (const name of names) {
    const lower = name.toLowerCase();
    const member = members.find(
      (m) => m.displayName.toLowerCase() === lower && m.status !== 'archived',
    );
    if (member) memberIds.push(member.id);
  }

  return memberIds;
}
