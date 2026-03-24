/** Module-level daemon reference for cleanup on exit/crash.
 *  ResumeView sets this when the daemon starts.
 *  The exit handler in index.tsx uses it. */
export let daemonRef: { stop: () => Promise<void> } | null = null;

export function setDaemonRef(d: { stop: () => Promise<void> } | null): void {
  daemonRef = d;
}

/** Synchronously kill our entire process tree (Windows: taskkill /T, Unix: SIGTERM).
 *  Used as a last resort when async stop() can't complete before exit. */
export function killProcessTree(): void {
  if (process.platform === 'win32') {
    try {
      require('child_process').execSync(
        `taskkill /F /T /PID ${process.pid}`,
        { stdio: 'ignore', timeout: 3000 },
      );
    } catch {}
  }
}
