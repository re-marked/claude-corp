import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWhoamiResult,
  formatHuman,
  validateRenameName,
  renderNamingBody,
  checkRenameEligibility,
} from '../packages/cli/src/commands/whoami.js';
import {
  createChit,
  createCasketIfMissing,
  advanceCurrentStep,
  type Member,
  type TaskFields,
} from '../packages/shared/src/index.js';

/**
 * Coverage for whoami's pure builder + formatter (Project 1.10.2).
 * cmdWhoami itself is a thin I/O wrapper — its non-trivial logic
 * lives in buildWhoamiResult + formatHuman, both pure given a
 * Member + tmpdir corp.
 */

describe('whoami', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'whoami-'));
    writeFileSync(join(corpRoot, 'members.json'), '[]', 'utf-8');
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      // Windows fs-handle races
    }
  });

  function makeMember(overrides: Partial<Member> = {}): Member {
    return {
      id: 'toast',
      displayName: 'Toast',
      rank: 'worker',
      status: 'active',
      type: 'agent',
      scope: 'corp',
      scopeId: '',
      agentDir: 'agents/toast/',
      port: null,
      spawnedBy: null,
      createdAt: '2026-04-25T10:00:00.000Z',
      ...overrides,
    };
  }

  // ─── Partner shape ────────────────────────────────────────────────

  it('Partner with chosen displayName + idle casket', () => {
    const member = makeMember({
      id: 'ceo',
      displayName: 'CEO',
      rank: 'master',
      role: 'ceo',
      kind: 'partner',
    });
    createCasketIfMissing(corpRoot, 'ceo', 'ceo');

    const r = buildWhoamiResult(corpRoot, member);
    expect(r.slug).toBe('ceo');
    expect(r.displayName).toBe('CEO');
    expect(r.displayNameChosen).toBe(true);
    expect(r.kind).toBe('partner');
    expect(r.role).toBe('ceo');
    expect(r.roleDisplayName).toBe('CEO');
    expect(r.generation).toBeNull();
    expect(r.parentSlot).toBeNull();
    expect(r.casket).toEqual({ currentStep: null, title: null });
  });

  it('Partner with active casket resolves task title', () => {
    const member = makeMember({
      id: 'ceo',
      displayName: 'CEO',
      rank: 'master',
      role: 'ceo',
      kind: 'partner',
    });
    createCasketIfMissing(corpRoot, 'ceo', 'ceo');
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'mark',
      status: 'active',
      fields: {
        task: {
          title: 'Implement bacteria reactor',
          priority: 'high',
          assignee: 'ceo',
          workflowStatus: 'in_progress',
        } as TaskFields,
      } as never,
    });
    advanceCurrentStep(corpRoot, 'ceo', task.id, 'ceo');

    const r = buildWhoamiResult(corpRoot, member);
    expect(r.casket?.currentStep).toBe(task.id);
    expect(r.casket?.title).toBe('Implement bacteria reactor');
  });

  // ─── Employee bacteria-spawned shape ──────────────────────────────

  it('Employee with bacteria lineage exposes parent + generation', () => {
    const member = makeMember({
      id: 'backend-engineer-ab',
      displayName: 'backend-engineer-ab', // self-name pending
      role: 'backend-engineer',
      kind: 'employee',
      generation: 3,
      parentSlot: 'backend-engineer-toast',
    });

    const r = buildWhoamiResult(corpRoot, member);
    expect(r.kind).toBe('employee');
    expect(r.displayNameChosen).toBe(false); // displayName === slug
    expect(r.generation).toBe(3);
    expect(r.parentSlot).toBe('backend-engineer-toast');
    expect(r.roleDisplayName).toBe('Backend Engineer');
  });

  it('Employee gen 0 with no parent (first of lineage)', () => {
    const member = makeMember({
      id: 'backend-engineer-bb',
      displayName: 'backend-engineer-bb',
      role: 'backend-engineer',
      kind: 'employee',
      generation: 0,
      parentSlot: null,
    });

    const r = buildWhoamiResult(corpRoot, member);
    expect(r.generation).toBe(0);
    expect(r.parentSlot).toBeNull();
  });

  // ─── User (founder) shape ─────────────────────────────────────────

  it('User shape — no casket, no kind, no lineage', () => {
    const member = makeMember({
      id: 'mark',
      displayName: 'Mark',
      rank: 'owner',
      type: 'user',
      kind: undefined,
    });

    const r = buildWhoamiResult(corpRoot, member);
    expect(r.type).toBe('user');
    expect(r.kind).toBeNull();
    expect(r.casket).toBeNull();
  });

  // ─── Formatter ────────────────────────────────────────────────────

  it('formatHuman: Employee bacteria-spawned shows pending naming hint', () => {
    const member = makeMember({
      id: 'backend-engineer-ab',
      displayName: 'backend-engineer-ab',
      role: 'backend-engineer',
      kind: 'employee',
      generation: 3,
      parentSlot: 'backend-engineer-toast',
    });
    const out = formatHuman(buildWhoamiResult(corpRoot, member));
    expect(out).toContain('slug:        backend-engineer-ab');
    expect(out).toContain('<not yet chosen — pending self-naming>');
    expect(out).toContain('kind:        Employee');
    expect(out).toContain('generation:  3');
    expect(out).toContain('parent:      backend-engineer-toast');
    expect(out).toContain('casket:      idle');
  });

  it('formatHuman: Partner with named displayName + active task', () => {
    const member = makeMember({
      id: 'ceo',
      displayName: 'CEO',
      rank: 'master',
      role: 'ceo',
      kind: 'partner',
    });
    createCasketIfMissing(corpRoot, 'ceo', 'ceo');
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      createdBy: 'mark',
      status: 'active',
      fields: {
        task: {
          title: 'Ship feature X',
          priority: 'normal',
          workflowStatus: 'in_progress',
        } as TaskFields,
      } as never,
    });
    advanceCurrentStep(corpRoot, 'ceo', task.id, 'ceo');

    const out = formatHuman(buildWhoamiResult(corpRoot, member));
    expect(out).toContain('displayName: CEO');
    expect(out).toContain('kind:        Partner');
    expect(out).toContain('Ship feature X');
    expect(out).not.toContain('<not yet chosen');
  });

  // ─── Codex P2 regression: malformed casket-target chit ──────────

  it('degrades gracefully when casket points at a malformed task chit', () => {
    const member = makeMember({
      id: 'broken',
      displayName: 'broken',
      role: 'backend-engineer',
      kind: 'employee',
    });
    createCasketIfMissing(corpRoot, 'broken', 'broken');

    // Plant a malformed task chit at the predicted path. findChitById
    // resolves chit-t-<hex> by checking corp-level chits/task/<id>.md;
    // a parseable file with broken frontmatter throws ChitMalformedError
    // when the loader tries to read it.
    const fakeChitId = 'chit-t-deadbeef';
    const malformedDir = join(corpRoot, 'chits', 'task');
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(
      join(malformedDir, `${fakeChitId}.md`),
      '---\nthis is: { not [valid yaml ::: \n---\nbody\n',
      'utf-8',
    );
    advanceCurrentStep(corpRoot, 'broken', fakeChitId, 'broken');

    // Must not throw — the diagnostic command exists for moments
    // exactly like this.
    const r = buildWhoamiResult(corpRoot, member);
    expect(r.casket?.currentStep).toBe(fakeChitId);
    expect(r.casket?.title).toBeNull();
  });

  // ─── Rename: name-shape validator ─────────────────────────────────

  it.each([
    'Toast',
    'Shadow',
    'Copper',
    'Soot',
    'Aluminum-67',
    'snake_case',
    'A1',
    'Whetstone',
  ])('validateRenameName accepts %s', (name) => {
    expect(validateRenameName(name)).toBeNull();
  });

  it.each([
    ['', 'empty string'],
    ['T', 'too short'],
    ['Toast Pancakes', 'multi-word'],
    ['1Toast', 'starts with digit'],
    ['-Toast', 'starts with hyphen'],
    ['Toast!', 'special char'],
    ['Toast Toast', 'whitespace'],
    ['x'.repeat(31), 'too long (31 chars)'],
  ])('validateRenameName rejects %s (%s)', (name) => {
    expect(validateRenameName(name)).not.toBeNull();
  });

  // ─── Rename: eligibility check (every rejection path) ────────────

  function makeFreshSlot(overrides: Partial<Member> = {}): Member {
    return makeMember({
      id: 'backend-engineer-ab',
      displayName: 'backend-engineer-ab', // self-naming pending
      kind: 'employee',
      role: 'backend-engineer',
      status: 'active',
      type: 'agent',
      ...overrides,
    });
  }

  it('checkRenameEligibility accepts a fresh Employee with valid name', () => {
    const member = makeFreshSlot();
    expect(checkRenameEligibility(member, 'Toast', [member])).toEqual({ ok: true });
  });

  it('rejects User type members', () => {
    const member = makeFreshSlot({ type: 'user', kind: undefined });
    const r = checkRenameEligibility(member, 'Toast', [member]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/type=user/);
  });

  it('rejects Partners (kind=partner)', () => {
    const member = makeFreshSlot({ kind: 'partner' });
    const r = checkRenameEligibility(member, 'Toast', [member]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/only Employees/);
  });

  it('rejects archived / non-active members', () => {
    const member = makeFreshSlot({ status: 'archived' });
    const r = checkRenameEligibility(member, 'Toast', [member]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/status=archived/);
  });

  it('rejects already-named slots (displayName !== id)', () => {
    const member = makeFreshSlot({ displayName: 'Toast' });
    const r = checkRenameEligibility(member, 'Shadow', [member]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already has displayName/);
  });

  it('rejects bad-shape names', () => {
    const member = makeFreshSlot();
    const r = checkRenameEligibility(member, 'Toast Pancakes', [member]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/doesn't match the name shape/);
  });

  it('rejects when slot has no role registered', () => {
    const member = makeFreshSlot({ role: undefined });
    const r = checkRenameEligibility(member, 'Toast', [member]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no role registered/);
  });

  it('rejects when an active sibling already holds the chosen name', () => {
    const me = makeFreshSlot({ id: 'backend-engineer-ab' });
    const sibling = makeMember({
      id: 'backend-engineer-cd',
      displayName: 'Toast', // already taken
      kind: 'employee',
      role: 'backend-engineer',
      status: 'active',
    });
    const r = checkRenameEligibility(me, 'Toast', [me, sibling]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/already holds displayName "Toast"/);
      expect(r.error).toMatch(/backend-engineer-cd/);
    }
  });

  it('allows the same name held by an archived sibling (only active siblings reserve)', () => {
    const me = makeFreshSlot({ id: 'backend-engineer-ab' });
    const archivedSibling = makeMember({
      id: 'backend-engineer-cd',
      displayName: 'Toast',
      kind: 'employee',
      role: 'backend-engineer',
      status: 'archived',
    });
    const r = checkRenameEligibility(me, 'Toast', [me, archivedSibling]);
    expect(r).toEqual({ ok: true });
  });

  it('allows the same name held in a different role pool', () => {
    const me = makeFreshSlot({ id: 'backend-engineer-ab' });
    const otherRoleSibling = makeMember({
      id: 'qa-engineer-cd',
      displayName: 'Toast',
      kind: 'employee',
      role: 'qa-engineer',
      status: 'active',
    });
    const r = checkRenameEligibility(me, 'Toast', [me, otherRoleSibling]);
    expect(r).toEqual({ ok: true });
  });

  // ─── Rename: naming observation body ──────────────────────────────

  it('renderNamingBody includes the welcome line + lifecycle metadata', () => {
    const body = renderNamingBody({
      slug: 'backend-engineer-ab',
      chosenName: 'Toast',
      role: 'backend-engineer',
      parentSlot: 'backend-engineer-bd',
      generation: 3,
      bornAt: '2026-04-25T15:30:00.000Z',
    });
    expect(body).toContain('[backend-engineer-ab] is now Toast.');
    expect(body).toContain('born:        2026-04-25T15:30:00.000Z');
    expect(body).toContain('parent:      backend-engineer-bd');
    expect(body).toContain('generation:  3');
    expect(body).toContain('role:        backend-engineer');
    expect(body).toContain('Welcome, Toast.');
  });

  it('renderNamingBody handles gen-0 first-of-lineage slot', () => {
    const body = renderNamingBody({
      slug: 'backend-engineer-aa',
      chosenName: 'Whetstone',
      role: 'backend-engineer',
      parentSlot: null,
      generation: 0,
      bornAt: '2026-04-25T10:00:00.000Z',
    });
    expect(body).toContain('parent:      none (first of lineage)');
    expect(body).toContain('generation:  0');
    expect(body).toContain('Welcome, Whetstone.');
  });

  it('formatHuman: User shape is minimal (no casket / kind / role lines)', () => {
    const member = makeMember({
      id: 'mark',
      displayName: 'Mark',
      rank: 'owner',
      type: 'user',
      kind: undefined,
    });
    const out = formatHuman(buildWhoamiResult(corpRoot, member));
    expect(out).toContain('slug:        mark');
    expect(out).toContain('displayName: Mark');
    expect(out).toContain('type:        user');
    expect(out).not.toContain('kind:');
    expect(out).not.toContain('casket:');
  });
});
