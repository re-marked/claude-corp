export type ProjectType = 'codebase' | 'workspace';

export interface Project {
  id: string;
  name: string;
  displayName: string;
  type: ProjectType;
  path: string | null;
  lead: string | null;
  description: string;
  createdAt: string;
}
