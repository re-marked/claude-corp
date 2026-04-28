/**
 * cc-cli clearinghouse — Pressman's primitives surface (Project 1.12.1).
 *
 * The Pressman Employee session walks the `patrol/clearing` blueprint
 * and calls these subcommands at each step. Code provides the
 * operations (rebase, test, merge mechanics); the agent composes
 * them and decides at branch points (substantive conflict → file
 * blocker; consistent test fail → file blocker; hook reject → file
 * blocker; etc.).
 *
 * Subcommands:
 *   pick              Read queue + lock, claim the top submission.
 *   acquire-worktree  Ensure an isolated worktree on the branch.
 *   rebase            Fetch base + rebase + classify outcome.
 *   test              Run tests with one flake-retry + classify.
 *   merge             Push to origin + classify push outcome.
 *   finalize          Cascade merged: chit + lock + worktree cleanup.
 *   file-blocker      Cut escalation chit + fail submission + release.
 *   mark-failed       Terminal-fail or push-race re-queue + release.
 *   release           Bare cleanup (lock + worktree, no chit changes).
 *   status            Admin/debug: lock holder + queue depth + recent.
 *
 * Each action subcommand prints prose by default; `--json` emits
 * the structured `Result<T>` shape from the underlying workflow
 * primitive. The patrol blueprint instructs Pressman to always
 * pass `--json`.
 *
 * Identity: every subcommand except `status` requires `--from <slug>`.
 * The slug must resolve to a Member with `role='pressman'` —
 * pickNext rejects otherwise. The lock claim is keyed by this slug,
 * so every primitive in the walk has to use the same one.
 */

export async function cmdClearinghouse(rawArgs: string[]): Promise<void> {
  const subcommand = rawArgs[0];
  const subArgs = rawArgs.slice(1);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printClearinghouseHelp();
    return;
  }

  switch (subcommand) {
    case 'pick': {
      const { cmdClearinghousePick } = await import('./clearinghouse/pick.js');
      await cmdClearinghousePick(subArgs);
      break;
    }
    case 'acquire-worktree': {
      const { cmdClearinghouseAcquireWorktree } = await import('./clearinghouse/acquire-worktree.js');
      await cmdClearinghouseAcquireWorktree(subArgs);
      break;
    }
    case 'rebase': {
      const { cmdClearinghouseRebase } = await import('./clearinghouse/rebase.js');
      await cmdClearinghouseRebase(subArgs);
      break;
    }
    case 'test': {
      const { cmdClearinghouseTest } = await import('./clearinghouse/test.js');
      await cmdClearinghouseTest(subArgs);
      break;
    }
    case 'attribute': {
      const { cmdClearinghouseAttribute } = await import('./clearinghouse/attribute.js');
      await cmdClearinghouseAttribute(subArgs);
      break;
    }
    case 'merge': {
      const { cmdClearinghouseMerge } = await import('./clearinghouse/merge.js');
      await cmdClearinghouseMerge(subArgs);
      break;
    }
    case 'finalize': {
      const { cmdClearinghouseFinalize } = await import('./clearinghouse/finalize.js');
      await cmdClearinghouseFinalize(subArgs);
      break;
    }
    case 'file-blocker': {
      const { cmdClearinghouseFileBlocker } = await import('./clearinghouse/file-blocker.js');
      await cmdClearinghouseFileBlocker(subArgs);
      break;
    }
    case 'mark-failed': {
      const { cmdClearinghouseMarkFailed } = await import('./clearinghouse/mark-failed.js');
      await cmdClearinghouseMarkFailed(subArgs);
      break;
    }
    case 'release': {
      const { cmdClearinghouseRelease } = await import('./clearinghouse/release.js');
      await cmdClearinghouseRelease(subArgs);
      break;
    }
    case 'status': {
      const { cmdClearinghouseStatus } = await import('./clearinghouse/status.js');
      await cmdClearinghouseStatus(subArgs);
      break;
    }
    case 'log': {
      const { cmdClearinghouseLog } = await import('./clearinghouse/log.js');
      await cmdClearinghouseLog(subArgs);
      break;
    }
    case 'list': {
      const { cmdClearinghouseList } = await import('./clearinghouse/list.js');
      await cmdClearinghouseList(subArgs);
      break;
    }
    case 'show': {
      const { cmdClearinghouseShow } = await import('./clearinghouse/show.js');
      await cmdClearinghouseShow(subArgs);
      break;
    }
    default: {
      console.error(`cc-cli clearinghouse: unknown subcommand "${subcommand}"`);
      console.error('');
      printClearinghouseHelp();
      process.exit(1);
    }
  }
}

