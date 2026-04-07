import { defineConfig } from 'tsup';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: false,
  // Copy demo scenarios to dist after build (tsup doesn't copy non-TS by default)
  onSuccess: async () => {
    const srcDir = join('src', 'demo', 'scenarios');
    const distDir = join('dist', 'demo', 'scenarios');
    if (existsSync(srcDir)) {
      mkdirSync(distDir, { recursive: true });
      cpSync(srcDir, distDir, { recursive: true });
      console.log('[tsup] Copied demo scenarios to dist');
    }
  },
});
