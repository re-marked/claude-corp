import type { MemberRank } from './types/member.js';

const RANK_LEVEL: Record<MemberRank, number> = {
  owner: 0,
  master: 1,
  leader: 2,
  worker: 3,
  subagent: 4,
};

/** Check if a creator at `creatorRank` is allowed to hire an agent at `targetRank`. */
export function canHire(creatorRank: MemberRank, targetRank: MemberRank): boolean {
  // Cannot create at or above your own rank
  return RANK_LEVEL[creatorRank] < RANK_LEVEL[targetRank];
}
