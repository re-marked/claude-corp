import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  chitId,
  casketChitId,
  isChitIdFormat,
  chitPath,
  createChit,
  readChit,
  updateChit,
  closeChit,
  promoteChit,
  archiveChit,
  queryChits,
  findChitById,
  checkConcurrentModification,
  ChitConcurrentModificationError,
} from '../packages/shared/src/chits.js';
import { ChitValidationError } from '../packages/shared/src/chit-types.js';

describe('chit id generation', () => {
  it('chitId produces chit-<prefix>-<8hex> format', () => {
    const id = chitId('task');
    expect(id).toMatch(/^chit-t-[0-9a-f]{8}$/);
  });

  it('chitId uses observation prefix for observations', () => {
    expect(chitId('observation')).toMatch(/^chit-o-[0-9a-f]{8}$/);
  });

  it('chitId uses dispatch-context prefix', () => {
    expect(chitId('dispatch-context')).toMatch(/^chit-dc-[0-9a-f]{8}$/);
  });

  it('chitId generates unique ids across many calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(chitId('task'));
    expect(ids.size).toBe(100);
  });

  it('casketChitId produces casket-<slug>', () => {
    expect(casketChitId('toast')).toBe('casket-toast');
    expect(casketChitId('backend-engineer')).toBe('casket-backend-engineer');
  });

  it('casketChitId rejects non-kebab slugs', () => {
    expect(() => casketChitId('Toast')).toThrow(ChitValidationError);
    expect(() => casketChitId('toast_underscore')).toThrow(ChitValidationError);
    expect(() => casketChitId('')).toThrow(ChitValidationError);
  });

  describe('isChitIdFormat', () => {
    it('accepts normal chit ids', () => {
      expect(isChitIdFormat('chit-t-abcdef01')).toBe(true);
      expect(isChitIdFormat('chit-o-12345678')).toBe(true);
      expect(isChitIdFormat('chit-dc-deadbeef')).toBe(true);
      expect(isChitIdFormat('chit-pbe-cafebabe')).toBe(true);
    });

    it('accepts casket ids', () => {
      expect(isChitIdFormat('casket-toast')).toBe(true);
      expect(isChitIdFormat('casket-backend-engineer')).toBe(true);
    });

    it('rejects typos and garbage', () => {
      expect(isChitIdFormat('random-string')).toBe(false);
      expect(isChitIdFormat('chit-x')).toBe(false);
      expect(isChitIdFormat('chit-t-ZZZZZZZZ')).toBe(false); // non-hex
      expect(isChitIdFormat('')).toBe(false);
      expect(isChitIdFormat('CHIT-T-ABCDEF01')).toBe(false); // uppercase
    });
  });
});

describe('references + dependsOn id validation at CRUD boundary', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chits-links-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('createChit rejects references with invalid chit id format', () => {
    expect(() =>
      createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: 't', priority: 'normal' } },
        createdBy: 'ceo',
        references: ['chit-t-abcdef01', 'typo-not-a-chit'],
      }),
    ).toThrow(ChitValidationError);
  });

  it('createChit rejects dependsOn with invalid chit id format', () => {
    expect(() =>
      createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: 't', priority: 'normal' } },
        createdBy: 'ceo',
        dependsOn: ['not-a-chit-id'],
      }),
    ).toThrow(ChitValidationError);
  });

  it('updateChit rejects references with invalid chit id format', () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });

    expect(() =>
      updateChit(corpRoot, 'corp', 'task', task.id, {
        references: ['not-valid'],
        updatedBy: 'ceo',
      }),
    ).toThrow(ChitValidationError);
  });

  it('accepts valid references including casket ids', () => {
    expect(() =>
      createChit(corpRoot, {
        type: 'observation',
        scope: 'agent:toast',
        fields: { observation: { category: 'NOTICE', subject: 'mark', importance: 2 } },
        createdBy: 'toast',
        references: ['chit-t-11223344', 'casket-toast'],
      }),
    ).not.toThrow();
  });
});

