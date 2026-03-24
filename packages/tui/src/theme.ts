/** Warm charcoal color palette — orange/amber accents on dark background. */
export const COLORS = {
  // Brand
  primary: '#E17055',     // burnt orange — accent, titles, active borders
  secondary: '#FFEAA7',   // warm yellow — highlights, active status

  // Semantic
  success: '#00B894',     // green — completed, healthy
  warning: '#FDCB6E',     // amber — assigned, idle, warnings
  danger: '#D63031',      // deep red — failed, crashed, errors
  info: '#E17055',        // orange — in_progress, links

  // Neutral
  text: '#DFE6E9',        // warm white — primary text
  subtle: '#B2BEC3',      // light warm gray — secondary text, timestamps
  muted: '#636E72',       // warm gray — dim, offline, archived
  border: '#636E72',      // warm gray — default borders
  borderActive: '#E17055', // orange — focused/active borders

  // Agents
  user: '#00B894',        // green — user/founder messages
  agent: '#E17055',       // orange — agent messages
  ceo: 'rainbow' as const, // special
  system: '#636E72',      // dim gray — system messages
} as const;

/** Status indicators using diamond/rotated square characters. */
export const STATUS = {
  active: { icon: '◆', color: COLORS.success },
  working: { icon: '◆', color: COLORS.info },
  idle: { icon: '◇', color: COLORS.warning },
  suspended: { icon: '◇', color: COLORS.muted },
  archived: { icon: '─', color: COLORS.muted },
  offline: { icon: '◇', color: COLORS.muted },
} as const;

/** Task status indicators. */
export const TASK_STATUS = {
  pending: { icon: '◇', color: COLORS.muted },
  assigned: { icon: '◆', color: COLORS.warning },
  in_progress: { icon: '◆', color: COLORS.info },
  blocked: { icon: '◈', color: COLORS.danger },
  completed: { icon: '✓', color: COLORS.success },
  failed: { icon: '✗', color: COLORS.danger },
  cancelled: { icon: '─', color: COLORS.muted },
} as const;

/** Task priority colors. */
export const PRIORITY = {
  critical: '#D63031',
  high: '#E17055',
  normal: '#DFE6E9',
  low: '#636E72',
} as const;

/** Border style for all views — always round (╭╮╰╯). */
export const BORDER_STYLE = 'round' as const;
