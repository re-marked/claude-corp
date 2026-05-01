import { describe, it, expect } from 'vitest';
import {
  buildLineageNodes,
  formatLineageTree,
} from '../packages/cli/src/commands/bacteria/lineage.js';
import {
  type ApoptoseEvent,
  type BacteriaEvent,
  type Member,
  type MitoseEvent,
} from '../packages/shared/src/index.js';

/**
 * Coverage for cc-cli bacteria lineage's pure helpers (Project 1.10.4).
 * buildLineageNodes resolves slug → node from events + members;
 * formatLineageTree renders ASCII forest from those nodes.
 */

describe('bacteria lineage', () => {
  function member(overrides: Partial<Member> = {}): Member {
    const id = overrides.id ?? 'backend-engineer-aa';
    return {
      id,
      // displayName defaults to id (the bacteria-spawned signal:
      // not yet self-named). Override explicitly to test the
      // chosen-name path.
      displayName: id,
      rank: 'worker',
      status: 'active',
      type: 'agent',
      scope: 'corp',
      scopeId: '',
      agentDir: `agents/${id}/`,
      port: null,
      spawnedBy: null,
      createdAt: '2026-04-25T08:00:00.000Z',
      kind: 'employee',
      role: 'backend-engineer',
      generation: 0,
      ...overrides,
    };
  }

  function mitose(slug: string, parentSlug: string | null, generation: number): MitoseEvent {
    return {
      kind: 'mitose',
      ts: '2026-04-25T10:00:00.000Z',
      role: 'backend-engineer',
      slug,
      generation,
      parentSlug,
      assignedChit: 'chit-t-abc',
    };
  }

  function apoptose(slug: string, parentSlug: string | null, lifetimeMs = 3_600_000): ApoptoseEvent {
    return {
      kind: 'apoptose',
      ts: '2026-04-25T11:00:00.000Z',
      role: 'backend-engineer',
      slug,
      generation: 1,
      parentSlug,
      chosenName: 'Toast',
      reason: 'queue drained',
      idleSince: '2026-04-25T10:55:00.000Z',
      lifetimeMs,
      tasksCompleted: 5,
    };
  }

  // ─── buildLineageNodes ────────────────────────────────────────────

  it('mitose-only event produces an alive node', () => {
    const events = [mitose('backend-engineer-aa', null, 0)];
    const members: Member[] = [member({ id: 'backend-engineer-aa' })];
    const nodes = buildLineageNodes('backend-engineer', members, events);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.alive).toBe(true);
    expect(nodes[0]!.apoptosedAt).toBeNull();
  });

  it('mitose + apoptose pair produces a dead node with lifetime + tasks', () => {
    const events: BacteriaEvent[] = [
      mitose('backend-engineer-aa', null, 0),
      apoptose('backend-engineer-aa', null, 3_600_000),
    ];
    const nodes = buildLineageNodes('backend-engineer', [], events);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.alive).toBe(false);
    expect(nodes[0]!.apoptosedAt).toBe('2026-04-25T11:00:00.000Z');
    expect(nodes[0]!.lifetimeMs).toBe(3_600_000);
    expect(nodes[0]!.tasksCompleted).toBe(5);
    expect(nodes[0]!.displayName).toBe('Toast');
  });

  it('member without mitose event flagged as direct hire', () => {
    const members: Member[] = [
      member({ id: 'backend-engineer-aa', displayName: 'Manual', generation: 0 }),
    ];
    const nodes = buildLineageNodes('backend-engineer', members, []);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.directHire).toBe(true);
    expect(nodes[0]!.alive).toBe(true);
  });

  it('lineage edges link via parentSlug', () => {
    const events: BacteriaEvent[] = [
      mitose('backend-engineer-aa', null, 0),
      mitose('backend-engineer-bb', 'backend-engineer-aa', 1),
      mitose('backend-engineer-cc', 'backend-engineer-bb', 2),
    ];
    const nodes = buildLineageNodes('backend-engineer', [], events);
    const aa = nodes.find((n) => n.slug === 'backend-engineer-aa');
    const bb = nodes.find((n) => n.slug === 'backend-engineer-bb');
    const cc = nodes.find((n) => n.slug === 'backend-engineer-cc');
    expect(aa?.parentSlug).toBeNull();
    expect(bb?.parentSlug).toBe('backend-engineer-aa');
    expect(cc?.parentSlug).toBe('backend-engineer-bb');
  });

  // ─── formatLineageTree ────────────────────────────────────────────

  it('empty pool prints "no lineage yet" message', () => {
    const out = formatLineageTree('Backend Engineer', 'backend-engineer', []);
    expect(out).toContain('no lineage yet');
  });

  it('summary header reports total / alive / apoptosed counts', () => {
    const events: BacteriaEvent[] = [
      mitose('backend-engineer-aa', null, 0),
      mitose('backend-engineer-bb', null, 0),
      apoptose('backend-engineer-bb', null, 3_600_000),
    ];
    const members: Member[] = [member({ id: 'backend-engineer-aa' })];
    const nodes = buildLineageNodes('backend-engineer', members, events);
    const out = formatLineageTree('Backend Engineer', 'backend-engineer', nodes);
    expect(out).toContain('2 total');
    expect(out).toContain('1 alive');
    expect(out).toContain('1 apoptosed');
  });

  // ─── Codex P3 regression: recycled slugs preserve distinct lifecycles ─

  it('recycled slug produces TWO nodes — does not collapse history', () => {
    // Slot is born, dies, slot reborn with same slug (bacteria recycles
    // 2-letter suffixes). Both lifecycles must render as distinct nodes.
    const events: BacteriaEvent[] = [
      mitose('backend-engineer-aa', null, 0),
      apoptose('backend-engineer-aa', null, 1_800_000),
      // Same slug, born again later (event ts overrides earlier mitose).
      {
        ...mitose('backend-engineer-aa', null, 0),
        ts: '2026-04-25T15:00:00.000Z',
      },
    ];
    const members: Member[] = [
      // The second lifecycle is alive in members.json.
      member({ id: 'backend-engineer-aa' }),
    ];
    const nodes = buildLineageNodes('backend-engineer', members, events);
    expect(nodes).toHaveLength(2);

    // First lifecycle: born early, apoptosed.
    const dead = nodes.find((n) => n.bornAt === '2026-04-25T10:00:00.000Z');
    expect(dead).toBeDefined();
    expect(dead?.alive).toBe(false);
    expect(dead?.apoptosedAt).toBe('2026-04-25T11:00:00.000Z');
    expect(dead?.displayName).toBe('Toast');

    // Second lifecycle: born later, alive.
    const alive = nodes.find((n) => n.bornAt === '2026-04-25T15:00:00.000Z');
    expect(alive).toBeDefined();
    expect(alive?.alive).toBe(true);
    expect(alive?.apoptosedAt).toBeNull();

    // lifecycleId differs between the two — that's how the renderer
    // links children to the correct ancestor.
    expect(dead?.lifecycleId).not.toBe(alive?.lifecycleId);
  });

  it('children of recycled-slug parent link to the correct lifecycle by birth time', () => {
    // Parent born → child A born under it → parent apoptoses → parent
    // reborn with same slug → child B born under the new lifecycle.
    // Each child must point to the lifecycle alive at its birth.
    const events: BacteriaEvent[] = [
      // First parent lifecycle
      {
        ...mitose('backend-engineer-aa', null, 0),
        ts: '2026-04-25T08:00:00.000Z',
      },
      // Child A born under first parent
      {
        ...mitose('backend-engineer-bb', 'backend-engineer-aa', 1),
        ts: '2026-04-25T09:00:00.000Z',
      },
      // First parent apoptoses
      {
        ...apoptose('backend-engineer-aa', null, 3_600_000),
        ts: '2026-04-25T11:00:00.000Z',
      },
      // Same slug, second lifecycle starts
      {
        ...mitose('backend-engineer-aa', null, 0),
        ts: '2026-04-25T13:00:00.000Z',
      },
      // Child C born under second parent
      {
        ...mitose('backend-engineer-cc', 'backend-engineer-aa', 1),
        ts: '2026-04-25T14:00:00.000Z',
      },
    ];
    const nodes = buildLineageNodes('backend-engineer', [], events);
    const out = formatLineageTree('Backend Engineer', 'backend-engineer', nodes);

    // Tree should have TWO roots (the two `aa` lifecycles), each with
    // its own child. Without the P3 fix both children would lump
    // under whichever `aa` won the slug-keyed map.
    expect(out).toContain('backend-engineer-bb');
    expect(out).toContain('backend-engineer-cc');

    // Both lifecycles render. First (apoptosed) shows by its chosen
    // name 'Toast'; second (unnamed) shows by raw slug. Two distinct
    // identities present means both ancestors survived the per-lifecycle
    // build pass.
    expect(out).toContain('Toast (');
    expect(out).toMatch(/^backend-engineer-aa /m);

    // Each child is linked to a DIFFERENT parent lifecycle. Verify by
    // counting that bb and cc both appear under their respective
    // roots — each child appears exactly once and follows ONE root.
    const bbIdx = out.indexOf('backend-engineer-bb');
    const ccIdx = out.indexOf('backend-engineer-cc');
    const toastIdx = out.indexOf('Toast (');
    const aaUnnamedIdx = out.search(/^backend-engineer-aa /m);
    // bb sits under Toast (first root); cc sits under the unnamed aa.
    expect(toastIdx).toBeLessThan(bbIdx);
    expect(aaUnnamedIdx).toBeLessThan(ccIdx);
  });

  it('renders parent → child structure with branch glyphs', () => {
    const events: BacteriaEvent[] = [
      mitose('backend-engineer-aa', null, 0),
      mitose('backend-engineer-bb', 'backend-engineer-aa', 1),
    ];
    const members: Member[] = [
      member({ id: 'backend-engineer-aa' }),
      member({ id: 'backend-engineer-bb', generation: 1, parentSlot: 'backend-engineer-aa' }),
    ];
    const nodes = buildLineageNodes('backend-engineer', members, events);
    const out = formatLineageTree('Backend Engineer', 'backend-engineer', nodes);
    // Root + child indented under it. The renderer uses └── for the
    // last child of a branch.
    expect(out).toContain('backend-engineer-aa');
    expect(out).toContain('backend-engineer-bb');
    expect(out).toMatch(/└── .*backend-engineer-bb/);
  });
});
