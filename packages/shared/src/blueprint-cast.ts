/**
 * Blueprint cast — Project 1.8 PR 2, commit 4 of 5.
 *
 * Turns a blueprint chit into a Contract chit + a tree of Task chits.
 * The name matches the chosen verb: you cast a Contract from the
 * blueprint's mold, producing a working impression with concrete
 * values filled in.
 *
 * Cast is the PR 2 terminus — it composes blueprint-parser (template
 * expansion) + blueprint-vars (coercion + merge) + chit CRUD into the
 * single high-level operation every downstream consumer calls. CLI
 * commands in PR 3 (`cc-cli blueprint cast`, `cc-cli contract start`)
 * wrap this primitive.
 *
 * ### Validation-first pattern
 *
 * Every failure mode that CAN be caught before any chit is written,
 * IS caught. Concretely:
 *
 *   1. Parse blueprint (parseBlueprint) — var coercion + template
 *      syntax + strict-mode undeclared references
 *   2. Blueprint status check — only `active` blueprints cast;
 *      `draft`/`closed` throw BlueprintCastError with a hint
 *   3. Step role resolution — for every step, blueprint.assigneeRole
 *      wins when non-null, else opts.stepRoleOverrides[step.id], else
 *      throw (no role, no resolution path)
 *   4. Role registry check — every resolved role must exist in
 *      ROLES, else throw (caught here not at chit-type-validator time
 *      because the validator is pure on fields and has no registry
 *      access; the registry IS available at cast time)
 *   5. Contract field assembly — title, goal, priority all resolved
 *      before any write
 *
 * Only THEN do we start creating chits. Disk-write failure is the
 * only remaining failure mode; it's genuinely rare and doesn't need
 * transactional rollback (orphan tasks cleanable via cc-cli chit
 * tools later if ever needed).
 *
 * ### Task initial state
 *
 * Cast creates Task chits with `workflowStatus: 'draft'` — the chain
 * walker / hand mechanism advances them through `queued → dispatched
 * → in_progress` when dispatch actually happens. Cast isn't a hand;
 * it produces the Contract structure for something else to walk.
 * PR 3's `cc-cli contract start` wraps cast + the initial hand into
 * one founder-facing action.
 *
 * ### dependsOn rewriting
 *
 * Blueprint step ids are local kebab-case labels (`scan-caskets`).
 * Task chit ids are corp-wide (`chit-t-a1b2c3d4`). Cast pre-allocates
 * all Task chit ids up front, builds a step-id → chit-id map, then
 * rewrites each step's `dependsOn` from step-ids to chit-ids so the
 * resulting Task chits have real chit-id refs the chain walker can
 * follow. Pre-allocation means dependencies work regardless of the
 * order tasks actually get written to disk.
 */

import type { Chit, ChitScope, TaskFields } from './types/chit.js';
import { createChit, chitId } from './chits.js';
import { parseBlueprint, type ParsedBlueprint, type ParsedBlueprintStep } from './blueprint-parser.js';
import { isKnownRole } from './roles.js';

// ─── Error class ────────────────────────────────────────────────────

/**
 * Raised on cast-specific failures that aren't parse errors (which
 * surface as BlueprintParseError) or var errors (BlueprintVarError).
 * Covers:
 *   - Blueprint not in 'active' status
 *   - Step with no assignee (null in blueprint + no stepRoleOverride)
 *   - Step assigneeRole unknown in role registry
 *
 * Carries `stepId` when the failure is step-specific, so CLI can
 * point at the exact step.
 */
export class BlueprintCastError extends Error {
  constructor(
    message: string,
    public readonly stepId?: string,
  ) {
    super(message);
    this.name = 'BlueprintCastError';
  }
}

// ─── Public types ────────────────────────────────────────────────────

/**
 * Caller-facing options for cast. `scope` + `createdBy` are required
 * (where the Contract + Tasks get created, and who's initiating).
 * Everything else has a sensible default derived from the blueprint.
 */
