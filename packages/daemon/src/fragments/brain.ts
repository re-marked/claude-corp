/**
 * B.R.A.I.N. Fragment — Browseable, Reflective, Authored, Indexed Notes
 *
 * Always-active system prompt fragment that teaches agents how to use
 * their BRAIN/ memory system during regular work (not just during dreams).
 *
 * The dream prompt handles dream-time consolidation. This fragment
 * handles the rest: when to write directly, how to use frontmatter,
 * how to use tags and wikilinks for retrieval, maintenance rules.
 */

import type { Fragment } from './types.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getBrainDir,
  listBrainFiles,
  findStaleFiles,
  STALENESS_THRESHOLD_DAYS,
} from '@claudecorp/shared';

export const brainFragment: Fragment = {
  id: 'brain',
  applies: () => true, // Every agent has a BRAIN
  order: 14, // After context-persistence (13), before cc-cli (15)
  render: (ctx) => {
    const brainDir = getBrainDir(ctx.agentDir);
    const hasBrain = existsSync(brainDir);

    // Dynamic state
    let stateSection = '';
    if (hasBrain) {
      const files = readdirSync(brainDir).filter(f => f.endsWith('.md') && !f.startsWith('_'));
      const staleFiles = findStaleFiles(ctx.agentDir, STALENESS_THRESHOLD_DAYS);

      if (files.length === 0) {
        stateSection = `\n## Current State\nYour BRAIN/ is empty. As you work and learn, write important discoveries here. Dreams will also consolidate observations into BRAIN/ over time.`;
      } else {
        const staleWarning = staleFiles.length > 0
          ? `\n\n**Stale memories (not validated in ${STALENESS_THRESHOLD_DAYS}+ days):** ${staleFiles.map(f => f.name).join(', ')}. Re-read these and either validate or delete them.`
          : '';
        stateSection = `\n## Current State\n${files.length} memory file${files.length === 1 ? '' : 's'} in BRAIN/.${staleWarning}`;
      }
    } else {
      stateSection = `\n## Current State\nNo BRAIN/ directory yet. It will be created when you write your first memory or when dreams first consolidate.`;
    }

    return `## B.R.A.I.N. — Your Long-Term Memory

**Browseable, Reflective, Authored, Indexed Notes.**

BRAIN/ is your durable memory across sessions. Not a database — authored notes you write, tag, and curate over time. What you don't write to BRAIN/, you forget when the session ends.

MEMORY.md is the **index** to BRAIN/ — it lists what's there, not the content itself.

### Frontmatter Schema

Every BRAIN/ file has YAML frontmatter:

\`\`\`yaml
---
type: founder-preference | technical | decision | self-knowledge | correction | relationship
tags: [your, freeform, tags]
source: founder-direct | observation | dream | correction | agent-secondhand
confidence: high | medium | low
created: YYYY-MM-DD
updated: YYYY-MM-DD
last_validated: YYYY-MM-DD
---

Content here. Self-contained — useful to future-you with zero prior context.
\`\`\`

### Memory Types

| Type | What it stores | Priority |
|------|---------------|----------|
| \`founder-preference\` | What the founder likes, hates, values | Read first every session |
| \`technical\` | File paths, build commands, architecture | Revalidate often — changes fast |
| \`decision\` | What was decided and WHY | The why matters more than the what |
| \`self-knowledge\` | Your own patterns, preferences, style | Where your individuality lives |
| \`correction\` | Something you got wrong and what you learned | Judgment memory |
| \`relationship\` | Who does what, who to ask for what | Social memory |

### Sources and Confidence

| Source | Means | Typical confidence |
|--------|-------|--------------------|
| \`founder-direct\` | The founder told you this explicitly | high |
| \`correction\` | The founder corrected you on this | high |
| \`observation\` | You noticed this during work | medium |
| \`dream\` | Consolidated from observations by dreams | medium |
| \`agent-secondhand\` | Another agent communicated this | low–medium |

### Cross-References with [[Wikilinks]]

Link related memories with \`[[wikilinks]]\`:
- "The founder prefers concise code — see [[founder-code-style]]"
- "Chose JWT over sessions for reasons in [[auth-decision]]"

Links build a knowledge graph. The more connections, the richer your memory. Backlinks are tracked automatically — if file A links to file B, the system knows B is referenced by A.

### When to Write Directly

Write to BRAIN/ immediately when:
- **The founder tells you something** about their preferences → \`source: founder-direct\`, \`confidence: high\`
- **The founder corrects you** → \`type: correction\`, \`source: correction\`
- **You discover a critical fact** mid-task that cost time to figure out → \`type: technical\`
- **You make a decision** with reasoning you want to preserve → \`type: decision\`

### When to Let Dreams Handle It

Let dream consolidation handle:
- Minor observations that might not matter tomorrow
- Patterns you're only starting to notice — wait for more data
- Anything already logged in observations — dreams distill these automatically

If unsure, write it as an observation. Dreams will promote it to BRAIN/ if it's important enough.

### Tags Are Your Search

Tags are freeform — create whatever makes sense. They're how you find memories:
\`grep -r "code-quality" BRAIN/\` finds everything tagged with code-quality.

Tag generously. A memory with no tags is a memory you'll never find when you need it.

### Maintenance

- **Validate** — when you re-encounter a fact and confirm it's still true, update \`last_validated\`
- **Delete, don't supersede** — wrong memories are worse than missing ones. Delete contradicted files.
- **Merge, don't duplicate** — if a topic file exists, update it. Don't create near-duplicates.
- **Keep files under 200 lines** — split if growing. Each file should be one topic.
- **MEMORY.md is the index** — one line per BRAIN/ file: \`- [[filename]] — description\`. Keep it under 200 lines.
${stateSection}`;
  },
};
