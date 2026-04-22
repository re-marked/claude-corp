/**
 * Evidence scanner — given a task chit's acceptance criteria and the
 * agent's RecentActivity, return which criteria have no evidence and
 * which universal gates (build, tests, git-status) didn't run.
 *
 * V1 heuristics are deliberately simple pattern matches, not an LLM
 * call. Per REFACTOR.md 0.7.3's "the audit doesn't parse evidence
 * deeply — the Stop hook just re-runs" framing: we don't need to
 * PROVE completion, we need to surface "hey, I don't see evidence
 * of X in your recent turns — please show it or explain." The loop
 * does the rest.
 *
 * V2 can extend: LLM-based criterion matching for free-text criteria
 * that don't fit the keyword heuristic, output-parsing for PASS/FAIL,
 * git-status cleanliness checks, etc. The scanner interface stays
 * stable; implementations replace transparently.
 *
 * Pure function, no I/O. Tested by feeding canned RecentActivity
 * shapes + canned criteria arrays.
 */

import type { RecentActivity, ToolCall } from './types.js';

/**
 * The scanner's verdict — feeds straight into buildAuditPrompt's
 * `unverifiedCriteria` + `filesNeedingReadback` + `missingEvidence`
 * fields.
 */
export interface EvidenceScanResult {
  /** Criteria from task.acceptanceCriteria that had no matching evidence. */
  unverifiedCriteria: string[];
  /**
   * Files mentioned in criteria that weren't read-back via the Read
   * tool after being written/edited. The read-back gate enforces
   * "you claimed to write this — confirm its contents match intent."
   */
  filesNeedingReadback: string[];
  /**
   * Universal gates: build, tests, git-status. Missing from this
   * array = evidence found. Present = agent hasn't demonstrated they
   * ran it in recent activity.
   */
  missingEvidence: Array<'build' | 'tests' | 'git-status'>;
}

/**
 * Scan `recent` for evidence matching each criterion. Returns which
 * criteria are unverified + which universal gates didn't fire.
 *
 * The pattern matchers below are case-insensitive regex scans over
 * bash `command` strings and file paths. Intentionally fuzzy — a
 * criterion "ensure tests pass" matches any bash that contains
 * `vitest` OR `pnpm test` OR the word "test"; cross-reference with
 * per-task context is a v2 concern.
 */
export function scanEvidence(
  criteria: string[],
  recent: RecentActivity,
): EvidenceScanResult {
  const unverifiedCriteria: string[] = [];
  const filesNeedingReadback = new Set<string>();
  const missingEvidence = new Set<'build' | 'tests' | 'git-status'>();

  // Universal gates first — these apply regardless of criteria shape.
  if (!hasBashMatching(recent.toolCalls, BUILD_PATTERN)) missingEvidence.add('build');
  if (!hasBashMatching(recent.toolCalls, TEST_PATTERN)) missingEvidence.add('tests');
  if (!hasBashMatching(recent.toolCalls, GIT_STATUS_PATTERN)) missingEvidence.add('git-status');

  // Per-criterion scan.
  for (const criterion of criteria) {
    const verified = isCriterionVerified(criterion, recent);
    if (!verified) unverifiedCriteria.push(criterion);

    // Read-back gate: if the criterion references a specific file
    // path, and the agent wrote/edited that file in recent activity,
    // they should have Read it back afterward to verify contents.
    for (const path of extractFilePathsFromCriterion(criterion)) {
      if (
        hasFileOperation(recent, path, ['Write', 'Edit', 'MultiEdit']) &&
        !hasFileOperation(recent, path, ['Read'])
      ) {
        filesNeedingReadback.add(path);
      }
    }
  }

  return {
    unverifiedCriteria,
    filesNeedingReadback: [...filesNeedingReadback],
    missingEvidence: [...missingEvidence],
  };
}

// ─── Heuristics ─────────────────────────────────────────────────────

