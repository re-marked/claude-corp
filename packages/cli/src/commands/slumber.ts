/**
 * cc-cli slumber — SLUMBER mode management from the CLI.
 *
 * Subcommands:
 *   slumber [duration|profile]  — activate SLUMBER
 *   slumber profiles            — list available profiles
 *   slumber stats               — show analytics
 *   slumber status              — show autoemon state
 *   slumber schedule <profile>  — set recurring schedule
 *   slumber schedule off        — clear schedule
 *   wake                        — end SLUMBER with CEO digest
 *   brief                       — mid-session CEO check-in
 */

import { getClient, getCorpRoot, getFounder, getMembers } from '../client.js';
import { parseIntervalExpression, type Member } from '@claudecorp/shared';

export async function cmdSlumber(opts: {
  args: string[];
  json: boolean;
}): Promise<void> {
  const client = getClient();
  const subcommand = opts.args[0]?.toLowerCase();

  // No args → show status or usage
  if (!subcommand) {
    const status = await client.get('/autoemon/status') as any;
    if (status.globalState === 'active') {
      const elapsed = status.activatedAt ? Math.round((Date.now() - status.activatedAt) / 60_000) : 0;
      console.log(`SLUMBER active (${elapsed}m) — ${status.enrolledCount} agent(s) enrolled`);
      console.log(`Ticks: ${status.totalTicks} total, ${status.totalProductiveTicks} productive`);
      if (status.activeProfileId) console.log(`Profile: ${status.activeProfileId}`);
    } else {
      console.log('SLUMBER is inactive.');
      console.log('');
      console.log('Usage:');
      console.log('  cc-cli slumber <duration|profile>   Activate (e.g., slumber 3h, slumber night-owl)');
      console.log('  cc-cli slumber profiles             List profiles');
      console.log('  cc-cli slumber stats                Show analytics');
      console.log('  cc-cli slumber status               Show detailed state');
      console.log('  cc-cli slumber schedule <profile>   Set recurring schedule');
      console.log('  cc-cli slumber schedule off          Clear schedule');
      console.log('  cc-cli wake                         End SLUMBER');
      console.log('  cc-cli brief                        Mid-session check-in');
    }
    return;
  }

  // slumber profiles
  if (subcommand === 'profiles') {
    const profiles = await client.get('/autoemon/profiles') as any[];
    if (opts.json) { console.log(JSON.stringify(profiles, null, 2)); return; }
    for (const p of profiles) {
      const dur = p.durationMs ? `${Math.round(p.durationMs / 3_600_000)}h` : '∞';
      const interval = `${Math.round(p.tickIntervalMs / 60_000)}m`;
      const budget = p.budgetTicks ? `${p.budgetTicks} ticks` : '∞';
      console.log(`${p.icon} ${p.name} (${p.id})`);
      console.log(`  ${p.description}`);
      console.log(`  ${interval} ticks · ${dur} duration · ${budget} budget · ${p.conscription}`);
      console.log('');
    }
    return;
  }

  // slumber stats
  if (subcommand === 'stats') {
    const data = await client.get('/autoemon/analytics') as any;
    if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
    console.log(data.report ?? 'No SLUMBER data.');
    return;
  }

  // slumber status
  if (subcommand === 'status') {
    const status = await client.get('/autoemon/status') as any;
    if (opts.json) { console.log(JSON.stringify(status, null, 2)); return; }
    console.log(`State: ${status.globalState}`);
    if (status.activatedBy) console.log(`Source: ${status.activatedBy}`);
    if (status.activeProfileId) console.log(`Profile: ${status.activeProfileId}`);
    console.log(`Enrolled: ${status.enrolledAgents?.join(', ') || 'none'}`);
    console.log(`Ticks: ${status.totalTicks} total, ${status.totalProductiveTicks} productive`);
    if (status.blockReason) console.log(`Blocked: ${status.blockReason}`);
    for (const [id, s] of Object.entries(status.agents ?? {})) {
      const a = s as any;
      console.log(`  ${id}: ${a.tickCount} ticks, ${a.productiveTickCount} productive, ${a.state}`);
    }
    return;
  }

  // slumber schedule
  if (subcommand === 'schedule') {
    const scheduleArg = opts.args[1];
    if (!scheduleArg) {
      console.error('Usage: cc-cli slumber schedule <profile-id>');
      console.error('       cc-cli slumber schedule off');
      process.exit(1);
    }
    if (scheduleArg === 'off' || scheduleArg === 'clear') {
      await client.post('/autoemon/schedule/clear');
      console.log('Schedule cleared.');
      return;
    }
    const result = await client.post('/autoemon/schedule', { profileId: scheduleArg }) as any;
    if (result.ok) {
      console.log(`${result.icon} Schedule set: ${result.profileName}`);
      console.log(`  Window: ${result.schedule}`);
      console.log(`  Duration: ${result.durationLabel}`);
    } else {
      console.error(result.error ?? 'Failed.');
      process.exit(1);
    }
    return;
  }

  // slumber <duration|profile> — activate
  let durationMs: number | undefined;
  let profileId: string | undefined;

  const parsed = parseIntervalExpression(subcommand);
  if (parsed) {
    durationMs = parsed;
  } else {
    // Try as profile name
    const profile = await client.get(`/autoemon/profile/${subcommand}`) as any;
    if (profile?.id) {
      profileId = profile.id;
      durationMs = profile.durationMs ?? undefined;
    } else {
      console.error(`Unknown: "${subcommand}". Use a duration (3h, 45m) or profile name (night-owl, sprint).`);
      process.exit(1);
    }
  }

  console.log('Activating SLUMBER...');
  await client.post('/autoemon/activate', { source: 'slumber', durationMs, profileId });
  const status = await client.get('/autoemon/status') as any;
  console.log(`SLUMBER active. ${status.enrolledCount} agent(s) enrolled.`);
}

