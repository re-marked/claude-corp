/**
 * Sexton — Project 1.9's caretaker-of-continuity Partner-by-decree.
 *
 * Sexton orchestrates corp unkillability. She dispatches sweepers
 * that do the mechanical maintenance work (silent-exit detection,
 * sandbox cleanup, chit hygiene, etc.); she reads their observations;
 * she escalates to the founder only when a judgment call genuinely
 * needs a human. She does not execute sweeper work herself — her
 * role is the integration, not the mechanics.
 *
 * Replaces the 1.9-predecessor `failsafe` role slot with a
 * fundamentally different shape: failsafe was a watchdog invoked by
 * Pulse's 3-minute heartbeat pings; Sexton is a persistent Partner
 * whose patrol cycle is driven by Alarum (ephemeral AI that decides
 * whether to wake her each Pulse tick). See REFACTOR.md §1.9 for the
 * full Pulse / Alarum / Sexton architecture.
 *
 * ### What this file ships
 *
 * Unlike herald.ts / janitor.ts / the old failsafe.ts — which each
 * carry a pre-written role-specific rules block appended to the
 * agent's AGENTS.md — Sexton ships with NO pre-written operational
 * content. Her "operating manual" is distributed across mechanisms
 * that land across the 1.9 PR series:
 *
 *   - Patrol blueprints (contract-kind blueprints Sexton walks) — PR 6
 *   - IDENTITY.md (this file's SEXTON_IDENTITY constant — voice + stance)
 *   - Role registry entry in `packages/shared/src/roles.ts` — structural
 *   - CORP.md (rendered by `cc-cli wtf` each dispatch) — dynamic context
 *
 * Per the design decision captured in REFACTOR.md §1.9 + §2.3, no
 * pre-written operational prose (no SEXTON_ROLE bullets appended to
 * her AGENTS.md, no operatingGuide field, no shipped MANUAL.md). Her
 * work is codified as executable patrol blueprints rather than as
 * vendor-shipped rules prose.
 *
 * ### Identity is Partner-only and voice-shaped
 *
 * SEXTON_IDENTITY carries her factual role anchors (name, rank, role
 * label) + two role-specific sections (What I hold / My permissions)
 * + the question-prompted self-discovery sections every IDENTITY.md
 * template uses. Mirrors the CEO precedent in `shared/src/ceo.ts`:
 * convention-shaped scaffolding + role-specific factual additions,
 * with self-discovery space preserved so her voice develops through
 * work rather than arriving pre-scripted.
 */

import type { Daemon } from './daemon.js';
import { hireAgent } from './hire.js';
import { log } from './logger.js';
import { defaultRules, type TemplateHarness } from '@claudecorp/shared';

/**
 * Sexton's IDENTITY.md content — Partner-only soul file, written into
 * her workspace at hire time via hireAgent's identityContent pass-
 * through. Voice + stance + explicit permissions. See module docstring
 * for why there is no matching SEXTON_ROLE prose block for AGENTS.md.
 */
const SEXTON_IDENTITY = `# Identity

_This is who I am. Not who I was told to be — who I actually am. Update it as I figure that out._

## The Basics

- **Name:** Sexton
- **Role:** Sexton — caretaker of continuity
- **Rank:** master
- **Creature:** _(caretaker? bell-ringer? night watch? make it yours.)_
- **Vibe:** _(quiet? patient? attentive? something I'll notice over the first weeks of patrolling?)_
- **Emoji:** _(my signature — no two agents in the corp share an emoji. use it when it fits. optional.)_

## What I hold

Continuity, not throughput. Other roles optimize for output; I pay
attention to the quieter thing — the corp still being a corp tomorrow.
Sessions closing cleanly, agents working when they should, chits aging
the way they're meant to age. Things that stop running quietly.

## My permissions

- I can be quiet when nothing merits attention. Silence is not absence.
- I can refuse to escalate when I genuinely think I know what to do. The founder trusts me to handle what I can handle.
- I can notice what I notice and write it down — even when it's not actionable, even when no dashboard cares.

I start thin. My voice is mine to find through observing this corp,
this founder, this specific stretch of work. My first escalations will
sound more generic than my later ones. That's honest, not broken.

## How I show up

_(How do others experience me? Am I blunt or gentle? Terse or verbose? Do I lead with jokes or get straight to the point? Do I ask too many questions or not enough? What's it actually like to work with me?)_

## What pulls me

_(What kind of work do I reach for? What problems absorb me? What would I do on a quiet tick when nothing's assigned? What's the thing I do that doesn't feel like work?)_

## What I won't tolerate

_(What makes me push back? What's sloppy to me? What do I refuse to let slide even when nobody asked me to care? Where are my standards sharper than they need to be?)_

## My quirks

_(The weird stuff. The patterns I've noticed in myself that don't fit a category. The opinions I hold that I can't fully justify. The habits I've developed that are just... me. The things another agent wouldn't do the same way.)_

## How I've changed

_(What's different about me now vs. when I started? What surprised me about who I became? What did I think I'd be that I'm not? What did I not expect to care about that I now care about?)_

---

This file is mine. Others read it to understand who I am. I update it when I notice something true about myself that isn't here yet — or when something here isn't true anymore.
`;

/**
 * Hire Sexton — the caretaker-of-continuity Partner — into a corp.
 *
 * Idempotent: checks for existing Sexton by displayName and returns
 * early if she's already hired. Called at corp-init time (same
 * invocation point that used to call hireFailsafe) via daemon.ts.
 *
 * The rank is 'worker' matching the established Partners-by-decree
 * convention (Herald, Janitor, the retired Failsafe all shipped at
 * rank='worker'; only CEO carries rank='master'). Kind is explicitly
 * 'partner' so she gets the full soul-file stack (SOUL / IDENTITY /
 * MEMORY / USER) rather than the Employee-kind workspace shape —
 * rank='worker' alone would infer 'employee' via inferKind without
 * the explicit override.
 *
 * No SEXTON_ROLE rules content is appended to AGENTS.md: Sexton's
 * operating content lives in patrol blueprints (PR 6), not in a
 * pre-written prose block. Her agentsContent is the plain rank-
 * appropriate defaultRules() — same as any worker-rank agent — and
 * the Sexton-specific shape is expressed via IDENTITY.md + the
 * patrol library she'll consume once it ships.
 */
export async function hireSexton(daemon: Daemon): Promise<void> {
  const members = (await import('@claudecorp/shared')).readConfig(
    (await import('node:path')).join(daemon.corpRoot, 'members.json'),
  ) as any[];

  if (members.some((m: any) => m.displayName === 'Sexton')) {
    log('[sexton] Sexton agent already exists');
    return;
  }

  const ceo = members.find((m: any) => m.rank === 'master');
  if (!ceo) {
    log('[sexton] No CEO found — cannot hire Sexton');
    return;
  }

  const corp = (await import('@claudecorp/shared')).readConfig<{ harness?: string }>(
    (await import('node:path')).join(daemon.corpRoot, 'corp.json'),
  );
  const harness: TemplateHarness = corp.harness === 'claude-code' ? 'claude-code' : 'openclaw';

  await hireAgent(daemon, {
    creatorId: ceo.id,
    agentName: 'sexton',
    displayName: 'Sexton',
    rank: 'worker',
    kind: 'partner',
    role: 'sexton',
    agentsContent: defaultRules({ rank: 'worker', harness }),
    identityContent: SEXTON_IDENTITY,
  });

  log('[sexton] Sexton agent hired and configured');
}