function printClearinghouseHelp(): void {
  console.log(`cc-cli clearinghouse — Pressman's primitives (Project 1.12)

Usage:
  cc-cli clearinghouse <subcommand> [options]

Lifecycle subcommands (Pressman session walks these in order):
  pick              --from <slug> [--json]
                    Read queue, claim lock, return next submission.
                    Returns ok(null) when nothing's ready.

  acquire-worktree  --from <slug> --submission <id> --branch <name> [--json]
                    Ensure isolated worktree at deterministic path.

  rebase            --from <slug> --submission <id> --worktree <path>
                    --branch <name> [--base <branch>] [--json]
                    Fetch base + rebase. Classifies into clean,
                    auto-resolved, needs-author, sanity-failed, fatal.

  test              --from <slug> --submission <id> --worktree <path>
                    [--command "..."] [--max-retries <n>] [--json]
                    Run tests with one flake retry. Classifies into
                    passed-first, flake, consistent-fail, inconclusive.

  attribute         --from <slug> --submission <id> --worktree <path>
                    --branch <name> [--base <ref>] [--command "..."] [--json]
                    Project 1.12.3 — re-run failed tests on
                    origin/main + compare failure sets. Classifies
                    into pr-introduced, main-regression, mixed, or
                    inconclusive. Drives blocker routing —
                    main-regression goes to engineering-lead.

  merge             --from <slug> --submission <id> --worktree <path>
                    --branch <name> [--json]
                    Push to origin. Classifies into merged, race,
                    hook-rejected, branch-deleted, fatal.

Terminal-state subcommands:
  finalize          --from <slug> --submission <id>
                    [--merge-sha <sha>] [--worktree <path>] [--json]
                    On clean merge: cascade chit graph + release lock
                    + remove worktree.

  file-blocker      --from <slug> --submission <id>
                    --kind <rebase-conflict|test-fail|hook-reject>
                    --summary "..." --detail "..."
                    [--worktree <path>] [--json]
                    Cut escalation chit for author's role + fail
                    submission + release.

  mark-failed       --from <slug> --submission <id> --reason "..."
                    [--requeue] [--worktree <path>] [--json]
                    Terminal-fail OR push-race re-queue (under cap)
                    + release.

  release           --from <slug> [--worktree <path>] [--json]
                    Bare cleanup — release lock + remove worktree.
                    No chit changes.

Admin/debug:
  status            [--json]
                    Lock holder, queue depth, recent submissions.

  log               [--today | --this-week | --this-month |
                    --since <iso> | --until <iso>]
                    [--merged-only | --blocked-only | --failed-only]
                    [--role <id>] [--replay <submission-id>]
                    [--verbose] [--json]
                    Project 1.12.3 — the lane's diary. Renders
                    lane-events chronologically: terminal events
                    only by default; --verbose for the firehose;
                    --replay <id> for one submission's full journey.

  list              [--status <state>] [--role <id>] [--include-merged]
                    [--include-failed] [--since <iso>] [--until <iso>]
                    [--limit <n>] [--json]
                    Project 1.12.3 — paginated submission browser.
                    Defaults to active (queued/processing/conflict);
                    flags widen to terminal states.

  show <id>         [--json]
                    Project 1.12.3 — forensic per-submission view:
                    summary, lane-event timeline, review-comments
                    grouped by severity + category, escalation
                    chain.

Walked order in patrol/clearing:
  pick → acquire-worktree → rebase → test → merge → finalize
  Branch points file-blocker / mark-failed instead of advancing.
`);
}
