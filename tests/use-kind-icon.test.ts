import { describe, it, expect } from 'vitest';
import { __FOR_TEST } from '../packages/tui/src/hooks/use-kind-icon.ts';

// The hook itself is state + setInterval; exercising it needs a React
// test harness we don't have set up for the TUI. Instead we pin the
// data surface: every ambient kind has a static icon fallback, every
// animated kind has a sensible frame sequence. Regressions that drop
// a kind from the lookup would fall back to '·' silently; these tests
// catch that.

const { ANIMATIONS, STATIC_ICONS } = __FOR_TEST;

const ALL_KINDS = [
  'heartbeat',
  'cron',
  'loop',
  'autoemon',
  'dream',
  'inbox',
  'failsafe',
  'herald',
  'recovery',
] as const;

describe('useKindIcon data', () => {
  it('provides a static icon for every AmbientKind', () => {
    for (const k of ALL_KINDS) {
      expect(STATIC_ICONS[k]).toBeTruthy();
      expect(typeof STATIC_ICONS[k]).toBe('string');
      expect(STATIC_ICONS[k]!.length).toBeGreaterThan(0);
    }
  });

  it('animated kinds have non-empty frame arrays + positive interval', () => {
    for (const [kind, anim] of Object.entries(ANIMATIONS)) {
      if (!anim) continue;
      expect(anim.frames.length, `${kind} frames`).toBeGreaterThan(1);
      expect(anim.ms, `${kind} ms`).toBeGreaterThan(0);
      // All frames are non-empty strings.
      for (const f of anim.frames) {
        expect(typeof f).toBe('string');
        expect(f.length).toBeGreaterThan(0);
      }
    }
  });

  it('dream cycles through a moon-phase sequence', () => {
    // Specific-enough pin — if someone accidentally reorders or
    // replaces the moon sequence, this catches it.
    expect(ANIMATIONS.dream?.frames.length).toBe(8);
    expect(ANIMATIONS.dream?.frames[0]).toBe('🌑');
    expect(ANIMATIONS.dream?.frames[4]).toBe('🌕');
  });

  it('cron ticks through a clock-hand sequence', () => {
    expect(ANIMATIONS.cron?.frames.length).toBeGreaterThanOrEqual(4);
  });

  it('frame intervals are in the "calm" range (>= 300ms)', () => {
    // Avoid busy re-renders. If someone accidentally drops interval
    // below 300ms, CPU load goes up noticeably on screens with many
    // stacks open.
    for (const anim of Object.values(ANIMATIONS)) {
      if (!anim) continue;
      expect(anim.ms).toBeGreaterThanOrEqual(300);
    }
  });
});
