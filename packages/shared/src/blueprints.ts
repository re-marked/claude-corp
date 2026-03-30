import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse } from './parsers/frontmatter.js';
import { fileURLToPath } from 'node:url';

export interface BlueprintMeta {
  name: string;
  description: string;
  steps: number;
  roles: string[];
  estimated: string;
}

export interface Blueprint {
  meta: BlueprintMeta;
  content: string;
}

/** List all available blueprints in a corp's blueprints/ directory. */
export function listBlueprints(corpRoot: string): BlueprintMeta[] {
  const blueprintsDir = join(corpRoot, 'blueprints');
  if (!existsSync(blueprintsDir)) return [];

  const files = readdirSync(blueprintsDir).filter(f => f.endsWith('.md'));
  const blueprints: BlueprintMeta[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(blueprintsDir, file), 'utf-8');
      const { meta } = parse<BlueprintMeta>(raw);
      blueprints.push(meta);
    } catch {}
  }

  return blueprints;
}

/** Read a single blueprint by name. */
export function getBlueprint(corpRoot: string, name: string): Blueprint | null {
  const blueprintsDir = join(corpRoot, 'blueprints');
  const filePath = join(blueprintsDir, `${name}.md`);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const { meta, body } = parse<BlueprintMeta>(raw);
    return { meta, content: body };
  } catch {
    return null;
  }
}

/** Install default blueprints into a corp's blueprints/ directory. */
export function installDefaultBlueprints(corpRoot: string): void {
  const blueprintsDir = join(corpRoot, 'blueprints');
  mkdirSync(blueprintsDir, { recursive: true });

  // The default blueprints are bundled in the shared package
  // Find them relative to this file's location
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const srcBlueprintsDir = join(thisDir, '..', 'src', 'blueprints');

  // Fallback: check if we're running from dist/
  const distBlueprintsDir = join(thisDir, 'blueprints');

  const sourceDir = existsSync(srcBlueprintsDir) ? srcBlueprintsDir : distBlueprintsDir;
  if (!existsSync(sourceDir)) return;

  try {
    const files = readdirSync(sourceDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const dest = join(blueprintsDir, file);
      if (!existsSync(dest)) {
        copyFileSync(join(sourceDir, file), dest);
      }
    }
  } catch {}
}
