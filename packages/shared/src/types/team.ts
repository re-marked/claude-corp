export type TeamStatus = 'active' | 'paused' | 'dissolved';

export interface Team {
  id: string;
  name: string;
  description: string;
  leaderMemberId: string;
  parentId: string | null;
  status: TeamStatus;
  memberIds: string[];
  createdBy: string;
  createdAt: string;
}
