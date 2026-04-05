/**
 * Stale Process Cleanup — kills orphaned processes from previous daemon sessions.
 *
 * Orphans can survive in 3 places:
 * 1. The daemon itself (tracked by .daemon.pid)
 * 2. The corp gateway (openclaw process on .gateway/ port)
 * 3. Local agent gateways (openclaw per agent, each on their own port)
 *
 * Scans the corp structure, finds every port that was in use,
 * and kills the process holding each one. Then cleans up state files.
 *
 * Extracted from daemon.ts — self-contained, no daemon instance state needed.
 */

import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_PID_PATH, DAEMON_PORT_PATH } from '@claudecorp/shared';
import { log } from './logger.js';

/**
 * Kill all Claude Corp processes from a previous session.
 * Safe to call on daemon startup — only kills processes that aren't us.
 */
export async function killStaleProcesses(corpRoot: string): Promise<void> {
  const portsToKill = new Set<number>();
  const pidsToKill = new Set<number>();

  // 1. Old daemon PID
  try {
    if (existsSync(DAEMON_PID_PATH)) {
      const oldPid = parseInt(readFileSync(DAEMON_PID_PATH, 'utf-8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        pidsToKill.add(oldPid);
      }
    }
  } catch {}

  // 2. Old daemon port
  try {
    if (existsSync(DAEMON_PORT_PATH)) {
      const oldPort = parseInt(readFileSync(DAEMON_PORT_PATH, 'utf-8').trim(), 10);
      if (oldPort) portsToKill.add(oldPort);
    }
  } catch {}

  // 3. Corp gateway port — read from .gateway/openclaw.json
  try {
    const gwConfigPath = join(corpRoot, '.gateway', 'openclaw.json');
    if (existsSync(gwConfigPath)) {
      const gwConfig = JSON.parse(readFileSync(gwConfigPath, 'utf-8'));
      const gwPort = gwConfig?.gateway?.port;
      if (gwPort && typeof gwPort === 'number') portsToKill.add(gwPort);
    }
  } catch {}

  // 4. Local agent gateway ports — scan agents/*/config.json and .openclaw/openclaw.json
  collectAgentPorts(join(corpRoot, 'agents'), portsToKill);

  // 5. Project-scoped agent ports — scan projects/*/agents/*
  try {
    const projectsDir = join(corpRoot, 'projects');
    if (existsSync(projectsDir)) {
      const projects = readdirSync(projectsDir, { withFileTypes: true });
      for (const proj of projects) {
        if (!proj.isDirectory()) continue;
        collectAgentPorts(join(projectsDir, proj.name, 'agents'), portsToKill);
      }
    }
  } catch {}

  if (pidsToKill.size === 0 && portsToKill.size === 0) return;

  log(`[daemon] Cleaning up stale processes — ${pidsToKill.size} PIDs, ${portsToKill.size} ports`);
  const { execa: run } = await import('execa');

  // Kill PIDs first (with process tree on Windows)
  for (const pid of pidsToKill) {
    try {
      if (process.platform === 'win32') {
        await run('taskkill', ['/F', '/T', '/PID', String(pid)], { reject: false, timeout: 5000 });
      } else {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
      log(`[daemon] Killed stale PID ${pid}`);
    } catch {}
  }

  // Kill anything holding our ports
  if (process.platform === 'win32') {
    await killPortsWindows(run, portsToKill, pidsToKill);
  } else {
    await killPortsUnix(portsToKill);
  }

  // Wait for processes to die
  await new Promise(r => setTimeout(r, 2000));

  // Clean up stale files
  try { unlinkSync(DAEMON_PID_PATH); } catch {}
  try { unlinkSync(DAEMON_PORT_PATH); } catch {}

  log(`[daemon] Stale process cleanup complete`);
}

// ── Helpers ────────────────────────────────────────────────────────

/** Scan an agents directory for port numbers in config files. */
function collectAgentPorts(agentsDir: string, ports: Set<number>): void {
  try {
    if (!existsSync(agentsDir)) return;
    const agents = readdirSync(agentsDir, { withFileTypes: true });
    for (const agent of agents) {
      if (!agent.isDirectory()) continue;

      // Check agent config.json for port
      try {
        const configPath = join(agentsDir, agent.name, 'config.json');
        if (existsSync(configPath)) {
          const config = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (config.port && typeof config.port === 'number') {
            ports.add(config.port);
          }
        }
      } catch {}

      // Check agent's .openclaw/openclaw.json for gateway port
      try {
        const ocConfigPath = join(agentsDir, agent.name, '.openclaw', 'openclaw.json');
        if (existsSync(ocConfigPath)) {
          const ocConfig = JSON.parse(readFileSync(ocConfigPath, 'utf-8'));
          const agentPort = ocConfig?.gateway?.port;
          if (agentPort && typeof agentPort === 'number') {
            ports.add(agentPort);
          }
        }
      } catch {}
    }
  } catch {}
}

/** Kill processes on ports — Windows (netstat + taskkill). */
async function killPortsWindows(
  run: typeof import('execa').execa,
  ports: Set<number>,
  alreadyKilled: Set<number>,
): Promise<void> {
  for (const port of ports) {
    try {
      const check = await run('cmd', ['/c', `netstat -ano | findstr :${port} | findstr LISTENING`], { reject: false, timeout: 5000 });
      if (check.stdout) {
        const lines = check.stdout.trim().split('\n');
        for (const line of lines) {
          const match = line.trim().match(/\s(\d+)\s*$/);
          if (match?.[1]) {
            const holderPid = parseInt(match[1]);
            if (holderPid !== process.pid && !alreadyKilled.has(holderPid)) {
              await run('taskkill', ['/F', '/T', '/PID', String(holderPid)], { reject: false, timeout: 5000 });
              log(`[daemon] Killed stale process on port ${port} (PID ${holderPid})`);
            }
          }
        }
      }
    } catch {}
  }
}

/** Kill processes on ports — Unix (lsof). */
async function killPortsUnix(ports: Set<number>): Promise<void> {
  const { execa: run } = await import('execa');
  for (const port of ports) {
    try {
      const check = await run('lsof', ['-ti', `:${port}`], { reject: false, timeout: 5000 });
      if (check.stdout) {
        for (const pidStr of check.stdout.trim().split('\n')) {
          const pid = parseInt(pidStr);
          if (pid && pid !== process.pid) {
            try { process.kill(pid, 'SIGTERM'); } catch {}
            log(`[daemon] Killed stale process on port ${port} (PID ${pid})`);
          }
        }
      }
    } catch {}
  }
}
