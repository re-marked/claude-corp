import { ensureGlobalConfig } from '@claudecorp/shared';
import { Daemon, isDaemonRunning, DaemonClient } from '@claudecorp/daemon';
import { getCorpRoot } from '../client.js';

export async function cmdStart(opts: { corp?: string }) {
  const { running, port: existingPort } = isDaemonRunning();
  if (running && existingPort) {
    // Check which corp the existing daemon is serving
    try {
      const client = new DaemonClient(existingPort);
      const status = await client.status();
      const activeName = status.corpRoot.split(/[/\\]/).pop() ?? status.corpRoot;
      console.log(`Daemon already running on port ${existingPort} (corp: ${activeName})`);
      if (opts.corp && !status.corpRoot.includes(opts.corp)) {
        console.error(`\nYou requested --corp ${opts.corp} but the daemon is serving "${activeName}".`);
        console.error(`Stop it first: claudecorp-cli stop`);
      }
    } catch {
      console.log(`Daemon already running on port ${existingPort}`);
    }
    return;
  }

  const corpRoot = await getCorpRoot(opts.corp);
  const corpName = corpRoot.split(/[/\\]/).pop() ?? corpRoot;
  const globalConfig = ensureGlobalConfig();
  const daemon = new Daemon(corpRoot, globalConfig);

  const port = await daemon.start();
  console.log(`Daemon listening on port ${port} (PID ${process.pid})`);
  console.log(`Corp: ${corpName} (${corpRoot})`);

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
  console.log(`\nDaemon running in foreground. Press Ctrl+C to stop.`);

  // Keep alive + graceful shutdown. The top-level run() chain in
  // index.ts now calls process.exit(0) after resolution to avoid the
  // undici keep-alive hang that other commands hit (cc-cli inspect,
  // status, etc. would dangle for ~5s after printing). `start` is the
  // one long-running command — block here so the auto-exit never fires
  // and the daemon stays up until SIGINT/SIGTERM.
  const shutdown = async () => {
    console.log('\nShutting down...');
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise<void>(() => { /* hold forever — shutdown handlers exit */ });
}
