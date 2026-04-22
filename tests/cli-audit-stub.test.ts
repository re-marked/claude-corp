import { describe, it, expect, vi } from 'vitest';
import { cmdAudit } from '../packages/cli/src/commands/audit.js';

/**
 * Fail-open invariant coverage for the 0.7.3 real cc-cli audit.
 *
 * Rich decision-tree coverage lives in tests/audit-engine.test.ts
 * (pure function, canned inputs). This file tests the I/O-shell
 * guarantees: even when cmdAudit is invoked outside a live corp
 * (no members.json, no resolvable state) or without --agent, it
 * MUST emit an approve decision and not throw. Trapping a session
 * because audit crashed on startup is the worst failure mode the
 * refactor thesis explicitly protects against.
 */

describe('cmdAudit — fail-open invariants (I/O shell)', () => {
  it('writes a JSON approve decision to stdout and does not throw', async () => {
    const writes: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);

    try {
      await cmdAudit({ agent: 'ceo', json: false });
    } finally {
      stdoutSpy.mockRestore();
    }

    const combined = writes.join('');
    const parsed = JSON.parse(combined);
    expect(parsed).toEqual({ decision: 'approve' });
  });

  it('accepts --json flag without crashing (fail-open still emits approve JSON)', async () => {
    const writes: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);

    try {
      await cmdAudit({ agent: 'ceo', json: true });
    } finally {
      stdoutSpy.mockRestore();
    }

    const combined = writes.join('');
    expect(JSON.parse(combined).decision).toBe('approve');
  });

  it('accepts omitted --agent without crashing (logs the missing-slug error, fail-open approves)', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    try {
      await expect(cmdAudit({ json: false })).resolves.not.toThrow();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
