export interface SpriteFrame {
  lines: string[];
}

export type SpriteState = 'idle' | 'working' | 'walking' | 'talking';

export interface SpriteDefinition {
  name: string;
  role: string;
  states: Record<SpriteState, SpriteFrame[]>;
}

/** Animation speed per state (ms between frames). */
export const STATE_INTERVALS: Record<SpriteState, number> = {
  idle: 500,     // slow — mostly still, occasional blink
  working: 400,  // moderate — gear spinning, legs moving
  walking: 300,  // fast — scuttling around
  talking: 600,  // moderate — speech indicator pulse
};
