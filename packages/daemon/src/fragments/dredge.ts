import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fragment } from './types.js';

/**
 * Dredge — session recovery fragment.
 * Injects WORKLOG.md (recent DM activity) into every agent's system prompt
 * so they can pick up where they left off across sessions.
 */
export const dredgeFragment: Fragment = {
  id: 'dredge',
  applies: () => true,
  order: 13, // After inbox (12), before cc-cli (15)
  render: (ctx) => {
    const worklogPath = join(ctx.agentDir, 'WORKLOG.md');
    if (!existsSync(worklogPath)) return '';

    try {
      const content = readFileSync(worklogPath, 'utf-8').trim();
      if (!content) return '';

      return `## Dredge — Recent Work

${content}

Pick up where you left off. Don't repeat what you've already done.`;
    } catch {
      return '';
    }
  },
};
