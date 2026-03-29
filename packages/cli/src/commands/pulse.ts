import { getClient, getCorpRoot, getFounder, getCeo } from '../client.js';

export async function cmdPulse(opts: { action?: string; json: boolean }) {
  const client = getClient();

  if (!opts.action || opts.action === 'status') {
    // Check if Pulse exists and its status
    const agents = await client.listAgents();
    const pulse = agents.find((a: any) => a.displayName === 'Pulse');
    if (!pulse) {
      console.log('Pulse agent not hired. Run: cc-cli pulse start');
      return;
    }
    const ws = (pulse as any).workStatus ?? pulse.status;
    console.log(`Pulse: ${ws}`);
    return;
  }

  if (opts.action === 'start') {
    // Hire the Pulse agent
    const corpRoot = await getCorpRoot();
    const ceo = getCeo(corpRoot);
    if (!ceo) {
      console.error('No CEO found. Create a corp first.');
      process.exit(1);
    }

    const agents = await client.listAgents();
    if (agents.some((a: any) => a.displayName === 'Pulse')) {
      console.log('Pulse agent already exists.');
      return;
    }

    await client.hireAgent({
      creatorId: ceo.id,
      agentName: 'pulse',
      displayName: 'Pulse',
      rank: 'worker',
    });
    console.log('Pulse agent hired. It will monitor other agents on heartbeat.');
    return;
  }

  if (opts.action === 'stop') {
    try {
      await client.stopAgent('pulse');
      console.log('Pulse agent stopped.');
    } catch {
      console.error('Failed to stop Pulse.');
    }
    return;
  }

  console.error('Usage: cc-cli pulse [start|stop|status]');
}
