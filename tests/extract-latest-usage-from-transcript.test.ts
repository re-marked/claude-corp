import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractLatestUsageFromTranscript } from '../packages/shared/src/audit/transcript.js';

/**
 * Coverage for the transcript-side token extractor used by 1.7 round 3's
 * auto-checkpoint. Walks the JSONL backwards looking for the latest
 * message_start / message_delta usage block. Defensive — fail-soft on
 * every class of input that could crash a production hook.
 */

function makeTranscript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'usage-transcript-'));
  const path = join(dir, 'transcript.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return path;
}

function cleanup(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort — Windows occasionally holds the file descriptor briefly.
  }
}

describe('extractLatestUsageFromTranscript — happy path', () => {
  it('returns the message_start usage block from a transcript with one event', () => {
    const path = makeTranscript([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 152_000,
              output_tokens: 0,
              cache_read_input_tokens: 120_000,
              cache_creation_input_tokens: 500,
            },
          },
        },
      },
    ]);
    try {
      const usage = extractLatestUsageFromTranscript(path);
      expect(usage).not.toBeNull();
      expect(usage!.inputTokens).toBe(152_000);
      expect(usage!.outputTokens).toBe(0);
      expect(usage!.cacheReadInputTokens).toBe(120_000);
      expect(usage!.cacheCreationInputTokens).toBe(500);
    } finally {
      cleanup(path);
    }
  });

  it('returns the LATEST usage when multiple events are present (most recent wins)', () => {
    const path = makeTranscript([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 50_000, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 75_000, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { input_tokens: 75_000, output_tokens: 3_200 },
        },
      },
    ]);
    try {
      const usage = extractLatestUsageFromTranscript(path);
      expect(usage!.inputTokens).toBe(75_000);
      expect(usage!.outputTokens).toBe(3_200);
    } finally {
      cleanup(path);
    }
  });

  it('extracts from message_delta when it is the latest event', () => {
    const path = makeTranscript([
      {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { input_tokens: 180_000, output_tokens: 1_500 },
        },
      },
    ]);
    try {
      const usage = extractLatestUsageFromTranscript(path);
      expect(usage!.inputTokens).toBe(180_000);
      expect(usage!.outputTokens).toBe(1_500);
    } finally {
      cleanup(path);
    }
  });

  it('defaults missing numeric fields to 0 (no NaN leaks)', () => {
    const path = makeTranscript([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 42 } },
        },
      },
    ]);
    try {
      const usage = extractLatestUsageFromTranscript(path);
      expect(usage!.inputTokens).toBe(42);
      expect(usage!.outputTokens).toBe(0);
      expect(usage!.cacheReadInputTokens).toBe(0);
      expect(usage!.cacheCreationInputTokens).toBe(0);
    } finally {
      cleanup(path);
    }
  });

  it('walks past non-usage events to find the latest usage', () => {
    const path = makeTranscript([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 100_000, output_tokens: 0 } },
        },
      },
      { type: 'user', content: 'some user turn' },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0 } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'hi' } } },
    ]);
    try {
      const usage = extractLatestUsageFromTranscript(path);
      expect(usage!.inputTokens).toBe(100_000);
    } finally {
      cleanup(path);
    }
  });
});

describe('extractLatestUsageFromTranscript — fail-soft paths', () => {
  it('returns null for a missing file', () => {
    expect(extractLatestUsageFromTranscript('/this/path/does/not/exist.jsonl')).toBeNull();
  });

  it('returns null for an empty string path', () => {
    expect(extractLatestUsageFromTranscript('')).toBeNull();
  });

  it('returns null for a transcript with no stream_event lines', () => {
    const path = makeTranscript([
      { type: 'user', content: 'just a prompt' },
      { type: 'assistant', content: 'just a reply' },
    ]);
    try {
      expect(extractLatestUsageFromTranscript(path)).toBeNull();
    } finally {
      cleanup(path);
    }
  });

  it('returns null for a transcript with stream_events but no usage blocks', () => {
    const path = makeTranscript([
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'x' } } },
    ]);
    try {
      expect(extractLatestUsageFromTranscript(path)).toBeNull();
    } finally {
      cleanup(path);
    }
  });

  it('skips malformed JSON lines and keeps walking', () => {
    const path = makeTranscript([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 55_000, output_tokens: 0 } },
        },
      },
    ]);
    try {
      // Append a garbage line AFTER the good one to prove the walker
      // skips it rather than aborting the whole scan.
      writeFileSync(
        path,
        // start with the good line, then corrupt content
        `{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":55000,"output_tokens":0}}}}\n{not valid json\n`,
        'utf-8',
      );
      const usage = extractLatestUsageFromTranscript(path);
      expect(usage!.inputTokens).toBe(55_000);
    } finally {
      cleanup(path);
    }
  });

  it('ignores usage objects where every numeric field is undefined (prevents zero-masking)', () => {
    // An empty-usage entry shouldn't be returned — that would hide a
    // real lower-down-in-the-file match. Prove by putting an empty
    // usage AFTER a real one: the walker should return the real one.
    const path = makeTranscript([
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { usage: { input_tokens: 99_000, output_tokens: 0 } },
        },
      },
      {
        type: 'stream_event',
        event: { type: 'message_delta', usage: {} }, // empty — should be skipped
      },
    ]);
    try {
      const usage = extractLatestUsageFromTranscript(path);
      expect(usage!.inputTokens).toBe(99_000);
    } finally {
      cleanup(path);
    }
  });
});
