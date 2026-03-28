export interface FileLock {
  /** Absolute or corp-relative path that is locked */
  filePath: string;
  /** Member ID of the agent holding the lock */
  lockedBy: string;
  /** Display name of the agent holding the lock (for human-readable output) */
  lockedByName: string;
  /** ISO timestamp when the lock was acquired */
  lockedAt: string;
  /** Optional reason / task context */
  reason?: string;
}

export interface LocksFile {
  /** Active locks keyed by normalised file path */
  locks: Record<string, FileLock>;
  /** ISO timestamp of last modification */
  updatedAt: string;
}
