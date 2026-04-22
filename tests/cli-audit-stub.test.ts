import { describe, it, expect, vi } from 'vitest';
import { cmdAudit } from '../packages/cli/src/commands/audit.js';

/**
 * Smoke coverage for the 0.7.2 cc-cli audit stub. The stub's whole job
 * is "approve everything so the Stop hook doesn't block sessions until
 * 0.7.3 ships the real audit gate." A crash at invocation time would
 * silently break every fresh Claude Code hire's session-end flow.
 *
 * 0.7.3 will replace the stub wholesale — these tests will be rewritten
 * against the real audit logic. Keeping them minimal so the churn is
 * trivial when that happens.
 */

describe('cmdAudit (0.7.2 stub — approves everything)', () => {
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

  it('accepts but ignores --json flag (stub output shape is fixed regardless)', async () => {
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

  it('accepts omitted --agent (the stub ignores it; 0.7.3 real command will require it)', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    try {
      await expect(cmdAudit({ json: false })).resolves.not.toThrow();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});
