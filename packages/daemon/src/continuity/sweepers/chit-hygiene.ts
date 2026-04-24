/**
 * `chit-hygiene` sweeper — data integrity scan of the chit store.
 *
 * Walks every discoverable chit. Flags three classes of problem:
 *
 *   1. Malformed chits. Files under the chits/ tree whose YAML
 *      frontmatter is broken, whose required ChitCommon fields
 *      are missing, or which fail the type's validator.
 *      queryChits collects these into result.malformed — this
 *      sweeper just surfaces them as kinks. Severity=error
 *      because they're unreadable by every consumer.
 *
 *   2. Orphan references. A chit whose `references` array
 *      contains an id that no longer resolves via findChitById.
 *      Soft breakage — references are loose pointers, not
 *      dispatch-critical — but still worth surfacing so the
 *      corp's link graph stays honest. Severity=warn.
 *
 *   3. Orphan dependencies. A chit whose `dependsOn` array
 *      contains an id that doesn't resolve. Harder breakage —
 *      dependsOn drives chain-walker behavior (1.3); a bad
 *      pointer can stall a dispatch chain. Severity=error.
 *
 * ### What this does NOT do
 *
 * No deletion, no rewriting. chit-hygiene is a reporter, not a
 * fixer. Autonomously deleting/editing chits would:
 *   - Destroy soul material if the "malformed" was actually a
 *     temporary parse issue from a mid-write race.
 *   - Rewrite references without knowing the semantic intent
 *     (maybe the orphan pointer is meaningful in context the
 *     sweeper can't see).
 *
 * Sexton reads the kinks and decides — often escalating to
 * founder for review when errors pile up.
 *
 * ### Auto-resolve
 *
 * Runner's auto-resolve handles "malformed chit got fixed" and
 * "broken pointer got repaired" cleanly: next run doesn't emit
 * a finding for that subject → runner closes the prior kink.
 */

import { queryChits } from '@claudecorp/shared';
import { log } from '../../logger.js';
import type { SweeperContext, SweeperResult, SweeperFinding } from './types.js';

