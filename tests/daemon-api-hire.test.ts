import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Mock hireAgent BEFORE importing createApi — vi.mock is hoisted above
// imports, so createApi's module-level `import { hireAgent } from
// './hire.js'` picks up the mocked version.
vi.mock('../packages/daemon/src/hire.js', () => ({
  hireAgent: vi.fn(),
}));

import { createApi } from '../packages/daemon/src/api.js';
import { hireAgent } from '../packages/daemon/src/hire.js';

/**
 * Regression test for a bug where POST /agents/hire silently dropped
 * the `harness` field from the request body — meaning cc-cli hire
 * --harness claude-code would persist harness='openclaw' (or the corp
 * default) and skip CLAUDE.md generation. Detected live, fixed by
 * adding `harness: (body.harness as string) ?? undefined` to the hire
 * opts passed to hireAgent().
 */

describe('POST /agents/hire harness threading', () => {
  let server: Server;
  let port: number;
  const mockedHire = hireAgent as unknown as ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockedHire.mockReset();
    mockedHire.mockResolvedValue({
      member: { id: 'stub-member', displayName: 'Stub', rank: 'worker', status: 'active', type: 'agent', scope: 'corp', scopeId: '', agentDir: 'agents/stub/', port: null, spawnedBy: 'x', createdAt: new Date().toISOString() },
      dmChannel: { id: 'stub-dm', name: 'dm-x-stub', path: 'channels/dm-x-stub/', memberIds: [], kind: 'direct', scope: 'corp', scopeId: '', teamId: null, createdBy: 'x', createdAt: new Date().toISOString() },
    });

    // Minimal daemon stub — only /agents/hire path is exercised in
    // these tests and the handler just passes daemon through to the
    // mocked hireAgent, so concrete state doesn't matter.
    const stubDaemon = {} as Parameters<typeof createApi>[0];
    server = createApi(stubDaemon);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function postHire(body: Record<string, unknown>) {
    return fetch(`http://127.0.0.1:${port}/agents/hire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('threads body.harness=claude-code into hireAgent opts', async () => {
    const res = await postHire({
      creatorId: 'mark',
      agentName: 'pilot',
      displayName: 'Pilot',
      rank: 'worker',
      harness: 'claude-code',
    });

    expect(res.status).toBe(200);
    expect(mockedHire).toHaveBeenCalledOnce();
    expect(mockedHire).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ harness: 'claude-code' }),
    );
  });

  it('threads body.harness=openclaw into hireAgent opts', async () => {
    await postHire({
      creatorId: 'mark',
      agentName: 'pilot',
      displayName: 'Pilot',
      rank: 'worker',
      harness: 'openclaw',
    });

    expect(mockedHire).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ harness: 'openclaw' }),
    );
  });

  it('passes harness=undefined when body omits it (corp default resolves downstream)', async () => {
    await postHire({
      creatorId: 'mark',
      agentName: 'pilot',
      displayName: 'Pilot',
      rank: 'worker',
    });

    expect(mockedHire).toHaveBeenCalledOnce();
    const opts = mockedHire.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.harness).toBeUndefined();
  });

  it('still threads other optional body fields (scope, scopeId, model, provider)', async () => {
    await postHire({
      creatorId: 'mark',
      agentName: 'pilot',
      displayName: 'Pilot',
      rank: 'worker',
      scope: 'project',
      scopeId: 'proj-1',
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      harness: 'claude-code',
    });

    expect(mockedHire).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'project',
        scopeId: 'proj-1',
        model: 'claude-opus-4-6',
        provider: 'anthropic',
        harness: 'claude-code',
      }),
    );
  });

  it('rejects when required fields missing (harness alone is not enough)', async () => {
    const res = await postHire({ harness: 'claude-code' });
    expect(res.status).toBe(400);
    expect(mockedHire).not.toHaveBeenCalled();
  });
});
