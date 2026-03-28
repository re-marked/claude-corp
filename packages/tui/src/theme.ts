/** Premium dark palette — neutral tone, colorful accents. */
export const COLORS = {
  // Brand
  primary: '#E07B56',     // warm coral — accent, titles, active
  secondary: '#F0C674',   // golden — highlights

  // Semantic
  success: '#6CC490',     // vivid green — completed, healthy
  warning: '#F0C674',     // golden — assigned, idle, warnings
  danger: '#E05A5A',      // clear red — failed, crashed, errors
  info: '#6BAED6',        // sky blue — in_progress, working

  // Neutral — clean gray, no yellow cast
  text: '#E2E2E2',        // pure light gray — primary text
  subtle: '#9E9E9E',      // mid gray — timestamps, secondary
  muted: '#5A5A5A',       // dark gray — dim, offline, hints
  border: '#3A3A3A',      // charcoal — borders
  borderActive: '#E07B56', // coral — focused borders

  // Agents
  user: '#6CC490',        // green — user/founder messages
  agent: '#6BAED6',       // sky blue — agent messages
  ceo: 'rainbow' as const,
  system: '#5A5A5A',      // gray — system messages
} as const;

/** Status indicators — clean, minimal. */
export const STATUS = {
  active: { icon: '\u25CF', color: COLORS.success },   // ●
  working: { icon: '\u25CF', color: COLORS.info },      // ●
  idle: { icon: '\u25CB', color: COLORS.warning },      // ○
  suspended: { icon: '\u25CB', color: COLORS.muted },   // ○
  archived: { icon: '\u2013', color: COLORS.muted },    // –
  offline: { icon: '\u25CB', color: COLORS.muted },     // ○
} as const;

/** Task status indicators. */
export const TASK_STATUS = {
  pending: { icon: '\u25CB', color: COLORS.muted },     // ○
  assigned: { icon: '\u25CF', color: COLORS.warning },   // ●
  in_progress: { icon: '\u25CF', color: COLORS.info },   // ●
  blocked: { icon: '\u25CF', color: COLORS.danger },     // ●
  completed: { icon: '\u2713', color: COLORS.success },  // ✓
  failed: { icon: '\u2717', color: COLORS.danger },      // ✗
  cancelled: { icon: '\u2013', color: COLORS.muted },    // –
} as const;

/** Task priority colors. */
export const PRIORITY = {
  critical: '#E05A5A',
  high: '#E07B56',
  normal: '#E2E2E2',
  low: '#5A5A5A',
} as const;

/** Border style for all views. */
export const BORDER_STYLE = 'round' as const;
