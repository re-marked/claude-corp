import { getClient, getCorpRoot, getCeo } from '../client.js';

export async function cmdFailsafe(opts: { action?: string; json: boolean }) {
  const client = getClient();

  if (!opts.action || opts.action === 'status') {
    // Check if Failsafe exists and its status
    const agents = await client.listAgents();
    const failsafe = agents.find((a: any) => a.displayName === 'Failsafe');
    if (!failsafe) {
      console.log('Failsafe agent not found. It should be auto-hired on daemon start.');
      return;
    }
    const ws = (failsafe as any).workStatus ?? failsafe.status;
    console.log(`Failsafe: ${ws}`);
    return;
  }

  if (opts.action === 'start') {
    const corpRoot = await getCorpRoot();
    const ceo = getCeo(corpRoot);
    if (!ceo) {
      console.error('No CEO found. Create a corp first.');
      process.exit(1);
    }

    const agents = await client.listAgents();
    if (agents.some((a: any) => a.displayName === 'Failsafe')) {
      console.log('Failsafe agent already exists.');
      return;
    }

    await client.hireAgent({
      creatorId: ceo.id,
      agentName: 'failsafe',
      displayName: 'Failsafe',
      rank: 'worker',
    });
    console.log('Failsafe agent hired. It will monitor other agents on heartbeat.');
    return;
  }

  if (opts.action === 'stop') {
    try {
      await client.stopAgent('failsafe');
      console.log('Failsafe agent stopped.');
    } catch {
      console.error('Failed to stop Failsafe.');
    }
    return;
  }

  console.error('Usage: cc-cli failsafe [start|stop|status]');
}
