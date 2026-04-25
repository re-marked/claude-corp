/**
 * Bacteria — pure decision module.
 *
 * Reads filesystem state (members.json + active task chits + caskets),
 * combines with the reactor's accumulated hysteresis bookkeeping
 * (`previousState.idleSince`), and returns a list of actions for the
 * executor to apply this tick — plus the updated state to thread into
 * the next tick.
 *
 * Pure: same inputs (including the injected `now`) → same outputs.
 * Tests pass fixture states + a fixed `now`; production passes the
 * real corp + `new Date()`. No model calls, no network, no logging.
 *
 * ### The math, in plain terms
 *
 * Per worker-tier role pool:
 *
 *   1. Count busy slots (casket.currentStep != null) and idle slots.
 *   2. Find unprocessed chits — task chits where `assignee === role.id`
 *      (not yet claimed by a specific slot), workflowStatus ∈
 *      {queued, dispatched}, and not currently the currentStep of any
 *      slot in the pool.
 *   3. Sum weights via complexity (trivial 0.25, small 0.5, medium 1,
 *      large 2; null/unknown defaults to medium).
 *   4. targetExtraSlots = ceil(weighted_queue / TARGET_WEIGHTED_PER_SLOT).
 *   5. delta = targetExtraSlots - idle_slots.count
 *   6. delta > 0 → emit `delta` MitoseActions, each carrying one of the
 *      oldest-first unprocessed chits as its `assignedChit` (push
 *      model: spawn slots WITH work).
 *   7. delta < 0 → emit ApoptoseActions for the longest-idle slots
 *      whose hysteresis window has elapsed. Slots whose hysteresis
 *      hasn't elapsed yet stay in `nextState.idleSince` and may
 *      apoptose on a future tick.
 *
 * Busy slots are not counted toward capacity — they're already
 * committed to their current chit. We don't speculate about how soon
 * they'll free up. Idle slots are the bacteria-relevant capacity.
 *
 * ### Why `dispatched` counts as "unprocessed" when assignee=role
 *
 * In normal flow, the dispatch path rewrites a chit's assignee from
 * role.id to slot.id when it lands on a Casket. So `assignee=role.id`
 * means "not yet claimed by a slot" regardless of workflowStatus.
 * Both `queued` and `dispatched` (which sometimes lingers if the role-
 * resolver pickup happens fast enough) read the same way to bacteria.
 * `blocked` is excluded because a blocked task is by definition
 * committed to a slot via 1.4.1 — it shouldn't sit unassigned.
 *
 * ### Lineage selection
 *
 * The parent slot is the genealogy edge for the new mitosis. Picked
 * deterministically: lexically-first busy slot in the pool if any
 * exist, else lexically-first idle slot, else null (the new slot is
 * the first of its lineage). Generation = parent.generation + 1, or
 * 0 when parent is null. The choice of "lexically-first busy" is
 * arbitrary — any deterministic rule works since the lineage edge is
 * cosmetic / diagnostic, not load-bearing for bacteria's math.
 */

import { join } from 'node:path';
import {
  readConfig,
  queryChits,
  getCurrentStep,
  employeeRoles,
  MEMBERS_JSON,
  type Member,
  type ChitWithBody,
  type TaskFields,
} from '@claudecorp/shared';
import {
  type BacteriaAction,
  type BacteriaState,
  type MitoseAction,
  type ApoptoseAction,
  TARGET_WEIGHTED_PER_SLOT,
  APOPTOSIS_HYSTERESIS_MS,
  weightFor,
} from './types.js';

export interface DecideOpts {
  readonly corpRoot: string;
  readonly previousState: BacteriaState;
  /** Injected so tests can fix time. Production passes `new Date()`. */
  readonly now: Date;
}

export interface DecideResult {
  readonly actions: readonly BacteriaAction[];
  readonly nextState: BacteriaState;
}

/**
 * Compute the bacteria actions for this tick. Pure function over the
 * three inputs in `DecideOpts`. Reads filesystem state for the corp
 * but performs no writes. Caller (the reactor) is responsible for
 * applying the returned `actions` via the executor and threading
 * `nextState` into the next tick.
 *
 * Empty `actions` array means "everything's stable, no mutations
 * needed this tick" — the most common outcome under steady-state.
 */
