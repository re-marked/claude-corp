import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runWalkCheck,
  renderTeachingMessage,
  createChit,
  castFromBlueprint,
  findChitById,
  type Chit,
  type ExpectedOutputSpec,
  type CheckResult,
} from '../packages/shared/src/index.js';

/**
 * Project 2.3 — runWalkCheck composition + teaching-message coverage.
 *
 * Underlying checkers (tag-on-task / chit-of-type / file-exists /
 * branch-exists / commit-on-branch / task-output-nonempty / multi)
 * are already covered in walk.test.ts; these tests focus on the
 * five-state outcome runWalkCheck produces on top, and on the
 * per-kind teaching messages the agent reads in the audit block.
 */

function makeCorp(): { corpRoot: string; cleanup: () => void } {
  const corpRoot = mkdtempSync(join(tmpdir(), 'walk-check-test-'));
  return {
    corpRoot,
    cleanup: () => {
      try { rmSync(corpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

/**
 * Cast a minimal walk fixture: blueprint with one step + one contract +
 * one task tagged into the walk. Returns the task chit so tests can run
 * runWalkCheck against it directly.
 */
async function castSingleStepWalk(
  corpRoot: string,
  expectedOutput: ExpectedOutputSpec | undefined,
): Promise<Chit<'task'>> {
  const blueprint = createChit(corpRoot, {
    type: 'blueprint',
    scope: 'corp',
    status: 'active',
    createdBy: 'test',
    body: '',
    fields: {
      blueprint: {
        name: 'test-walk',
        origin: 'authored',
        vars: [],
        steps: [
          {
            id: 'only-step',
            title: 'Do the thing',
            assigneeRole: 'backend-engineer',
            ...(expectedOutput ? { expectedOutput } : {}),
          },
        ],
      },
    },
  });

  const result = castFromBlueprint(corpRoot, blueprint as Chit<'blueprint'>, {}, {
    scope: 'corp',
    createdBy: 'test',
  });
  return result.tasks[0]! as Chit<'task'>;
}

// ─── 1. Five outcome states ────────────────────────────────────────

describe('runWalkCheck — outcome states', () => {
  it('returns no-walk for an ad-hoc task (no walk tags)', () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const adhoc: Chit<'task'> = {
        id: 'chit-t-adhoc1',
        type: 'task',
        status: 'active',
        createdAt: '2026-05-01T10:00:00.000Z',
        updatedAt: '2026-05-01T10:00:00.000Z',
        createdBy: 'mark',
        tags: [],
        fields: { task: { title: 'random work', priority: 'normal' } },
      } as Chit<'task'>;

      const outcome = runWalkCheck(corpRoot, adhoc, 'mark');
      expect(outcome.status).toBe('no-walk');
    } finally { cleanup(); }
  });

  it('returns no-spec when a walk-tagged task has no expectedOutput on the step', async () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const task = await castSingleStepWalk(corpRoot, undefined);
      const outcome = runWalkCheck(corpRoot, task, 'toast');
      expect(outcome.status).toBe('no-spec');
      if (outcome.status === 'no-spec') {
        expect(outcome.stepId).toBe('only-step');
        expect(outcome.blueprintName).toBe('test-walk');
      }
    } finally { cleanup(); }
  });

  it('returns met when the spec is satisfied (tag-on-task with tag present)', async () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const task = await castSingleStepWalk(corpRoot, {
        kind: 'tag-on-task',
        tag: 'reviewed',
      });
      // Inject the tag onto the persisted task chit so the checker sees it.
      // findChitById gives the on-disk version; we rewrite via the path.
      const hit = findChitById(corpRoot, task.id);
      expect(hit).not.toBeNull();
      // Easier: re-read with the tag added directly. Use a Chit fixture
      // that mutates the in-memory chit (the tag-on-task checker reads
      // `taskChit.tags`, which is what runWalkCheck passes through).
      const tagged = { ...task, tags: [...task.tags, 'reviewed'] } as Chit<'task'>;
      const outcome = runWalkCheck(corpRoot, tagged, 'toast');
      expect(outcome.status).toBe('met');
      if (outcome.status === 'met') {
        expect(outcome.stepId).toBe('only-step');
        expect(outcome.kind).toBe('tag-on-task');
      }
    } finally { cleanup(); }
  });

  it('returns unmet with teaching message when spec is missing (tag absent)', async () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const task = await castSingleStepWalk(corpRoot, {
        kind: 'tag-on-task',
        tag: 'reviewed',
      });
      const outcome = runWalkCheck(corpRoot, task, 'toast');
      expect(outcome.status).toBe('unmet');
      if (outcome.status === 'unmet') {
        expect(outcome.kind).toBe('tag-on-task');
        // Teaching message names the missed tag, the cc-cli verb, and
        // the step id — the agent should be able to act on it without
        // re-reading the blueprint.
        expect(outcome.teachingMessage).toContain('reviewed');
        expect(outcome.teachingMessage).toContain('cc-cli chit tag');
        expect(outcome.teachingMessage).toContain('only-step');
      }
    } finally { cleanup(); }
  });

  it('returns unable-to-check when checker environment is unavailable (file-exists with bad cwd)', async () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const task = await castSingleStepWalk(corpRoot, {
        kind: 'file-exists',
        pathPattern: 'dist/foo.js',
      });
      const outcome = runWalkCheck(corpRoot, task, 'toast', {
        cwd: join(corpRoot, 'definitely-does-not-exist'),
      });
      expect(outcome.status).toBe('unable-to-check');
      if (outcome.status === 'unable-to-check') {
        expect(outcome.kind).toBe('file-exists');
        expect(outcome.reason).toMatch(/does not exist/);
      }
    } finally { cleanup(); }
  });
});

