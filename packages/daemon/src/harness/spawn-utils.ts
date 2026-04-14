/**
 * Cross-platform subprocess spawn helpers.
 *
 * ClaudeCodeHarness (and any future subprocess-based harness) goes
 * through `defaultSpawn`, which uses Windows shell mode to let cmd.exe
 * resolve the binary via PATH + PATHEXT (handles .exe / .cmd / .bat /
 * npm-shim shells uniformly) and quotes arguments through
 * `quoteForWindowsCmd` so paths with spaces and cmd.exe metacharacters
 * don't break tokenization.
 *
 * POSIX doesn't need any of this — `child_process.spawn` resolves via
 * PATH natively and preserves arg boundaries without a shell.
 */

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