export interface CastFromBlueprintOpts {
  /** Scope where the Contract + Tasks get created. Usually `corp` or `project:<name>`. */
  scope: ChitScope;
  /** Member id of the cast initiator — founder, CEO, or the agent triggering the cast. */
  createdBy: string;
  /**
   * Fill for steps where `assigneeRole` is null in the blueprint.
   * Keyed by step id; each value must be a role id in the role
   * registry. A null blueprint assignee + no override for that step
   * throws BlueprintCastError.
   *
   * When the blueprint HAS an explicit assigneeRole for a step, the
   * blueprint wins — overrides apply only to null fields. Rationale:
   * blueprint-declared assignments encode author intent; if the
   * caller wants a different role, the right action is to author a
   * different blueprint, not silently override.
   */
  stepRoleOverrides?: Record<string, string>;
  /**
   * Contract-level overrides. Every field has a fallback derived from
   * the blueprint; callers only set these when they want a non-default
   * shape for the cast Contract.
   */
  contractOverrides?: {
    /** Defaults to blueprint.title ?? blueprint.name. */
    title?: string;
    /** Defaults to blueprint.summary ?? `"Cast from blueprint '${name}'"`. */
    goal?: string;
    /** Defaults to 'normal'. */
    priority?: 'critical' | 'high' | 'normal' | 'low';
    /** Defaults to null (no lead). */
    leadId?: string | null;
    /** Defaults to undefined (no deadline). ISO 8601 timestamp. */
    deadline?: string;
  };
}

/**
 * Return value of a successful cast. Full chit objects (not just ids)
 * so programmatic callers can inspect the resulting structure without
 * a second read pass.
 */
export interface CastFromBlueprintResult {
  readonly contract: Chit<'contract'>;
  readonly tasks: readonly Chit<'task'>[];
  /** The parsed blueprint used — echoed for audit / debugging. */
  readonly parsed: ParsedBlueprint;
}

// ─── Cast ────────────────────────────────────────────────────────────

/**
 * Cast a Contract from a blueprint chit. Validation-first: every
 * failure the function can catch before writing any chit IS caught
 * before writing. See module docstring for the full pipeline.
 *
 * Throws:
 *   - BlueprintVarError   — caller vars coercion / missing required
 *   - BlueprintParseError — Handlebars syntax / strict-mode refs
 *   - BlueprintCastError  — status, role resolution, registry refs
 *   - ChitValidationError — if createChit rejects (shouldn't happen
 *     since we've pre-validated, but propagates cleanly if it does)
 */
