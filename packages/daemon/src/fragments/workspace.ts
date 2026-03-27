import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fragment } from './types.js';

/** Load skill descriptions from agent's skills/ directory for system prompt injection. */
function loadSkillDescriptions(agentDir: string): string {
  const skillsDir = join(agentDir, 'skills');
  if (!existsSync(skillsDir)) return '';

  const skills: string[] = [];
  try {
    const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const skillMd = join(skillsDir, dir.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const content = readFileSync(skillMd, 'utf-8');
      // Extract frontmatter description
      const descMatch = content.match(/description:\s*"([^"]+)"/);
      if (descMatch) {
        skills.push(`- **${dir.name}**: ${descMatch[1]}`);
      } else {
        skills.push(`- **${dir.name}**: Read ${skillMd} for details`);
      }
    }
  } catch {}
  return skills.length > 0
    ? `\n## Skills\nYou have ${skills.length} skills installed in ${skillsDir}. When a task matches a skill, READ the skill's SKILL.md BEFORE starting work.\n${skills.join('\n')}`
    : '';
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
