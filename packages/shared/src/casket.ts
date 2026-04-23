/**
 * Casket — the durable hook that pins an agent to their current work.
 *
 * A Casket is a Chit of `type: 'casket'`, one per agent, with
 * deterministic id `casket-<agent-slug>`. Its single functional field
 * is `fields.casket.currentStep`, a Chit id pointing at the Task the
 * agent is currently on (or null when idle). Sessions die, contexts
 * compact, agents respawn — the Casket survives on disk and carries
 * the agent's position forward.
 *
 * Until this module shipped, Casket was ~1% built: the chit type was
 * registered (schema + validator in chit-types.ts) and one reader in
 * wtf-state.ts returned `undefined` when the Casket was missing —
 * which was always. No hire path created a Casket, nothing advanced
 * currentStep, the audit gate (0.7.3) had nothing to read.
 *
 * This module is the minimum lifecycle surface needed to make Casket
 * actually load-bearing:
 *
 *   createCasketIfMissing  — idempotent creation, called by agent-setup
 *                            and reconcile-agent-workspace at hire /
 *                            re-reconcile time.
 *   getCurrentStep         — read the pointer.
 *   advanceCurrentStep     — write the pointer (called by hand-complete,
 *                            and eventually by 1.3's chain walker).
 *   casketExists           — presence check (distinguish missing from
 *                            "exists but idle").
 *
 * Project 1.2's full scope (chain-walker integration, kind-specific
 * defaults) builds on this surface; nothing here prejudges that design.
 * We ship just enough lifecycle to unblock the audit gate.
 *
 * All writes go through the chit-store primitives, so Casket chits
 * live at `agents/<slug>/chits/casket/casket-<slug>.md` exactly like
 * any other agent-scoped chit. No special-case paths, no parallel
 * substrate.
 */

import {
  casketChitId,
  createChit,
  findChitById,
  readChit,
  updateChit,
} from './chits.js';
import type { Chit, ChitScope } from './types/chit.js';

/**
 * Agent-scope string builder — centralized so callers can't fat-finger
 * the prefix. Shares the kebab-case slug validation that casketChitId
 * already enforces.
 */
function agentScope(agentSlug: string): ChitScope {
  return `agent:${agentSlug}` as ChitScope;
}

/**
 * True iff a Casket chit exists for this agent on disk. Distinguishes
 * two states the `getCurrentStep` result conflates:
 *   - Casket exists, currentStep is null (agent is idle)    → true, null
 *   - Casket does not exist (agent never had one)           → false
 * The audit gate uses the first state to mean "approve — no task to
 * gate"; the second means "the agent's substrate is broken, log + fail
 * open instead of blocking." Different handling in each case.
 */
export function casketExists(corpRoot: string, agentSlug: string): boolean {
  const id = casketChitId(agentSlug);
  try {
    const hit = findChitById(corpRoot, id);
    return hit !== null && hit.chit.type === 'casket';
  } catch {
    return false;
  }
}

/**
 * Create a Casket for this agent if one doesn't already exist. Returns
 * the existing chit unchanged when idempotent-no-op; returns the
 * freshly-created chit otherwise. Does not throw on re-creation — the
 * whole point is that agent-setup and reconcile-agent-workspace can
 * call this on every workspace init pass without guarding against
 * duplicate-create errors.
 *
 * `createdBy` is the author written into the chit frontmatter. For
 * hire-time creation, pass the agent's own slug — Casket is agent-owned
 * state, and git attribution matches the substrate's owner. Founder
 * hires an agent; the agent "owns" its own Casket from the first
 * moment.
 *
 * Fresh Caskets start with `currentStep: null` (idle). A later hand or
 * chain advance sets the pointer.
 */
export function createCasketIfMissing(
  corpRoot: string,
  agentSlug: string,
  createdBy: string,
): Chit<'casket'> {
  const id = casketChitId(agentSlug);
  const existing = findChitById(corpRoot, id);
  if (existing && existing.chit.type === 'casket') {
    return existing.chit as Chit<'casket'>;
  }

  return createChit(corpRoot, {
    type: 'casket',
    id,
    scope: agentScope(agentSlug),
    createdBy,
    fields: {
      casket: {
        currentStep: null,
        sessionCount: 0,
      },
    },
    body:
      // Human-readable preamble — Casket body isn't load-bearing (the
      // pointer lives in frontmatter) but an agent or founder eyeballing
      // the raw file on disk deserves a one-liner explaining what it is.
      `Durable work-pointer for \`${agentSlug}\`. ` +
      `The \`currentStep\` frontmatter field points at this agent's active task chit ` +
      `(or is null when idle). Managed by the casket lifecycle helpers; ` +
      `don't edit by hand unless you know what you're doing.\n`,
  });
}

