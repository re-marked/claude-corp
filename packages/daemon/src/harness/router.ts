/**
 * HarnessRouter — AgentHarness implementation that dispatches each agent
 * to a different underlying harness based on per-agent configuration.
 *
 * The daemon owns a single `AgentHarness` reference (PR 1), but agents
 * in a single corp may run on different substrates (PR 2+). HarnessRouter
 * sits in that slot, wraps a Map of concrete harnesses keyed by name,
 * and routes each call to the right one.
 *
 * Resolution chain per agent:
 *   1. AgentSpec.harness (when passed to addAgent)
 *   2. resolveHarness(agentId) callback — typically reads Member.harness
 *      and the corp-level Corporation.harness default
 *   3. fallbackHarness (default: 'openclaw')
 *
 * init/shutdown fan out to every underlying harness.
 * health aggregates counts + reports per-harness breakdown in info.
 * removeAgent fans out (safe cleanup when we don't track owning harness).
 * addAgent delegates to a single target (spec.harness or resolved name).
 * dispatch delegates to the resolved harness; unknown name → HarnessError.
 */

import { log } from '../logger.js';
import {
  type AgentHarness,
  type AgentSpec,
  type DispatchOpts,
  type DispatchResult,
  type HarnessConfig,
  type HarnessHealth,
  HarnessError,
} from './types.js';

export interface HarnessRouterDeps {
  /**
   * Underlying harnesses keyed by their registered name. Must be
   * non-empty — the router has no fallback concrete harness of its own.
   */
  harnesses: Map<string, AgentHarness>;
  /**
   * Resolves which harness name should handle an agent. Returns undefined
   * when nothing is declared for the agent — router then uses
   * `fallbackHarness`. Called on every dispatch, so keep it cheap.
   */
  resolveHarness: (agentId: string) => string | undefined;
  /**
   * Harness name used when resolveHarness returns undefined.
   * Default: 'openclaw' for backwards compat.
   */
  fallbackHarness?: string;
}

export class HarnessRouter implements AgentHarness {
  readonly name = 'router';

  private deps: HarnessRouterDeps;
  private fallback: string;
  private startedAt = 0;
  private _dispatches = 0;
  private _errors = 0;
  private _lastDispatchAt: number | null = null;

  constructor(deps: HarnessRouterDeps) {
    if (deps.harnesses.size === 0) {
      throw new Error('HarnessRouter requires at least one underlying harness');
    }
    this.deps = deps;
    this.fallback = deps.fallbackHarness ?? 'openclaw';
  }

  async init(config: HarnessConfig): Promise<void> {
    this.startedAt = Date.now();
    // Initialize every underlying harness in parallel so startup stays fast
    // even when one harness is slow to come up.
    await Promise.all([...this.deps.harnesses.values()].map((h) => h.init(config)));
    log(`[harness:router] init complete (${this.deps.harnesses.size} harness${this.deps.harnesses.size === 1 ? '' : 'es'}: ${[...this.deps.harnesses.keys()].join(', ')}, fallback=${this.fallback})`);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.deps.harnesses.values()].map((h) => h.shutdown()));
    log('[harness:router] shutdown complete');
  }

  async health(): Promise<HarnessHealth> {
    const entries = await Promise.all(
      [...this.deps.harnesses.entries()].map(async ([name, h]) => {
        const health = await h.health();
        return { registeredName: name, health };
      }),
    );

    // Any underlying harness being ok counts as router ok — we're a multi-
    // substrate facade, not a single point of failure.
    const anyOk = entries.some((e) => e.health.ok);

    // Aggregate counters include our own per-dispatch bookkeeping (router
    // counts every attempt before it delegates, so unknown-harness errors
    // show up in router totals even though they never reached an
    // underlying harness).
    const delegatedDispatches = entries.reduce((sum, e) => sum + e.health.dispatches, 0);
    const delegatedErrors = entries.reduce((sum, e) => sum + e.health.errors, 0);

    const delegatedLastAt = entries
      .map((e) => e.health.lastDispatchAt ?? 0)
      .reduce((a, b) => Math.max(a, b), 0);
    const routerLastAt = this._lastDispatchAt ?? 0;
    const lastDispatchAt = Math.max(delegatedLastAt, routerLastAt) || null;

    return {
      ok: anyOk,
      name: this.name,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      // Router totals represent the user-visible number (every call that
      // hit `router.dispatch`). Delegated totals differ if underlying
      // harnesses were called directly (which we don't do).
      dispatches: Math.max(this._dispatches, delegatedDispatches),
      errors: Math.max(this._errors, delegatedErrors),
      lastDispatchAt,
      info: {
        fallback: this.fallback,
        harnesses: entries.map((e) => ({
          name: e.health.name,
          registeredAs: e.registeredName,
          ok: e.health.ok,
          dispatches: e.health.dispatches,
          errors: e.health.errors,
        })),
      },
    };
  }

  async addAgent(spec: AgentSpec): Promise<void> {
    const targetName = this.resolveTargetName(spec.agentId, spec);
    const target = this.deps.harnesses.get(targetName);
    if (!target) {
      throw this.unknownHarnessError(spec.agentId, targetName, 'addAgent');
    }
    await target.addAgent(spec);
  }

  async removeAgent(agentId: string): Promise<void> {
    // We don't track which underlying harness owns a given agent — fan out
    // so cleanup is safe even when the router was re-constructed without
    // that history. Each harness's removeAgent is expected to be
    // idempotent.
    await Promise.all([...this.deps.harnesses.values()].map((h) => h.removeAgent(agentId)));
  }

  async dispatch(opts: DispatchOpts): Promise<DispatchResult> {
    this._dispatches += 1;
    this._lastDispatchAt = Date.now();

    // Pre-check aborted signal at the router layer so abort errors surface
    // with harnessName='router' (not whichever harness happened to be the
    // target). This keeps "who cancelled this?" attribution stable across
    // harness swaps and is the behavior the AgentHarness contract expects.
    if (opts.signal?.aborted) {
      this._errors += 1;
      throw new HarnessError({
        category: 'aborted',
        harnessName: this.name,
        message: 'Dispatch aborted before it started',
      });
    }

    const targetName = this.resolveTargetName(opts.agentId);
    const target = this.deps.harnesses.get(targetName);
    if (!target) {
      this._errors += 1;
      throw this.unknownHarnessError(opts.agentId, targetName, 'dispatch');
    }

    try {
      return await target.dispatch(opts);
    } catch (err) {
      this._errors += 1;
      throw err;
    }
  }

  /**
   * Public so callers + tests can inspect the resolution for diagnostics.
   * Returns the harness name that would handle dispatches for this agent
   * right now. Does NOT check whether that harness is actually registered.
   */
  getHarnessNameFor(agentId: string): string {
    return this.resolveTargetName(agentId);
  }

  /** List of currently-registered harness names. */
  registeredHarnessNames(): string[] {
    return [...this.deps.harnesses.keys()];
  }

  private resolveTargetName(agentId: string, spec?: AgentSpec): string {
    if (spec?.harness) return spec.harness;
    const resolved = this.deps.resolveHarness(agentId);
    if (resolved) return resolved;
    return this.fallback;
  }

  private unknownHarnessError(agentId: string, targetName: string, phase: string): HarnessError {
    const known = [...this.deps.harnesses.keys()].join(', ') || '(none)';
    return new HarnessError({
      category: 'internal',
      harnessName: this.name,
      message: `Cannot ${phase} agent "${agentId}" — declared harness "${targetName}" is not registered. Known harnesses: ${known}`,
    });
  }
}
