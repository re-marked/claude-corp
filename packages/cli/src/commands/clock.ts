import { getClient } from '../client.js';
import type { Clock } from '@claudecorp/shared';

const STATUS_ICON: Record<string, string> = {
  running: '\u25CF',  // ●
  paused: '\u25CB',   // ○
  stopped: '\u2013',  // –
  error: '\u2717',    // ✗
};

const STATUS_LABEL: Record<string, string> = {
  running: 'running',
  paused: 'PAUSED',
  stopped: 'stopped',
  error: 'ERROR',
};

export async function cmdClock(opts: { json: boolean }) {
  const client = getClient();

  let clocks: Clock[];
  try {
    clocks = await client.listClocks();
  } catch {
    console.error('Cannot connect to daemon. Start it first: cc-cli start');
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(clocks, null, 2));
    return;
  }

  if (clocks.length === 0) {
    console.log('No clocks registered.');
    return;
  }

  const running = clocks.filter(c => c.status === 'running').length;
  const errors = clocks.filter(c => c.status === 'error').length;
  const paused = clocks.filter(c => c.status === 'paused').length;

  console.log(`CLOCKS \u2014 ${running} running${errors > 0 ? `, ${errors} ERROR` : ''}${paused > 0 ? `, ${paused} paused` : ''}`);
  console.log('');

  // Group by type
  const groups: Record<string, Clock[]> = {};
  for (const c of clocks) {
    const key = c.type.toUpperCase() + 'S';
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }

  // Render order: heartbeats first, then timers, then system, then loops/crons
  const order = ['HEARTBEATS', 'TIMERS', 'SYSTEMS', 'LOOPS', 'CRONS'];
  for (const groupName of order) {
    const group = groups[groupName];
    if (!group || group.length === 0) continue;

    console.log(groupName);

    for (const c of group) {
      const icon = STATUS_ICON[c.status] ?? '\u25CB';
      const interval = formatInterval(c.intervalMs);
      const last = c.lastFiredAt ? formatTimestamp(c.lastFiredAt) : 'never';
      const next = c.nextFireAt ? formatTimestamp(c.nextFireAt) : '-';
      const fired = formatCount(c.fireCount);
      const errInfo = c.consecutiveErrors > 0 ? ` ERR:${c.consecutiveErrors}` : '';

      // Time until next fire
      let remaining = '';
      if (c.nextFireAt && c.status === 'running') {
        const ms = c.nextFireAt - Date.now();
        remaining = ms > 0 ? formatRemaining(ms) : 'now';
      }

      console.log(
        `  ${icon} ${c.name.padEnd(22)} every ${interval.padEnd(6)} ` +
        `last: ${last}   next: ${remaining.padEnd(8)} ` +
        `fired: ${fired}${errInfo}`
      );

      // Show error details if any
      if (c.lastError && c.consecutiveErrors > 0) {
        console.log(`    \u2514 ${c.lastError.slice(0, 80)}`);
      }
    }
    console.log('');
  }
}

function formatInterval(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(0)}s`;
  return `${ms}ms`;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  const ms3 = d.getMilliseconds().toString().padStart(3, '0');
  return `${h}:${m}:${s}.${ms3}`;
}

function formatRemaining(ms: number): string {
  if (ms >= 60_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s.toString().padStart(2, '0')}s`;
  }
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatCount(n: number): string {
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
