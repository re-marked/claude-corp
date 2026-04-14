import { getClient } from '../client.js';

/**
 * cc-cli harness list
 *
 * Reports which harnesses the running daemon has registered, the
 * fallback used when an agent declares nothing, and a one-line health
 * summary per harness. Useful before running `cc-cli agent set-harness`
 * so the user knows which names are actually routable.
 */
export async function cmdHarness(opts: { args: string[]; json: boolean }): Promise<void> {
  const action = opts.args[0] ?? 'list';
  if (action !== 'list' && action !== 'ls' && action !== 'health') {
    console.error('Usage: cc-cli harness list|health');
    process.exit(1);
  }

  const client = getClient();
  const info = await client.listHarnesses();

  if (opts.json) {
    console.log(JSON.stringify(info, null, 2));
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
}