// ─── 2. Teaching messages — per-kind shape spot-checks ──────────────

describe('renderTeachingMessage — per ExpectedOutputKind', () => {
  const baseCtx = {
    stepId: 'implement',
    blueprintName: 'ship-feature',
    taskId: 'chit-t-test',
    slug: 'coder',
    // For non-multi specs the result.evidence is unused by the renderer;
    // a minimal CheckResult with status 'unmet' suffices.
    result: { status: 'unmet' as const },
  };

  it('chit-of-type teaching names the chit type and tags', () => {
    const msg = renderTeachingMessage({
      ...baseCtx,
      spec: {
        kind: 'chit-of-type',
        chitType: 'clearance-submission',
        withTags: ['task:chit-t-test'],
      },
    });
    expect(msg).toContain('clearance-submission');
    expect(msg).toContain('task:chit-t-test');
    expect(msg).toContain('coder');
    expect(msg).toContain('implement');
  });

  it('branch-exists teaching names the branch pattern and the git verb', () => {
    const msg = renderTeachingMessage({
      ...baseCtx,
      spec: { kind: 'branch-exists', branchPattern: 'feat/foo' },
    });
    expect(msg).toContain('feat/foo');
    expect(msg).toContain('git switch -c');
  });

  it('commit-on-branch teaching mentions git commit + sinceClaim default', () => {
    const msg = renderTeachingMessage({
      ...baseCtx,
      spec: { kind: 'commit-on-branch', branchPattern: 'feat/foo' },
    });
    expect(msg).toContain('feat/foo');
    expect(msg).toContain('git commit');
    expect(msg).toContain('since you claimed');
  });

  it('commit-on-branch teaching omits since-clause when sinceClaim:false', () => {
    const msg = renderTeachingMessage({
      ...baseCtx,
      spec: { kind: 'commit-on-branch', branchPattern: 'feat/foo', sinceClaim: false },
    });
    expect(msg).not.toContain('since you claimed');
  });

  it('file-exists teaching names the file path', () => {
    const msg = renderTeachingMessage({
      ...baseCtx,
      spec: { kind: 'file-exists', pathPattern: 'dist/main.js' },
    });
    expect(msg).toContain('dist/main.js');
  });

  it('tag-on-task teaching gives the cc-cli command verbatim', () => {
    const msg = renderTeachingMessage({
      ...baseCtx,
      spec: { kind: 'tag-on-task', tag: 'reviewed' },
    });
    expect(msg).toContain('cc-cli chit tag chit-t-test +reviewed');
  });

  it('task-output-nonempty teaching mentions the field + cc-cli done --output', () => {
    const msg = renderTeachingMessage({
      ...baseCtx,
      spec: { kind: 'task-output-nonempty' },
    });
    expect(msg).toContain('task.output');
    expect(msg).toContain('cc-cli done --output');
  });
});

