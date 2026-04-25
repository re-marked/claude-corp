/**
 * `cc-cli bacteria pause --role <id>` and
 * `cc-cli bacteria resume --role <id>` — founder-controlled pause
 * registry. Decision module skips paused roles entirely (no mitose,
 * no apoptose) until resumed.
 *
 * Validates the role exists + is worker-tier (pausing a non-worker
 * role is a no-op the decision module already ignores; rejecting at
 * the CLI catches typos and meaningful misuse). Idempotent: pausing
 * an already-paused role / resuming an already-active role both
 * succeed without error.
 *
 * Project 1.10.4.
 */

import { parseArgs } from 'node:util';
import { getRole, pauseRole, readPausedRoles, resumeRole } from '@claudecorp/shared';
import { getCorpRoot } from '../../client.js';

interface PauseOpts {
  role?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdBacteriaPause(rawArgs: string[]): Promise<void> {
  await runPauseAction(rawArgs, 'pause');
}

export async function cmdBacteriaResume(rawArgs: string[]): Promise<void> {
  await runPauseAction(rawArgs, 'resume');
}

async function runPauseAction(rawArgs: string[], action: 'pause' | 'resume'): Promise<void> {
  const opts = parsePauseOpts(rawArgs, action);
  if (!opts.role) {
    console.error(`cc-cli bacteria ${action}: --role <id> or positional role required`);
    process.exit(1);
  }
  const role = getRole(opts.role);
  if (!role) {
    console.error(`cc-cli bacteria ${action}: unknown role "${opts.role}"`);
    process.exit(1);
  }
  if (role.tier !== 'worker') {
    console.error(
      `cc-cli bacteria ${action}: role "${opts.role}" is tier=${role.tier}, not worker — bacteria only manages worker pools`,
    );
    process.exit(1);
  }

  const corpRoot = await getCorpRoot(opts.corp);
  const before = readPausedRoles(corpRoot);
  const wasPaused = before.has(opts.role);

  if (action === 'pause') {
    pauseRole(corpRoot, opts.role);
  } else {
    resumeRole(corpRoot, opts.role);
  }

  const result = {
    ok: true,
    action,
    role: opts.role,
    previousState: wasPaused ? 'paused' : 'active',
    newState: action === 'pause' ? 'paused' : 'active',
    idempotent: action === 'pause' ? wasPaused : !wasPaused,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.idempotent) {
    console.log(`role "${opts.role}" was already ${result.newState} — no change.`);
  } else {
    console.log(`role "${opts.role}" → ${result.newState}.`);
    if (action === 'pause') {
      console.log('  bacteria will skip this role until resumed (no mitose, no apoptose).');
      console.log('  resume with: cc-cli bacteria resume --role ' + opts.role);
    } else {
      console.log('  bacteria will reassess this role on its next tick (~5s).');
    }
  }
}

function parsePauseOpts(rawArgs: string[], action: string): PauseOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      role: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  const positional = parsed.positionals[0];
  return {
    role: (parsed.values.role as string | undefined) ?? positional,
    corp: parsed.values.corp as string | undefined,
    json: !!parsed.values.json,
  };
}
