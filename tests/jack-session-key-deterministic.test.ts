import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression test for the `jack:${slug}:${Date.now()}` bug fixed in
 * e01ca2f. The TUI and cc-cli's jack command both stamped a timestamp
 * into the jack session key, which derived a fresh UUIDv5 every time
 * the user entered a DM or invoked `cc-cli jack`. Result: claude-code
 * agents lost their conversation memory between channel switches and
 * the CEO re-introduced itself on every message.
 *
 * Every other dispatcher in the daemon (autoemon, dreams, slumber,
 * api, router) already used the deterministic `jack:${slug}` form.
 * The fix dropped the timestamp from the three outliers; this test
 * locks the rule in: no source file may bake `Date.now()` (or
 * `new Date()`) into a `jack:` template literal.
 *
 * Walks every .ts / .tsx file under packages/, skips dist/ and
 * node_modules/, looks for any string-template line where a `jack:`
 * prefix and a `Date.now` (or `new Date(`) appear together. Empty
 * match list = pass.
 */

const REPO_ROOT = join(__dirname, '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

function walk(dir: string, hits: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) {
      walk(full, hits);
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    let text: string;
    try { text = readFileSync(full, 'utf-8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Match: a backtick-string containing `jack:` AND `Date.now`
      // (or `new Date(`) on the same line. The regex is intentionally
      // narrow to avoid matching e.g., `Date.now()` referenced in a
      // separate line of unrelated code.
      if (/`[^`]*\bjack:[^`]*\$\{[^}]*Date\.now\(\)/.test(line) ||
          /`[^`]*\bjack:[^`]*\$\{[^}]*new Date\(/.test(line)) {
        hits.push(`${full.replace(REPO_ROOT, '').replace(/\\/g, '/')}:${i + 1}: ${line.trim()}`);
      }
    }
  }
}

describe('jack session keys must be deterministic', () => {
  it('no source file bakes a timestamp into a jack: template literal', () => {
    const hits: string[] = [];
    walk(PACKAGES_DIR, hits);
    if (hits.length > 0) {
      throw new Error(
        `Found jack: session keys with non-deterministic suffixes. ` +
        `These break claude-code session resume — same agent must always derive the same UUID:\n  ` +
        hits.join('\n  '),
      );
    }
    expect(hits).toEqual([]);
  });
});
