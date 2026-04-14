import { describe, it, expect } from 'vitest';
import type { GlobalConfig } from '../packages/shared/dist/index.js';
import { defaultHarness, type HarnessOption } from '../packages/tui/src/utils/harness-detect.js';

/**
 * Unit coverage for the TUI's harness-detection helper. We don't exercise
 * the live process-spawn path (detectAvailableHarnesses) because it depends
 * on what's installed on the test runner, which isn't portable. Instead we
 * cover the pure decision layer (defaultHarness) + exercise the detector
 * surface by feeding it a real GlobalConfig and asserting invariants that
 * hold regardless of whether `claude` is actually on this machine's PATH.
 */

function makeConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    apiKeys: {},
    daemon: { portRange: [7800, 7900], logLevel: 'info' },
    defaults: { model: 'claude-haiku-4-5', provider: 'anthropic' },
    ...overrides,
  } as GlobalConfig;
}

describe('defaultHarness', () => {
  const cc: HarnessOption = {
    id: 'claude-code', displayName: 'Claude Code', tagline: '', available: true, note: '', fixHint: null,
  };
  const oc: HarnessOption = {
    id: 'openclaw', displayName: 'OpenClaw', tagline: '', available: true, note: '', fixHint: null,
  };

  it('prefers claude-code when both harnesses are available', () => {
    expect(defaultHarness([cc, oc])).toBe('claude-code');
  });

  it('falls back to openclaw when only openclaw is available', () => {
    expect(defaultHarness([{ ...cc, available: false }, oc])).toBe('openclaw');
  });

  it('picks claude-code when only claude-code is available', () => {
    expect(defaultHarness([cc, { ...oc, available: false }])).toBe('claude-code');
  });

  it('still picks claude-code when neither is available — user sees the fix hint + can proceed intentionally', () => {
    expect(defaultHarness([{ ...cc, available: false }, { ...oc, available: false }])).toBe('claude-code');
  });

  it('is order-independent: openclaw-first array resolves the same', () => {
    expect(defaultHarness([oc, cc])).toBe('claude-code');
  });
});

describe('detectAvailableHarnesses invariants', () => {
  // We re-import inside the block so the earlier defaultHarness describe
  // doesn't accidentally tree-shake detectAvailableHarnesses out.
  async function detect(cfg: GlobalConfig) {
    const mod = await import('../packages/tui/src/utils/harness-detect.js');
    return mod.detectAvailableHarnesses(cfg);
  }

  it('always returns both harness options, in a stable order', async () => {
    const opts = await detect(makeConfig());
    expect(opts).toHaveLength(2);
    expect(opts[0]!.id).toBe('claude-code');
    expect(opts[1]!.id).toBe('openclaw');
  });

  it('each option has the full shape (displayName, tagline, note, fixHint)', async () => {
    const opts = await detect(makeConfig());
    for (const opt of opts) {
      expect(opt.displayName.length).toBeGreaterThan(0);
      expect(opt.tagline.length).toBeGreaterThan(0);
      expect(opt.note.length).toBeGreaterThan(0);
      // fixHint is null iff available
      if (opt.available) expect(opt.fixHint).toBeNull();
      else expect(typeof opt.fixHint).toBe('string');
    }
  });

  it('OpenClaw is available when any provider API key is present', async () => {
    const opts = await detect(makeConfig({ apiKeys: { anthropic: 'sk-ant-fake' } }));
    const openclaw = opts.find(o => o.id === 'openclaw')!;
    expect(openclaw.available).toBe(true);
    expect(openclaw.note).toContain('API key set');
    expect(openclaw.fixHint).toBeNull();
  });

  it('OpenClaw is unavailable with an install-hint when no keys are set', async () => {
    const opts = await detect(makeConfig({ apiKeys: {} }));
    const openclaw = opts.find(o => o.id === 'openclaw')!;
    expect(openclaw.available).toBe(false);
    expect(openclaw.fixHint).toContain('global-config.json');
  });

  it('OpenClaw treats empty-string keys as absent, not present', async () => {
    const opts = await detect(makeConfig({ apiKeys: { anthropic: '   ' } }));
    const openclaw = opts.find(o => o.id === 'openclaw')!;
    expect(openclaw.available).toBe(false);
  });

  it('Claude Code detection note always starts with ✓ or ✗', async () => {
    // Result varies by machine but the prefix is stable.
    const opts = await detect(makeConfig());
    const cc = opts.find(o => o.id === 'claude-code')!;
    expect(cc.note[0] === '✓' || cc.note[0] === '✗').toBe(true);
  });

  it('Claude Code when unavailable surfaces an install-hint pointing at claude.com/claude-code', async () => {
    // Force the PATH to an empty set of dirs so findExecutableInPath returns null.
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const opts = await detect(makeConfig());
      const cc = opts.find(o => o.id === 'claude-code')!;
      expect(cc.available).toBe(false);
      expect(cc.fixHint).toContain('claude.com/claude-code');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
