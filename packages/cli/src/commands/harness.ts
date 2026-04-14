import { getClient } from '../client.js';

/**
 * cc-cli harness list
 * cc-cli harness health
 *
 * `list` is a one-line-per-harness summary table — useful before
 * running `cc-cli agent set-harness` so the user knows which names are
 * actually routable.
 *
 * `health` adds a per-harness diagnostic dump from the underlying
 * harness's own health().info — typically binary version + login state
 * + rate-limit status + cumulative cost for ClaudeCodeHarness, gateway
 * connectivity for OpenClawHarness.
 */
export async function cmdHarness(opts: { args: string[]; json: boolean }): Promise<void> {
  const action = opts.args[0] ?? 'list';
  if (action !== 'list' && action !== 'ls' && action !== 'health') {
    console.error('Usage: cc-cli harness list|health');
    process.exit(1);
  }

  const client = getClient();
  const info = await client.listHarnesses();
  const verbose = action === 'health';

  if (opts.json) {
    if (verbose) {
      // Health view also pulls the full router health (which carries the
      // per-harness info objects nested inside info.harnesses).
      const router = await fetch(`http://127.0.0.1:${(client as any).port ?? 0}/status`);
      console.log(JSON.stringify({ ...info, full: await router.json().catch(() => null) }, null, 2));
    } else {
      console.log(JSON.stringify(info, null, 2));
    }
    return;
  }

  if (info.registered.length === 0) {
    console.log('No harnesses registered. Daemon may be mid-startup.');
    return;
  }

  console.log(`Registered harnesses (${info.registered.length}), fallback=${info.fallback}:`);
  console.log();

  const name = (s: string) => s.padEnd(14);
  const num = (n: number) => String(n).padStart(6);

  console.log(`  ${name('NAME')}  ${'OK'.padEnd(5)}  ${'DISPATCHES'}  ${'ERRORS'}`);
  console.log(`  ${'-'.repeat(14)}  ${'-'.repeat(5)}  ${'-'.repeat(10)}  ${'-'.repeat(6)}`);
  for (const h of info.summary) {
    const ok = h.ok ? '\u25C6' : '\u25C7';
    const marker = h.registeredAs === info.fallback ? ' (fallback)' : '';
    console.log(`  ${name(h.registeredAs)}  ${ok.padEnd(5)}  ${num(h.dispatches)}      ${num(h.errors)}${marker}`);
  }

  if (!verbose) return;

  // Health view adds per-harness diagnostic info pulled from the router's
  // aggregated health (info.harnesses[i] only carries the rolled-up
  // counters; the underlying harness-specific info lives on its own
  // health() — surface it via the same /harnesses endpoint shape if the
  // daemon includes it, falling back to a "(no extra info)" line.
  console.log();
  console.log('Per-harness diagnostics:');
  for (const h of info.summary) {
    console.log();
    console.log(`  [${h.registeredAs}]`);
    const extras = h as unknown as Record<string, unknown>;
    const knownKeys = new Set(['name', 'registeredAs', 'ok', 'dispatches', 'errors']);
    let anyExtra = false;
    for (const [k, v] of Object.entries(extras)) {
      if (knownKeys.has(k)) continue;
      console.log(`    ${k}: ${formatValue(v)}`);
      anyExtra = true;
    }
    if (!anyExtra) {
      console.log('    (no extra diagnostic info exposed by this harness)');
      console.log('    Tip: future harness versions surface binary version, login state,');
      console.log('         rate-limit status, and cumulative cost here.');
    }
  }
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '(unset)';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