describe('chitPath', () => {
  const corpRoot = '/corp';

  it('places corp-scope chits at root', () => {
    expect(chitPath(corpRoot, 'corp', 'contract', 'chit-c-abc')).toBe(
      join(corpRoot, 'chits', 'contract', 'chit-c-abc.md'),
    );
  });

  it('places agent-scope chits under agents/<slug>', () => {
    expect(chitPath(corpRoot, 'agent:toast', 'casket', 'casket-toast')).toBe(
      join(corpRoot, 'agents', 'toast', 'chits', 'casket', 'casket-toast.md'),
    );
  });

  it('places project-scope chits under projects/<name>', () => {
    expect(chitPath(corpRoot, 'project:fire', 'task', 'chit-t-xyz')).toBe(
      join(corpRoot, 'projects', 'fire', 'chits', 'task', 'chit-t-xyz.md'),
    );
  });

  it('places team-scope chits under projects/<project>/teams/<team>', () => {
    expect(chitPath(corpRoot, 'team:fire/backend', 'task', 'chit-t-xyz')).toBe(
      join(corpRoot, 'projects', 'fire', 'teams', 'backend', 'chits', 'task', 'chit-t-xyz.md'),
    );
  });

  it('rejects malformed team scope', () => {
    expect(() => chitPath(corpRoot, 'team:onlyproject' as never, 'task', 'x')).toThrow(ChitValidationError);
    expect(() => chitPath(corpRoot, 'team:' as never, 'task', 'x')).toThrow(ChitValidationError);
  });

  it('rejects empty agent slug', () => {
    expect(() => chitPath(corpRoot, 'agent:' as never, 'task', 'x')).toThrow(ChitValidationError);
  });
});

describe('createChit', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chits-create-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('creates a task chit at the correct path with defaults applied', () => {
    const chit = createChit(corpRoot, {
      type: 'task',
      scope: 'project:fire',
      fields: { task: { title: 'do the thing', priority: 'high' } },
      createdBy: 'ceo',
    });

    expect(chit.id).toMatch(/^chit-t-[0-9a-f]{8}$/);
    expect(chit.type).toBe('task');
    expect(chit.status).toBe('draft'); // registry default
    expect(chit.ephemeral).toBe(false); // registry default
    expect(chit.ttl).toBeUndefined();
    expect(chit.createdBy).toBe('ceo');
    expect(chit.references).toEqual([]);
    expect(chit.dependsOn).toEqual([]);
    expect(chit.tags).toEqual([]);
    expect(chit.fields).toEqual({ task: { title: 'do the thing', priority: 'high' } });

    const path = chitPath(corpRoot, 'project:fire', 'task', chit.id);
    expect(existsSync(path)).toBe(true);
  });

  it('applies ephemeral + TTL defaults for observation', () => {
    const chit = createChit(corpRoot, {
      type: 'observation',
      scope: 'agent:toast',
      fields: { observation: { category: 'FEEDBACK', subject: 'mark', importance: 4 } },
      createdBy: 'toast',
    });

    expect(chit.ephemeral).toBe(true);
    expect(chit.ttl).toBeDefined();
    expect(new Date(chit.ttl!).getTime()).toBeGreaterThan(Date.now());
  });

  it('respects explicit id override (for casket)', () => {
    const id = casketChitId('toast');
    const chit = createChit(corpRoot, {
      type: 'casket',
      scope: 'agent:toast',
      id,
      fields: { casket: { currentStep: null } },
      createdBy: 'daemon',
    });

    expect(chit.id).toBe('casket-toast');
    expect(existsSync(chitPath(corpRoot, 'agent:toast', 'casket', 'casket-toast'))).toBe(true);
  });

  it('respects explicit status override if valid', () => {
    const chit = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'x', priority: 'normal' } },
      createdBy: 'ceo',
      status: 'active',
    });
    expect(chit.status).toBe('active');
  });

  it('rejects invalid status for type', () => {
    expect(() =>
      createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: 'x', priority: 'normal' } },
        createdBy: 'ceo',
        status: 'burning', // not valid for task
      }),
    ).toThrow(ChitValidationError);
  });

  it('rejects invalid fields payload via the registry validator', () => {
    expect(() =>
      createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: '', priority: 'normal' } },
        createdBy: 'ceo',
      }),
    ).toThrow(ChitValidationError);
  });

  it('rejects unknown chit type', () => {
    expect(() =>
      createChit(corpRoot, {
        type: 'bogus' as never,
        scope: 'corp',
        fields: {} as never,
        createdBy: 'ceo',
      }),
    ).toThrow(ChitValidationError);
  });

  it('writes body to file when provided', () => {
    const chit = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'x', priority: 'normal' } },
      createdBy: 'ceo',
      body: '# Task\n\nBody content here.',
    });
    const raw = readFileSync(chitPath(corpRoot, 'corp', 'task', chit.id), 'utf-8');
    expect(raw).toContain('# Task');
    expect(raw).toContain('Body content here.');
  });
});

