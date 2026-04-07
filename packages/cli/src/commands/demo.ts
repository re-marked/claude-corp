/**
 * cc-cli demo — play scripted demo scenarios for video recording.
 *
 * Usage:
 *   cc-cli demo list                    # list available scenarios
 *   cc-cli demo overview                # play the overview scenario
 *   cc-cli demo overview --speed 2x     # 2x speed
 *   cc-cli demo overview --pause 30s    # pause at 30s for screenshot
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { playScenario } from '../demo/player.js';
import type { Scenario, PlayerOptions } from '../demo/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve scenario directory — handles src (npx tsx), dist (built), and chunked layouts. */
function getScenariosDir(): string {
  // Built layout: dist/demo-CHUNK.js + dist/demo/scenarios/
  const builtSibling = join(__dirname, 'demo', 'scenarios');
  if (existsSync(builtSibling)) return builtSibling;

  // tsx layout: src/commands/demo.ts + src/demo/scenarios/
  const tsxSibling = join(__dirname, '..', 'demo', 'scenarios');
  if (existsSync(tsxSibling)) return tsxSibling;

  // Last resort — walk up to find packages/cli/src/demo/scenarios
  const altDir = join(__dirname, '..', '..', 'src', 'demo', 'scenarios');
  if (existsSync(altDir)) return altDir;

  return tsxSibling;
}

function listScenarios(): Scenario[] {
  const dir = getScenariosDir();
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Scenario;
      } catch {
        return null;
      }
    })
    .filter((s): s is Scenario => s !== null);
}

function parseSpeed(input: string | undefined): number {
  if (!input) return 1.0;
  const match = input.match(/^(\d*\.?\d+)x?$/);
  if (!match) return 1.0;
  return parseFloat(match[1]!);
}

function parsePauseAt(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const match = input.match(/^(\d+)s?$/);
  if (!match) return undefined;
  return parseInt(match[1]!, 10);
}

export interface DemoOpts {
  args: string[];
  speed?: string;
  pause?: string;
  corp?: string;
  noCleanup?: boolean;
  reset?: boolean;
}

/**
 * Reset a demo corp to a clean state for re-recording.
 * Wipes all channel JSONLs (preserves channels.json), all tasks, and any
 * agents beyond the system bootstrap (CEO, Failsafe, Janitor, Warden, Herald, Planner).
 */
async function resetDemoCorp(corpRoot: string): Promise<void> {
  const { writeFileSync, readdirSync, existsSync, rmSync } = await import('node:fs');
  const { readConfig, writeConfig, MEMBERS_JSON, CHANNELS_JSON } = await import('@claudecorp/shared');

  // 1. Wipe all message JSONLs
  try {
    const channels = readConfig<any[]>(join(corpRoot, CHANNELS_JSON));
    for (const ch of channels) {
      const msgPath = join(corpRoot, ch.path, 'messages.jsonl');
      if (existsSync(msgPath)) writeFileSync(msgPath, '');
    }
  } catch {}

  // 2. Wipe all tasks
  try {
    const tasksDir = join(corpRoot, 'tasks');
    if (existsSync(tasksDir)) {
      for (const f of readdirSync(tasksDir)) {
        if (f.endsWith('.md')) rmSync(join(tasksDir, f));
      }
    }
  } catch {}

  // 3. Remove non-system agents from members.json
  try {
    const membersPath = join(corpRoot, MEMBERS_JSON);
    const members = readConfig<any[]>(membersPath);
    const SYSTEM = new Set(['ceo', 'failsafe', 'janitor', 'warden', 'herald', 'planner']);
    const cleaned = members.filter(m => m.type !== 'agent' || SYSTEM.has(m.id));
    writeConfig(membersPath, cleaned);
  } catch {}

  // 4. Wipe BRAIN/observations for system agents (so dreams demo starts fresh)
  try {
    for (const id of ['ceo', 'failsafe', 'janitor', 'warden', 'herald', 'planner']) {
      const brainDir = join(corpRoot, 'agents', id, 'BRAIN');
      const obsDir = join(corpRoot, 'agents', id, 'observations');
      if (existsSync(brainDir)) rmSync(brainDir, { recursive: true });
      if (existsSync(obsDir)) rmSync(obsDir, { recursive: true });
    }
  } catch {}
}

