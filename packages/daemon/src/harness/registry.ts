/**
 * HarnessRegistry — plugin-style registration of agent harnesses.
 *
 * Future harnesses register themselves by name via `register(name, factory)`.
 * Claude Corp's daemon picks a harness by name (from corp config / per-agent
 * config in later PRs) and instantiates via `create(name, config)`.
 *
 * The factory captures harness-specific dependencies at registration time.
 * For example, `OpenClawHarness` needs references to the daemon's
 * ProcessManager + WS-client accessors — those are closure-captured when
 * the daemon registers "openclaw" at startup. The registry itself never
 * needs to know about those dependencies.
 *
 * After a factory returns a constructed AgentHarness, the registry calls
 * `init(config)` exactly once before returning it. Factories should NOT
 * call init themselves.
 */

import type { AgentHarness, HarnessConfig, HarnessFactory } from './types.js';

export class HarnessRegistry {
  private factories = new Map<string, HarnessFactory>();

  /**
   * Register a factory under a name. Throws if the name is already taken —
   * callers should call `unregister` first if they need to replace one.
   */
  register(name: string, factory: HarnessFactory): void {
    if (!name || typeof name !== 'string') {
      throw new Error('Harness name must be a non-empty string');
    }
    if (this.factories.has(name)) {
      throw new Error(
        `Harness "${name}" already registered. Call unregister("${name}") first to replace.`,
      );
    }
    this.factories.set(name, factory);
  }

  /** Remove a factory by name. Returns true if something was removed. */
  unregister(name: string): boolean {
    return this.factories.delete(name);
  }

  /** Check if a harness name is known to this registry. */
  has(name: string): boolean {
    return this.factories.has(name);
  }

  /** List all registered harness names in registration order. */
  list(): string[] {
    return [...this.factories.keys()];
  }

  /**
   * Instantiate a registered harness and initialize it.
   *
   * Error if the name isn't registered. After the factory returns, `init` is
   * invoked once before the instance is returned to the caller.
   */
  async create(name: string, config: HarnessConfig): Promise<AgentHarness> {
    const factory = this.factories.get(name);
    if (!factory) {
      const known = this.list().join(', ') || '(none registered)';
      throw new Error(`Unknown harness "${name}". Known harnesses: ${known}`);
    }
    const harness = await factory(config);
    await harness.init(config);
    return harness;
  }

  /** Clear all registrations. Primarily useful for tests. */
  clear(): void {
    this.factories.clear();
  }

  /** Snapshot size (number of registered harnesses). */
  get size(): number {
    return this.factories.size;
  }
}

/**
 * Default process-wide registry. The daemon registers its built-in harnesses
 * (openclaw, mock, and eventually claude-code) against this singleton at
 * startup. Tests that want isolation should construct their own instance.
 */
export const defaultHarnessRegistry = new HarnessRegistry();