/**
 * Read the agent's current step pointer. Returns:
 *   - `string` — the chit id the agent is on (not yet verified to resolve)
 *   - `null`   — Casket exists, agent is idle
 *   - `undefined` — Casket does not exist (substrate gap; audit treats as fail-open)
 *
 * The three-way return is deliberate: callers that need to distinguish
 * "idle" from "broken" can. Callers that don't can treat undefined+null
 * interchangeably via `?? null`.
 */
export function getCurrentStep(
  corpRoot: string,
  agentSlug: string,
): string | null | undefined {
  const id = casketChitId(agentSlug);
  const hit = findChitById(corpRoot, id);
  if (!hit || hit.chit.type !== 'casket') return undefined;
  const { currentStep } = (hit.chit as Chit<'casket'>).fields.casket;
  return currentStep ?? null;
}

/**
 * Advance (or clear) the Casket's current step pointer. Throws if the
 * Casket doesn't exist — caller is responsible for createCasketIfMissing
 * before their first advance. Every advance bumps `lastAdvanced` to an
 * ISO timestamp for observability; `sessionCount` is left to
 * session-boundary hooks to bump (not this helper's job).
 *
 * The `nextStepId` is NOT validated to exist or be an active Task chit
 * — that's chain-walker (1.3) semantics, not Casket primitive
 * semantics. Casket is a dumb pointer; the walker enforces chain
 * invariants. Separating concerns keeps Casket simple and keeps the
 * walker replaceable.
 */
export function advanceCurrentStep(
  corpRoot: string,
  agentSlug: string,
  nextStepId: string | null,
  updatedBy: string,
): Chit<'casket'> {
  const id = casketChitId(agentSlug);
  // updateChit deep-merges at fields.<type> so we only name the sub-fields
  // we're changing — sessionCount (and any other future sub-fields) get
  // preserved without an explicit spread.
  return updateChit(corpRoot, agentScope(agentSlug), 'casket', id, {
    updatedBy,
    fields: {
      casket: {
        currentStep: nextStepId,
        lastAdvanced: new Date().toISOString(),
      },
    },
  }) as Chit<'casket'>;
}

/**
 * Bump `sessionCount` by 1 — called by session-boundary hooks each
 * time a fresh Claude Code session boots against this agent's
 * workspace. Pure observability; nothing gates on this value today.
 * Separate helper (not folded into advanceCurrentStep) because session
 * starts and step advances are orthogonal events — one can happen
 * without the other.
 */
export function incrementSessionCount(
  corpRoot: string,
  agentSlug: string,
  updatedBy: string,
): Chit<'casket'> {
  const id = casketChitId(agentSlug);
  // Need a read first because we're computing a delta (count + 1) against
  // the current value. Concurrent session-boot races could clobber — if
  // two sessions boot within milliseconds, the first bump may land on the
  // original value, the second on the first's post-write state, and total
  // count stays accurate. Losing one count occasionally is acceptable for
  // pure observability; we don't need transactional correctness here.
  const hit = readChit(corpRoot, agentScope(agentSlug), 'casket', id);
  const existing = (hit.chit as Chit<'casket'>).fields.casket;

  // CasketFields.currentStep is required in the type; updateChit's
  // `fields` param uses Partial<{casket: CasketFields}> which makes the
  // `casket` key optional but leaves its value required-in-full once
  // present. Runtime does a deep merge so currentStep would survive
  // anyway — but TypeScript doesn't know that, so we spread the existing
  // shape to keep the compiler honest.
  return updateChit(corpRoot, agentScope(agentSlug), 'casket', id, {
    updatedBy,
    fields: {
      casket: {
        ...existing,
        sessionCount: (existing.sessionCount ?? 0) + 1,
      },
    },
  }) as Chit<'casket'>;
}