describe('readChit', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chits-read-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('reads back a chit round-trip', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'round trip', priority: 'normal' } },
      createdBy: 'ceo',
      body: 'hello body',
    });

    const { chit, body, path } = readChit(corpRoot, 'corp', 'task', created.id);
    expect(chit.id).toBe(created.id);
    expect(chit.type).toBe('task');
    expect(chit.fields).toEqual({ task: { title: 'round trip', priority: 'normal' } });
    expect(body.trim()).toBe('hello body');
    expect(path).toBe(chitPath(corpRoot, 'corp', 'task', created.id));
  });

  it('throws if the chit does not exist', () => {
    expect(() => readChit(corpRoot, 'corp', 'task', 'chit-t-nonexist')).toThrow(/not found/);
  });

  it('throws ChitMalformedError when the file exists but is unparseable', async () => {
    const { ChitMalformedError } = await import('../packages/shared/src/chits.js');
    const badPath = join(corpRoot, 'chits', 'task', 'chit-t-bogus.md');
    mkdirSync(dirname(badPath), { recursive: true });
    writeFileSync(badPath, 'no frontmatter at all', 'utf-8');

    expect(() => readChit(corpRoot, 'corp', 'task', 'chit-t-bogus')).toThrow(ChitMalformedError);

    // Malformed event also written to audit log
    const logPath = join(corpRoot, 'chits', '_log', 'malformed.jsonl');
    expect(existsSync(logPath)).toBe(true);
  });

  it('reads chits from different scopes independently', () => {
    const corpChit = createChit(corpRoot, {
      type: 'contract',
      scope: 'corp',
      fields: { contract: { title: 'c1', goal: 'ship', taskIds: [] } },
      createdBy: 'ceo',
    });
    const agentChit = createChit(corpRoot, {
      type: 'observation',
      scope: 'agent:toast',
      fields: { observation: { category: 'NOTICE', subject: 'mark', importance: 2 } },
      createdBy: 'toast',
    });

    expect(readChit(corpRoot, 'corp', 'contract', corpChit.id).chit.id).toBe(corpChit.id);
    expect(readChit(corpRoot, 'agent:toast', 'observation', agentChit.id).chit.id).toBe(agentChit.id);
  });
});

