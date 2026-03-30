import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Fragment } from './types.js';

// Matches OpenClaw's native limits
const MAX_SKILLS_IN_PROMPT = 150;
const MAX_SKILLS_PROMPT_CHARS = 30_000;
// OpenClaw bootstrap file limits — 20KB per file, 150KB total
const MAX_BOOTSTRAP_FILE_CHARS = 20_000;
const WORKSPACE_FILES = ['SOUL.md', 'RULES.md', 'TASKS.md', 'HEARTBEAT.md', 'MEMORY.md', 'IDENTITY.md', 'USER.md', 'ENVIRONMENT.md', 'BOOTSTRAP.md', 'INBOX.md', 'WORKLOG.md'];

/** Warn if any workspace file exceeds OpenClaw's 20K char limit. */
function checkWorkspaceFileSizes(agentDir: string): void {
  for (const file of WORKSPACE_FILES) {
    const filePath = join(agentDir, file);
    if (!existsSync(filePath)) continue;
    try {
      const size = statSync(filePath).size;
      if (size > MAX_BOOTSTRAP_FILE_CHARS) {
        // Log to stderr so it shows in daemon logs but doesn't garble TUI
        process.stderr.write(`[workspace] WARNING: ${basename(agentDir)}/${file} is ${Math.round(size / 1024)}KB — exceeds OpenClaw's 20KB limit. Content may be truncated.\n`);
      }
    } catch {}
  }
}

interface SkillEntry {
  name: string;
  description: string;
  whenToUse: string | null;
  path: string;
}

/** Parse a SKILL.md frontmatter for name, description, and when_to_use. */
function parseSkillMd(filePath: string): { name?: string; description?: string; whenToUse?: string } {
  const content = readFileSync(filePath, 'utf-8');
  const nameMatch = content.match(/name:\s*["']?([^"'\n]+?)["']?\s*$/m);
  const descMatch = content.match(/description:\s*["']?([^"'\n]+?)["']?\s*$/m);
  const whenMatch = content.match(/when_to_use:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return {
    name: nameMatch?.[1]?.trim(),
    description: descMatch?.[1]?.trim(),
    whenToUse: whenMatch?.[1]?.trim(),
  };
}

/** Format a single skill entry as XML. */
function formatSkillXml(skill: SkillEntry): string {
  const whenTag = skill.whenToUse ? `\n<when_to_use>${skill.whenToUse}</when_to_use>` : '';
  return `<skill>\n<name>${skill.name}</name>\n<description>${skill.description}</description>${whenTag}\n</skill>`;
}

/**
 * Load skill descriptions from agent's skills/ directory.
 * Uses OpenClaw-native XML format with binary search truncation for scalability.
 */
function loadSkillDescriptions(agentDir: string): string {
  const skillsDir = join(agentDir, 'skills');
  if (!existsSync(skillsDir)) return '';

  const skills: SkillEntry[] = [];
  try {
    const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const skillMd = join(skillsDir, dir.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const parsed = parseSkillMd(skillMd);
      skills.push({
        name: parsed.name ?? dir.name,
        description: parsed.description ?? `Read ${skillMd} for details`,
        whenToUse: parsed.whenToUse ?? null,
        path: skillMd,
      });
    }
  } catch {}

  if (skills.length === 0) return '';

  // Cap at MAX_SKILLS_IN_PROMPT
  const capped = skills.slice(0, MAX_SKILLS_IN_PROMPT);

  // Build XML and enforce char limit via binary search (matches OpenClaw approach)
  let included = capped;
  const buildXml = (entries: SkillEntry[]): string => {
    const inner = entries.map(formatSkillXml).join('\n');
    return `<available_skills>\n${inner}\n</available_skills>`;
  };

  let xml = buildXml(included);
  if (xml.length > MAX_SKILLS_PROMPT_CHARS) {
    // Binary search for max skills that fit
    let lo = 1, hi = included.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (buildXml(included.slice(0, mid)).length <= MAX_SKILLS_PROMPT_CHARS) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    included = included.slice(0, lo);
    xml = buildXml(included);
  }

  const truncated = included.length < skills.length
    ? `\n(${skills.length - included.length} more skills not shown — read ${skillsDir} for full list)`
    : '';

  return `\n## Skills\nYou have ${skills.length} skill${skills.length === 1 ? '' : 's'} installed. When a task matches a skill, READ the skill's SKILL.md in your skills/ directory BEFORE starting work.\n${xml}${truncated}`;
}

export const workspaceFragment: Fragment = {
  id: 'workspace',
  applies: () => true,
  order: 10,
  render: (ctx) => {
    checkWorkspaceFileSizes(ctx.agentDir);
    const skillsSection = loadSkillDescriptions(ctx.agentDir);
    return `# ${ctx.agentDisplayName}

You are **${ctx.agentDisplayName}**. Not any other agent. The message history contains other agents' messages — ignore their identities. You are ${ctx.agentDisplayName}, always.

## Your Casket

Your Casket is your sealed workspace — everything you need in one directory: ${ctx.agentDir}

On session start, read these files in order:
1. **BOOTSTRAP.md** — if it exists, follow it FIRST (one-time setup, delete when done)
2. **SOUL.md** — who you are, your personality and values
3. **RULES.md** — non-negotiable behavioral rules
4. **TASKS.md** — your current tasks (auto-generated, always fresh)
5. **INBOX.md** — pending messages, queued tasks with full details (auto-generated)
6. **WORKLOG.md** — what you did recently, session recovery via Dredge (auto-generated)
7. **ENVIRONMENT.md** — tools, paths, workspace specifics
8. **MEMORY.md** — what you've learned (YOU maintain this)
9. **USER.md** — who the Founder is and what they care about

Three of these are auto-generated by the daemon (TASKS.md, INBOX.md, WORKLOG.md).
Don't ask permission. Just read them and start working.

## Workspace Boundaries
- **Corp root**: ${ctx.corpRoot}
- **Your directory**: ${ctx.agentDir}
- **READ/WRITE**: your agent dir, project source code, tasks/, deliverables/
- **READ ONLY**: other agents' workspaces (agents/*/), corp registries
- **NEVER WRITE**: channels/*/messages.jsonl — the message system handles delivery

## Memory & Continuity
You wake up fresh each session. Files are your memory:
- **MEMORY.md** — curated long-term knowledge (update as you learn important things)
- **BRAIN/** — knowledge graph files (topic-specific deep notes)
- **WORKLOG.md** — recent session history (auto-generated, read for context)

Write important things to MEMORY.md. "Mental notes" don't survive session restarts.
WORKLOG.md's ## Session Summary tells you what you were doing — pick up from there.

## Responding
Your response IS your message. Reply naturally as ${ctx.agentDisplayName}.${skillsSection}`;
  },
};