const BUILD_PATTERN = /\b(pnpm\s+build|npm\s+run\s+build|yarn\s+build|tsc\b|turbo\s+build)\b/i;
const TEST_PATTERN = /\b(pnpm\s+test|npm\s+test|yarn\s+test|vitest|jest\b)\b/i;
const GIT_STATUS_PATTERN = /\bgit\s+status\b/i;
const TYPE_CHECK_PATTERN = /\b(type-check|typecheck|tsc\s+--noEmit)\b/i;

/**
 * Does the criterion look satisfied by recent activity? Walks the
 * criterion looking for topical keywords and checks whether the
 * matching evidence exists in tool calls / touched files.
 *
 * Intentionally permissive: we want to avoid false-block (criterion
 * unverified when agent did the work) more than false-approve. A
 * false-approve is caught downstream (Warden review, founder gate);
 * a false-block traps the agent in a loop, which is worse UX.
 */
function isCriterionVerified(criterion: string, recent: RecentActivity): boolean {
  const lower = criterion.toLowerCase();

  // Keyword route: each keyword maps to a set of evidence checks.
  // First match wins; criterion is verified iff evidence for that
  // category exists.
  if (/\b(build|compiles?|compilation)\b/.test(lower)) {
    return hasBashMatching(recent.toolCalls, BUILD_PATTERN);
  }
  if (/\btests?\b|\btesting\b/.test(lower)) {
    return hasBashMatching(recent.toolCalls, TEST_PATTERN);
  }
  if (/\btype[- ]?check|\btypes?\b/.test(lower)) {
    return hasBashMatching(recent.toolCalls, TYPE_CHECK_PATTERN);
  }

  // File-path route: if criterion names a file, verified when that
  // file was touched (Read counts — understanding the file IS work).
  const filePaths = extractFilePathsFromCriterion(criterion);
  if (filePaths.length > 0) {
    return filePaths.every((p) =>
      hasFileOperation(recent, p, ['Read', 'Write', 'Edit', 'MultiEdit']),
    );
  }

  // Heuristic-miss: no keyword hit, no file path. V1 trusts the
  // agent (permissive default) — false-approve is cheaper than
  // false-block. V2 can extend with LLM-based criterion understanding
  // for prose criteria like "design is user-friendly."
  return true;
}

/**
 * Extract any "looks like a file path" tokens from a criterion string.
 * Catches `src/foo.ts`, `packages/shared/bar.ts`, `README.md`. Ignores
 * bare extensions like `.ts` (too broad — would match "uses .ts files")
 * and purely-directory paths like `src/`.
 */
function extractFilePathsFromCriterion(criterion: string): string[] {
  // Match non-whitespace tokens containing at least one slash AND
  // ending with a file extension. Rough but effective.
  const matches = criterion.match(/[\w./\\-]+\.[a-z]{1,6}\b/gi) ?? [];
  return matches.filter((m) => m.includes('/') || m.includes('\\'));
}

function hasBashMatching(toolCalls: ToolCall[], pattern: RegExp): boolean {
  for (const call of toolCalls) {
    if (call.name !== 'Bash') continue;
    const cmd = call.input?.command;
    if (typeof cmd === 'string' && pattern.test(cmd)) return true;
  }
  return false;
}

function hasFileOperation(
  recent: RecentActivity,
  path: string,
  allowedTools: Array<'Read' | 'Write' | 'Edit' | 'MultiEdit' | 'NotebookEdit'>,
): boolean {
  // Normalize path separators for cross-platform matching — a criterion
  // written in forward-slash convention still matches a Windows backslash
  // tool call.
  const wanted = path.replace(/\\/g, '/').toLowerCase();
  const allowed = new Set(allowedTools);
  for (const file of recent.touchedFiles) {
    const filePath = file.path.replace(/\\/g, '/').toLowerCase();
    if (!filePath.endsWith(wanted)) continue;
    for (const tool of file.via) {
      if (allowed.has(tool)) return true;
    }
  }
  return false;
}
