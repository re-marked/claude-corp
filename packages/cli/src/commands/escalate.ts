/**
 * cc-cli escalate — Employee-to-Partner "I need a judgment call."
 *
 * Project 1.4. An escalation is distinct from a blocker (which is work
 * that unblocks other work) and from a hand (which is assignment of
 * work). It's a DECISION request: the Employee hit something above
 * their pay grade and wants a Partner's call before proceeding.
 *
 * Composes two 1.4 primitives:
 *
 *   1. Creates an `escalation` chit (corp scope, ephemeral, 7d TTL)
 *      carrying originatingChit / reason / from / to / severity.
 *   2. Calls the same Casket-writing mechanism hand uses to deliver
 *      the escalation chit to the target Partner's Casket.
 *
 * ### Target scope
 *
 * Partners only. Accepts a named Partner slug. Does NOT accept a role
 * (escalations can't pool-dispatch — judgment is personal). If the
 * caller passes a worker-tier role, fail with an actionable message
 * pointing at hand.
 *
 * ### Severity
 *
 *   `blocker`  — a chain is stalled, founder needs visibility → Tier 3
 *                inbox-item fires alongside the Casket write.
 *   `question` — Employee needs a call but isn't stuck → Tier 2 inbox.
 *   `review`   — Employee wants a second pair of eyes on completed work
 *                before shipping → Tier 2 inbox.
 *
 * ### Flow
 *
 *   1. Resolve originating work chit (the thing Employee was on) from
 *      either --chit or the caller's Casket.currentStep (best-effort
 *      fallback so agents don't have to restate what they were doing).
 *   2. Resolve target Partner by slug. Reject roles + Employees.
 *   3. Create escalation chit (corp scope, references originatingChit).
 *   4. Write target's Casket.currentStep = escalationChitId.
 *   5. Fire inbox-item at severity-matched tier.
 *   6. Return.
 */

import { parseArgs } from 'node:util';
import {
  type Member,
  advanceCurrentStep,
  getCurrentStep,
  createChit,
  createInboxItem,
  getRole,
  type EscalationFields,
} from '@claudecorp/shared';
import { getCorpRoot, getMembers, getFounder } from '../client.js';

const MIN_REASON_CHARS = 20;

export interface EscalateOpts {
  to?: string;
  reason?: string;
  chit?: string;
  severity?: EscalationFields['severity'];
  from?: string;
  corp?: string;
  json?: boolean;
}

export async function cmdEscalate(rawArgs: string[]): Promise<void>;
export async function cmdEscalate(opts: EscalateOpts): Promise<void>;
export async function cmdEscalate(input: string[] | EscalateOpts): Promise<void> {
  const opts = Array.isArray(input) ? parseOpts(input) : input;

  if (!opts.to) fail('--to <partner-slug> required');
  if (!opts.reason || opts.reason.trim().length < MIN_REASON_CHARS) {
    fail(
      `--reason "..." required (min ${MIN_REASON_CHARS} chars). Escalations ` +
        `are decision requests — the Partner needs the "what I hit + what I ` +
        `need" spelled out, not "please help". Example: "migration script ` +
        `fails on the legacy timezone field; unclear whether to coerce UTC ` +
        `or preserve local — your call".`,
    );
  }
  const severity: EscalationFields['severity'] = opts.severity ?? 'question';
  if (!isValidSeverity(severity)) {
    fail(`--severity must be one of: blocker | question | review (got "${severity}")`);
  }

  const corpRoot = await getCorpRoot(opts.corp);
  const members = safeGetMembers(corpRoot);
  const founder = getFounder(corpRoot);
  const fromId = opts.from ?? fail('--from <your-slug> required — escalations name the Employee') as never;

  // 1. Resolve originating chit. Prefer explicit --chit; fall back to
  // the Employee's Casket currentStep (so agents don't have to restate
  // their current work in the escalate invocation).
  let originatingChit = opts.chit;
  if (!originatingChit) {
    try {
      const cs = getCurrentStep(corpRoot, fromId);
      originatingChit = typeof cs === 'string' ? cs : undefined;
    } catch {
      // ignore — fall through to error
    }
  }
  if (!originatingChit) {
    fail(
      `--chit <chit-id> required (or run with a Casket currentStep set). ` +
        `An escalation must name the work it's about.`,
    );
  }

  // 2. Resolve target: must be a named Partner, NOT a role, NOT an Employee.
  const target = resolvePartnerTarget(members, opts.to);
  if (target.kind === 'error') fail(target.message);

  // 3. Create escalation chit.
  const chit = createChit(corpRoot, {
    type: 'escalation',
    scope: 'corp',
    fields: {
      escalation: {
        originatingChit,
        reason: opts.reason.trim(),
        from: fromId,
        to: target.member.id,
        severity,
      },
    } as never,
    createdBy: fromId,
    references: [originatingChit],
    body:
      `Escalation from \`${fromId}\` to \`${target.member.id}\` (${severity}).\n\n` +
      `Originating chit: \`${originatingChit}\`\n\n` +
      `## What I hit\n\n${opts.reason.trim()}\n`,
  });

  // 4. Land on target's Casket. Escalation IS work from the Partner's
  // perspective — they need to resolve it before the Employee can proceed.
  try {
    advanceCurrentStep(corpRoot, target.member.id, chit.id, fromId);
  } catch (err) {
    fail(`casket advance failed: ${(err as Error).message}`);
  }

  // 5. Inbox notification. Blocker severity → Tier 3 (founder sees,
  // audit gate blocks session completion until resolved). Others → Tier 2.
  const tier = severity === 'blocker' ? 3 : 2;
  let announced = false;
  try {
    createInboxItem({
      corpRoot,
      recipient: target.member.id,
      tier,
      from: fromId,
      subject: renderSubject(severity, opts.reason.trim()),
      source: 'escalation',
      sourceRef: chit.id,
    });
    announced = true;
  } catch {
    // non-fatal
  }

  // Tier 3 also notifies the founder so chain-stalling escalations
  // reach them without relying on the Partner to forward.
  if (severity === 'blocker' && founder.id !== target.member.id) {
    try {
      createInboxItem({
        corpRoot,
        recipient: founder.id,
        tier: 3,
        from: fromId,
        subject: `CHAIN STALLED: ${target.member.displayName} needs to unblock ${fromId} — ${renderSubject(severity, opts.reason.trim())}`,
        source: 'escalation',
        sourceRef: chit.id,
      });
    } catch {
      // non-fatal
    }
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          escalation: chit.id,
          originatingChit,
          target: target.member.id,
          severity,
          inboxTier: tier,
          announced,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`escalated ${chit.id} → ${target.member.displayName} [${severity}]`);
    console.log(`  originating: ${originatingChit}`);
    console.log(`  inbox tier: ${tier}${severity === 'blocker' ? ' (founder also notified)' : ''}`);
  }
}

