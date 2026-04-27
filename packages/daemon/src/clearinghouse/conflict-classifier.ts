/**
 * Merge-conflict classifier (Project 1.12).
 *
 * Parses git's conflict markers in a merged file, classifies each
 * block by triviality (identical / whitespace-only / comment-only /
 * substantive), and suggests an auto-resolution for trivial cases.
 * Pressman's `attemptMerge` flow uses this to decide whether to
 * resolve in-place or file a blocker.
 *
 * ### Why a code primitive
 *
 * Conflict-marker parsing is the kind of brittle text handling that
 * a code module nails and an agent fumbles. The structural
 * extraction must be exact (offsets matter for in-place
 * resolution); the agent should never try to do this from raw
 * file content.
 *
 * ### Marker shapes supported
 *
 * Standard:
 *   <<<<<<< HEAD
 *   ours
 *   =======
 *   theirs
 *   >>>>>>> branch
 *
 * diff3 / zdiff3 (with merge.conflictStyle):
 *   <<<<<<< HEAD
 *   ours
 *   ||||||| base
 *   common ancestor
 *   =======
 *   theirs
 *   >>>>>>> branch
 *
 * The base section is captured but not used in v1's classification
 * — keeping it makes future enhancements (semantic three-way merge)
 * non-disruptive.
 *
 * ### Triviality categories
 *
 * - `identical-content`: ours and theirs match byte-for-byte after
 *   line-ending normalization. Resolution: collapse markers, keep
 *   one copy. Real cause: typically the same fix landed twice via
 *   different routes.
 *
 * - `whitespace-only`: ours and theirs differ only in whitespace
 *   (leading/trailing/internal). Resolution: pick theirs (they came
 *   in fresher). Real cause: editor reformatted, both sides did,
 *   slight difference in indent or trailing newline.
 *
 * - `comment-only`: ours and theirs differ only in lines that
 *   parse as comments per the file's extension. Resolution: pick
 *   theirs. Real cause: docstring update on both sides.
 *
 * - `substantive`: anything else. No auto-resolution; route to the
 *   author's role with the conflict block included for context.
 *
 * Order is important: `identical-content` → `whitespace-only` →
 * `comment-only` → `substantive`. Always pick the most specific
 * (cheapest) category that applies — an identical block isn't
 * "whitespace-only," it's literally identical.
 *
 * ### Out of scope (v1)
 *
 * - Semantic three-way merge using the diff3 base. The base is
 *   captured for future use; v1 ignores it for classification.
 * - Language-aware AST comparison. Comment detection is heuristic
 *   per file extension; we don't parse the file. A `//` inside a
 *   string literal is a false positive for "comment line." That's
 *   an acceptable v1 risk — substantive-classification is the
 *   safe default when heuristics disagree, so a misclassified
 *   string-with-slashes would land in `substantive` (the safe
 *   side), not auto-resolved incorrectly.
 * - Add/delete conflicts (one side deletes, other modifies). These
 *   show up as conflict blocks with one empty side; we classify
 *   them as substantive (always need human judgment).
 */

export type ConflictTriviality =
  | 'identical-content'
  | 'whitespace-only'
  | 'comment-only'
  | 'substantive';

export interface ConflictBlock {
  /** 1-indexed line where the `<<<<<<<` marker sits. */
  readonly startLine: number;
  /** 1-indexed line where the `>>>>>>>` marker sits. */
  readonly endLine: number;
  /** "Ours" content lines (between `<<<<<<<` and `||||||` or `=======`). */
  readonly current: readonly string[];
  /** "Theirs" content lines (between `=======` and `>>>>>>>`). */
  readonly incoming: readonly string[];
  /** Diff3-mode base content (between `||||||` and `=======`). Empty when absent. */
  readonly base: readonly string[];
  /** Block's triviality classification. */
  readonly triviality: ConflictTriviality;
  /**
   * Suggested resolution lines for trivial blocks. Absent for
   * substantive blocks (no auto-resolve possible). The orchestrator
   * splices these in place of the entire marker-bracketed region.
   */
  readonly resolution?: readonly string[];
}