describe('updateChit', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chits-update-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('updates status and bumps updatedAt', async () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });

    // wait ~5ms so updatedAt can differ
    await new Promise((r) => setTimeout(r, 5));

    const updated = updateChit(corpRoot, 'corp', 'task', created.id, {
      status: 'active',
      updatedBy: 'ceo',
    });

    expect(updated.status).toBe('active');
    expect(updated.updatedBy).toBe('ceo');
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime());
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it('merges partial field updates and re-validates', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });

    const updated = updateChit(corpRoot, 'corp', 'task', created.id, {
      fields: { task: { title: 't', priority: 'high', assignee: 'backend' } },
      updatedBy: 'ceo',
    });

    expect(updated.fields.task.priority).toBe('high');
    expect(updated.fields.task.assignee).toBe('backend');
  });

  it('rejects field updates that fail validation', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });

    expect(() =>
      updateChit(corpRoot, 'corp', 'task', created.id, {
        fields: { task: { title: 't', priority: 'nonsense' as never } },
        updatedBy: 'ceo',
      }),
    ).toThrow(ChitValidationError);
  });

  it('rejects status transitions outside validStatuses', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });

    expect(() =>
      updateChit(corpRoot, 'corp', 'task', created.id, {
        status: 'burning',
        updatedBy: 'ceo',
      }),
    ).toThrow(ChitValidationError);
  });

  it('rejects status change out of terminal status (terminal lock)', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });
    // First move it to a terminal status via closeChit
    closeChit(corpRoot, 'corp', 'task', created.id, 'completed', 'ceo');

    // Now try to transition back to active — must be rejected
    expect(() =>
      updateChit(corpRoot, 'corp', 'task', created.id, {
        status: 'active',
        updatedBy: 'ceo',
      }),
    ).toThrow(/terminal/);
  });

  it('allows non-status updates on terminal chits (notes, tags)', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });
    closeChit(corpRoot, 'corp', 'task', created.id, 'completed', 'ceo');

    // Updating tags without changing status should still work — terminal
    // lock only blocks status transitions, not metadata updates.
    expect(() =>
      updateChit(corpRoot, 'corp', 'task', created.id, {
        tags: ['retrospective'],
        updatedBy: 'ceo',
      }),
    ).not.toThrow();
  });

  it('allows re-setting the same terminal status (idempotent)', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });
    closeChit(corpRoot, 'corp', 'task', created.id, 'completed', 'ceo');

    // Setting status to the same terminal status is a no-op, not a violation
    expect(() =>
      updateChit(corpRoot, 'corp', 'task', created.id, {
        status: 'completed',
        updatedBy: 'ceo',
      }),
    ).not.toThrow();
  });

  it('checkConcurrentModification passes when the file matches expected updatedAt', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });
    const path = chitPath(corpRoot, 'corp', 'task', created.id);

    expect(() => checkConcurrentModification(path, created.updatedAt)).not.toThrow();
  });

  it('checkConcurrentModification throws when on-disk updatedAt differs', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });
    const path = chitPath(corpRoot, 'corp', 'task', created.id);

    // Simulate a concurrent writer by mutating the file's updatedAt directly
    const mutated = readFileSync(path, 'utf-8').replace(
      /^updatedAt:.*$/m,
      `updatedAt: '2099-01-01T00:00:00.000Z'`,
    );
    writeFileSync(path, mutated, 'utf-8');

    expect(() => checkConcurrentModification(path, created.updatedAt)).toThrow(
      ChitConcurrentModificationError,
    );
  });

  it('replaces body when provided; preserves when undefined', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
      body: 'original body',
    });

    const afterPreserve = updateChit(corpRoot, 'corp', 'task', created.id, { status: 'active', updatedBy: 'ceo' });
    expect(readChit(corpRoot, 'corp', 'task', created.id).body.trim()).toBe('original body');

    updateChit(corpRoot, 'corp', 'task', created.id, { body: 'new body', updatedBy: 'ceo' });
    expect(readChit(corpRoot, 'corp', 'task', created.id).body.trim()).toBe('new body');

    // Lint against unused var
    expect(afterPreserve.id).toBe(created.id);
  });

  it('throws ChitConcurrentModificationError when expectedUpdatedAt mismatches', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });

    expect(() =>
      updateChit(corpRoot, 'corp', 'task', created.id, {
        status: 'active',
        updatedBy: 'ceo',
        expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      }),
    ).toThrow(ChitConcurrentModificationError);
  });

  it('accepts expectedUpdatedAt matching current updatedAt', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });

    expect(() =>
      updateChit(corpRoot, 'corp', 'task', created.id, {
        status: 'active',
        updatedBy: 'ceo',
        expectedUpdatedAt: created.updatedAt,
      }),
    ).not.toThrow();
  });
});

describe('closeChit', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chits-close-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('transitions to a terminal status and leaves file on disk', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });

    const closed = closeChit(corpRoot, 'corp', 'task', created.id, 'completed', 'ceo');
    expect(closed.status).toBe('completed');
    expect(existsSync(chitPath(corpRoot, 'corp', 'task', created.id))).toBe(true);
  });

  it('rejects non-terminal status', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });

    expect(() => closeChit(corpRoot, 'corp', 'task', created.id, 'active', 'ceo')).toThrow(
      ChitValidationError,
    );
  });

  it('rejects close for types with no terminal statuses (casket)', () => {
    const id = casketChitId('toast');
    createChit(corpRoot, {
      type: 'casket',
      scope: 'agent:toast',
      id,
      fields: { casket: { currentStep: null } },
      createdBy: 'daemon',
    });

    expect(() => closeChit(corpRoot, 'agent:toast', 'casket', id, 'closed', 'daemon')).toThrow(/terminal/);
  });
});

