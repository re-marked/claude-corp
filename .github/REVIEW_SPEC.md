# PR Review Spec

This repository expects every pull request to be reviewed by the GitHub App reviewer before merge.

## Review Output Contract

The reviewer should produce:

- A short summary of what changed.
- Findings ordered by severity.
- Inline comments for any finding that can be pinned to a concrete file and line.
- A closing verdict:
  - `approve` when there are no findings.
  - `request_changes` when there is at least one blocking finding.
  - `comment` when the review is informative only.

## Inline Comment Rules

- Use inline comments only when the issue is tied to a specific line or small contiguous range.
- Put broad architecture concerns, missing tests, or cross-file risks in the review summary.
- Do not invent line numbers.
- Do not leave vague comments like "consider improving this" without a concrete action.

## Finding Format

Each finding should include:

- severity: `critical`, `important`, or `minor`
- file path
- line number or range
- explanation of the bug, risk, or regression
- concrete fix guidance

Example:

```text
important: packages/daemon/src/router.ts:142
The new dispatch path bypasses deduplication, so repeated FS events can enqueue duplicate work.
Fix: route this path through post() or reuse the existing dedup guard.
```

## Reviewer Priorities

1. Behavioral regressions
2. Broken tests or missing tests for changed behavior
3. Cross-package contract violations
4. Security, data integrity, and state consistency
5. Style only when it hides a real problem

## Merge Gate

Branch protection should require:

- the `codex-review` check from the GitHub App
- CI

Do not merge if the review check is missing, pending, or failed.