export function decideBacteriaActions(opts: DecideOpts): DecideResult {
  const { corpRoot, previousState, now } = opts;
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  const actions: BacteriaAction[] = [];
  const nextIdleSince = new Map<string, string>();

  const members = loadMembers(corpRoot);
  const allActiveTasks = loadActiveTaskChits(corpRoot);

  for (const role of employeeRoles()) {
    if (role.tier !== 'worker') continue;

    // Pool members: active Employees of this role.
    const pool = members
      .filter(
        (m) =>
          m.type === 'agent' &&
          m.status !== 'archived' &&
          m.role === role.id &&
          (m.kind ?? 'partner') === 'employee',
      )
      .sort((a, b) => a.id.localeCompare(b.id));

    // Bucket into busy / idle by reading caskets.
    const busy: Member[] = [];
    const idle: Member[] = [];
    const onCasket = new Set<string>();
    for (const slot of pool) {
      const cs = readCurrentStepSafe(corpRoot, slot.id);
      if (cs) {
        busy.push(slot);
        onCasket.add(cs);
      } else {
        idle.push(slot);
      }
    }

    // Update idleSince map for THIS role's idle slots.
    //   - Slot was idle last tick + still idle now: keep prior timestamp.
    //   - Slot wasn't tracked (newly idle this tick): mark as nowIso.
    //   - Slot is busy now: drop from map (clean reset; if it goes idle
    //     again the hysteresis re-clocks from scratch).
    for (const slot of idle) {
      const prev = previousState.idleSince.get(slot.id);
      nextIdleSince.set(slot.id, prev ?? nowIso);
    }

    // Find unprocessed chits — assignee = role.id, active workflow,
    // not currently the currentStep of any slot in this pool.
    const unprocessed = allActiveTasks
      .filter((cwb) => {
        const fields = cwb.chit.fields.task as TaskFields;
        if (fields.assignee !== role.id) return false;
        const ws = fields.workflowStatus ?? null;
        if (ws !== 'queued' && ws !== 'dispatched') return false;
        if (onCasket.has(cwb.chit.id)) return false;
        return true;
      })
      // FIFO — oldest createdAt first. Spawned slots take the longest-
      // waiting work; remaining queue continues to drain through the
      // existing role-resolver idle-first pickup path.
      .sort((a, b) => a.chit.createdAt.localeCompare(b.chit.createdAt));

    const weightedQueue = unprocessed.reduce(
      (sum, cwb) => sum + weightFor((cwb.chit.fields.task as TaskFields).complexity),
      0,
    );

    const targetExtraSlots = Math.ceil(weightedQueue / TARGET_WEIGHTED_PER_SLOT);
    const delta = targetExtraSlots - idle.length;

    if (delta > 0) {
      // MITOSE. Spawn `delta` new slots, each carrying one of the
      // oldest-first unprocessed chits.
      const toAssign = unprocessed.slice(0, delta);
      // Lineage edge: prefer a busy slot (the one whose queue is
      // overflowing). Else any slot in the pool. Else null (first
      // of the lineage).
      const parent: Member | undefined = busy[0] ?? idle[0];
      const parentGeneration = parent?.generation ?? 0;
      for (const cwb of toAssign) {
        const action: MitoseAction = {
          kind: 'mitose',
          role: role.id,
          parentSlug: parent?.id ?? null,
          generation: parent ? parentGeneration + 1 : 0,
          assignedChit: cwb.chit.id,
        };
        actions.push(action);
      }
    } else if (delta < 0) {
      // APOPTOSE. Surplus idle slots; longest-idle-first, but only
      // those whose hysteresis window has elapsed. Slots whose
      // hysteresis hasn't elapsed yet stay tracked in nextIdleSince
      // and may apoptose on a future tick.
      const surplus = -delta;
      const idleByAge = idle
        .map((slot) => ({
          slot,
          idleSince: nextIdleSince.get(slot.id) ?? nowIso,
        }))
        .sort((a, b) => a.idleSince.localeCompare(b.idleSince));
      let apoptosed = 0;
      for (const { slot, idleSince } of idleByAge) {
        if (apoptosed >= surplus) break;
        const idleSinceMs = new Date(idleSince).getTime();
        if (nowMs - idleSinceMs < APOPTOSIS_HYSTERESIS_MS) continue;
        const action: ApoptoseAction = {
          kind: 'apoptose',
          slug: slot.id,
          idleSince,
          reason: 'queue drained, hysteresis elapsed',
        };
        actions.push(action);
        // Decision-side state pruning: about-to-apoptose slots leave
        // the idleSince map. If the executor fails, next tick will
        // re-observe the slot and re-add it.
        nextIdleSince.delete(slot.id);
        apoptosed++;
      }
    }
  }

  return { actions, nextState: { idleSince: nextIdleSince } };
}

// ─── Helpers ────────────────────────────────────────────────────────

function loadMembers(corpRoot: string): Member[] {
  try {
    return readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  } catch {
    return [];
  }
}

/**
 * Read every active task chit in the corp once per tick. Bacteria's
 * decision iterates every worker-tier role, but the chit store scan
 * is the same for all of them — we walk it once and filter in-memory.
 *
 * Malformed chits surface in queryChits's `result.malformed` and are
 * already logged to the audit trail; we ignore them here (a bad chit
 * shouldn't trigger a mitose).
 */
function loadActiveTaskChits(corpRoot: string): ChitWithBody<'task'>[] {
  const result = queryChits<'task'>(corpRoot, {
    types: ['task'],
    statuses: ['active'],
    limit: 0,
  });
  return result.chits;
}

/**
 * getCurrentStep can throw if the casket file is corrupted; we
 * default to "treat as idle" rather than letting one bad casket
 * abort the whole bacteria tick. The corrupt-casket case is rare and
 * separately handled by 1.9's chit-hygiene sweeper.
 */
function readCurrentStepSafe(
  corpRoot: string,
  slug: string,
): string | null {
  try {
    const cs = getCurrentStep(corpRoot, slug);
    return cs ?? null;
  } catch {
    return null;
  }
}
