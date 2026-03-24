/** Module-level daemon reference for crash cleanup.
 *  ResumeView sets this when the daemon starts.
 *  The uncaughtException handler in index.tsx reads it to call stop(). */
export let daemonRef: { stop: () => Promise<void> } | null = null;

export function setDaemonRef(d: { stop: () => Promise<void> } | null): void {
  daemonRef = d;
}
