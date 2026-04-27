import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  // failure-taxonomy
  failure,
  ok,
  err,
  hasErrnoCode,
  categorizeErrno,
  // conflict-classifier
  parseConflictMarkers,
  classifyBlock,
  classifyFile,
  applyResolutions,
  isCommentLine,
  suggestResolution,
  // git-ops parsers
  parseShortstat,
  parseWorktreeListPorcelain,
  // worktree-pool
  WorktreePool,
  // rebase-flow
  attemptRebase,
  SANITY_FILE_MULTIPLIER,
  SANITY_FLOOR_FILE_COUNT,
  // merge-flow
  attemptMerge,
  // tests-runner
  runTests,
  // test-attribution
  compareRuns,
  attributeFailure,
  attributionSummary,
  flakeComparisonSummary,
  runWithFlakeRetry,
  // editor-diff
  shouldFilterFile,
  validateCommentPosition,
  parseNumstatOutput,
  parseNameStatusOutput,
  // types
  type GitOps,
  type RebaseOutcome,
  type PushOutcome,
  type DiffStats,
  type WorktreeEntry,
  type TestRunResult,
  type TestFailureSummary,
  type ReviewableDiff,
  type FailureRecord,
  type Result,
} from '../packages/daemon/src/clearinghouse/index.js';

/**
 * Coverage for the Project 1.12 Clearinghouse code primitives.
 * Pure helpers tested directly; orchestrators tested via a mocked
 * GitOps that returns scripted Results.
 */