export async function cmdDemo(opts: DemoOpts): Promise<void> {
  const sub = opts.args[0];

  // cc-cli demo list
  if (!sub || sub === 'list') {
    const scenarios = listScenarios();
    if (scenarios.length === 0) {
      console.log('No scenarios found.');
      return;
    }
    console.log('\nAvailable demo scenarios:\n');
    for (const s of scenarios) {
      console.log(`  ${s.name.padEnd(20)} ${s.title}`);
      console.log(`  ${' '.repeat(20)} ${s.description}`);
      console.log(`  ${' '.repeat(20)} duration: ${s.durationSec}s\n`);
    }
    console.log('Run: cc-cli demo <name>\n');
    return;
  }

  // cc-cli demo reset <corp>
  if (sub === 'reset') {
    const corpName = opts.args[1] ?? opts.corp;
    if (!corpName) {
      console.error('Usage: cc-cli demo reset <corp-name>');
      process.exit(1);
    }
    const corpRoot = join(homedir(), '.claudecorp', corpName);
    if (!existsSync(corpRoot)) {
      console.error(`Corp "${corpName}" not found.`);
      process.exit(1);
    }
    console.log(`\n🧹 Resetting demo corp "${corpName}"...`);
    await resetDemoCorp(corpRoot);
    console.log(`✓ Reset complete. Channels, tasks, non-system agents, BRAIN, and observations cleared.\n`);
    return;
  }

  // cc-cli demo <scenario>
  const scenarios = listScenarios();
  const scenario = scenarios.find(s => s.name === sub);
  if (!scenario) {
    console.error(`Scenario "${sub}" not found.`);
    console.error(`Run: cc-cli demo list`);
    process.exit(1);
  }

  // Resolve corp root — use the scenario's setup.corpName
  const corpName = opts.corp ?? scenario.setup.corpName;
  const corpRoot = join(homedir(), '.claudecorp', corpName);

  // Auto-reset before playback if --reset flag passed
  if (opts.reset && existsSync(corpRoot)) {
    console.log(`\n🧹 Resetting "${corpName}" before playback...`);
    await resetDemoCorp(corpRoot);
  }

  if (!existsSync(corpRoot)) {
    console.error(`\n✗ Demo corp "${corpName}" doesn't exist yet.`);
    console.error(`\nCreate it first:`);
    console.error(`  cc-cli init --name ${corpName} --user ${scenario.setup.founderName ?? 'Mark'} --theme ${scenario.setup.theme ?? 'corporate'}`);
    console.error(`  cc-cli start --corp ${corpName}`);
    console.error(`\nThen open the TUI in another terminal:`);
    console.error(`  cc --corp ${corpName}`);
    console.error(`\nThen run this command again.`);
    process.exit(1);
  }

  // Find the daemon port — lives at ~/.claudecorp/.daemon.port (global, not per-corp)
  const portFile = join(homedir(), '.claudecorp', '.daemon.port');
  if (!existsSync(portFile)) {
    console.error(`\n✗ Daemon not running.`);
    console.error(`\nStart it: cc-cli start --corp ${corpName}`);
    process.exit(1);
  }
  const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
  const daemonUrl = `http://127.0.0.1:${port}`;

  // Find the scenario file path
  const scenariosDir = getScenariosDir();
  const scenarioPath = join(scenariosDir, `${sub}.json`);

  const playerOpts: PlayerOptions = {
    scenarioPath,
    speed: parseSpeed(opts.speed),
    daemonUrl,
    corpRoot,
    pauseAtSec: parsePauseAt(opts.pause),
    noCleanup: opts.noCleanup,
  };

  console.log(`\n📼 Demo recording mode`);
  console.log(`   Corp: ${corpName} (${corpRoot})`);
  console.log(`   Daemon: ${daemonUrl}`);
  console.log(`   Speed: ${playerOpts.speed}x`);
  if (playerOpts.pauseAtSec) {
    console.log(`   Pause at: ${playerOpts.pauseAtSec}s`);
  }
  console.log(`\n⚠  Make sure the TUI is open: cc --corp ${corpName}\n`);
  console.log(`Press Enter to start...`);

  await new Promise<void>(resolve => {
    process.stdin.once('data', () => resolve());
  });

  await playScenario(playerOpts);
}
