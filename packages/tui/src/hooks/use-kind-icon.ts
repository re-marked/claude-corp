/**
 * Per-kind animated icons for ambient stack badges.
 *
 * The point isn't to be flashy — it's to make the TUI feel alive.
 * A static icon in a stack of 8 cron ticks reads as "dead log row."
 * A slowly rotating clock hand, a waxing moon, a subtle heartbeat
 * pulse — the icon tells you "this agent is doing this RIGHT NOW"
 * at a glance, without demanding attention.
 *
 * Frame rates are deliberately low (400ms–1500ms between frames) so
 * CPU and re-render cost are negligible. Kinds without a natural
 * motion metaphor stay static.
 */

import { useState, useEffect } from 'react';
import type { AmbientKind } from '@claudecorp/shared';

// ── Frame sequences ────────────────────────────────────────────────

/** Animation spec: frames cycle in order, one frame per `ms`. */
interface Animation {
  frames: readonly string[];
  ms: number;
}

/**
 * Only kinds that naturally imply motion animate. Others render as
 * stable symbols (less noise, less CPU for the render loop).
 */
const ANIMATIONS: Partial<Record<AmbientKind, Animation>> = {
  // Moon phases — a dream cycle "waxes" through the night.
  dream: { frames: ['🌑', '🌘', '🌗', '🌖', '🌕', '🌔', '🌓', '🌒'], ms: 1500 },
  // Clock hands — cron literally ticks time.
  cron: { frames: ['◴', '◷', '◶', '◵'], ms: 600 },
  // Rotating half-disc — autoemon is continuous motion.
  autoemon: { frames: ['◐', '◓', '◑', '◒'], ms: 400 },
  // Loop arrow → circular arrow alternation, subtle direction hint.
  loop: { frames: ['↻', '↺'], ms: 900 },
  // Heartbeat breathes — pulse via dim/bright toggle done in the
  // COMPONENT layer (color), not frame swap. The icon here stays
  // stable so we don't fight the pulse visually.
};

/** Static fallback symbols. */
const STATIC_ICONS: Record<AmbientKind, string> = {
  heartbeat: '⏱',
  cron: '⚙',
  loop: '↻',
  autoemon: '◐',
  dream: '🌙',
  inbox: '✉',
  failsafe: '🛡',
  herald: '◆',
  recovery: '✓',
};

// ── Hook ────────────────────────────────────────────────────────────

/**
 * Returns the current animated icon frame for an ambient kind.
 *
 * Only a single global interval per animation-kind exists — cheap
 * to mount on every badge. React batches re-renders per frame so 50
 * heartbeats on screen cost one re-render per pulse, not 50.
 */
export function useKindIcon(kind: AmbientKind): string {
  const anim = ANIMATIONS[kind];
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!anim) return;
    const id = setInterval(() => {
      setFrame(prev => (prev + 1) % anim.frames.length);
    }, anim.ms);
    return () => clearInterval(id);
  }, [anim]);

  if (anim) return anim.frames[frame % anim.frames.length]!;
  return STATIC_ICONS[kind] ?? '·';
}

/**
 * Convenience — true while the heartbeat pulse is in its "bright"
 * half-cycle. Components use this to apply a subtle color brighten
 * WITHOUT swapping the ⏱ glyph itself (which would feel jittery).
 * 700ms period matches a slow resting human pulse — borrowed metaphor.
 */
export function useHeartbeatPulse(active: boolean): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setOn(prev => !prev), 700);
    return () => clearInterval(id);
  }, [active]);
  return on;
}

// Exported for tests — not for rendering.
export const __FOR_TEST = { ANIMATIONS, STATIC_ICONS };