export async function cmdWake(opts: { json: boolean }): Promise<void> {
  const client = getClient();

  const status = await client.get('/autoemon/status') as any;
  if (status.globalState === 'inactive') {
    console.log('SLUMBER is not active.');
    return;
  }

  console.log('Waking up — asking CEO for summary...');

  // Ask CEO to summarize
  const wrapUp = await client.post('/autoemon/wrapup', { reason: 'wake_command' }) as any;

  // Get analytics before deactivation
  const analytics = await client.get('/autoemon/analytics') as any;

  // Deactivate
  await client.post('/autoemon/deactivate');

  if (opts.json) {
    console.log(JSON.stringify({ digest: wrapUp.digest, analytics }, null, 2));
    return;
  }

  console.log('');
  if (wrapUp.ok && wrapUp.digest) {
    console.log('CEO Briefing:');
    console.log(wrapUp.digest);
  }
  if (analytics?.totalTicks > 0) {
    console.log('');
    console.log(analytics.report);
  }
  console.log('');
  console.log('☀ SLUMBER ended.');
}

export async function cmdBrief(opts: { json: boolean }): Promise<void> {
  const client = getClient();
  const corpRoot = await getCorpRoot();
  const members = getMembers(corpRoot);

  const status = await client.get('/autoemon/status') as any;
  if (status.globalState !== 'active') {
    console.log('SLUMBER is not active.');
    return;
  }

  const ceo = members.find((m: Member) => m.rank === 'master' && m.type === 'agent');
  if (!ceo) { console.error('No CEO found.'); process.exit(1); }
  const ceoSlug = ceo.displayName.toLowerCase().replace(/\s+/g, '-');

  console.log('Asking CEO for a brief update...');

  const elapsed = status.activatedAt ? Math.round((Date.now() - status.activatedAt) / 60_000) : 0;

  const result = await client.post('/cc/say', {
    target: ceoSlug,
    message: [
      `The Founder wants a brief status update. SLUMBER continues after this.`,
      `Session so far: ${elapsed}m elapsed, ${status.totalTicks} ticks, ${status.totalProductiveTicks} productive.`,
      `Give a quick update: what have you done, what now, anything urgent?`,
    ].join('\n'),
    sessionKey: `jack:${ceoSlug}`,
  }) as any;

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.ok && result.response) {
    console.log('');
    console.log(`CEO: ${result.response}`);
  } else {
    console.error(`Brief failed: ${result.error ?? 'no response'}`);
  }
}
