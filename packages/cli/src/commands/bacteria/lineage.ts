/**
 * `cc-cli bacteria lineage <role>` — family tree of a worker-tier
 * pool, rendered from the bacteria-events.jsonl log.
 *
 * Reads the full event history (no time filter) for the role. Every
 * slug with a mitose event becomes a node; its parent edge comes
 * from parentSlug. Apoptose events stamp a death timestamp +
 * lifetime + tasks-completed onto the node. Slots present in
 * members.json without a mitose event (founder-hired pre-bacteria)
 * get rendered as roots with "(direct hire)" marker.
 *
 * Defensive against cycles via a visited-set in the tree walker —
 * shouldn't happen given how mitose works, but a corrupted log
 * shouldn't crash the renderer.
 *
 * Project 1.10.4.
 */

import { parseArgs } from 'node:util';
import {
  getRole,
  readBacteriaEvents,
  type ApoptoseEvent,
  type BacteriaEvent,
  type Member,
  type MitoseEvent,
} from '@claudecorp/shared';
import { getCorpRoot, getMembers } from '../../client.js';

interface LineageOpts {
  role?: string;
  corp?: string;
  json?: boolean;
}

interface LineageNode {
  /**
   * Per-lifecycle identity — bacteria recycles 2-letter slugs after
   * apoptosis, so a long-running pool can have multiple distinct
   * lifecycles sharing a slug. lifecycleId disambiguates them in
   * the tree (parent edges resolve to specific lifecycles, not just
   * slugs). Format: `${slug}@${bornAt}` for event-borne nodes,
   * `${slug}#hire` for direct-hire nodes (no mitose event).
   */
  lifecycleId: string;
  slug: string;
  displayName: string | null;
  generation: number;
  parentSlug: string | null;
  bornAt: string | null;
  /** null = alive, string = apoptose ISO ts. */
  apoptosedAt: string | null;
  lifetimeMs: number | null;
  tasksCompleted: number | null;
  /** Founder-hired slot with no mitose event in the log. */
  directHire: boolean;
  /** Currently exists in members.json. */
  alive: boolean;
}

function makeLifecycleId(slug: string, bornAt: string | null, suffix?: string): string {
  if (suffix) return `${slug}#${suffix}`;
  return bornAt ? `${slug}@${bornAt}` : `${slug}#unknown`;
}

export async function cmdBacteriaLineage(rawArgs: string[]): Promise<void> {
  const opts = parseLineageOpts(rawArgs);
  if (!opts.role) {
    console.error('cc-cli bacteria lineage: --role <id> or positional role required');
    process.exit(1);
  }
  const role = getRole(opts.role);
  if (!role) {
    console.error(`cc-cli bacteria lineage: unknown role "${opts.role}"`);
    process.exit(1);
  }
  if (role.tier !== 'worker') {
    console.error(`cc-cli bacteria lineage: role "${opts.role}" is tier=${role.tier}, not worker — bacteria only manages worker pools`);
    process.exit(1);
  }

  const corpRoot = await getCorpRoot(opts.corp);
  const members = getMembers(corpRoot);
  const events = readBacteriaEvents(corpRoot, { role: opts.role });

  const nodes = buildLineageNodes(opts.role, members, events);

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, role: opts.role, nodes }, null, 2));
    return;
  }

  console.log(formatLineageTree(role.displayName, opts.role, nodes));
}

// ─── Pure helpers (testable) ────────────────────────────────────────