// ─── 3. Multi-spec composition ──────────────────────────────────────

describe('runWalkCheck — multi composition', () => {
  it('returns met when all sub-checks satisfied', async () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const task = await castSingleStepWalk(corpRoot, {
        kind: 'multi',
        specs: [
          { kind: 'tag-on-task', tag: 'tag-a' },
          { kind: 'tag-on-task', tag: 'tag-b' },
        ],
      });
      const tagged = {
        ...task,
        tags: [...task.tags, 'tag-a', 'tag-b'],
      } as Chit<'task'>;
      const outcome = runWalkCheck(corpRoot, tagged, 'toast');
      expect(outcome.status).toBe('met');
    } finally { cleanup(); }
  });

  it('returns unmet with single sub-spec teaching when one of two fails', async () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const task = await castSingleStepWalk(corpRoot, {
        kind: 'multi',
        specs: [
          { kind: 'tag-on-task', tag: 'tag-a' },
          { kind: 'tag-on-task', tag: 'tag-b' },
        ],
      });
      // Only tag-a present; tag-b is the unmet one.
      const tagged = { ...task, tags: [...task.tags, 'tag-a'] } as Chit<'task'>;
      const outcome = runWalkCheck(corpRoot, tagged, 'toast');
      expect(outcome.status).toBe('unmet');
      if (outcome.status === 'unmet') {
        // Single-sub-failure renders as the inner teaching message,
        // not a numbered list — readable for the common case.
        expect(outcome.teachingMessage).toContain('tag-b');
        expect(outcome.teachingMessage).not.toMatch(/^Walk-aware audit blocked: step `[^`]+`.*requires multiple outputs/);
      }
    } finally { cleanup(); }
  });

  it('renders a numbered list when multiple sub-checks fail', async () => {
    const { corpRoot, cleanup } = makeCorp();
    try {
      const task = await castSingleStepWalk(corpRoot, {
        kind: 'multi',
        specs: [
          { kind: 'tag-on-task', tag: 'tag-a' },
          { kind: 'tag-on-task', tag: 'tag-b' },
          { kind: 'tag-on-task', tag: 'tag-c' },
        ],
      });
      // Only tag-a present; tag-b + tag-c both unmet.
      const tagged = { ...task, tags: [...task.tags, 'tag-a'] } as Chit<'task'>;
      const outcome = runWalkCheck(corpRoot, tagged, 'toast');
      expect(outcome.status).toBe('unmet');
      if (outcome.status === 'unmet') {
        expect(outcome.teachingMessage).toContain('2 of 3 sub-checks failed');
        expect(outcome.teachingMessage).toContain('tag-b');
        expect(outcome.teachingMessage).toContain('tag-c');
        // Numbered list — "  1." and "  2." appear.
        expect(outcome.teachingMessage).toMatch(/  1\./);
        expect(outcome.teachingMessage).toMatch(/  2\./);
      }
    } finally { cleanup(); }
  });
});

// ─── 4. Defensive: shape divergence ────────────────────────────────

describe('renderTeachingMessage — defensive paths', () => {
  it('multi with mismatched evidence falls back to kind enumeration', () => {
    // Hand-construct a multi spec with an evidence shape that diverges
    // from spec.specs (zero subResults despite two specs). Renderer
    // should fall back to the generic enumeration rather than throw.
    const msg = renderTeachingMessage({
      spec: {
        kind: 'multi',
        specs: [
          { kind: 'tag-on-task', tag: 'tag-a' },
          { kind: 'task-output-nonempty' },
        ],
      },
      result: { status: 'unmet', evidence: { subResults: [] } } as CheckResult,
      stepId: 'implement',
      blueprintName: 'ship-feature',
      taskId: 'chit-t-test',
      slug: 'coder',
    });
    expect(msg).toContain('multiple outputs');
    expect(msg).toContain('`tag-on-task`');
    expect(msg).toContain('`task-output-nonempty`');
  });
});
