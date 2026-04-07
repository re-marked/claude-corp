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

/** Resolve scenario directory — handles both src and dist paths. */
function getScenariosDir(): string {
  // Try src first (development), then dist (built)
  const srcDir = join(__dirname, '..', 'demo', 'scenarios');
  if (existsSync(srcDir)) return srcDir;
  const altDir = join(__dirname, '..', '..', 'src', 'demo', 'scenarios');
  if (existsSync(altDir)) return altDir;
  return srcDir;
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

  // Find the daemon port
  const portFile = join(corpRoot, '.daemon.port');
  if (!existsSync(portFile)) {
    console.error(`\n✗ Daemon not running for "${corpName}".`);
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
