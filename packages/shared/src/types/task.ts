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
  /** Member ID of who handed this task (the sponsor — gets notified on completion/failure/blocked). */
  handedBy: string | null;
  /** When the task was handed (ISO timestamp). null if not yet handed. */
  handedAt: string | null;
  teamId: string | null;
  acceptanceCriteria: string[] | null;
  dueAt: string | null;
  /** Loop that drives this task. When the loop completes, this task auto-completes. */
  loopId: string | null;
  createdAt: string;
  updatedAt: string;
}
