import { existsSync, mkdirSync, readdirSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Sync corp-level skills to an agent's workspace.
 * Copies all skill directories from {corpRoot}/skills/ to {agentDir}/skills/.
 */
export function syncSkillsToAgent(corpRoot: string, agentDir: string): void {
  const corpSkillsDir = join(corpRoot, 'skills');
  const agentSkillsDir = join(corpRoot, agentDir, 'skills');

  if (!existsSync(corpSkillsDir)) return;

  mkdirSync(agentSkillsDir, { recursive: true });

  const skills = readdirSync(corpSkillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const skill of skills) {
    const src = join(corpSkillsDir, skill.name);
    const dest = join(agentSkillsDir, skill.name);
    cpSync(src, dest, { recursive: true, force: true });
  }
}

/**
 * Sync corp-level skills to ALL agents in the corp.
 * Call on daemon startup to ensure all agents have the latest skills.
 */
export function syncSkillsToAllAgents(corpRoot: string): void {
  const agentsDir = join(corpRoot, 'agents');
  if (!existsSync(agentsDir)) return;

  const corpSkillsDir = join(corpRoot, 'skills');
  if (!existsSync(corpSkillsDir)) return;

  const agents = readdirSync(agentsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const agent of agents) {
    syncSkillsToAgent(corpRoot, `agents/${agent.name}/`);
  }
}

/**
 * Install default skills into a new corp's skills/ directory.
 * Copies from the bundled skills in the shared package.
 */
export function installDefaultSkills(corpRoot: string): void {
  const corpSkillsDir = join(corpRoot, 'skills');
  mkdirSync(corpSkillsDir, { recursive: true });

  // Default skills ship with the package
  const bundledSkillsDir = join(dirname(new URL(import.meta.url).pathname), '..', '..', 'skills');
  // On Windows, strip leading /
  const normalizedPath = process.platform === 'win32'
    ? bundledSkillsDir.replace(/^\/([A-Z]:)/, '$1')
    : bundledSkillsDir;

  if (!existsSync(normalizedPath)) return;

  const skills = readdirSync(normalizedPath, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const skill of skills) {
    const src = join(normalizedPath, skill.name);
    const dest = join(corpSkillsDir, skill.name);
    if (!existsSync(dest)) {
      cpSync(src, dest, { recursive: true });
    }
  }
}