export function buildLineageNodes(
  roleId: string,
  members: readonly Member[],
  events: readonly BacteriaEvent[],
): LineageNode[] {
  // Per-lifecycle node construction (Codex P3 fix). Bacteria recycles
  // 2-letter slugs after apoptosis, so the SAME slug can have
  // multiple distinct lifecycles in a long-running pool. We walk
  // events sequentially: each mitose opens a new lifecycle node;
  // the next apoptose for that slug closes it. After close, the
  // slug is "free" and a subsequent mitose starts a NEW node — never
  // overwrites the closed one.
  const allNodes: LineageNode[] = [];
  const openBySlug = new Map<string, LineageNode>();

  for (const e of events) {
    if (e.kind === 'mitose') {
      const node: LineageNode = {
        lifecycleId: makeLifecycleId(e.slug, e.ts),
        slug: e.slug,
        displayName: null,
        generation: e.generation,
        parentSlug: e.parentSlug,
        bornAt: e.ts,
        apoptosedAt: null,
        lifetimeMs: null,
        tasksCompleted: null,
        directHire: false,
        alive: false,
      };
      // If a prior open lifecycle for this slug exists (mitose without
      // a matching apoptose — log corruption / lost rotation), the new
      // mitose displaces it; the old one stays in the array as
      // "ancestral, no apoptose event seen."
      openBySlug.set(e.slug, node);
      allNodes.push(node);
    } else {
      const open = openBySlug.get(e.slug);
      if (open && !open.apoptosedAt) {
        // Close the matching open lifecycle.
        open.apoptosedAt = e.ts;
        open.lifetimeMs = e.lifetimeMs;
        open.tasksCompleted = e.tasksCompleted;
        open.displayName = e.chosenName;
        openBySlug.delete(e.slug);
      } else {
        // Apoptose without a matching mitose in the log — the
        // ancestral mitose was rotated/lost. Stub a node carrying
        // the apoptose payload so the death isn't silently swallowed.
        allNodes.push({
          lifecycleId: makeLifecycleId(e.slug, e.ts, `apoptose-${e.ts}`),
          slug: e.slug,
          displayName: e.chosenName,
          generation: e.generation,
          parentSlug: e.parentSlug,
          bornAt: null,
          apoptosedAt: e.ts,
          lifetimeMs: e.lifetimeMs,
          tasksCompleted: e.tasksCompleted,
          directHire: false,
          alive: false,
        });
      }
    }
  }

  // Live members of the role: mark `alive: true` on the matching open
  // lifecycle (if any), or stub a direct-hire node when no event exists.
  // Pre-1.10 founder-hired slots fall into the direct-hire path.
  const aliveMembers = members.filter(
    (m) =>
      m.type === 'agent' &&
      m.status !== 'archived' &&
      m.role === roleId &&
      (m.kind ?? 'partner') === 'employee',
  );
  for (const member of aliveMembers) {
    const open = openBySlug.get(member.id);
    if (open) {
      open.alive = true;
      // Slot may have self-named after birth (PR 3 — `cc-cli whoami
      // rename`). Pull the chosen name onto the lifecycle node so the
      // tree displays it for alive slots, not just apoptosed ones.
      if (member.displayName !== member.id) {
        open.displayName = member.displayName;
      }
    } else {
      // Direct hire / pre-bacteria slot — no mitose event explains
      // its existence. Render as a root with the founder-hire marker.
      allNodes.push({
        lifecycleId: makeLifecycleId(member.id, member.createdAt, 'hire'),
        slug: member.id,
        displayName:
          member.displayName !== member.id ? member.displayName : null,
        generation: member.generation ?? 0,
        parentSlug: member.parentSlot ?? null,
        bornAt: member.createdAt,
        apoptosedAt: null,
        lifetimeMs: null,
        tasksCompleted: null,
        directHire: true,
        alive: true,
      });
    }
  }

  // Sort by birth time so older roots come first (more readable trees).
  // Nodes without a bornAt (orphan apoptose stubs) sort to the start;
  // they typically appear with a "(gone — no apoptose event)" marker.
  allNodes.sort((a, b) => (a.bornAt ?? '').localeCompare(b.bornAt ?? ''));
  return allNodes;
}

export function formatLineageTree(
  roleDisplayName: string,
  roleId: string,
  nodes: readonly LineageNode[],
): string {
  if (nodes.length === 0) {
    return `${roleDisplayName} (${roleId}) — no lineage yet (pool has never spawned).`;
  }

  // Codex P3: link by lifecycleId, not slug. Same slug recycled
  // produces multiple nodes; each child must point at the SPECIFIC
  // lifecycle that was alive at the child's birth time, not all
  // ancestors that ever held the slug.
  //
  // Strategy: for each node, find its parent lifecycle by walking
  // candidate nodes with the matching slug and picking the one whose
  // [bornAt, apoptosedAt) bracketed the child's bornAt. Falls back
  // to most-recent-by-birth-time if no overlap (stubs without bornAt).
  const childrenByParentLifecycle = new Map<string | null, LineageNode[]>();
  for (const child of nodes) {
    const parentLifecycleId = resolveParentLifecycleId(child, nodes);
    const list = childrenByParentLifecycle.get(parentLifecycleId) ?? [];
    list.push(child);
    childrenByParentLifecycle.set(parentLifecycleId, list);
  }

  const aliveCount = nodes.filter((n) => n.alive).length;
  const apoptosedCount = nodes.filter((n) => n.apoptosedAt !== null).length;

  const lines: string[] = [
    `${roleDisplayName} (${roleId}) lineage — ${nodes.length} total, ${aliveCount} alive, ${apoptosedCount} apoptosed`,
    '',
  ];

  // Roots: nodes with no resolvable parent lifecycle (parentSlug
  // null OR no candidate matched). They render flush-left.
  const roots = childrenByParentLifecycle.get(null) ?? [];

  // Visited set keyed by lifecycleId so a cycle in the log doesn't
  // recurse forever, and so distinct lifecycles sharing a slug both
  // get visited.
  const visited = new Set<string>();

  for (let i = 0; i < roots.length; i++) {
    const isLast = i === roots.length - 1;
    renderSubtree(lines, roots[i]!, '', isLast, true, childrenByParentLifecycle, visited);
  }

  return lines.join('\n');
}

