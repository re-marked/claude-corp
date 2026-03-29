import type { Member } from './types/index.js';

/**
 * Resolve @mentions in content to member IDs.
 * Dead simple: check if "@" + memberName appears in the content.
 * Checks longest names first so "Lead Coder" matches before "Lead".
 * Case-insensitive. No regex. No edge cases.
 */
export function resolveMentions(content: string, members: Member[]): string[] {
  const lower = content.toLowerCase();
  const ids: string[] = [];

  // Sort by name length descending — longest match first
  const sorted = [...members]
    .filter(m => m.status !== 'archived')
    .sort((a, b) => b.displayName.length - a.displayName.length);

  for (const m of sorted) {
    if (ids.includes(m.id)) continue;
    const pattern = `@${m.displayName.toLowerCase()}`;
    if (lower.includes(pattern)) {
      ids.push(m.id);
    }
  }

  return ids;
}

/** Extract raw mention names from content (for display/highlighting). */
export function extractMentionNames(content: string): string[] {
  const re = /@"([^"]+)"|@([A-Za-z0-9][\w-]*)/g;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((match = re.exec(content)) !== null) {
    const name = match[1] ?? match[2];
    if (name) names.push(name);
  }
  return names;
}
