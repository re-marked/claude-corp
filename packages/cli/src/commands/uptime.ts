import { getClient } from '../client.js';

export async function cmdUptime(opts: { json: boolean }) {
  const client = getClient();
  const data = await client.getUptime();

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`Uptime:    ${data.uptime}`);
  console.log(`Messages:  ${data.totalMessages}`);
  console.log(`Started:   ${new Date(data.startedAt).toLocaleString()}`);
}