describe('clearinghouse primitives', () => {
  // ─── failure-taxonomy ──────────────────────────────────────────

  describe('failure-taxonomy', () => {
    it('failure() fills retryable + route from category defaults', () => {
      const f = failure('test-flake', 'pedagogical', 'raw');
      expect(f.category).toBe('test-flake');
      expect(f.retryable).toBe(true);
      expect(f.route).toBe('author');
      expect(f.retryDelayMs).toBeGreaterThan(0);
    });

    it('failure() honors explicit overrides', () => {
      const f = failure('disk-full', 'p', 'r', { retryable: true, route: 'engineering-lead' });
      expect(f.retryable).toBe(true);
      expect(f.route).toBe('engineering-lead');
    });

    it('hasErrnoCode true on matching code', () => {
      const e = Object.assign(new Error('x'), { code: 'ENOSPC' });
      expect(hasErrnoCode(e, 'ENOSPC')).toBe(true);
      expect(hasErrnoCode(e, 'ENOENT')).toBe(false);
      expect(hasErrnoCode(null, 'X')).toBe(false);
      expect(hasErrnoCode('not an object', 'X')).toBe(false);
    });

    it('categorizeErrno maps known codes', () => {
      expect(categorizeErrno('ENOSPC')).toBe('disk-full');
      expect(categorizeErrno('ENOENT')).toBe('tool-missing');
      expect(categorizeErrno('ETIMEDOUT')).toBe('network-timeout');
      expect(categorizeErrno('ECONNREFUSED')).toBe('network-timeout');
      expect(categorizeErrno('ESOMETHINGWEIRD')).toBeUndefined();
      expect(categorizeErrno(undefined)).toBeUndefined();
    });

    it('ok / err produce discriminated Results', () => {
      const okR = ok('value');
      expect(okR.ok).toBe(true);
      if (okR.ok) expect(okR.value).toBe('value');

      const errR = err<string>(failure('unknown', 'p', 'r'));
      expect(errR.ok).toBe(false);
      if (!errR.ok) expect(errR.failure.category).toBe('unknown');
    });
  });

  // ─── conflict-classifier ───────────────────────────────────────

  describe('conflict-classifier', () => {
    it('parseConflictMarkers extracts standard 3-way blocks', () => {
      const text = `unchanged before
<<<<<<< HEAD
ours line 1
ours line 2
=======
theirs line 1
>>>>>>> their-branch
unchanged after`;
      const blocks = parseConflictMarkers(text);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.current).toEqual(['ours line 1', 'ours line 2']);
      expect(blocks[0]!.incoming).toEqual(['theirs line 1']);
      expect(blocks[0]!.base).toEqual([]);
    });

    it('parseConflictMarkers extracts diff3 blocks with base section', () => {
      const text = `<<<<<<< HEAD
ours
||||||| base
common ancestor
=======
theirs
>>>>>>> b`;
      const blocks = parseConflictMarkers(text);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.current).toEqual(['ours']);
      expect(blocks[0]!.base).toEqual(['common ancestor']);
      expect(blocks[0]!.incoming).toEqual(['theirs']);
    });

    it('parseConflictMarkers handles multiple blocks in one file', () => {
      const text = `<<<<<<< HEAD
a
=======
A
>>>>>>> b
filler
<<<<<<< HEAD
b
=======
B
>>>>>>> b`;
      expect(parseConflictMarkers(text)).toHaveLength(2);
    });

    it('parseConflictMarkers tolerates malformed (open without close)', () => {
      const text = `<<<<<<< HEAD
just opens, never closes`;
      // Tolerated: no completed block emitted, no throw.
      expect(parseConflictMarkers(text)).toHaveLength(0);
    });

    it('classifyBlock identifies identical content', () => {
      const block = {
        startLine: 1,
        endLine: 4,
        current: ['same'],
        incoming: ['same'],
        base: [],
      };
      expect(classifyBlock(block, 'foo.ts')).toBe('identical-content');
    });

    it('classifyBlock identifies whitespace-only differences', () => {
      const block = {
        startLine: 1,
        endLine: 4,
        current: ['  hello  world  '],
        incoming: ['hello world'],
        base: [],
      };
      expect(classifyBlock(block, 'foo.ts')).toBe('whitespace-only');
    });

    it('classifyBlock identifies comment-only differences in TS', () => {
      const block = {
        startLine: 1,
        endLine: 5,
        current: ['// comment v1', 'const x = 1;'],
        incoming: ['// comment v2', 'const x = 1;'],
        base: [],
      };
      expect(classifyBlock(block, 'foo.ts')).toBe('comment-only');
    });

    it('classifyBlock identifies substantive differences', () => {
      const block = {
        startLine: 1,
        endLine: 4,
        current: ['const x = 1;'],
        incoming: ['const x = 2;'],
        base: [],
      };
      expect(classifyBlock(block, 'foo.ts')).toBe('substantive');
    });

    it('classifyBlock treats empty side as substantive (add/delete)', () => {
      const block = {
        startLine: 1,
        endLine: 4,
        current: [],
        incoming: ['new line'],
        base: [],
      };
      expect(classifyBlock(block, 'foo.ts')).toBe('substantive');
    });

    it('isCommentLine respects file extension', () => {
      expect(isCommentLine('// hi', 'a.ts')).toBe(true);
      expect(isCommentLine('# hi', 'a.py')).toBe(true);
      expect(isCommentLine('// hi', 'a.py')).toBe(false); // wrong syntax for python
      expect(isCommentLine('   ', 'a.ts')).toBe(false); // whitespace not comment
    });

    it('classifyFile aggregates triviality + sets fullyTrivial', () => {
      // Standalone comment-line difference (the supported case).
      // Inline comments-on-code aren't filtered — that requires
      // AST-aware parsing, which is out of v1 scope.
      const text = `<<<<<<< HEAD
// v1 docstring
const x = 1;
=======
// v2 docstring
const x = 1;
>>>>>>> b`;
      const classified = classifyFile(text, 'foo.ts');
      expect(classified.blocks).toHaveLength(1);
      expect(classified.blocks[0]!.triviality).toBe('comment-only');
      expect(classified.fullyTrivial).toBe(true);
      expect(classified.worstTriviality).toBe('comment-only');
    });

    it('classifyFile fullyTrivial=false on substantive block', () => {
      const text = `<<<<<<< HEAD
foo
=======
bar
>>>>>>> b`;
      const classified = classifyFile(text, 'foo.ts');
      expect(classified.fullyTrivial).toBe(false);
      expect(classified.worstTriviality).toBe('substantive');
    });

    it('suggestResolution returns incoming for trivial cases', () => {
      const block = {
        startLine: 1,
        endLine: 4,
        current: ['  x  '],
        incoming: ['x'],
        base: [],
        triviality: 'whitespace-only' as const,
      };
      expect(suggestResolution(block)).toEqual(['x']);
    });

    it('suggestResolution returns null for substantive', () => {
      const block = {
        startLine: 1,
        endLine: 4,
        current: ['a'],
        incoming: ['b'],
        base: [],
        triviality: 'substantive' as const,
      };
      expect(suggestResolution(block)).toBeNull();
    });

    it('applyResolutions splices trivial resolutions in-place', () => {
      const text = `before
<<<<<<< HEAD
  x
=======
x
>>>>>>> b
after`;
      const classified = classifyFile(text, 'foo.ts');
      expect(classified.fullyTrivial).toBe(true);
      const resolved = applyResolutions(text, classified);
      expect(resolved).toBe('before\nx\nafter');
    });

    it('applyResolutions throws when block lacks resolution', () => {
      const text = `<<<<<<< HEAD
a
=======
b
>>>>>>> br`;
      const classified = classifyFile(text, 'foo.ts');
      expect(() => applyResolutions(text, classified)).toThrow(/no resolution/);
    });
  });

  // ─── git-ops parsers ───────────────────────────────────────────

  describe('git-ops parsers', () => {
    it('parseShortstat extracts file/insertions/deletions', () => {
      const r = parseShortstat(' 3 files changed, 42 insertions(+), 7 deletions(-)');
      expect(r).toEqual({ filesChanged: 3, insertions: 42, deletions: 7 });
    });

    it('parseShortstat handles missing insertions/deletions sides', () => {
      const r1 = parseShortstat(' 1 file changed, 5 insertions(+)');
      expect(r1).toEqual({ filesChanged: 1, insertions: 5, deletions: 0 });
      const r2 = parseShortstat(' 1 file changed, 5 deletions(-)');
      expect(r2).toEqual({ filesChanged: 1, insertions: 0, deletions: 5 });
    });

    it('parseShortstat returns zeros on empty input', () => {
      expect(parseShortstat('')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
    });

    it('parseWorktreeListPorcelain extracts entries with branch + bare', () => {
      const text = `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo/wt-0
HEAD def456
branch refs/heads/feature

worktree /repo/wt-bare
HEAD 0000
bare`;
      const entries = parseWorktreeListPorcelain(text);
      expect(entries).toHaveLength(3);
      expect(entries[0]!).toEqual({ path: '/repo', head: 'abc123', branch: 'refs/heads/main', bare: false });
      expect(entries[1]!.branch).toBe('refs/heads/feature');
      expect(entries[2]!.bare).toBe(true);
    });
  });

  // ─── editor-diff ───────────────────────────────────────────────

  describe('editor-diff', () => {
    it('shouldFilterFile catches lockfiles', () => {
      expect(shouldFilterFile('pnpm-lock.yaml').filtered).toBe(true);
      expect(shouldFilterFile('package-lock.json').filtered).toBe(true);
      expect(shouldFilterFile('Cargo.lock').filtered).toBe(true);
    });

    it('shouldFilterFile catches generated dirs', () => {
      expect(shouldFilterFile('packages/foo/dist/index.js').filtered).toBe(true);
      expect(shouldFilterFile('node_modules/x/y.js').filtered).toBe(true);
    });

    it('shouldFilterFile catches binaries by extension', () => {
      expect(shouldFilterFile('logo.png').filtered).toBe(true);
      expect(shouldFilterFile('bundle.min.js').filtered).toBe(true);
    });

    it('shouldFilterFile passes source code through', () => {
      expect(shouldFilterFile('packages/shared/src/foo.ts').filtered).toBe(false);
      expect(shouldFilterFile('tests/foo.test.ts').filtered).toBe(false);
    });

    it('parseNumstatOutput handles standard rows', () => {
      const text = `12\t3\tfile/a.ts\n0\t5\tfile/b.ts\n-\t-\timg.png`;
      const rows = parseNumstatOutput(text);
      expect(rows).toHaveLength(3);
      expect(rows[0]!).toEqual({ additions: 12, deletions: 3, path: 'file/a.ts' });
      expect(rows[2]!).toEqual({ additions: 0, deletions: 0, path: 'img.png' }); // binary
    });

    it('parseNameStatusOutput handles renames and adds', () => {
      const text = `A\tnew.ts\nM\tchanged.ts\nR100\told.ts\trenamed.ts`;
      const entries = parseNameStatusOutput(text);
      expect(entries).toHaveLength(3);
      expect(entries[0]!.status).toBe('added');
      expect(entries[1]!.status).toBe('modified');
      expect(entries[2]!.status).toBe('renamed');
      expect(entries[2]!.oldPath).toBe('old.ts');
      expect(entries[2]!.path).toBe('renamed.ts');
    });

    it('validateCommentPosition catches inverted ranges', () => {
      const diff: ReviewableDiff = {
        files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
        filteredFiles: [],
        totalAdditions: 1,
        totalDeletions: 0,
        oversized: false,
      };
      const result = validateCommentPosition({
        filePath: 'a.ts',
        lineStart: 10,
        lineEnd: 5,
        diff,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toMatch(/lineEnd.*lineStart/);
    });

    it('validateCommentPosition catches filtered files', () => {
      const diff: ReviewableDiff = {
        files: [],
        filteredFiles: [{ path: 'pnpm-lock.yaml', reason: 'lockfile (machine-generated)' }],
        totalAdditions: 0,
        totalDeletions: 0,
        oversized: false,
      };
      const result = validateCommentPosition({
        filePath: 'pnpm-lock.yaml',
        lineStart: 1,
        lineEnd: 1,
        diff,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toMatch(/filtered/);
    });

    it('validateCommentPosition catches files not in diff', () => {
      const diff: ReviewableDiff = {
        files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
        filteredFiles: [],
        totalAdditions: 1,
        totalDeletions: 0,
        oversized: false,
      };
      const result = validateCommentPosition({
        filePath: 'b.ts',
        lineStart: 1,
        lineEnd: 1,
        diff,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toMatch(/not in the reviewable/);
    });

    it('validateCommentPosition accepts good positions', () => {
      const diff: ReviewableDiff = {
        files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
        filteredFiles: [],
        totalAdditions: 1,
        totalDeletions: 0,
        oversized: false,
      };
      expect(validateCommentPosition({ filePath: 'a.ts', lineStart: 5, lineEnd: 5, diff }).valid).toBe(true);
    });
  });

  // ─── test-attribution (pure) ───────────────────────────────────

  describe('test-attribution pure helpers', () => {
    function passing(failures: TestFailureSummary[] = []): TestRunResult {
      return {
        outcome: 'passed',
        durationMs: 100,
        stdout: '',
        stderr: '',
        exitCode: 0,
        truncated: false,
        failures,
      };
    }
    function failing(failures: TestFailureSummary[]): TestRunResult {
      return {
        outcome: 'failed',
        durationMs: 100,
        stdout: '',
        stderr: '',
        exitCode: 1,
        truncated: false,
        failures,
      };
    }

    it('compareRuns detects flake (one passes, one fails)', () => {
      const c = compareRuns(failing([{ name: 't1', summary: 'x' }]), passing());
      expect(c.kind).toBe('flake');
    });

    it('compareRuns detects consistent-fail with shared failures', () => {
      const c = compareRuns(
        failing([{ name: 't1', summary: 'x' }]),
        failing([{ name: 't1', summary: 'x' }, { name: 't2', summary: 'y' }]),
      );
      expect(c.kind).toBe('consistent-fail');
      if (c.kind === 'consistent-fail') {
        expect(c.commonFailures).toHaveLength(1);
        expect(c.commonFailures[0]!.name).toBe('t1');
      }
    });

    it('compareRuns flags inconclusive on timeout/crash', () => {
      const timeout: TestRunResult = { ...failing([]), outcome: 'timeout' };
      expect(compareRuns(timeout, passing()).kind).toBe('inconclusive');
    });

    it('attributeFailure pr-introduced when main passes', () => {
      const pr = failing([{ name: 't1', summary: 'pr-only' }]);
      const main = passing();
      const a = attributeFailure(pr, main);
      expect(a.kind).toBe('pr-introduced');
    });

    it('attributeFailure main-regression when both fail with shared names', () => {
      const pr = failing([{ name: 't1', summary: 'shared' }]);
      const main = failing([{ name: 't1', summary: 'shared' }]);
      const a = attributeFailure(pr, main);
      expect(a.kind).toBe('main-regression');
    });

    it('attributeFailure mixed when some shared + some pr-only', () => {
      const pr = failing([
        { name: 'shared', summary: 'x' },
        { name: 'pr-new', summary: 'y' },
      ]);
      const main = failing([{ name: 'shared', summary: 'x' }]);
      const a = attributeFailure(pr, main);
      expect(a.kind).toBe('mixed');
      if (a.kind === 'mixed') {
        expect(a.prOnly).toHaveLength(1);
        expect(a.sharedWithMain).toHaveLength(1);
      }
    });

    it('attributeFailure no-failure on PR pass', () => {
      const a = attributeFailure(passing(), failing([{ name: 't', summary: 'x' }]));
      expect(a.kind).toBe('no-failure');
    });

    it('attributeFailure inconclusive on asymmetric parsed-failure data', () => {
      const pr = failing([{ name: 't', summary: 'x' }]);
      const main = failing([]); // unparsed
      const a = attributeFailure(pr, main);
      expect(a.kind).toBe('inconclusive');
    });

    it('attributionSummary mentions key facts for each kind', () => {
      expect(attributionSummary({ kind: 'no-failure' })).toMatch(/passed/i);
      expect(
        attributionSummary({ kind: 'pr-introduced', prFailures: [{ name: 'x', summary: '' }] }),
      ).toMatch(/PR introduced/);
      expect(
        attributionSummary({ kind: 'main-regression', sharedFailures: [] }),
      ).toMatch(/main is broken/);
    });

    it('flakeComparisonSummary describes each shape', () => {
      expect(flakeComparisonSummary({ kind: 'both-passed' })).toMatch(/no flake/i);
      expect(flakeComparisonSummary({ kind: 'flake', passingRun: 'second' })).toMatch(/Flake/);
    });
  });

  // ─── runWithFlakeRetry (uses real runTests with mock command) ──

  describe('runWithFlakeRetry', () => {
    it('returns passed-first when initial run passes', async () => {
      const result = await runWithFlakeRetry({
        runOpts: {
          cwd: process.cwd(),
          program: 'node',
          args: ['-e', 'process.exit(0)'],
          timeoutMs: 30_000,
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.classifiedAs).toBe('passed-first');
    }, 60_000);

    it('detects consistent-fail when both runs fail the same way', async () => {
      const result = await runWithFlakeRetry({
        runOpts: {
          cwd: process.cwd(),
          program: 'node',
          args: ['-e', 'process.exit(1)'],
          timeoutMs: 30_000,
        },
        maxRetries: 1,
        retryDelayMs: 0,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.classifiedAs).toBe('consistent-fail');
    }, 60_000);
  });

  // ─── Mock GitOps for orchestrator tests ────────────────────────

  function buildMockGitOps(scripts: Partial<GitOps>): GitOps {
    const noop = async () => ok<void>(undefined);
    return {
      fetchOrigin: scripts.fetchOrigin ?? noop,
      worktreeAdd: scripts.worktreeAdd ?? noop,
      worktreeRemove: scripts.worktreeRemove ?? noop,
      worktreeList: scripts.worktreeList ?? (async () => ok([])),
      rebase: scripts.rebase ?? (async () => ok({ state: 'clean' as const })),
      rebaseAbort: scripts.rebaseAbort ?? noop,
      rebaseContinue: scripts.rebaseContinue ?? (async () => ok({ state: 'clean' as const })),
      stageAll: scripts.stageAll ?? noop,
      push: scripts.push ?? (async () => ok({ state: 'pushed' as const })),
      currentSha: scripts.currentSha ?? (async () => ok('a'.repeat(40))),
      diffStats: scripts.diffStats ?? (async () => ok({ filesChanged: 0, insertions: 0, deletions: 0 })),
      listConflictedFiles: scripts.listConflictedFiles ?? (async () => ok([])),
      branchExists: scripts.branchExists ?? (async () => ok(true)),
      isClean: scripts.isClean ?? (async () => ok(true)),
    };
  }

  // ─── attemptMerge (orchestrator) ───────────────────────────────

  describe('attemptMerge', () => {
    it('merged on clean push; mergeCommitSha set', async () => {
      const gitOps = buildMockGitOps({});
      const result = await attemptMerge({ worktreePath: '/wt', prBranch: 'feat/x', gitOps });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcome).toBe('merged');
        expect(result.value.mergeCommitSha).toMatch(/^[a-f0-9]{40}$/);
      }
    });

    it('race when push reports rejected-race', async () => {
      const gitOps = buildMockGitOps({
        push: async () => ok({ state: 'rejected-race' }),
      });
      const result = await attemptMerge({ worktreePath: '/wt', prBranch: 'feat/x', gitOps });
      if (result.ok) expect(result.value.outcome).toBe('race');
    });

    it('hook-rejected captures hookOutput', async () => {
      const gitOps = buildMockGitOps({
        push: async () => ok({ state: 'rejected-hook', hookOutput: 'pre-receive said no' }),
      });
      const result = await attemptMerge({ worktreePath: '/wt', prBranch: 'feat/x', gitOps });
      if (result.ok) {
        expect(result.value.outcome).toBe('hook-rejected');
        expect(result.value.hookOutput).toMatch(/pre-receive said no/);
      }
    });

    it('branch-deleted when push categorizes as such', async () => {
      const gitOps = buildMockGitOps({
        push: async () => err(failure('branch-deleted', 'branch gone', 'detail')),
      });
      const result = await attemptMerge({ worktreePath: '/wt', prBranch: 'feat/x', gitOps });
      if (result.ok) expect(result.value.outcome).toBe('branch-deleted');
    });
  });

  // ─── attemptRebase (orchestrator) ──────────────────────────────

  describe('attemptRebase', () => {
    it('clean outcome when rebase is clean', async () => {
      const gitOps = buildMockGitOps({
        diffStats: async () => ok({ filesChanged: 5, insertions: 10, deletions: 2 }),
      });
      const result = await attemptRebase({
        worktreePath: '/wt',
        baseBranch: 'main',
        prBranch: 'feat/x',
        gitOps,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcome).toBe('clean');
        expect(result.value.preStats?.filesChanged).toBe(5);
      }
    });

    it('needs-author when conflict has substantive blocks', async () => {
      // Set up a temp worktree with one conflicted file containing
      // a substantive marker block.
      const tempWt = mkdtempSync(join(tmpdir(), 'rebase-flow-'));
      try {
        writeFileSync(
          join(tempWt, 'a.ts'),
          `<<<<<<< HEAD
const x = 1;
=======
const x = 2;
>>>>>>> b`,
          'utf-8',
        );

        let firstRun = true;
        const gitOps = buildMockGitOps({
          rebase: async () => {
            if (firstRun) {
              firstRun = false;
              return ok({ state: 'conflict' as const, conflictedFiles: ['a.ts'] });
            }
            return ok({ state: 'clean' as const });
          },
          listConflictedFiles: async () => ok(['a.ts']),
          diffStats: async () => ok({ filesChanged: 1, insertions: 1, deletions: 1 }),
        });
        const result = await attemptRebase({
          worktreePath: tempWt,
          baseBranch: 'main',
          prBranch: 'feat/x',
          gitOps,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.outcome).toBe('needs-author');
          expect(result.value.conflictedFiles).toContain('a.ts');
        }
      } finally {
        try { rmSync(tempWt, { recursive: true, force: true }); } catch { /* */ }
      }
    });

    it('auto-resolved when conflict is fully trivial', async () => {
      const tempWt = mkdtempSync(join(tmpdir(), 'rebase-trivial-'));
      try {
        writeFileSync(
          join(tempWt, 'a.ts'),
          `<<<<<<< HEAD
  spaced
=======
spaced
>>>>>>> b`,
          'utf-8',
        );

        let rebaseCallCount = 0;
        const gitOps = buildMockGitOps({
          rebase: async () => {
            rebaseCallCount++;
            return ok({ state: 'conflict' as const, conflictedFiles: ['a.ts'] });
          },
          rebaseContinue: async () => ok({ state: 'clean' as const }),
          listConflictedFiles: async () => ok(['a.ts']),
          diffStats: async () => ok({ filesChanged: 1, insertions: 1, deletions: 1 }),
        });
        const result = await attemptRebase({
          worktreePath: tempWt,
          baseBranch: 'main',
          prBranch: 'feat/x',
          gitOps,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.outcome).toBe('auto-resolved');
          expect(result.value.autoResolvedFiles).toContain('a.ts');
        }
      } finally {
        try { rmSync(tempWt, { recursive: true, force: true }); } catch { /* */ }
      }
    });

    it('sanity-failed when post-rebase blows up file count', async () => {
      // Pre stats: 2 files. Post stats: 50 files. Ceiling = max(2*5, 20) = 20. 50 > 20 → sanity-failed.
      let callCount = 0;
      const gitOps = buildMockGitOps({
        diffStats: async () => {
          callCount++;
          // first call is pre-stats (HEAD vs base before rebase),
          // second is post-stats (HEAD vs base after rebase landed).
          if (callCount === 1) return ok({ filesChanged: 2, insertions: 5, deletions: 1 });
          return ok({ filesChanged: 50, insertions: 500, deletions: 50 });
        },
      });
      const result = await attemptRebase({
        worktreePath: '/wt',
        baseBranch: 'main',
        prBranch: 'feat/x',
        gitOps,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcome).toBe('sanity-failed');
        expect(result.value.failureRecord?.category).toBe('rebase-sanity-check-failed');
      }
    });
  });

  // ─── WorktreePool (with mock GitOps) ───────────────────────────

  describe('WorktreePool', () => {
    let corpRoot: string;
    beforeEach(() => {
      corpRoot = mkdtempSync(join(tmpdir(), 'wtpool-'));
    });
    afterEach(() => {
      try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* */ }
    });

    it('acquire creates a new worktree via gitOps.worktreeAdd', async () => {
      const calls: string[] = [];
      const gitOps = buildMockGitOps({
        worktreeAdd: async (branch, path) => {
          calls.push(`add ${branch} ${path}`);
          return ok(undefined);
        },
      });
      const pool = new WorktreePool({ corpRoot, gitOps });
      const result = await pool.acquire({ branch: 'feat/x', holder: 'pressman-aa' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.holder).toBe('pressman-aa');
        expect(result.value.branch).toBe('feat/x');
        expect(result.value.path).toContain('wt-0');
      }
      expect(calls.length).toBe(1);
    });

    it('release returns slot to pool; subsequent acquire reuses', async () => {
      const calls: string[] = [];
      const gitOps = buildMockGitOps({
        worktreeAdd: async (b, p) => {
          calls.push(`add ${b}`);
          return ok(undefined);
        },
        worktreeRemove: async (p) => {
          calls.push(`remove ${p}`);
          return ok(undefined);
        },
      });
      const pool = new WorktreePool({ corpRoot, gitOps });
      const acq1 = await pool.acquire({ branch: 'feat/x', holder: 'pressman-aa' });
      expect(acq1.ok).toBe(true);
      if (!acq1.ok) return;
      await pool.release(acq1.value);

      // Re-acquire SAME branch — should not create a new worktree.
      const acq2 = await pool.acquire({ branch: 'feat/x', holder: 'pressman-bb' });
      expect(acq2.ok).toBe(true);
      if (acq2.ok) {
        expect(acq2.value.path).toBe(acq1.value.path); // Same wt.
      }
      // worktreeAdd was called once; not twice.
      expect(calls.filter((c) => c.startsWith('add')).length).toBe(1);
    });

    it('pool full returns retryable failure when cap reached + all held', async () => {
      const gitOps = buildMockGitOps({});
      const pool = new WorktreePool({ corpRoot, gitOps, cap: 1 });
      const acq1 = await pool.acquire({ branch: 'feat/x', holder: 'p-aa' });
      expect(acq1.ok).toBe(true);
      const acq2 = await pool.acquire({ branch: 'feat/y', holder: 'p-bb' });
      expect(acq2.ok).toBe(false);
      if (!acq2.ok) {
        expect(acq2.failure.retryable).toBe(true);
        expect(acq2.failure.route).toBe('founder');
      }
    });

    it('release with mismatched holder rejects', async () => {
      const gitOps = buildMockGitOps({});
      const pool = new WorktreePool({ corpRoot, gitOps });
      const acq = await pool.acquire({ branch: 'feat/x', holder: 'p-aa' });
      if (!acq.ok) return;
      const wrongHandle = { ...acq.value, holder: 'p-bb' };
      const release = await pool.release(wrongHandle);
      expect(release.ok).toBe(false);
    });

    it('drain force-removes all entries', async () => {
      const calls: string[] = [];
      const gitOps = buildMockGitOps({
        worktreeRemove: async (p) => {
          calls.push(`remove ${p}`);
          return ok(undefined);
        },
      });
      const pool = new WorktreePool({ corpRoot, gitOps });
      await pool.acquire({ branch: 'feat/a', holder: 'p-aa' });
      await pool.acquire({ branch: 'feat/b', holder: 'p-bb' });
      const drain = await pool.drain();
      expect(drain.ok).toBe(true);
      if (drain.ok) {
        expect(drain.value.removed).toBe(2);
      }
    });

    it('cleanupOrphanWorktrees removes wt-* dirs not in pool', async () => {
      // Plant an orphan dir.
      const parent = join(corpRoot, '.clearinghouse');
      mkdirSync(join(parent, 'wt-99'), { recursive: true });
      writeFileSync(join(parent, '.gitignore'), 'x', 'utf-8');

      const removed: string[] = [];
      const gitOps = buildMockGitOps({
        worktreeRemove: async (p) => {
          removed.push(p);
          return ok(undefined);
        },
      });
      const pool = new WorktreePool({ corpRoot, gitOps });
      const result = await pool.cleanupOrphanWorktrees();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.removed).toBe(1);
      expect(removed[0]!).toContain('wt-99');
    });
  });

  // ─── runTests (real subprocess) ────────────────────────────────

  describe('runTests', () => {
    it('reports passed for exit-0 commands', async () => {
      const result = await runTests({
        cwd: process.cwd(),
        program: 'node',
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 30_000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcome).toBe('passed');
        expect(result.value.exitCode).toBe(0);
      }
    }, 60_000);

    it('reports failed for non-zero exit', async () => {
      const result = await runTests({
        cwd: process.cwd(),
        program: 'node',
        args: ['-e', 'process.exit(7)'],
        timeoutMs: 30_000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.outcome).toBe('failed');
        expect(result.value.exitCode).toBe(7);
      }
    }, 60_000);

    it('tool-missing for missing binary', async () => {
      // execa's behavior when shell isn't used: spawn fails synchronously
      // with ENOENT. The wrapped Result should carry tool-missing.
      const result = await runTests({
        cwd: process.cwd(),
        program: 'definitely-not-a-real-binary-xyz123',
        args: [],
        timeoutMs: 5_000,
      });
      // Either ok=false with tool-missing, OR ok=true with crashed
      // (Windows can return non-zero exit instead of throwing for
      // missing binaries). Both are acceptable end states.
      if (result.ok) {
        expect(['failed', 'crashed', 'tool-missing']).toContain(result.value.outcome);
      } else {
        expect(['tool-missing', 'unknown']).toContain(result.failure.category);
      }
    }, 30_000);
  });
});