export function castFromBlueprint(
  corpRoot: string,
  blueprint: Chit<'blueprint'>,
  callerVars: Record<string, unknown>,
  opts: CastFromBlueprintOpts,
): CastFromBlueprintResult {
  // ── Step 1: parse (var coercion + template expansion, strict mode)
  // May throw BlueprintVarError / BlueprintParseError. No chits written yet.
  const parsed = parseBlueprint(blueprint.fields.blueprint, callerVars);

  // ── Step 2: blueprint must be active
  if (blueprint.status !== 'active') {
    throw new BlueprintCastError(
      `blueprint '${parsed.name}' is in status '${blueprint.status}' — only 'active' blueprints can be cast. ` +
        `Promote via \`cc-cli blueprint validate ${blueprint.id}\` (draft → active) or re-open if closed.`,
    );
  }

  // ── Step 3: resolve per-step assignees (blueprint wins, overrides fill nulls)
  const stepAssignees = new Map<string, string>();
  for (const step of parsed.steps) {
    const resolved = resolveStepAssignee(step, opts.stepRoleOverrides);
    stepAssignees.set(step.id, resolved);
  }

  // ── Step 4: every resolved role exists in the registry
  for (const [stepId, role] of stepAssignees) {
    if (!isKnownRole(role)) {
      throw new BlueprintCastError(
        `step '${stepId}' resolves to role '${role}' which is not in the role registry. ` +
          `Check the role id or add the role via roles.ts before casting.`,
        stepId,
      );
    }
  }

  // ── Step 5: pre-allocate Task chit ids + build step-id → chit-id map
  // Pre-allocation lets us rewrite dependsOn before any chit is written,
  // so disk-write order doesn't matter — every Task chit's dependsOn
  // already points at the correct (eventual) chit ids.
  const stepToChitId = new Map<string, string>();
  for (const step of parsed.steps) {
    stepToChitId.set(step.id, chitId('task'));
  }

  // ── Step 6: assemble Contract field payloads (also pre-allocate contract id)
  const contractIdValue = chitId('contract');
  const contractTitle = opts.contractOverrides?.title ?? parsed.title ?? parsed.name;
  const contractGoal =
    opts.contractOverrides?.goal ??
    parsed.summary ??
    `Cast from blueprint '${parsed.name}'`;
  const contractPriority = opts.contractOverrides?.priority ?? 'normal';

  // ── Step 7: write Task chits (pre-allocated ids, rewritten dependsOn)
  const tasks: Chit<'task'>[] = parsed.steps.map((step) => {
    const chitIdForStep = stepToChitId.get(step.id)!;
    const rewrittenDeps = step.dependsOn.map((depStepId) => {
      const depChitId = stepToChitId.get(depStepId);
      // Defensive: step.dependsOn already validated to refer to real
      // step ids by PR 1's chit-type validator. This throw-path is a
      // safety net for future refactors that might pipe unvalidated
      // data through.
      if (!depChitId) {
        throw new BlueprintCastError(
          `internal: step '${step.id}' depends on '${depStepId}' which has no allocated chit id`,
          step.id,
        );
      }
      return depChitId;
    });

    const taskFields: TaskFields = {
      title: step.title,
      priority: contractPriority,
      assignee: stepAssignees.get(step.id)!,
      workflowStatus: 'draft',
      ...(step.acceptanceCriteria.length > 0
        ? { acceptanceCriteria: [...step.acceptanceCriteria] }
        : {}),
    };

    return createChit(corpRoot, {
      type: 'task',
      id: chitIdForStep,
      scope: opts.scope,
      createdBy: opts.createdBy,
      dependsOn: rewrittenDeps,
      tags: [`blueprint:${parsed.name}`, `blueprint-step:${step.id}`],
      body: step.description ?? '',
      fields: { task: taskFields },
    });
  });

  // ── Step 8: write Contract chit referencing all Task chit ids + the blueprint
  const contract = createChit(corpRoot, {
    type: 'contract',
    id: contractIdValue,
    scope: opts.scope,
    createdBy: opts.createdBy,
    tags: [`blueprint:${parsed.name}`],
    body: blueprint.fields.blueprint.summary ?? '',
    fields: {
      contract: {
        title: contractTitle,
        goal: contractGoal,
        taskIds: tasks.map((t) => t.id),
        priority: contractPriority,
        blueprintId: blueprint.id,
        ...(opts.contractOverrides?.leadId !== undefined
          ? { leadId: opts.contractOverrides.leadId }
          : {}),
        ...(opts.contractOverrides?.deadline !== undefined
          ? { deadline: opts.contractOverrides.deadline }
          : {}),
      },
    },
  });

  return { contract, tasks, parsed };
}

// ─── Internals ───────────────────────────────────────────────────────

/**
 * Resolve one step's assignee: blueprint-declared role wins; null
 * blueprint assigneeRole falls back to stepRoleOverrides[stepId];
 * null + no override throws with a clear teaching message.
 */
function resolveStepAssignee(
  step: ParsedBlueprintStep,
  stepRoleOverrides: Record<string, string> | undefined,
): string {
  if (step.assigneeRole != null) return step.assigneeRole;
  const override = stepRoleOverrides?.[step.id];
  if (override != null) return override;
  throw new BlueprintCastError(
    `step '${step.id}' has no assignee: blueprint declares null and no stepRoleOverrides entry was provided. ` +
      `Either set assigneeRole in the blueprint, or pass stepRoleOverrides.${step.id} at cast time.`,
    step.id,
  );
}

