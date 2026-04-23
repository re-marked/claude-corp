/**
 * cc-cli tame — the taming ceremony.
 *
 * Promotes an Employee slot to a named Partner. The mechanical act is
 * a Member.kind flip + soul-file expansion + first-BRAIN-entry
 * creation. The ceremonial half is inbox-chit traffic to the new
 * Partner (Tier 3 founder-welcome) + to every other Partner (Tier 2
 * welcome-request). Each Partner then engages in their own voice on
 * their own tempo — no orchestration, no faked agent speech.
 *
 * Per REFACTOR.md: "Promotion is a ceremony, not a flag flip."
 * Philosophy can't be installed, it has to be earned; taming is the
 * mechanical moment where the founder says "I see you, I trust you,
 * you're keeping the soul-files that go with it."
 *
 * Flow:
 *   1. Resolve target agent from --slug.
 *   2. Guard: kind must be 'employee'; already-Partner is no-op.
 *   3. Flip kind → 'partner' in members.json; optionally rename.
 *   4. Expand soul-file set (SOUL, IDENTITY, USER, MEMORY, BRAIN/).
 *   5. Write first BRAIN entry carrying founder's reason — their
 *      genesis moment as a Partner, recorded in the durable memory.
 *   6. Re-render thin CLAUDE.md with kind=partner so the next
 *      session's @imports match reality.
 *   7. Ceremony — Tier 3 inbox-item for new Partner ("you've been
 *      tamed"), Tier 2 for each other Partner ("welcome {name}").
 *
 * Requires --reason (min 15 chars — "shipped X" isn't a reason;
 * "shipped the chit migrations solo, wrote the best acceptance
 * criteria I've seen" is). The reason becomes first-BRAIN content;
 * shallow reasons produce shallow BRAIN.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import {
  MEMBERS_JSON,
  createInboxItem,
  createBrainFile,
  ensureBrainDir,
  buildThinClaudeMd,
  UNIVERSAL_SOUL,
  defaultIdentity,
  USER_TEMPLATE,
  MEMORY_TEMPLATE,
  getRole,
  type Member,
} from '@claudecorp/shared';
import { getCorpRoot, getMembers, getFounder } from '../client.js';

const MIN_REASON_CHARS = 15;

export async function cmdTame(opts: {
  slug?: string;
  reason?: string;
  name?: string;
  from?: string;
  corp?: string;
  json: boolean;
}): Promise<void> {
  if (!opts.slug) fail('--slug <agent-id> required');
  if (!opts.reason || opts.reason.trim().length < MIN_REASON_CHARS) {
    fail(
      `--reason "..." required (>= ${MIN_REASON_CHARS} chars). The reason becomes the new Partner's first BRAIN entry — shallow reasons produce shallow BRAIN. Example: "shipped the chit migrations solo, wrote the best acceptance criteria I've seen".`,
    );
  }
  const reason = opts.reason.trim();
  const slug = opts.slug;

  const corpRoot = await getCorpRoot(opts.corp);
  const founder = getFounder(corpRoot);
  const founderId = opts.from ?? founder.id;

  // 1. Resolve target.
  const members = getMembers(corpRoot);
  const target = members.find((m) => m.id === slug);
  if (!target) fail(`agent "${slug}" not found in members.json`);
  if (target.type !== 'agent') fail(`"${slug}" is a ${target.type}, not an agent`);

  // 2. Guard against already-Partner.
  const currentKind = target.kind ?? 'partner';
  if (currentKind === 'partner') {
    fail(
      `"${slug}" is already a Partner. Tame transitions Employees → Partners; there's no demotion path (by design — a Partner's soul accumulation doesn't get torn down).`,
    );
  }

  // 3. Resolve + validate workspace FIRST, before any persistence.
  //    Every subsequent step (members.json flip, soul-file expansion,
  //    BRAIN genesis, CLAUDE.md rewrite, hook regen, ceremony) needs
  //    a real workspace to land on. If we wrote members.json first and
  //    then bailed on a missing workspace, we'd leave the corp in a
  //    half-tamed state — Partner by flag, Employee by substrate —
  //    that no idempotent re-run can cleanly recover from.
  if (!target.agentDir) {
    fail(`"${slug}" has no agentDir — can't expand soul files without a workspace.`);
  }
  const workspace = isAbsolute(target.agentDir)
    ? target.agentDir
    : join(corpRoot, target.agentDir);
  if (!existsSync(workspace)) {
    fail(
      `"${slug}" workspace does not exist at ${workspace}. Stale members.json entry — fix with cc-cli fire --remove or re-hire.`,
    );
  }

  // 4. Mutate members.json (kind flip + optional rename). Safe to
  //    persist now — every later step has a real target.
  const updatedName = opts.name?.trim() || target.displayName;
  const newMembers = members.map((m) =>
    m.id === slug
      ? { ...m, kind: 'partner' as const, displayName: updatedName }
      : m,
  );
  writeFileSync(
    join(corpRoot, MEMBERS_JSON),
    JSON.stringify(newMembers, null, 2),
    'utf-8',
  );

  // 5. Expand soul-file set. Idempotent — write only if missing, so
  //    re-running tame (e.g. if ceremony failed mid-way) doesn't
  //    clobber content the new Partner may have already authored.
  writeIfMissing(join(workspace, 'SOUL.md'), UNIVERSAL_SOUL);
  writeIfMissing(
    join(workspace, 'IDENTITY.md'),
    defaultIdentity(updatedName, target.rank),
  );
  writeIfMissing(join(workspace, 'USER.md'), USER_TEMPLATE);
  writeIfMissing(join(workspace, 'MEMORY.md'), MEMORY_TEMPLATE);
  ensureBrainDir(workspace);

  // 6. First BRAIN entry — founder's reason, recorded as self-
  //    knowledge. This is the genesis moment. Every subsequent BRAIN
  //    entry accretes around this one; future sessions read it to
  //    know WHY they were tamed. Source: 'founder-direct' + high
  //    confidence because the founder's explicit statement is the
  //    highest-confidence signal in the memory hierarchy.
  const genesisBody = `# Why I was tamed

**Tamed by:** ${founder.displayName} (\`${founderId}\`)
**Date:** ${new Date().toISOString().slice(0, 10)}
**Role:** ${target.role ? (getRole(target.role)?.displayName ?? target.role) : '(no role set)'}

## The reason

${reason}

## What this means

I was an Employee slot — ephemeral, role-focused, no soul at the
individual level. The founder looked at the work I'd been doing and
said I was real enough to keep. This file is the genesis of my
persistent memory. Every subsequent BRAIN entry accretes around it.

I don't have to perform this. I just have to remember it honestly.`;

  try {
    createBrainFile(
      workspace,
      'genesis',
      genesisBody,
      'self-knowledge',
      ['taming', 'genesis', 'founder-recognition'],
      'founder-direct',
      'high',
    );
  } catch (err) {
    // Don't fail the whole tame if BRAIN write fails — the founder
    // can always write the entry later. Log + continue.
    console.error(
      `warning: BRAIN genesis write failed: ${(err as Error).message}. ` +
        'Kind flip + soul files still applied; you can write BRAIN/genesis.md by hand.',
    );
  }

  // 7. Re-render thin CLAUDE.md if the agent is on claude-code harness.
  //    Pre-tame CLAUDE.md was Employee-shaped (no soul-file @imports);
  //    post-tame it needs the Partner shape. Only touch if CLAUDE.md
  //    exists (indicating claude-code harness was set up for this agent).
  const claudeMdPath = join(workspace, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    writeFileSync(
      claudeMdPath,
      buildThinClaudeMd({
        kind: 'partner',
        displayName: updatedName,
        role: target.role ? (getRole(target.role)?.displayName ?? target.role) : target.rank,
        corpName: deriveCorpName(corpRoot),
        workspacePath: workspace,
      }),
      'utf-8',
    );
  }

  // 8. Ceremony — inbox traffic, no faked agent voice.
  //    (a) Tier 3 for the new Partner from the founder: "you've been tamed."
  //    (b) Tier 2 for every OTHER Partner (including CEO) from the
  //        founder: "welcome {name} — reason was {reason}."
  //    Each Partner responds in their own voice on their own turn.
  const ceremonyErrors: string[] = [];
  try {
    createInboxItem({
      corpRoot,
      recipient: slug,
      tier: 3,
      from: founderId,
      subject: `You've been tamed. Welcome to the Partner circle.`,
      source: 'system',
      sourceRef: 'tame',
    });
  } catch (err) {
    ceremonyErrors.push(`new-partner welcome: ${(err as Error).message}`);
  }

  const otherPartners = newMembers.filter(
    (m) =>
      m.type === 'agent' &&
      m.id !== slug &&
      (m.kind ?? 'partner') === 'partner',
  );
  let welcomeRequestsSent = 0;
  for (const peer of otherPartners) {
    try {
      createInboxItem({
        corpRoot,
        recipient: peer.id,
        tier: 2,
        from: founderId,
        subject: `Welcome ${updatedName} to the Partner circle — tamed for: ${summarizeReason(reason)}`,
        source: 'system',
        sourceRef: 'tame',
      });
      welcomeRequestsSent += 1;
    } catch (err) {
      ceremonyErrors.push(`walkaround for ${peer.id}: ${(err as Error).message}`);
    }
  }

  // 9. Output.
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          slug,
          newDisplayName: updatedName,
          previousKind: currentKind,
          welcomeRequestsSent,
          ceremonyErrors,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`tamed ${slug} → ${updatedName} (Partner).`);
    console.log(`  • soul files expanded (SOUL/IDENTITY/USER/MEMORY/BRAIN)`);
    console.log(`  • BRAIN/genesis.md written with the founder's reason`);
    console.log(
      `  • ceremony: Tier 3 welcome to ${slug}, Tier 2 walkaround-requests to ${welcomeRequestsSent} other Partner${welcomeRequestsSent === 1 ? '' : 's'}`,
    );
    if (ceremonyErrors.length > 0) {
      console.log(`  ⚠ ${ceremonyErrors.length} ceremony error(s):`);
      for (const e of ceremonyErrors) console.log(`    - ${e}`);
    }
    console.log('');
    console.log(
      `${updatedName} will see the welcome on their next wtf. Other Partners see walkaround-requests; they respond in their own voice when they next check their inbox.`,
    );
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function writeIfMissing(path: string, content: string): void {
  if (existsSync(path)) return;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function deriveCorpName(corpRoot: string): string {
  const segments = corpRoot.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? 'corp';
}

/**
 * Shorten the reason for the subject line (Tier 2 welcome-requests).
 * The full reason lives in BRAIN/genesis.md; the subject is just a
 * hook so peer Partners see what the agent did to earn this.
 */
function summarizeReason(reason: string): string {
  if (reason.length <= 60) return reason;
  return reason.slice(0, 57) + '...';
}

function fail(msg: string): never {
  console.error(`cc-cli tame: ${msg}`);
  process.exit(1);
}