export interface ClassifiedFile {
  readonly filePath: string;
  readonly blocks: readonly ConflictBlock[];
  /** True iff every block has a resolution. Pressman's "auto-resolve this file" gate. */
  readonly fullyTrivial: boolean;
  /**
   * Worst classification across blocks. `substantive` if any block
   * is substantive; otherwise the worst of identical/whitespace/comment.
   * Drives the file's overall handling.
   */
  readonly worstTriviality: ConflictTriviality;
}

// ─── Parser ──────────────────────────────────────────────────────────

/**
 * Extract conflict blocks from a file's raw contents. Handles both
 * standard and diff3 marker forms. Tolerates malformed markers by
 * skipping the malformed range and continuing — we'd rather classify
 * partial conflicts than refuse to handle the file.
 */
export function parseConflictMarkers(fileContents: string): Omit<ConflictBlock, 'triviality' | 'resolution'>[] {
  // Normalize line endings so offsets stay sane on Windows-checked-out repos.
  const normalized = fileContents.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  type State = 'outside' | 'in-current' | 'in-base' | 'in-incoming';
  const blocks: Omit<ConflictBlock, 'triviality' | 'resolution'>[] = [];

  let state: State = 'outside';
  let blockStart = -1;
  let current: string[] = [];
  let base: string[] = [];
  let incoming: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('<<<<<<< ') || line === '<<<<<<<') {
      // New conflict block opens. If we were already inside one,
      // that's malformed — discard the in-progress and reset.
      state = 'in-current';
      blockStart = i;
      current = [];
      base = [];
      incoming = [];
      continue;
    }
    if (state !== 'outside') {
      if (line.startsWith('||||||| ') || line === '|||||||') {
        // diff3 base section starts.
        state = 'in-base';
        continue;
      }
      if (line === '=======') {
        // Switch from current/base to incoming.
        state = 'in-incoming';
        continue;
      }
      if (line.startsWith('>>>>>>> ') || line === '>>>>>>>') {
        // Block closes.
        if (state === 'in-incoming' && blockStart >= 0) {
          blocks.push({
            startLine: blockStart + 1,
            endLine: i + 1,
            current: [...current],
            incoming: [...incoming],
            base: [...base],
          });
        }
        // else: malformed (close before =======), discard and reset.
        state = 'outside';
        blockStart = -1;
        current = [];
        base = [];
        incoming = [];
        continue;
      }
      // Regular content line within a section.
      switch (state) {
        case 'in-current':
          current.push(line);
          break;
        case 'in-base':
          base.push(line);
          break;
        case 'in-incoming':
          incoming.push(line);
          break;
      }
    }
  }

  return blocks;
}

// ─── Comment detection ───────────────────────────────────────────────

/**
 * Per-extension comment-line patterns. Heuristic (whole-line match
 * after stripping leading/trailing whitespace) — not AST-aware. The
 * conservative direction is to UNDER-match: a non-comment line being
 * passed through harmlessly differs into substantive classification
 * (safe), whereas a non-comment line incorrectly flagged AS comment
 * gets stripped and could mislabel a substantive conflict as
 * comment-only — which would then auto-resolve to incoming and
 * silently drop behavior changes (Codex P1 catch on PR #192).
 *
 * Each regex must match the WHOLE line (anchored ^…$). Lines with
 * code mixed alongside comments (`x = 1; // note`) are NOT
 * classified as comments — the comment fragment isn't enough to
 * make the line as a whole pure comment.
 */
const C_FAMILY_PATTERNS: RegExp[] = [
  /^\/\/.*$/,                  // pure // comment (rest of line)
  /^\/\*.*?\*\/$/,             // single-line /* … */ filling the whole line
  /^\/\*[^*]*$/,               // start of multi-line block /* … (no */ on this line)
  /^\*\/$/,                    // multi-line block end "*/"
  /^\*\s.*$|^\*$/,             // multi-line continuation "* foo" or bare "*"
];

