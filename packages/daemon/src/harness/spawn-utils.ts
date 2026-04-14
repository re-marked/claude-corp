/**
 * Cross-platform subprocess spawn helpers.
 *
 * Strategy: at init time, harnesses call `findExecutableInPath(name)`
 * to resolve a binary's absolute path by walking process.env.PATH +
 * PATHEXT. They then store and use that absolute path for every spawn.
 *
 * Why not just spawn the bare name and rely on PATH search inside
 * Node's spawn? Two reasons observed empirically on Windows:
 *   1. Node's spawn without shell sometimes fails to find binaries
 *      that the same env's PATH demonstrably contains. The failure is
 *      contextual (cwd-dependent? launch-shell-dependent?) and not
 *      reproducible across all process states.
 *   2. Falling back to `shell: true` introduces a new failure on
 *      Windows when launched via MSYS/git-bash where ComSpec env var
 *      can be missing or pointed at a translated POSIX path, producing
 *      `spawn C:\WINDOWS\system32\cmd.exe ENOENT` even though cmd.exe
 *      exists at that path.
 *
 * Resolving an absolute path up front sidesteps both. Spawn is then
 * given a path that exists, no PATH search needed, no shell needed.
 *
 * `quoteForWindowsCmd` remains exported for any future caller that
 * does need shell-mode invocation, but `defaultSpawn` no longer uses
 * shell mode itself.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Walk process.env.PATH looking for a file matching `name` (with each
 * PATHEXT extension on Windows). Returns the absolute path of the first
 * match or null when nothing is found.
 *
 * Pure synchronous — relies on statSync. Fast enough at init time
 * (typical PATH has a few dozen entries).
 *
 * Windows extension priority matches PATHEXT semantics:
 *   .COM → .EXE → .BAT → .CMD → bare name
 * (Order chosen so .exe wins over .cmd when both happen to exist for
 * the same name, matching cmd.exe's natural search.)
 */
export function findExecutableInPath(name: string): string | null {
  const PATH = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = PATH.split(sep).filter(Boolean);

  const exts = process.platform === 'win32'
    ? ['.com', '.exe', '.bat', '.cmd', '']
    : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Doesn't exist or no permission — try the next candidate.
      }
    }
  }
  return null;
}

/**
 * Wrap an argument for safe passing through cmd.exe on Windows.
 *
 * Triggers wrapping when the argument contains any of:
 *   - Whitespace (space, tab, newline) — would split into multiple tokens
 *   - Double-quote `"` — needs escaping inside the wrapped string
 *   - cmd.exe metacharacters: `&` `|` `<` `>` `^` `%` — interpreted as
 *     command operators / variable references unless quoted
 *
 * Inside the wrap, any pre-existing `"` is doubled per cmd.exe's quoting
 * rules (`"foo""bar"` is the escape for `foo"bar`).
 *
 * Empty strings are emitted as `""` so they don't get swallowed by the
 * shell.
 *
 * No-op for POSIX callers — they don't need shell mode in the first
 * place, but this function remains safe to call on any platform.
 */
export function quoteForWindowsCmd(arg: string): string {
  if (arg === '') return '""';
  if (!CMD_UNSAFE_PATTERN.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}

/**
 * Characters that need cmd.exe quoting to survive shell tokenization +
 * metacharacter interpretation. Expanded from the naive /[\s"]/ guard
 * so paths containing `&` / `|` / `<` / `>` / `^` / `%` are safe too
 * (rare but possible in user directory names or environment substitutions).
 */
export const CMD_UNSAFE_PATTERN = /[\s"&|<>^%]/;