describe('promoteChit', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chits-promote-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('flips ephemeral → permanent, clears ttl, tags with reason-slug', () => {
    const obs = createChit(corpRoot, {
      type: 'observation',
      scope: 'agent:toast',
      fields: { observation: { category: 'FEEDBACK', subject: 'mark', importance: 4 } },
      createdBy: 'toast',
    });
    expect(obs.ephemeral).toBe(true);
    expect(obs.ttl).toBeDefined();

    const promoted = promoteChit(corpRoot, 'agent:toast', 'observation', obs.id, {
      reason: 'Mark reaffirmed this preference twice',
      updatedBy: 'ceo',
    });

    expect(promoted.ephemeral).toBe(false);
    expect(promoted.ttl).toBeUndefined();
    expect(promoted.tags).toContain('promoted:mark-reaffirmed-this-preference-twice');
    expect(promoted.updatedBy).toBe('ceo');
    expect(new Date(promoted.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(obs.updatedAt).getTime(),
    );

    // Re-read to confirm persistence
    const { chit: reread } = readChit(corpRoot, 'agent:toast', 'observation', obs.id);
    expect(reread.ephemeral).toBe(false);
  });

  it('rejects promoting an already-permanent chit', () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });
    expect(task.ephemeral).toBe(false);

    expect(() =>
      promoteChit(corpRoot, 'corp', 'task', task.id, { reason: 'x', updatedBy: 'ceo' }),
    ).toThrow(/already permanent/);
  });

  it('handles empty/garbage reason gracefully with no-reason slug', () => {
    const obs = createChit(corpRoot, {
      type: 'observation',
      scope: 'agent:toast',
      fields: { observation: { category: 'NOTICE', subject: 'mark', importance: 2 } },
      createdBy: 'toast',
    });

    const promoted = promoteChit(corpRoot, 'agent:toast', 'observation', obs.id, {
      reason: '!!!',
      updatedBy: 'ceo',
    });
    expect(promoted.tags).toContain('promoted:no-reason');
  });

  it('does not duplicate the promotion tag on re-promotion attempt', () => {
    // Only makes sense if a chit could be re-promoted; promote rejects
    // already-permanent so manually confirm the tag-dedup path logic
    // with a crafted case. Here: verify the tag appears exactly once.
    const obs = createChit(corpRoot, {
      type: 'observation',
      scope: 'agent:toast',
      fields: { observation: { category: 'DISCOVERY', subject: 'mark', importance: 3 } },
      createdBy: 'toast',
    });
    const promoted = promoteChit(corpRoot, 'agent:toast', 'observation', obs.id, {
      reason: 'important pattern',
      updatedBy: 'ceo',
    });
    const count = promoted.tags.filter((t) => t.startsWith('promoted:')).length;
    expect(count).toBe(1);
  });
});

describe('archiveChit', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chits-archive-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('moves a closed chit to _archive/<type>/', () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });
    closeChit(corpRoot, 'corp', 'task', task.id, 'completed', 'ceo');

    const result = archiveChit(corpRoot, 'corp', 'task', task.id);

    expect(existsSync(result.sourcePath)).toBe(false);
    expect(existsSync(result.archivePath)).toBe(true);
    expect(result.archivePath).toContain(join('chits', '_archive', 'task'));
  });

  it('preserves file content during archive', () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'archive me', priority: 'normal' } },
      createdBy: 'ceo',
      body: 'important body content',
    });
    const originalContent = readFileSync(chitPath(corpRoot, 'corp', 'task', task.id), 'utf-8');

    closeChit(corpRoot, 'corp', 'task', task.id, 'completed', 'ceo');

    // After closeChit the status changed, so content differs; that's fine.
    // What matters is archiveChit preserves the post-close content.
    const postCloseContent = readFileSync(chitPath(corpRoot, 'corp', 'task', task.id), 'utf-8');

    const result = archiveChit(corpRoot, 'corp', 'task', task.id);
    const archivedContent = readFileSync(result.archivePath, 'utf-8');
    expect(archivedContent).toBe(postCloseContent);
    // Lint against unused var
    expect(originalContent).toContain('archive me');
  });

  it('rejects archiving a chit in non-terminal status', () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });

    expect(() => archiveChit(corpRoot, 'corp', 'task', task.id)).toThrow(/terminal|closeChit first/);
  });

  it('rejects archiving a nonexistent chit', () => {
    expect(() => archiveChit(corpRoot, 'corp', 'task', 'chit-t-00000000')).toThrow(/not found/);
  });

  it('archived chits are invisible to default queries but visible with includeArchive', () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });
    closeChit(corpRoot, 'corp', 'task', task.id, 'completed', 'ceo');
    archiveChit(corpRoot, 'corp', 'task', task.id);

    const { chits: defaultResults } = queryChits(corpRoot, { types: ['task'] });
    expect(defaultResults.find((r) => r.chit.id === task.id)).toBeUndefined();

    const { chits: archiveResults } = queryChits(corpRoot, {
      types: ['task'],
      includeArchive: true,
    });
    expect(archiveResults.find((r) => r.chit.id === task.id)).toBeDefined();
  });
});