const COMMENT_PATTERNS: Record<string, RegExp[]> = {
  // C-family: anchored //, /* */, *, */ patterns.
  '.ts': C_FAMILY_PATTERNS,
  '.tsx': C_FAMILY_PATTERNS,
  '.js': C_FAMILY_PATTERNS,
  '.jsx': C_FAMILY_PATTERNS,
  '.go': C_FAMILY_PATTERNS,
  '.rs': [...C_FAMILY_PATTERNS, /^\/\/\/.*$/], // doc-comment ///
  '.java': C_FAMILY_PATTERNS,
  '.c': C_FAMILY_PATTERNS,
  '.h': C_FAMILY_PATTERNS,
  '.cpp': C_FAMILY_PATTERNS,
  '.swift': C_FAMILY_PATTERNS,
  '.kt': C_FAMILY_PATTERNS,
  // Hash-comment family — anchored # at line start.
  '.py': [/^#.*$/],
  '.sh': [/^#.*$/],
  '.rb': [/^#.*$/],
  '.pl': [/^#.*$/],
  '.yaml': [/^#.*$/],
  '.yml': [/^#.*$/],
  '.toml': [/^#.*$/],
  '.dockerfile': [/^#.*$/],
  // Markup — pure single-line comment OR start/end of multi-line.
  '.md': [/^<!--.*-->$/, /^<!--[^>]*$/, /^.*-->$/],
  '.html': [/^<!--.*-->$/, /^<!--[^>]*$/, /^.*-->$/],
  '.xml': [/^<!--.*-->$/, /^<!--[^>]*$/, /^.*-->$/],
};

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return '';
  return filePath.slice(dot).toLowerCase();
}

/**
 * Pure: is this line entirely a comment per the file's extension?
 * Whitespace-only lines are NOT comments (so a block of blanks
 * doesn't classify as comment-only) — they classify as whitespace.
 */
export function isCommentLine(line: string, filePath: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  const ext = getExtension(filePath);
  const patterns = COMMENT_PATTERNS[ext];
  if (!patterns) return false;
  return patterns.some((re) => re.test(trimmed));
}

// ─── Classification ──────────────────────────────────────────────────

function normalizeWhitespace(lines: readonly string[]): string {
  // Collapse runs of whitespace + trim leading/trailing per-line, then
  // join with newline. Two blocks that differ only in indent/spacing
  // produce the same string here.
  return lines.map((l) => l.replace(/\s+/g, ' ').trim()).join('\n');
}

function withoutComments(lines: readonly string[], filePath: string): string {
  return lines
    .filter((l) => !isCommentLine(l, filePath))
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n');
}

/**
 * Classify a single block. Uses identical → whitespace → comment →
 * substantive ordering, picking the most specific match.
 *
 * Empty-side conflicts (one of current/incoming is empty) are
 * always substantive — these are add/delete conflicts and need a
 * human to confirm intent.
 */
export function classifyBlock(
  block: Omit<ConflictBlock, 'triviality' | 'resolution'>,
  filePath: string,
): ConflictTriviality {
  if (block.current.length === 0 || block.incoming.length === 0) {
    return 'substantive';
  }

  const currentStr = block.current.join('\n');
  const incomingStr = block.incoming.join('\n');

  // Identical: byte-for-byte match (LF-normalized).
  if (currentStr === incomingStr) return 'identical-content';

  // Whitespace-only: differ only in whitespace.
  if (normalizeWhitespace(block.current) === normalizeWhitespace(block.incoming)) {
    return 'whitespace-only';
  }

  // Comment-only: differ only in comment lines.
  if (withoutComments(block.current, filePath) === withoutComments(block.incoming, filePath)) {
    return 'comment-only';
  }

  return 'substantive';
}

/**
 * Suggest an auto-resolution for a trivial block. Returns the
 * lines to splice in place of the marker-bracketed region.
 *
 * Strategy:
 *   - identical-content: keep `incoming` (functionally same as
 *     keeping current — pick one; we pick incoming for consistency).
 *   - whitespace-only / comment-only: pick `incoming` (it's the
 *     fresher version; in our setup it's the rebased side).
 *   - substantive: returns null.
 */
export function suggestResolution(
  block: Omit<ConflictBlock, 'triviality' | 'resolution'> & { triviality: ConflictTriviality },
): readonly string[] | null {
  switch (block.triviality) {
    case 'identical-content':
    case 'whitespace-only':
    case 'comment-only':
      return [...block.incoming];
    case 'substantive':
      return null;
  }
}

// ─── High-level file classifier ──────────────────────────────────────

const TRIVIALITY_RANK: Record<ConflictTriviality, number> = {
  'identical-content': 0,
  'whitespace-only': 1,
  'comment-only': 2,
  substantive: 3,
};

function worstOf(a: ConflictTriviality, b: ConflictTriviality): ConflictTriviality {
  return TRIVIALITY_RANK[a] >= TRIVIALITY_RANK[b] ? a : b;
}

/**
 * Parse + classify all conflict blocks in a file. The fullyTrivial
 * flag is the operational gate Pressman uses: true means
 * `applyResolutions` produces a clean file the rebase can continue
 * with; false means at least one block needs human attention.
 */
export function classifyFile(fileContents: string, filePath: string): ClassifiedFile {
  const raw = parseConflictMarkers(fileContents);
  const blocks: ConflictBlock[] = raw.map((b) => {
    const triviality = classifyBlock(b, filePath);
    const resolution = suggestResolution({ ...b, triviality }) ?? undefined;
    return { ...b, triviality, ...(resolution !== undefined ? { resolution } : {}) };
  });

  let worst: ConflictTriviality = 'identical-content';
  let allTrivial = blocks.length > 0;
  for (const b of blocks) {
    worst = worstOf(worst, b.triviality);
    if (b.resolution === undefined) allTrivial = false;
  }
  if (blocks.length === 0) {
    // No conflicts in the file — fullyTrivial is true (nothing to
    // resolve), worstTriviality is identical (the empty/no-op case).
    allTrivial = true;
  }

  return {
    filePath,
    blocks,
    fullyTrivial: allTrivial,
    worstTriviality: worst,
  };
}

// ─── Resolution application ──────────────────────────────────────────

/**
 * Splice resolutions into the file content, replacing each conflict
 * block (markers + sections) with the suggested resolution lines.
 * Throws if any block has no resolution — caller must check
 * `fullyTrivial` first.
 *
 * Preserves line endings of the original (LF or CRLF inferred from
 * the input). Operates left-to-right line-by-line; safe for any
 * number of blocks per file.
 */
export function applyResolutions(fileContents: string, classified: ClassifiedFile): string {
  const usedCRLF = fileContents.includes('\r\n');
  const lines = fileContents.replace(/\r\n/g, '\n').split('\n');

  // Walk blocks in reverse so earlier line indices stay stable when
  // we splice replacements into the array.
  const blocksDescending = [...classified.blocks].sort((a, b) => b.startLine - a.startLine);
  for (const block of blocksDescending) {
    if (block.resolution === undefined) {
      throw new Error(
        `applyResolutions: block at ${classified.filePath}:${block.startLine}-${block.endLine} has no resolution (triviality=${block.triviality})`,
      );
    }
    // startLine/endLine are 1-indexed inclusive; convert to array indices.
    const start = block.startLine - 1;
    const end = block.endLine - 1;
    lines.splice(start, end - start + 1, ...block.resolution);
  }

  const joined = lines.join('\n');
  return usedCRLF ? joined.replace(/\n/g, '\r\n') : joined;
}