// ─── Target resolution ──────────────────────────────────────────────

type PartnerResolution =
  | { kind: 'resolved'; member: Member }
  | { kind: 'error'; message: string };

function resolvePartnerTarget(members: Member[], to: string): PartnerResolution {
  const member = members.find(
    (m) => m.type === 'agent' && m.status === 'active' && m.id === to,
  );
  if (member) {
    const kind = member.kind ?? 'partner';
    if (kind !== 'partner') {
      return {
        kind: 'error',
        message:
          `"${to}" is an Employee, not a Partner. Escalations go UP the ` +
          `hierarchy — address a Partner by name. Use \`cc-cli block\` to ` +
          `request work from a peer Employee instead.`,
      };
    }
    return { kind: 'resolved', member };
  }

  // Did they pass a role id by mistake?
  if (getRole(to)) {
    return {
      kind: 'error',
      message:
        `"${to}" is a role, not a Partner slug. Escalations go to a NAMED ` +
        `Partner (judgment is personal — can't pool-dispatch). Use ` +
        `\`cc-cli hand --to ${to}\` for pool-resolved work assignment.`,
    };
  }

  return {
    kind: 'error',
    message:
      `no active agent with id "${to}". Escalations target a specific Partner ` +
      `by member id (e.g. \`ceo\`, \`adviser\`).`,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function isValidSeverity(s: unknown): s is EscalationFields['severity'] {
  return s === 'blocker' || s === 'question' || s === 'review';
}

function renderSubject(severity: EscalationFields['severity'], reason: string): string {
  const tag = severity === 'blocker' ? '[BLOCKER]' : severity === 'review' ? '[REVIEW]' : '[QUESTION]';
  const brief = reason.length <= 60 ? reason : reason.slice(0, 57) + '...';
  return `${tag} ${brief}`;
}

function safeGetMembers(corpRoot: string): Member[] {
  try {
    return getMembers(corpRoot);
  } catch {
    return [];
  }
}

function parseOpts(rawArgs: string[]): EscalateOpts {
  const parsed = parseArgs({
    args: rawArgs,
    options: {
      to: { type: 'string' },
      reason: { type: 'string' },
      chit: { type: 'string' },
      severity: { type: 'string' },
      from: { type: 'string' },
      corp: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: false,
  });
  const v = parsed.values as Record<string, unknown>;
  return {
    to: v.to as string | undefined,
    reason: v.reason as string | undefined,
    chit: v.chit as string | undefined,
    severity: v.severity as EscalationFields['severity'] | undefined,
    from: v.from as string | undefined,
    corp: v.corp as string | undefined,
    json: v.json === true,
  };
}

function fail(msg: string): never {
  console.error(`cc-cli escalate: ${msg}`);
  process.exit(1);
}
