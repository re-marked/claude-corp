/**
 * B.R.A.I.N. — Browseable, Reflective, Authored, Indexed Notes
 *
 * Claude Corp's authored memory framework. Agents consolidate raw
 * experience into curated, typed, time-aware knowledge through a
 * dream pipeline — producing memory that has judgment built in,
 * instead of memory that has retrieval built in.
 *
 * Every BRAIN file has YAML frontmatter with this schema.
 */

// ── Memory Types ────────────────────────────────────────────────────

/** What kind of knowledge this memory represents. */
export type BrainMemoryType =
  | 'founder-preference'  // What the founder likes, hates, values. Highest priority.
  | 'technical'           // File paths, build commands, architecture. Changes fast.
  | 'decision'            // What was decided and WHY. The why matters more.
  | 'self-knowledge'      // Agent's own patterns, preferences, style. Krasis.
  | 'correction'          // Something the agent got wrong and what it learned.
  | 'relationship';       // Who does what, who to ask. Social memory.

/** Where this memory came from. Determines trust level. */
export type BrainSource =
  | 'founder-direct'      // The founder said this explicitly. Highest confidence.
  | 'observation'         // The agent noticed this during work.
  | 'dream'              // Consolidated from observations during dreaming.
  | 'correction'         // The founder corrected the agent on this.
  | 'agent-secondhand';  // Another agent communicated this.

/** How confident the agent is in this memory. */
export type BrainConfidence = 'high' | 'medium' | 'low';

// ── Frontmatter Schema ──────────────────────────────────────────────

/** YAML frontmatter for every BRAIN/ file. */
export interface BrainFrontmatter {
  /** What kind of knowledge this is. */
  type: BrainMemoryType;

  /** Freeform tags for retrieval. The semantic search layer. */
  tags: string[];

  /** Where this memory came from. */
  source: BrainSource;

  /** When this memory was first created. ISO date (YYYY-MM-DD). */
  created: string;

  /** When the content was last modified. ISO date (YYYY-MM-DD). */
  updated: string;

  /** When this was last confirmed still true — may differ from updated. ISO date (YYYY-MM-DD). */
  last_validated: string;

  /** How confident the agent is. founder-direct = high, inferred = medium, guessing = low. */
  confidence: BrainConfidence;
}

// ── Parsed BRAIN File ───────────────────────────────────────────────

/** A fully parsed BRAIN file: frontmatter + body + extracted metadata. */
export interface BrainFile {
  /** The filename without extension (e.g., 'founder-code-style'). */
  name: string;

  /** Absolute path to the file. */
  path: string;

  /** Parsed YAML frontmatter. */
  meta: BrainFrontmatter;

  /** Markdown body content (after frontmatter). */
  body: string;

  /** Wikilinks extracted from the body (e.g., ['auth-architecture', 'build-commands']). */
  links: string[];
}

// ── Stats & Search ──────────────────────────────────────────────────

/** Summary statistics for an agent's BRAIN. */
export interface BrainStats {
  /** Total number of BRAIN files. */
  fileCount: number;

  /** Count of files per memory type. */
  typeCounts: Partial<Record<BrainMemoryType, number>>;

  /** All unique tags across all files, sorted by frequency. */
  topTags: Array<{ tag: string; count: number }>;

  /** Files where last_validated is older than the staleness threshold. */
  staleFiles: Array<{ name: string; lastValidated: string; daysSinceValidation: number }>;

  /** Files with no inbound wikilinks from other BRAIN files. */
  orphanFiles: string[];

  /** Total wikilinks across all files. */
  totalLinks: number;
}

/** Search result from a BRAIN query. */
export interface BrainSearchResult {
  /** The matching file. */
  file: BrainFile;

  /** Why it matched (which tags, type, or link matched). */
  matchReason: string;
}
