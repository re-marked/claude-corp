import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fragment } from './types.js';

/**
 * Dredge — session recovery fragment.
 * Extracts the Session Summary from WORKLOG.md and injects it into
 * the system prompt. This gives agents concise continuity without
 * dumping the full worklog into every dispatch.
 */
export const dredgeFragment: Fragment = {
  id: 'dredge',
  applies: () => true,
  order: 13, // After inbox (12), before cc-cli (15)
  render: (ctx) => {
    const worklogPath = join(ctx.agentDir, 'WORKLOG.md');
    if (!existsSync(worklogPath)) return '';

    try {
      const content = readFileSync(worklogPath, 'utf-8');
      if (!content.trim()) return '';

      // Extract just the "## Session Summary" section — that's the actionable part
      const summaryMatch = content.match(/## Session Summary\n([\s\S]*?)(?=\n## |$)/);
      if (summaryMatch?.[1]?.trim()) {
        return `## Dredge — Session Recovery

${summaryMatch[1].trim()}

This is what you were doing before this session. Read WORKLOG.md for full session history if needed.`;
      }

      // Fallback: if no summary section, show the first 500 chars
      const preview = content.slice(0, 500).trim();
      if (!preview) return '';

      return `## Dredge — Session Recovery

${preview}

Read your full WORKLOG.md for detailed session history.`;
    } catch {
      return '';
    }
  },
};
