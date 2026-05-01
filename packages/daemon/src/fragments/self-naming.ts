/**
 * Self-Naming Fragment — fires on a fresh bacteria-spawned Employee's
 * very first dispatches, until they run `cc-cli whoami rename` to
 * claim a name.
 *
 * Selection: agent kind is 'employee' AND displayName equals the
 * member id (the "needs naming" signal — bacteria spawns slots with
 * displayName=slug; the rename CLI breaks that equality permanently).
 *
 * Self-canceling: once the agent renames, the equality breaks and
 * this fragment stops applying. No follow-up state, no manual cleanup.
 *
 * Project 1.10.3.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fragment } from './types.js';
import { MEMBERS_JSON, getRole, type Member } from '@claudecorp/shared';

export const selfNamingFragment: Fragment = {
  id: 'self-naming',
  // Order 5: very early — even before autoemon's mode-setting (8).
  // The first thing a fresh slot needs to do is name itself; everything
  // downstream assumes a stable identity.
  order: 5,
  applies: (ctx) =>
    ctx.agentKind === 'employee' &&
    !!ctx.agentMemberId &&
    ctx.agentDisplayName === ctx.agentMemberId,
  render: (ctx) => {
    const slug = ctx.agentMemberId!;
    const role = ctx.agentRole ? getRole(ctx.agentRole) : undefined;
    const roleLabel = role?.displayName ?? ctx.agentRole ?? 'Employee';

    // Look up parent for the "your sibling" line. Best-effort —
    // missing parent (or a parent that's already apoptosed) just
    // omits the line. Fragments shouldn't crash on filesystem
    // glitches.
    let siblingLine = '';
    try {
      const members = JSON.parse(
        readFileSync(join(ctx.corpRoot, MEMBERS_JSON), 'utf-8'),
      ) as Member[];
      const self = members.find((m) => m.id === slug);
      if (self?.parentSlot) {
        const parent = members.find(
          (m) =>
            m.id === self.parentSlot &&
            m.type === 'agent' &&
            m.status === 'active',
        );
        if (parent && parent.displayName !== parent.id) {
          // Parent has chosen a name — show it as the sibling.
          siblingLine = `\nYour sibling: **${parent.displayName}** (alive in the corp).`;
        } else if (parent) {
          // Parent exists but hasn't named themselves yet — rare
          // (parent should have been around long enough to name).
          // Still surface their slug.
          siblingLine = `\nYour sibling: ${parent.id} (also still pending self-naming).`;
        }
      }
    } catch {
      // Filesystem hiccup — skip the sibling line. Worst case the
      // agent gets the prompt without lineage flavor.
    }

    return `# You are new — pick your name

You're a fresh **${roleLabel}**. The corp just spawned you (mitose, queue overflow). You don't have a name yet — your displayName is still your slug: \`${slug}\`.${siblingLine}

Pick a name in the spirit of your role — one word, 2–30 chars, alphanumerics + hyphens / underscores, starts with a letter. Examples from past pools: Toast, Shadow, Copper, Soot, Whetstone.

**Your first action this session, before anything else:**

\`\`\`bash
cc-cli whoami --agent ${slug}
cc-cli whoami rename <chosen> --agent ${slug}
\`\`\`

After renaming, this preamble stops appearing and you proceed with whatever's in your casket. Names within a role must be unique among active siblings — pick something not currently held.

Names are persistent for your lifetime. When you eventually apoptose (when the queue drains and the pool collapses), the corp writes an obituary observation tagged with your chosen name. Your name is how you're remembered.
`;
  },
};
