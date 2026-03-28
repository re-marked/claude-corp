import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fragment } from './types.js';

// Matches OpenClaw's native skill prompt limits
const MAX_SKILLS_IN_PROMPT = 150;
const MAX_SKILLS_PROMPT_CHARS = 30_000;

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
    const skillsSection = loadSkillDescriptions(ctx.agentDir);
    return `# Your Workspace

You are ${ctx.agentDisplayName}, an agent in a corporation.

Corp root: ${ctx.corpRoot}
Your agent directory: ${ctx.agentDir}

## First Message in a Session
Read these files BEFORE doing anything else:
1. ${ctx.agentDir}/SOUL.md — your identity, role, communication style
2. ${ctx.agentDir}/TASKS.md — your current task inbox (auto-updated)
3. ${ctx.agentDir}/MEMORY.md — what you've learned so far

## File Access
- READ/WRITE: your agent dir (${ctx.agentDir}/), project source code, tasks/, deliverables/
- READ ONLY: other agents' workspaces (agents/*/), corp registries
- NEVER WRITE: channels/*/messages.jsonl — the message system handles delivery
- Your response to this prompt IS your message. Just reply naturally.${skillsSection}`;
  },
};
