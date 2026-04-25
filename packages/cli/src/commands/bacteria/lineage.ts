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
  const aliveSet = new Set(
    members
      .filter(
        (m) =>
          m.type === 'agent' &&
          m.status !== 'archived' &&
          m.role === roleId &&
          (m.kind ?? 'partner') === 'employee',
      )
      .map((m) => m.id),
  );
  const memberById = new Map(members.map((m) => [m.id, m]));

  const mitoseBySlug = new Map<string, MitoseEvent>();
  const apoptoseBySlug = new Map<string, ApoptoseEvent>();
  for (const e of events) {
    if (e.kind === 'mitose') mitoseBySlug.set(e.slug, e);
    else apoptoseBySlug.set(e.slug, e);
  }

  // Every slug that ever appeared in the role's events OR currently
  // lives in members.json gets a node.
  const slugs = new Set<string>([
    ...mitoseBySlug.keys(),
    ...apoptoseBySlug.keys(),
    ...aliveSet,
  ]);

  const nodes: LineageNode[] = [];
  for (const slug of slugs) {
    const mitose = mitoseBySlug.get(slug);
    const apoptose = apoptoseBySlug.get(slug);
    const member = memberById.get(slug);
    const directHire = !mitose; // born without a mitose event = founder hire
    const alive = aliveSet.has(slug);

    const generation = mitose?.generation
      ?? member?.generation
      ?? 0;
    const parentSlug = mitose?.parentSlug
      ?? member?.parentSlot
      ?? null;
    const bornAt = mitose?.ts ?? member?.createdAt ?? null;

    nodes.push({
      slug,
      displayName: apoptose?.chosenName
        ?? (member?.displayName !== member?.id ? member?.displayName ?? null : null),
      generation,
      parentSlug,
      bornAt,
      apoptosedAt: apoptose?.ts ?? null,
      lifetimeMs: apoptose?.lifetimeMs ?? null,
      tasksCompleted: apoptose?.tasksCompleted ?? null,
      directHire,
      alive,
    });
  }

  // Sort by birth time so older roots come first (more readable trees).
  nodes.sort((a, b) => (a.bornAt ?? '').localeCompare(b.bornAt ?? ''));
  return nodes;
}

export function formatLineageTree(
  roleDisplayName: string,
  roleId: string,
  nodes: readonly LineageNode[],
): string {
  if (nodes.length === 0) {
    return `${roleDisplayName} (${roleId}) — no lineage yet (pool has never spawned).`;
  }

  // Index children by parent.
  const childrenByParent = new Map<string | null, LineageNode[]>();
  for (const n of nodes) {
    const list = childrenByParent.get(n.parentSlug) ?? [];
    list.push(n);
    childrenByParent.set(n.parentSlug, list);
  }

  const aliveCount = nodes.filter((n) => n.alive).length;
  const apoptosedCount = nodes.filter((n) => n.apoptosedAt !== null).length;

  const lines: string[] = [
    `${roleDisplayName} (${roleId}) lineage — ${nodes.length} total, ${aliveCount} alive, ${apoptosedCount} apoptosed`,
    '',
  ];

  // Walk roots (parentSlug = null) and render each subtree. Visited
  // set defends against cycles in a corrupted log.
  const visited = new Set<string>();
  const roots = childrenByParent.get(null) ?? [];
  // Some slugs reference a parentSlug that doesn't exist as a node
  // (parent's events were rotated/lost). Treat them as roots too.
  const knownSlugs = new Set(nodes.map((n) => n.slug));
  for (const n of nodes) {
    if (n.parentSlug !== null && !knownSlugs.has(n.parentSlug)) {
      roots.push(n);
    }
  }

  for (let i = 0; i < roots.length; i++) {
    const isLast = i === roots.length - 1;
    renderSubtree(lines, roots[i]!, '', isLast, true, childrenByParent, visited);
  }

  return lines.join('\n');
}

function renderSubtree(
  out: string[],
  node: LineageNode,
  prefix: string,
  isLast: boolean,
  isRoot: boolean,
  childrenByParent: Map<string | null, LineageNode[]>,
  visited: Set<string>,
): void {
  if (visited.has(node.slug)) {
    out.push(`${prefix}${isRoot ? '' : isLast ? '└── ' : '├── '}${node.slug} (cycle in log — skipping)`);
    return;
  }
  visited.add(node.slug);

  // Roots render flush-left without a branch glyph; non-roots get
  // ├── (mid) or └── (last) under their parent's prefix.
  if (isRoot) {
    out.push(formatNode(node));
  } else {
    const branch = isLast ? '└── ' : '├── ';
    out.push(`${prefix}${branch}${formatNode(node)}`);
  }

  const children = childrenByParent.get(node.slug) ?? [];
  // Children's prefix: roots → '', non-roots → my prefix + '│   ' or
  // '    ' depending on whether I was the last sibling.
  const childPrefix = isRoot
    ? ''
    : prefix + (isLast ? '    ' : '│   ');
  for (let i = 0; i < children.length; i++) {
    const childIsLast = i === children.length - 1;
    renderSubtree(out, children[i]!, childPrefix, childIsLast, false, childrenByParent, visited);
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
