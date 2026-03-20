import { ensureGlobalConfig } from '@claudecorp/shared';
import { Daemon, isDaemonRunning } from '@claudecorp/daemon';
import { getCorpRoot } from '../client.js';

export async function cmdStart(opts: { corp?: string }) {
  const { running, port: existingPort } = isDaemonRunning();
  if (running && existingPort) {
    console.log(`Daemon already running on port ${existingPort}`);
    return;
  }

  const corpRoot = await getCorpRoot(opts.corp);
  const globalConfig = ensureGlobalConfig();
  const daemon = new Daemon(corpRoot, globalConfig);

  const port = await daemon.start();
  console.log(`Daemon listening on port ${port} (PID ${process.pid})`);

  console.log('Spawning agents...');
  try {
    await daemon.spawnAllAgents();
  } catch (err) {
    console.error('Agent spawning had errors:', err);
  }

  // Wait briefly for agents to become ready
  for (let i = 0; i < 15; i++) {
    const agents = daemon.processManager.listAgents();
    if (agents.some((a) => a.status === 'ready')) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  daemon.startRouter();

  const agents = daemon.processManager.listAgents();
  const readyCount = agents.filter((a) => a.status === 'ready').length;
  console.log(`Ready. ${readyCount}/${agents.length} agents online.`);
  console.log(`Corp: ${corpRoot}`);
  console.log(`\nDaemon running in foreground. Press Ctrl+C to stop.`);

  // Keep alive + graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
