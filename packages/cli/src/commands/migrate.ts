/**
 * `cc-cli migrate <target>` — corp data migrations.
 *
 * Project 0.3 ships `migrate tasks` (Task → Chit). Later sub-projects
 * add `migrate contracts`, `migrate observations`, etc. One dispatcher,
 * one subcommand per migration target. Each migration is idempotent —
 * re-running is safe.
 */

import { parseArgs } from 'node:util';
import { migrateTasksToChits, migrateContractsToChits } from '@claudecorp/shared';
import { getCorpRoot } from '../client.js';

export async function cmdMigrate(rawArgs: string[]): Promise<void> {
  const subcommand = rawArgs[0];
  const subArgs = rawArgs.slice(1);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printHelp();
    return;
  }

  switch (subcommand) {
    case 'tasks': {
      await cmdMigrateTasks(subArgs);
      break;
    }
    case 'contracts': {
      await cmdMigrateContracts(subArgs);
      break;
    }
    default: {
      console.error(`Unknown migrate subcommand: ${subcommand}`);
      console.error('');
      printHelp();
      process.exit(1);
    }
  }
}

async function cmdMigrateTasks(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      'dry-run': { type: 'boolean', default: false },
      overwrite: { type: 'boolean', default: false },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;

  if (v.help) {
    console.log(`cc-cli migrate tasks — Convert pre-chits Task files to Chits

Walks <corpRoot>/tasks/*.md, writes each task as a Chit of type=task at
<corpRoot>/chits/task/<id>.md, then deletes the source. All Task fields
(status, priority, blockedBy, parentTaskId, projectId, etc.) map into
the chit shape without data loss — see migrations/migrate-tasks.ts.

Idempotent: re-running is safe. Tasks already migrated (a chit exists
at the target path) are skipped unless --overwrite is set.

Usage:
  cc-cli migrate tasks [options]

Options:
  --dry-run       Report what would be migrated without writing or deleting
  --overwrite     If a chit already exists at the target, clobber it
  --corp <name>   Operate on a specific corp (defaults to active)
  --json          Structured result output

Exit codes:
  0 — migration succeeded (or no tasks to migrate)
  1 — at least one task failed (see errors in output)`);
    return;
  }

  const corpRoot = await getCorpRoot(typeof v.corp === 'string' ? v.corp : undefined);

  const result = migrateTasksToChits(corpRoot, {
    dryRun: !!v['dry-run'],
    overwrite: !!v.overwrite,
  });

  if (v.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (v['dry-run']) {
      console.log(`DRY RUN — would migrate ${result.planned.length} task${result.planned.length === 1 ? '' : 's'}:`);
      for (const { sourcePath, targetPath } of result.planned) {
        console.log(`  ${sourcePath}`);
        console.log(`    → ${targetPath}`);
      }
      if (result.planned.length === 0) {
        console.log(`(no tasks found at <corpRoot>/tasks/ to migrate)`);
      }
    } else {
      if (result.migrated > 0) {
        console.log(`migrated ${result.migrated} task${result.migrated === 1 ? '' : 's'}`);
      }
      if (result.skipped > 0) {
        console.log(`skipped ${result.skipped} (already migrated — chit exists at target)`);
      }
      if (result.migrated === 0 && result.skipped === 0 && result.errors.length === 0) {
        console.log(`(no tasks found at <corpRoot>/tasks/ to migrate)`);
      }
    }
    if (result.errors.length > 0) {
      console.error(`\n${result.errors.length} error${result.errors.length === 1 ? '' : 's'}:`);
      for (const { sourcePath, error } of result.errors) {
        console.error(`  ${sourcePath}`);
        console.error(`    ${error}`);
      }
    }
  }

  if (result.errors.length > 0) process.exit(1);
}

async function cmdMigrateContracts(rawArgs: string[]): Promise<void> {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      'dry-run': { type: 'boolean', default: false },
      overwrite: { type: 'boolean', default: false },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;

  if (v.help) {
    console.log(`cc-cli migrate contracts — Convert pre-chits Contract files to Chits

Walks <corpRoot>/projects/*/contracts/*.md, writes each contract as a
Chit of type=contract at <corpRoot>/projects/<name>/chits/contract/<id>.md
with scope project:<name>, then deletes the source. Full field mapping
is lossless — see migrations/migrate-contracts.ts.

Idempotent: re-running is safe. Contracts already migrated (a chit
exists at the target path) are skipped unless --overwrite is set.

Usage:
  cc-cli migrate contracts [options]

Options:
  --dry-run       Report what would be migrated without writing or deleting
  --overwrite     If a chit already exists at the target, clobber it
  --corp <name>   Operate on a specific corp (defaults to active)
  --json          Structured result output

Exit codes:
  0 — migration succeeded (or no contracts to migrate)
  1 — at least one contract failed (see errors in output)`);
    return;
  }

  const corpRoot = await getCorpRoot(typeof v.corp === 'string' ? v.corp : undefined);

  const result = migrateContractsToChits(corpRoot, {
    dryRun: !!v['dry-run'],
    overwrite: !!v.overwrite,
  });

  if (v.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (v['dry-run']) {
      console.log(
        `DRY RUN — would migrate ${result.planned.length} contract${result.planned.length === 1 ? '' : 's'}:`,
      );
      for (const { sourcePath, targetPath } of result.planned) {
        console.log(`  ${sourcePath}`);
        console.log(`    → ${targetPath}`);
      }
      if (result.planned.length === 0) {
        console.log(`(no contracts found under projects/*/contracts/ to migrate)`);
      }
    } else {
      if (result.migrated > 0) {
        console.log(`migrated ${result.migrated} contract${result.migrated === 1 ? '' : 's'}`);
      }
      if (result.skipped > 0) {
        console.log(`skipped ${result.skipped} (already migrated — chit exists at target)`);
      }
      if (result.migrated === 0 && result.skipped === 0 && result.errors.length === 0) {
        console.log(`(no contracts found under projects/*/contracts/ to migrate)`);
      }
    }
    if (result.errors.length > 0) {
      console.error(`\n${result.errors.length} error${result.errors.length === 1 ? '' : 's'}:`);
      for (const { sourcePath, error } of result.errors) {
        console.error(`  ${sourcePath}`);
        console.error(`    ${error}`);
      }
    }
  }

  if (result.errors.length > 0) process.exit(1);
}

function printHelp(): void {
  console.log(`cc-cli migrate — Corp data migrations

Usage: cc-cli migrate <target> [options]

Targets:
  tasks       Convert pre-chits Task files to Chits (Project 0.3)
  contracts   Convert pre-chits Contract files to Chits (Project 0.4)

Every migration is idempotent. Safe to re-run.

Run 'cc-cli migrate <target> --help' for per-target options.`);
}