/**
 * Find the parent lifecycle node for a child. Bacteria recycles 2-letter
 * slugs after apoptosis, so a parentSlug like 'backend-engineer-aa' can
 * match multiple historical lifecycles. Pick the one whose lifetime
 * contained the child's bornAt; fall back to most-recent if no overlap.
 *
 * Returns the parent's lifecycleId, or null when the parent isn't
 * resolvable (parentSlug missing, no matching lifecycle in the log).
 */
function resolveParentLifecycleId(
  child: LineageNode,
  allNodes: readonly LineageNode[],
): string | null {
  if (!child.parentSlug) return null;
  const candidates = allNodes.filter((n) => n.slug === child.parentSlug);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.lifecycleId;

  // Multiple candidates — pick the one whose [bornAt, apoptosedAt)
  // bracketed the child's bornAt. This is the "parent was alive when
  // child was born" rule, which is the only way bacteria writes the
  // edge in normal flow.
  if (child.bornAt) {
    for (const c of candidates) {
      if (!c.bornAt) continue;
      const start = c.bornAt;
      // Open-ended (alive) lifecycles use a sentinel that no real
      // ISO timestamp can exceed.
      const end = c.apoptosedAt ?? '9999-12-31T23:59:59.999Z';
      if (child.bornAt >= start && child.bornAt < end) {
        return c.lifecycleId;
      }
    }
  }

  // Fallback: most-recent candidate by bornAt. Used when child has
  // no bornAt (orphan apoptose stub) or when no lifetime overlap is
  // exact (clock skew, edge cases).
  const earlierCandidates = [...candidates]
    .filter((c) => c.bornAt !== null)
    .sort((a, b) => (b.bornAt ?? '').localeCompare(a.bornAt ?? ''));
  if (earlierCandidates.length > 0) return earlierCandidates[0]!.lifecycleId;

  // No candidate has a bornAt either — return the first one for
  // determinism. This is deeply anomalous state and the tree will
  // reflect it as such.
  return candidates[0]!.lifecycleId;
}

function renderSubtree(
  out: string[],
  node: LineageNode,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
  childrenByParentLifecycle: Map<string | null, LineageNode[]>,
  visited: Set<string>,
): void {
  // Codex P3: cycle detection keyed by lifecycleId so distinct
  // lifecycles sharing a slug both render. Per-slug visited would
  // wrongly skip the second lifecycle.
  if (visited.has(node.lifecycleId)) {
    out.push(`${prefix}${isRoot ? '' : isLast ? '└── ' : '├── '}${node.slug} (cycle in log — skipping)`);
    return;
  }
  visited.add(node.lifecycleId);

  // Roots render flush-left without a branch glyph; non-roots get
  // ├── (mid) or └── (last) under their parent's prefix.
  if (isRoot) {
    out.push(formatNode(node));
  } else {
    const branch = isLast ? '└── ' : '├── ';
    out.push(`${prefix}${branch}${formatNode(node)}`);
  }

  // Children: lookup by THIS node's lifecycleId, not slug. The P3
  // builder pass already linked each child to a specific parent
  // lifecycle via resolveParentLifecycleId.
  const children = childrenByParentLifecycle.get(node.lifecycleId) ?? [];
  const childPrefix = isRoot
    ? ''
    : prefix + (isLast ? '    ' : '│   ');
  for (let i = 0; i < children.length; i++) {
    const childIsLast = i === children.length - 1;
    renderSubtree(out, children[i]!, childPrefix, childIsLast, false, childrenByParentLifecycle, visited);
  }
}

function formatNode(n: LineageNode): string {
  const name = n.displayName ?? n.slug;
  const genLabel = `gen ${n.generation}`;
  const directHireLabel = n.directHire ? ', direct hire' : '';

  if (n.alive) {
    const aliveFor = n.bornAt
      ? formatDuration(Date.now() - new Date(n.bornAt).getTime())
      : '?';
    return `${name} (${genLabel}, alive ${aliveFor}${directHireLabel})`;
  }
  if (n.apoptosedAt) {
    const lifetime = n.lifetimeMs !== null ? formatDuration(n.lifetimeMs) : '?';
    const tasksLabel = n.tasksCompleted !== null ? `, ${n.tasksCompleted} tasks` : '';
    const timeOnly = n.apoptosedAt.slice(11, 16);
    return `${name} (${genLabel}, apoptosed ${timeOnly}, lived ${lifetime}${tasksLabel}${directHireLabel})`;
  }
  return `${name} (${genLabel}, gone — no apoptose event${directHireLabel})`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM === 0 ? `${h}h` : `${h}h${remM}m`;
}

function parseLineageOpts(rawArgs: string[]): LineageOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      role: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  // Accept role as positional too: `cc-cli bacteria lineage backend-engineer`.
  const positionalRole = parsed.positionals[0];
  return {
    role: (parsed.values.role as string | undefined) ?? positionalRole,
    corp: parsed.values.corp as string | undefined,
    json: !!parsed.values.json,
  };
}
