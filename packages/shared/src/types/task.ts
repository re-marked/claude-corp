export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskPriority = 'critical' | 'high' | 'normal' | 'low';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo: string | null;
  createdBy: string;
  projectId: string | null;
  parentTaskId: string | null;
  /** Task IDs that must complete before this task can start. */
  blockedBy: string[] | null;
  teamId: string | null;
  acceptanceCriteria: string[] | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}
