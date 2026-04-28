/**
 * cc-cli editor — Editor's primitives surface (Project 1.12.2).
 *
 * The Editor Employee session walks the `patrol/code-review`
 * blueprint and calls these subcommands at each step. Code provides
 * the operations (claim, diff metadata, comment chits, approve /
 * reject mechanics); the agent composes them and decides at the
 * judgment branch points (severity, category, approve vs. reject).
 *
 * Subcommands:
 *   pick              Find + claim the next review-eligible task.
 *   acquire-worktree  Ensure isolated worktree on author's branch.
 *   diff              Load task + contract context + diff metadata.
 *   file-comment      Cut a review-comment chit (severity + category).
 *   approve           Fire enterClearance + clear review state.
 *   reject            Increment round + escalation chit + clear claim.
 *   bypass            Self-bypass: capHit + enterClearance(bypassed).
 *   release           Bare claim release (no chit changes).
 *   status            Admin/debug snapshot of in-flight reviews.
 *
 * Action subcommands print prose by default; --json emits the
 * structured Result<T> shape from the underlying workflow primitive.
 * The patrol/code-review blueprint instructs Editor to always pass
 * --json.
 *
 * Identity: every subcommand except `status` requires `--from <slug>`.
 * The slug must resolve to an Editor (role='editor', non-archived);
 * pickNextReview rejects otherwise. The reviewer claim is keyed by
 * this slug — every primitive in the walk has to use the same one.
 */

export async function cmdEditor(rawArgs: string[]): Promise<void> {
  const subcommand = rawArgs[0];
  const subArgs = rawArgs.slice(1);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printEditorHelp();
    return;
  }

  switch (subcommand) {
    case 'pick': {
      const { cmdEditorPick } = await import('./editor/pick.js');
      await cmdEditorPick(subArgs);
      break;
    }
    case 'acquire-worktree': {
      const { cmdEditorAcquireWorktree } = await import('./editor/acquire-worktree.js');
      await cmdEditorAcquireWorktree(subArgs);
      break;
    }
    case 'diff': {
      const { cmdEditorDiff } = await import('./editor/diff.js');
      await cmdEditorDiff(subArgs);
      break;
    }
    case 'file-comment': {
      const { cmdEditorFileComment } = await import('./editor/file-comment.js');
      await cmdEditorFileComment(subArgs);
      break;
    }
    case 'file-pattern': {
      const { cmdEditorFilePattern } = await import('./editor/file-pattern.js');
      await cmdEditorFilePattern(subArgs);
      break;
    }
    case 'approve': {
      const { cmdEditorApprove } = await import('./editor/approve.js');
      await cmdEditorApprove(subArgs);
      break;
    }
    case 'reject': {
      const { cmdEditorReject } = await import('./editor/reject.js');
      await cmdEditorReject(subArgs);
      break;
    }
    case 'bypass': {
      const { cmdEditorBypass } = await import('./editor/bypass.js');
      await cmdEditorBypass(subArgs);
      break;
    }
    case 'release': {
      const { cmdEditorRelease } = await import('./editor/release.js');
      await cmdEditorRelease(subArgs);
      break;
    }
    case 'status': {
      const { cmdEditorStatus } = await import('./editor/status.js');
      await cmdEditorStatus(subArgs);
      break;
    }
    default: {
      console.error(`cc-cli editor: unknown subcommand "${subcommand}"`);
      console.error('');
      printEditorHelp();
      process.exit(1);
    }
  }
}

function printEditorHelp(): void {
  console.log(`cc-cli editor — Editor's primitives (Project 1.12.2)

Usage:
  cc-cli editor <subcommand> [options]

Lifecycle subcommands (Editor session walks these in order):
  pick              --from <slug> [--json]
                    Find + claim the next review-eligible task.
                    Returns ok(null) when nothing's ready.

  acquire-worktree  --from <slug> --task <id> --branch <name> [--json]
                    Ensure isolated worktree at deterministic path.

  diff              --from <slug> --task <id> [--worktree <path>] [--json]
                    Load task + contract context + diff metadata.
                    File list, filtered list, oversize check; Editor
                    follows up with native Read/Grep on the worktree
                    for actual diff content.

  file-comment      --from <slug> --task <id>
                    --file <path> --line-start <n> [--line-end <n>]
                    --severity <blocker|suggestion|nit>
                    --category <bug|drift>
                    --issue "..." --why "..." [--suggested-patch "..."]
                    --review-round <n> [--json]
                    Cut review-comment chit. Severity 'blocker' rejects
                    the round; 'suggestion'/'nit' advisory only.

  file-pattern      --from <slug>
                    --kind <role|codebase-area|corp-wide>
                    [--role <id>] [--area <path>]
                    --finding "..." [--linked-comments <id,id,...>] [--json]
                    Project 1.12.3 — record a recurring theme as a
                    pattern-observation chit. Future review sessions
                    read relevant observations as priors for the
                    drift pass; the corp's review taste tightens
                    monotonically.

Terminal-state subcommands:
  approve           --from <slug> --task <id> --worktree <path> [--json]
                    Pass review. Fires enterClearance with
                    reviewBypassed=false; clears review state on
                    success.

  reject            --from <slug> --task <id> --reason "..."
                    --detail "..." [--json]
                    Fail review. Increments task.editorReviewRound,
                    sets capHit if at cap, files escalation chit
                    routing to author's role.

  bypass            --from <slug> --task <id> --reason "..."
                    --worktree <path> [--json]
                    Self-bypass — set capHit, fire enterClearance with
                    reviewBypassed=true. Rare; usually audit triggers
                    bypass when the cap is reached automatically.

  release           --from <slug> --task <id> [--json]
                    Bare claim release. No chit changes; next pick
                    re-claims.

Admin/debug:
  status            [--json]
                    In-flight review claims + recent comments + tasks
                    awaiting review.

Walked order in patrol/code-review:
  pick → acquire-worktree → diff → file-comment* → approve | reject
  Bug pass + drift pass produce file-comment events; terminal is
  approve (clean) or reject (any blocker found).
`);
}
