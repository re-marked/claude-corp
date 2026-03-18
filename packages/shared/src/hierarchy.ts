import type { Member } from './types/member.js';

export interface HierarchyNode {
  member: Member;
  children: HierarchyNode[];
}

/** Build a hierarchy tree from members using spawnedBy relationships. */
export function buildHierarchy(members: Member[]): HierarchyNode | null {
  const owner = members.find((m) => m.rank === 'owner');
  if (!owner) return null;

  const buildNode = (parent: Member): HierarchyNode => {
    const children = members
      .filter((m) => m.spawnedBy === parent.id && m.id !== parent.id)
      .sort((a, b) => {
        // Sort by rank then name
        const rankOrder: Record<string, number> = { master: 0, leader: 1, worker: 2, subagent: 3 };
        const ra = rankOrder[a.rank] ?? 9;
        const rb = rankOrder[b.rank] ?? 9;
        if (ra !== rb) return ra - rb;
        return a.displayName.localeCompare(b.displayName);
      })
      .map((child) => buildNode(child));

    return { member: parent, children };
  };

  return buildNode(owner);
}
