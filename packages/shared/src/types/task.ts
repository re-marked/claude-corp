export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskPriority = 'critical' | 'high' | 'normal' | 'low';

/**
 * Task complexity — structured effort signal (NOT wall-clock time). Drives
 * decomposition decisions, model routing, and bacteria-split weighting.
 * See TaskFields.complexity docstring in types/chit.ts for the rubric.
 */
export type TaskComplexity = 'trivial' | 'small' | 'medium' | 'large';

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
  /** Effort/decomposition signal. Null = unassessed (agents should backfill on first touch). */
  complexity: TaskComplexity | null;
  dueAt: string | null;
  /** Loop that drives this task. When the loop completes, this task auto-completes. */
  loopId: string | null;
  createdAt: string;
  updatedAt: string;
}
