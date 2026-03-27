import { existsSync, mkdirSync, readdirSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the bundled skills directory shipped with the package.
 * Works both in source (src/) and compiled (dist/) contexts.
 */
function getBundledSkillsDir(): string | null {
  try {
    // From dist/index.js → ../skills/
    // From src/skills.ts → ../../skills/
    const thisFile = fileURLToPath(import.meta.url);
    const candidates = [
      resolve(thisFile, '..', '..', 'skills'),      // from dist/
      resolve(thisFile, '..', '..', '..', 'skills'), // from src/
    ];
    for (const c of candidates) {
      if (existsSync(c) && readdirSync(c).length > 0) return c;
    }
  } catch {}
  return null;
}

/**
 * Sync corp-level skills to an agent's workspace.
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
 */
export function installDefaultSkills(corpRoot: string): void {
  const corpSkillsDir = join(corpRoot, 'skills');
  mkdirSync(corpSkillsDir, { recursive: true });

  const bundled = getBundledSkillsDir();
  if (!bundled) return;

  const skills = readdirSync(bundled, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const skill of skills) {
    const src = join(bundled, skill.name);
    const dest = join(corpSkillsDir, skill.name);
    if (!existsSync(dest)) {
      cpSync(src, dest, { recursive: true });
    }
  }
}
