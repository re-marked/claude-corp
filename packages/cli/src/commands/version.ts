import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function cmdVersion(opts: { json: boolean }) {
  // Read package versions
  const versions: Record<string, string> = {};
  const thisFile = fileURLToPath(import.meta.url);

  const tryRead = (label: string, ...pathParts: string[]) => {
    try {
      const pkg = JSON.parse(readFileSync(join(thisFile, ...pathParts, 'package.json'), 'utf-8'));
      versions[label] = pkg.version ?? 'unknown';
    } catch {
      versions[label] = 'unknown';
    }
  };

  // From dist/index.js or src/index.ts
  tryRead('cli', '..', '..');
  tryRead('shared', '..', '..', '..', 'shared');
  tryRead('daemon', '..', '..', '..', 'daemon');
  tryRead('tui', '..', '..', '..', 'tui');

  if (opts.json) {
    console.log(JSON.stringify({ packages: versions, node: process.version, platform: process.platform }, null, 2));
    return;
  }

  console.log('Claude Corp versions:');
  for (const [pkg, ver] of Object.entries(versions)) {
    console.log(`  ${pkg.padEnd(12)} ${ver}`);
  }
  console.log(`  node         ${process.version}`);
  console.log(`  platform     ${process.platform}`);
}