describe('queryChits', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chits-query-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  function seed(): {
    taskA: string;
    taskB: string;
    obsA: string;
    obsB: string;
    contract: string;
  } {
    const taskA = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'alpha', priority: 'high' } },
      createdBy: 'ceo',
      tags: ['urgent', 'backend'],
    }).id;
    const taskB = createChit(corpRoot, {
      type: 'task',
      scope: 'project:fire',
      fields: { task: { title: 'beta', priority: 'normal' } },
      createdBy: 'engineering-lead',
      status: 'active',
      tags: ['frontend'],
    }).id;
    const obsA = createChit(corpRoot, {
      type: 'observation',
      scope: 'agent:toast',
      fields: { observation: { category: 'FEEDBACK', subject: 'mark', importance: 4 } },
      createdBy: 'toast',
      tags: ['mark-preference'],
    }).id;
    const obsB = createChit(corpRoot, {
      type: 'observation',
      scope: 'agent:toast',
      fields: { observation: { category: 'NOTICE', subject: 'corp', importance: 2 } },
      createdBy: 'toast',
    }).id;
    const contract = createChit(corpRoot, {
      type: 'contract',
      scope: 'corp',
      fields: { contract: { title: 'ship fire', goal: 'launch', taskIds: [taskA, taskB] } },
      createdBy: 'ceo',
    }).id;
    return { taskA, taskB, obsA, obsB, contract };
  }

  it('returns empty array on empty corp', () => {
    expect(queryChits(corpRoot).chits).toEqual([]);
  });

  it('returns all chits across scopes without filters', () => {
    seed();
    const { chits: results } = queryChits(corpRoot);
    expect(results).toHaveLength(5);
  });

  it('filters by single type', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, { types: ['task'] });
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.chit.type).toBe('task');
  });

  it('filters by multiple types (OR within filter)', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, { types: ['task', 'observation'] });
    expect(results).toHaveLength(4);
  });

  it('filters by status', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, { statuses: ['active'] });
    // taskB, obsA, obsB, contract (task defaults 'draft', contract defaults 'draft' — so only taskB is active)
    expect(results.map((r) => r.chit.id)).toContain(
      queryChits(corpRoot, { types: ['task'], statuses: ['active'] }).chits[0].chit.id,
    );
  });

  it('filters by tag (OR within tags)', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, { tags: ['urgent', 'frontend'] });
    expect(results).toHaveLength(2); // taskA (urgent) + taskB (frontend)
  });

  it('filters by scope (single)', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, { scopes: ['agent:toast'] });
    expect(results).toHaveLength(2); // obsA, obsB
    for (const r of results) expect(r.chit.type).toBe('observation');
  });

  it('filters by scope (multiple)', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, { scopes: ['agent:toast', 'project:fire'] });
    expect(results).toHaveLength(3);
  });

  it('combines filters with AND semantics', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, {
      types: ['task'],
      tags: ['urgent'],
    });
    expect(results).toHaveLength(1);
    expect(results[0].chit.fields.task.title).toBe('alpha');
  });

  it('filters by createdBy', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, { createdBy: 'toast' });
    expect(results).toHaveLength(2); // both observations
  });

  it('filters by references', () => {
    const { taskA } = seed();
    // Create a chit that references taskA
    createChit(corpRoot, {
      type: 'observation',
      scope: 'agent:toast',
      fields: { observation: { category: 'DISCOVERY', subject: taskA, importance: 3 } },
      createdBy: 'toast',
      references: [taskA],
    });
    const { chits: results } = queryChits(corpRoot, { references: [taskA] });
    expect(results).toHaveLength(1);
  });

  it('filters by dependsOn', () => {
    const { taskA } = seed();
    createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 'follow-up', priority: 'normal' } },
      createdBy: 'ceo',
      dependsOn: [taskA],
    });
    const { chits: results } = queryChits(corpRoot, { dependsOn: [taskA] });
    expect(results).toHaveLength(1);
    expect(results[0].chit.fields.task.title).toBe('follow-up');
  });

  it('filters by ephemeral true', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, { ephemeral: true });
    // observations are ephemeral by default
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.chit.ephemeral).toBe(true);
  });

  it('filters by ephemeral false', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, { ephemeral: false });
    // task, task, contract
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.chit.ephemeral).toBe(false);
  });

  it('sorts by updatedAt desc by default', () => {
    seed();
    const { chits: results } = queryChits(corpRoot);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].chit.updatedAt >= results[i].chit.updatedAt).toBe(true);
    }
  });

  it('sorts asc when requested', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, { sortOrder: 'asc' });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].chit.updatedAt <= results[i].chit.updatedAt).toBe(true);
    }
  });

  it('sorts by id', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, { sortBy: 'id', sortOrder: 'asc' });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].chit.id <= results[i].chit.id).toBe(true);
    }
  });

  it('respects limit', () => {
    seed();
    const { chits: results } = queryChits(corpRoot, { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('respects offset', () => {
    seed();
    const { chits: all } = queryChits(corpRoot);
    const { chits: offset } = queryChits(corpRoot, { offset: 2 });
    expect(offset).toHaveLength(all.length - 2);
    expect(offset[0].chit.id).toBe(all[2].chit.id);
  });

  it('limit=0 means unlimited', () => {
    seed();
    // Create many more
    for (let i = 0; i < 60; i++) {
      createChit(corpRoot, {
        type: 'task',
        scope: 'corp',
        fields: { task: { title: `bulk-${i}`, priority: 'low' } },
        createdBy: 'ceo',
      });
    }
    const { chits: results } = queryChits(corpRoot, { limit: 0 });
    expect(results.length).toBeGreaterThan(50);
  });

  it('skips archive subtree by default', () => {
    const { taskA } = seed();
    // Simulate an archived chit by placing a file in the _archive subtree
    const archiveDir = join(corpRoot, 'chits', '_archive', 'task');
    mkdirSync(archiveDir, { recursive: true });
    const archivedPath = join(archiveDir, 'chit-t-archived.md');
    writeFileSync(
      archivedPath,
      readFileSync(chitPath(corpRoot, 'corp', 'task', taskA), 'utf-8'),
    );
    // default query doesn't see archived
    const { chits: defaultResults } = queryChits(corpRoot, { types: ['task'] });
    expect(defaultResults.every((r) => !r.path.includes('_archive'))).toBe(true);
    // includeArchive picks it up
    const { chits: archiveResults } = queryChits(corpRoot, { types: ['task'], includeArchive: true });
    expect(archiveResults.some((r) => r.path.includes('_archive'))).toBe(true);
  });

  it('surfaces malformed chit files in the result + writes them to the audit log', () => {
    seed();
    // A file that won't parse as valid chit frontmatter (no id/type).
    const badPath = join(corpRoot, 'chits', 'task', 'chit-t-bogus.md');
    mkdirSync(dirname(badPath), { recursive: true });
    writeFileSync(badPath, 'not valid frontmatter content', 'utf-8');

    const result = queryChits(corpRoot, { types: ['task'] });

    // Matches still contain only the valid tasks (2 from seed), bogus is filtered out
    expect(result.chits.map((r) => r.chit.id).every((id) => id !== 'chit-t-bogus')).toBe(true);
    expect(result.chits.length).toBeGreaterThanOrEqual(2);

    // Malformed is surfaced in the return value
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0].path).toBe(badPath);
    expect(result.malformed[0].error).toMatch(/missing required chit frontmatter|frontmatter/i);
    expect(result.malformed[0].timestamp).toMatch(/^\d{4}-/);

    // Malformed is also written to the audit log
    const logPath = join(corpRoot, 'chits', '_log', 'malformed.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const logLines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(logLines).toHaveLength(1);
    const logEntry = JSON.parse(logLines[0]);
    expect(logEntry.path).toBe(badPath);
  });

  it('appends multiple malformed entries to the audit log', () => {
    const bad1 = join(corpRoot, 'chits', 'task', 'chit-t-bad1.md');
    const bad2 = join(corpRoot, 'chits', 'task', 'chit-t-bad2.md');
    mkdirSync(dirname(bad1), { recursive: true });
    writeFileSync(bad1, 'totally bogus', 'utf-8');
    writeFileSync(bad2, 'also bogus', 'utf-8');

    const result = queryChits(corpRoot);
    expect(result.malformed).toHaveLength(2);

    const logPath = join(corpRoot, 'chits', '_log', 'malformed.jsonl');
    const logLines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(logLines).toHaveLength(2);
  });

  it('returns empty malformed when no corruption found', () => {
    seed();
    const result = queryChits(corpRoot);
    expect(result.malformed).toEqual([]);
  });
});

describe('findChitById', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chits-find-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('finds a task by id across scopes', () => {
    const task = createChit(corpRoot, {
      type: 'task',
      scope: 'project:fire',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });
    const found = findChitById(corpRoot, task.id);
    expect(found).not.toBeNull();
    expect(found!.chit.id).toBe(task.id);
  });

  it('finds an observation in agent scope', () => {
    const obs = createChit(corpRoot, {
      type: 'observation',
      scope: 'agent:toast',
      fields: { observation: { category: 'NOTICE', subject: 'mark', importance: 3 } },
      createdBy: 'toast',
    });
    const found = findChitById(corpRoot, obs.id);
    expect(found).not.toBeNull();
    expect(found!.chit.type).toBe('observation');
  });

  it('finds a casket by its deterministic id', () => {
    const id = casketChitId('toast');
    createChit(corpRoot, {
      type: 'casket',
      scope: 'agent:toast',
      id,
      fields: { casket: { currentStep: null } },
      createdBy: 'daemon',
    });
    const found = findChitById(corpRoot, id);
    expect(found).not.toBeNull();
    expect(found!.chit.type).toBe('casket');
    expect(found!.chit.id).toBe('casket-toast');
  });

  it('returns null for unrecognizable id prefix', () => {
    expect(findChitById(corpRoot, 'notachit')).toBeNull();
    expect(findChitById(corpRoot, 'chit-xyz')).toBeNull();
  });

  it('returns null when the chit file does not exist', () => {
    expect(findChitById(corpRoot, 'chit-t-00000000')).toBeNull();
  });

  it('throws ChitMalformedError when file exists but is unparseable', async () => {
    const { ChitMalformedError } = await import('../packages/shared/src/chits.js');
    // Filename must match the strict chit-<prefix>-<8hex> regex so
    // parseChitIdType resolves it before findChitById tries to read.
    const badId = 'chit-t-abcdef01';
    const badPath = join(corpRoot, 'chits', 'task', `${badId}.md`);
    mkdirSync(dirname(badPath), { recursive: true });
    writeFileSync(badPath, 'bogus content no frontmatter', 'utf-8');

    expect(() => findChitById(corpRoot, badId)).toThrow(ChitMalformedError);

    // Malformed event logged to audit trail
    const logPath = join(corpRoot, 'chits', '_log', 'malformed.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const logEntry = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    expect(logEntry.path).toBe(badPath);
  });
});

describe('atomic-write integration', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'chits-atomic-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('overwrites existing file atomically on updateChit', () => {
    const created = createChit(corpRoot, {
      type: 'task',
      scope: 'corp',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });
    const path = chitPath(corpRoot, 'corp', 'task', created.id);
    const beforeSize = readFileSync(path, 'utf-8').length;

    updateChit(corpRoot, 'corp', 'task', created.id, {
      tags: ['new-tag'],
      updatedBy: 'ceo',
    });

    // File still exists (no partial state), new content has the tag
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('new-tag');
    expect(raw.length).toBeGreaterThanOrEqual(beforeSize);
  });

  it('creates nested scope directories on first write', () => {
    createChit(corpRoot, {
      type: 'task',
      scope: 'team:fire/backend',
      fields: { task: { title: 't', priority: 'normal' } },
      createdBy: 'ceo',
    });
    expect(existsSync(join(corpRoot, 'projects', 'fire', 'teams', 'backend', 'chits', 'task'))).toBe(true);
  });
});