export async function runChitHygiene(ctx: SweeperContext): Promise<SweeperResult> {
  const { daemon } = ctx;
  const findings: SweeperFinding[] = [];
  let malformedCount = 0;
  let orphanRefCount = 0;
  let orphanDepCount = 0;

  // Single query over all types (default when `types` is omitted)
  // across all scopes. queryChits separates malformed files into
  // result.malformed so we don't choke on bad YAML + can surface
  // those as their own class of finding.
  let result;
  try {
    result = queryChits(daemon.corpRoot, {
      // No type filter — we want every chit in the store.
      // No status filter — include active + cold + closed;
      // malformed data is bad regardless of lifecycle state.
      includeArchive: true,
      limit: 0, // unlimited — hygiene must see the full store
    });
  } catch (err) {
    return {
      status: 'failed',
      findings: [],
      summary: `chit-hygiene: query failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Direction 1: malformed chits.
  for (const m of result.malformed) {
    malformedCount++;
    findings.push({
      subject: m.path,
      severity: 'error',
      title: `Malformed chit at ${shortenPath(daemon.corpRoot, m.path)}`,
      body: `Chit file at ${m.path} failed to parse. Parser error: ${m.error}. Encountered at ${m.timestamp}. The file exists but can't be loaded by any consumer — dispatch, chain walker, wtf, TUI all skip it silently. Review and repair the YAML frontmatter, or \`rm\` the file if it's junk. See also ${daemon.corpRoot}/chits/_log/malformed.jsonl for the corp-level audit log.`,
    });
    log(`[sweeper:chit-hygiene] malformed ${m.path}: ${m.error}`);
  }

  // Build the universe of known ids ONCE from the already-loaded
  // query result. Replaces a prior per-ref findChitById call which
  // walked the chit store on every lookup — O(N × (R+D)) with a
  // filesystem-walk constant on each call. On a mature corp with
  // thousands of chits + typical 1-3 refs per chit, that was 10k+
  // fs scans per patrol.
  //
  // With the Set: O(N + R+D) total, O(1) per membership check.
  // Malformed chits are intentionally excluded from the set — they
  // HAVE ids in their (broken) frontmatter, but since no consumer
  // can load them, a reference pointing at a malformed chit is
  // effectively broken. Flagging it as orphan is more conservative
  // than extracting ids from unparseable files.
  const knownIds = new Set<string>(result.chits.map((c) => c.chit.id));

  // Direction 2 + 3: orphan references / dependsOn across all
  // well-formed chits.
  for (const item of result.chits) {
    const chit = item.chit;
    const refs = Array.isArray(chit.references) ? chit.references : [];
    const deps = Array.isArray(chit.dependsOn) ? chit.dependsOn : [];

    const orphanRefs: string[] = [];
    for (const refId of refs) {
      if (!knownIds.has(refId)) orphanRefs.push(refId);
    }
    const orphanDeps: string[] = [];
    for (const depId of deps) {
      if (!knownIds.has(depId)) orphanDeps.push(depId);
    }

    if (orphanRefs.length > 0) {
      orphanRefCount += orphanRefs.length;
      findings.push({
        subject: `${chit.id}:references`,
        severity: 'warn',
        title: `Chit ${chit.id} has ${orphanRefs.length} orphan reference(s)`,
        body: `Chit ${chit.id} (type=${chit.type}) carries references to chit ids that no longer resolve: ${orphanRefs.join(', ')}. References are soft pointers (no cascade), so this doesn't break dispatch, but it degrades the link graph and can confuse readers who follow the references for context. Either the referenced chits were deleted (expected — removing the orphan refs cleans up), or the ids are typos (expected — fix them to the right ids).`,
      });
      log(`[sweeper:chit-hygiene] orphan refs on ${chit.id}: ${orphanRefs.join(',')}`);
    }

    if (orphanDeps.length > 0) {
      orphanDepCount += orphanDeps.length;
      findings.push({
        subject: `${chit.id}:dependsOn`,
        severity: 'error',
        title: `Chit ${chit.id} has ${orphanDeps.length} orphan dependsOn`,
        body: `Chit ${chit.id} (type=${chit.type}) has dependsOn pointers that don't resolve: ${orphanDeps.join(', ')}. dependsOn drives 1.3's chain walker; a broken pointer means this chit can never be "ready" via the normal chain-advance path. If the referenced chit was intentionally removed, the dependsOn entry should be pruned (it's pinned a dead wait). If the dependsOn was meant to point somewhere else, fix the id. Until resolved, this chit is silently stuck.`,
      });
      log(`[sweeper:chit-hygiene] orphan deps on ${chit.id}: ${orphanDeps.join(',')}`);
    }
  }

  if (malformedCount === 0 && orphanRefCount === 0 && orphanDepCount === 0) {
    return {
      status: 'noop',
      findings: [],
      summary: `chit-hygiene: clean (scanned ${result.chits.length} well-formed chits + ${result.malformed.length} malformed entries).`,
    };
  }

  return {
    status: 'completed',
    findings,
    summary: `chit-hygiene: ${malformedCount} malformed, ${orphanRefCount} orphan reference(s), ${orphanDepCount} orphan dependsOn. Scanned ${result.chits.length + result.malformed.length} file(s).`,
  };
}

/**
 * Compact a full path into the corp-relative portion so kink
 * titles stay legible. `corpRoot`/chits/observation/abc.md →
 * `chits/observation/abc.md`.
 */
function shortenPath(corpRoot: string, fullPath: string): string {
  if (fullPath.startsWith(corpRoot)) {
    return fullPath.slice(corpRoot.length).replace(/^[/\\]/, '');
  }
  return fullPath;
}
