import type { TaskPriority } from './task.js';

/**
 * Contract status lifecycle:
 * draft → active → review → completed
 *                ↘ rejected (back to active with remediation tasks)
 *                ↘ failed (abandoned)
 */
export type ContractStatus =
  | 'draft'       // Created but not started — lead is reviewing/decomposing
  | 'active'      // Work in progress — tasks being executed
  | 'review'      // All tasks complete — Warden is reviewing
  | 'completed'   // Warden approved — contract delivered
  | 'rejected'    // Warden rejected — remediation needed (goes back to active)
  | 'failed';     // Abandoned — too many rejections or cancelled

/**
 * Contract — a bundle of tasks inside a Project with a goal, lead, and deadline.
 *
 * The orchestration primitive. The CEO creates Contracts, leads decompose
 * them into tasks and hand them to workers. When all tasks complete, the
 * Warden reviews and signs off. The Herald narrates progress.
 *
 * Contracts live inside projects: projects/<name>/contracts/<id>.md
 */
export interface Contract {
  /** Unique identifier */
  id: string;
  /** What this contract is about */
  title: string;
  /** What this contract achieves — the definition of success */
  goal: string;
  /** Which project this contract belongs to (project ID) */
  projectId: string;
  /** Team leader responsible for decomposing + executing (member ID) */
  leadId: string | null;
  /** Current lifecycle state */
  status: ContractStatus;
  /** Urgency level (reuses task priorities) */
  priority: TaskPriority;
  /** Task IDs that belong to this contract */
  taskIds: string[];
  /** Which blueprint was followed to execute this contract (if any) */
  blueprintId: string | null;
  /** When this contract must be delivered (ISO timestamp) */
  deadline: string | null;
  /** Who created this contract (member ID, usually CEO) */
  createdBy: string;
  /** When the Warden approved (ISO timestamp) */
  completedAt: string | null;
  /** Warden's member ID (who reviewed) */
  reviewedBy: string | null;
  /** Warden's verdict — approval note or rejection reason */
  reviewNotes: string | null;
  /** How many times the Warden rejected this contract */
  rejectionCount: number;
  /** When this contract was created */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/** Progress snapshot for display. */
export interface ContractProgress {
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  blockedTasks: number;
  pendingTasks: number;
  percentComplete: number;
}
