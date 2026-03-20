import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { DAEMON_PID_PATH, DAEMON_PORT_PATH } from '@claudecorp/shared';

export async function cmdStop() {
  if (!existsSync(DAEMON_PID_PATH)) {
    console.log('No daemon running (no PID file).');
    return;
  }

  const pid = parseInt(readFileSync(DAEMON_PID_PATH, 'utf-8').trim(), 10);

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to PID ${pid}`);
  } catch {
    console.log(`Process ${pid} is not running.`);
  }

  // Wait for exit
  for (let i = 0; i < 10; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      break;
    }
  }

  // Clean up stale files
  try { unlinkSync(DAEMON_PID_PATH); } catch {}
  try { unlinkSync(DAEMON_PORT_PATH); } catch {}
  console.log('Daemon stopped.');
}
