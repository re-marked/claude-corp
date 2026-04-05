import { describe, it, expect, beforeEach } from 'vitest';
import { post } from '../packages/shared/src/post.js';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'claude-corp-test-post');
const MSG_PATH = join(TEST_DIR, 'messages.jsonl');

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

describe('post()', () => {
  it('writes a message to JSONL with correct fields', () => {
    const msg = post('ch-001', MSG_PATH, {
      senderId: 'ceo',
      content: 'Hello world',
      source: 'router',
    });

    expect(msg).not.toBeNull();
    expect(msg!.senderId).toBe('ceo');
    expect(msg!.content).toBe('Hello world');
    expect(msg!.channelId).toBe('ch-001');
    expect(msg!.kind).toBe('text');
    expect(msg!.id).toBeTruthy();
    expect(msg!.originId).toBe(msg!.id);
    expect(msg!.timestamp).toBeTruthy();
    expect((msg!.metadata as any).source).toBe('router');

    // Verify it's in the file
    const lines = readFileSync(MSG_PATH, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.senderId).toBe('ceo');
  });

  it('throws if senderId is missing', () => {
    expect(() => {
      post('ch-001', MSG_PATH, {
        senderId: '',
        content: 'test',
        source: 'user',
      });
    }).toThrow('senderId is MANDATORY');
  });

  it('deduplicates same sender+content within 5 seconds', () => {
    const msg1 = post('ch-001', MSG_PATH, {
      senderId: 'ceo',
      content: 'duplicate test',
      source: 'router',
    });
    const msg2 = post('ch-001', MSG_PATH, {
      senderId: 'ceo',
      content: 'duplicate test',
      source: 'router',
    });

    expect(msg1).not.toBeNull();
    expect(msg2).toBeNull(); // Deduped

    const lines = readFileSync(MSG_PATH, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1); // Only one write
  });

  it('allows same content from different senders', () => {
    const msg1 = post('ch-001', MSG_PATH, {
      senderId: 'ceo',
      content: 'same content',
      source: 'router',
    });
    const msg2 = post('ch-001', MSG_PATH, {
      senderId: 'herald',
      content: 'same content',
      source: 'router',
    });

    expect(msg1).not.toBeNull();
    expect(msg2).not.toBeNull(); // Different sender = not deduped

    const lines = readFileSync(MSG_PATH, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('sets slumber flag in metadata when passed', () => {
    const msg = post('ch-001', MSG_PATH, {
      senderId: 'ceo',
      content: 'autonomous work',
      source: 'jack',
      slumber: true,
    });

    expect((msg!.metadata as any).slumber).toBe(true);
  });

  it('sets kind to tool_event when specified', () => {
    const msg = post('ch-001', MSG_PATH, {
      senderId: 'ceo',
      content: 'read file.ts',
      source: 'jack',
      kind: 'tool_event',
    });

    expect(msg!.kind).toBe('tool_event');
  });
});
