/**
 * Culture Fragment — always-on CULTURE.md surfacing.
 *
 * CULTURE.md lives at the corp root and holds rules the founder taught
 * the corp through repetition. The CEO's dream promotes compounded
 * feedback (tracked via BRAIN `times_heard`) into this file. Every
 * agent reads it on every dispatch so the rules hold across the corp,
 * not just for the agent that was present when the correction landed.
 *
 * If the file doesn't exist yet (no promotions have happened), the
 * fragment skips silently — it doesn't clutter the system prompt with
 * placeholders.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fragment } from './types.js';
import { CULTURE_MD_FILENAME } from '@claudecorp/shared';

// Soft cap — CULTURE.md shouldn't grow unbounded, but if it does we
// truncate for the fragment without breaking reads elsewhere.
const MAX_CULTURE_CHARS = 6000;

export const cultureFragment: Fragment = {
  id: 'culture',
  applies: (ctx) => {
    try {
      return existsSync(join(ctx.corpRoot, CULTURE_MD_FILENAME));
    } catch {
      return false;
    }
  },
  // Early in the prompt — culture is foundational context agents should
  // see before task-specific guidance. Between brain (14) and workspace.
  order: 8,
  render: (ctx) => {
    const p = join(ctx.corpRoot, CULTURE_MD_FILENAME);
    let body: string;
    try {
      body = readFileSync(p, 'utf-8').trim();
    } catch {
      return '';
    }
    if (!body) return '';

    const truncated = body.length > MAX_CULTURE_CHARS
      ? body.slice(0, MAX_CULTURE_CHARS) + `\n\n_(CULTURE.md truncated — full file at ${p})_`
      : body;

    return `# Corp Culture

These are rules the founder taught the corp through repetition — not your personal BRAIN, but the shared law of the corp. Every agent follows them. Violating them is the same as ignoring a direct founder correction.

${truncated}

If a correction lands on you that matches one of these rules, you don't need to re-learn it — apply it. If you find yourself about to do something one of these rules forbids, stop and reconsider.`;
  },
};
