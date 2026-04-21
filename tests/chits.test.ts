import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  chitId,
  casketChitId,
  chitPath,
  createChit,
  readChit,
  updateChit,
  closeChit,
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
