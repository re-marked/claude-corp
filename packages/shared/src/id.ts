import { randomBytes } from 'node:crypto';

// ── Word Lists ──────────────────────────────────────────────────────
// ~120 adjectives × ~120 nouns = ~14,400 unique pairs.
// Curated for: short, distinct, pronounceable, agent-friendly.

const ADJECTIVES = [
  'bold', 'warm', 'swift', 'calm', 'keen', 'wild', 'soft', 'dark',
  'fair', 'neat', 'vast', 'true', 'deep', 'firm', 'pure', 'rare',
  'cool', 'rich', 'wise', 'tall', 'lean', 'blue', 'gold', 'iron',
  'jade', 'ruby', 'mint', 'gray', 'pine', 'plum', 'rust', 'teal',
  'late', 'long', 'thin', 'wide', 'high', 'low', 'old', 'new',
  'red', 'dry', 'raw', 'hot', 'icy', 'dim', 'shy', 'sly',
  'odd', 'apt', 'fit', 'glad', 'grim', 'hazy', 'lazy', 'pale',
  'ripe', 'snug', 'tidy', 'zany', 'deft', 'foul', 'hale', 'lush',
  'meek', 'prim', 'taut', 'wary', 'agile', 'brisk', 'crisp', 'dense',
  'eager', 'fleet', 'grand', 'hardy', 'jolly', 'lucid', 'merry', 'noble',
  'proud', 'quiet', 'rapid', 'sharp', 'stark', 'steep', 'stout', 'terse',
  'tight', 'vivid', 'young', 'fresh', 'light', 'rough', 'round', 'solid',
  'sweet', 'thick', 'clear', 'clean', 'plain', 'stark', 'bright', 'dusty',
  'foggy', 'muddy', 'rocky', 'sandy', 'sunny', 'windy', 'frosty', 'misty',
  'smoky', 'stormy', 'early', 'final', 'first', 'great', 'inner', 'outer',
];

const NOUNS = [
  'fox', 'owl', 'elk', 'jay', 'bee', 'ant', 'eel', 'ram',
  'yak', 'cod', 'hen', 'pup', 'cub', 'doe', 'mare', 'bull',
  'hawk', 'wolf', 'bear', 'deer', 'crow', 'dove', 'frog', 'goat',
  'hare', 'lynx', 'moth', 'newt', 'pike', 'seal', 'swan', 'toad',
  'wren', 'bass', 'colt', 'dusk', 'dawn', 'gale', 'haze', 'mist',
  'rain', 'snow', 'tide', 'wave', 'wind', 'vale', 'glen', 'peak',
  'reef', 'bay', 'cove', 'mesa', 'dune', 'ford', 'knoll', 'ridge',
  'grove', 'marsh', 'brook', 'creek', 'pond', 'lake', 'isle', 'cape',
  'oak', 'elm', 'ash', 'fir', 'yew', 'ivy', 'moss', 'vine',
  'reed', 'palm', 'sage', 'fern', 'iris', 'lily', 'rose', 'flax',
  'ore', 'gem', 'coal', 'clay', 'sand', 'salt', 'lime', 'zinc',
  'bolt', 'gear', 'coil', 'spur', 'rung', 'arch', 'beam', 'cord',
  'drum', 'flag', 'helm', 'knot', 'loom', 'mast', 'plow', 'sled',
  'vane', 'axle', 'husk', 'bark', 'burr', 'stem', 'thorn', 'root',
  'shard', 'flint', 'spark', 'ember', 'forge', 'anvil', 'latch', 'wedge',
];

// ── Generators ──────────────────────────────────────────────────────

function randomWord(list: readonly string[]): string {
  return list[Math.floor(Math.random() * list.length)]!;
}

function shortHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

// ── Counters (in-memory, reset per process) ─────────────────────────
// For numbered IDs we use a monotonic counter per prefix.
// On restart the counter resets, but the full ID is still unique
// because we add a 2-char hex salt to avoid collisions.

const counters = new Map<string, number>();

function nextCounter(prefix: string): string {
  const n = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, n);
  return String(n).padStart(4, '0');
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Member ID — the slug IS the ID.
 * "CEO" → "ceo", "Lead Coder" → "lead-coder", "Mark" → "mark"
 */
export function memberId(displayName: string): string {
  return displayName.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Channel ID — the slug IS the ID.
 * "#general" → "general", "DM: CEO" → "dm-ceo"
 */
export function channelId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/^#/, '');
}

/**
 * Task ID — adj-noun word pair.
 * "bold-fox", "warm-tide", "swift-elk"
 */
export function taskId(): string {
  return `${randomWord(ADJECTIVES)}-${randomWord(NOUNS)}`;
}

/**
 * Contract ID — adj-noun word pair.
 * "swift-oak", "blue-wave"
 */
export function contractId(): string {
  return `${randomWord(ADJECTIVES)}-${randomWord(NOUNS)}`;
}

/**
 * Project ID — pj-NNNN with hex salt for uniqueness across restarts.
 * "pj-0001-a3", "pj-0012-f7"
 */
export function projectId(): string {
  return `pj-${nextCounter('pj')}-${shortHex(1)}`;
}

/**
 * Team ID — tm-NNNN with hex salt.
 * "tm-0001-b2", "tm-0003-e9"
 */
export function teamId(): string {
  return `tm-${nextCounter('tm')}-${shortHex(1)}`;
}

/**
 * Clock ID — ck-NNNN with hex salt.
 * "ck-0001-d4", "ck-0008-1a"
 */
export function clockId(): string {
  return `ck-${nextCounter('ck')}-${shortHex(1)}`;
}

/**
 * Message ID — m-XXXXX short hex. Fast, unique enough for local use.
 * "m-a7f3e2", "m-1b9c04"
 */
export function messageId(): string {
  return `m-${shortHex(3)}`;
}

/**
 * Legacy generateId() — returns a message-style short hex.
 * Kept for backward compatibility. New code should use typed generators.
 */
export function generateId(): string {
  return messageId();
}

/**
 * Gateway token — long random string for authentication.
 * Security-relevant, intentionally NOT short.
 */
export function gatewayToken(): string {
  return shortHex(24);
}

/**
 * Temp file suffix — short random for atomic writes.
 */
export function tempSuffix(): string {
  return shortHex(4);
}
