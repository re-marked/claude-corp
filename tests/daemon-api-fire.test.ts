import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';

import { createApi } from '../packages/daemon/src/api.js';

/**
 * Integration tests for POST /agents/:id/fire — the fire/remove endpoint.
 *
 * Covers:
 * - Authorization rules (who can fire whom)
 * - CEO sacred protection
 * - Cascade protection (leader with workers)
 * - Cascade execution (subordinates removed first)
 * - Fire vs remove (archive vs delete)
 * - Error handling (invalid agent, missing fields)
 *
 * Known bug tracked: DM channel entries are NOT removed from channels.json
 * after fire/remove — memberIds are stripped correctly but the channel entry
 * itself persists. Tests marked with [BUG] document this failure.
 */

const FOUNDER: Record<string, unknown> = {
  id: 'mark', displayName: 'mark', rank: 'owner', status: 'active',
  type: 'user', scope: 'corp', scopeId: 'corp', agentDir: null,
  port: null, spawnedBy: null, createdAt: '2026-01-01T00:00:00.000Z',
};
const CEO: Record<string, unknown> = {
  id: 'ceo', displayName: 'CEO', rank: 'master', status: 'active',
  type: 'agent', scope: 'corp', scopeId: 'corp', agentDir: 'agents/ceo/',
  port: null, spawnedBy: 'mark', createdAt: '2026-01-01T00:00:00.000Z',
};
const LEADER: Record<string, unknown> = {
  id: 'eng-lead', displayName: 'Engineering Lead', rank: 'leader', status: 'active',
  type: 'agent', scope: 'corp', scopeId: 'corp', agentDir: 'agents/eng-lead/',
  port: null, spawnedBy: 'ceo', createdAt: '2026-01-01T00:00:00.000Z',
};
const WORKER: Record<string, unknown> = {
  id: 'backend', displayName: 'Backend Engineer', rank: 'worker', status: 'active',
  type: 'agent', scope: 'corp', scopeId: 'corp', agentDir: 'agents/backend/',
  port: null, spawnedBy: 'ceo', createdAt: '2026-01-01T00:00:00.000Z',
};
const WORKER_UNDER_LEAD: Record<string, unknown> = {
  id: 'lead-worker', displayName: 'Lead Worker', rank: 'worker', status: 'active',
  type: 'agent', scope: 'corp', scopeId: 'corp', agentDir: 'agents/lead-worker/',
  port: null, spawnedBy: 'eng-lead', createdAt: '2026-01-01T00:00:00.000Z',
};

function makeDmChannel(member1: string, member2: string) {
  const names = [member1, member2].sort();
  const name = `dm-${names[0]}-${names[1]}`;
  return {
    id: name, name, kind: 'direct', scope: 'corp', scopeId: '', teamId: null,
    memberIds: [member1, member2], createdBy: member1,
    path: `channels/${name}/`, createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('POST /agents/:id/fire', () => {
  let server: Server;
  let port: number;
  let corpRoot: string;

  function writeMembers(members: unknown[]) {
    writeFileSync(join(corpRoot, 'members.json'), JSON.stringify(members, null, 2), 'utf-8');
  }
  function readMembers(): unknown[] {
    return JSON.parse(readFileSync(join(corpRoot, 'members.json'), 'utf-8'));
  }
  function writeChannels(channels: unknown[]) {
    writeFileSync(join(corpRoot, 'channels.json'), JSON.stringify(channels, null, 2), 'utf-8');
  }
  function readChannels(): unknown[] {
    return JSON.parse(readFileSync(join(corpRoot, 'channels.json'), 'utf-8'));
  }

  async function postFire(targetId: string, body: Record<string, unknown>) {
    return fetch(`http://127.0.0.1:${port}/agents/${encodeURIComponent(targetId)}/fire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    corpRoot = join(tmpdir(), `corp-fire-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(corpRoot, { recursive: true });
    mkdirSync(join(corpRoot, 'channels'), { recursive: true });
    mkdirSync(join(corpRoot, 'agents', 'ceo'), { recursive: true });
    mkdirSync(join(corpRoot, 'agents', 'eng-lead'), { recursive: true });
    mkdirSync(join(corpRoot, 'agents', 'backend'), { recursive: true });
    mkdirSync(join(corpRoot, 'agents', 'lead-worker'), { recursive: true });
    writeMembers([FOUNDER, CEO, LEADER, WORKER, WORKER_UNDER_LEAD]);
    writeChannels([]);

    const stubDaemon = {
      corpRoot,
      processManager: { stopAgent: vi.fn().mockResolvedValue(undefined) },
      heartbeat: { refreshAll: vi.fn() },
    } as unknown as Parameters<typeof createApi>[0];

    server = createApi(stubDaemon);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { rmSync(corpRoot, { recursive: true, force: true }); } catch {}
  });

  // ── Validation ───────────────────────────────────────────────────────────

  it('returns 400 when required fields are missing', async () => {
    const res = await postFire('backend', { requesterId: 'ceo' }); // missing action
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toMatch(/required/i);
  });

  it('returns 404 when target agent does not exist', async () => {
    const res = await postFire('ghost-agent', { requesterId: 'ceo', action: 'fire', cascade: false });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 404 when requester does not exist', async () => {
    const res = await postFire('backend', { requesterId: 'phantom', action: 'fire', cascade: false });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toMatch(/not found/i);
  });

  // ── CEO sacred ───────────────────────────────────────────────────────────

  it('refuses to fire CEO (sacred agent)', async () => {
    const res = await postFire('ceo', { requesterId: 'mark', action: 'fire', cascade: false });
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toMatch(/CEO cannot be fired/i);
  });

  it('refuses CEO self-fire', async () => {
    const res = await postFire('ceo', { requesterId: 'ceo', action: 'fire', cascade: false });
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe('string');
  });

  // ── Authorization ────────────────────────────────────────────────────────

  it('allows founder to fire any agent', async () => {
    const res = await postFire('backend', { requesterId: 'mark', action: 'fire', cascade: false });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it('allows CEO to fire any agent (except itself)', async () => {
    const res = await postFire('backend', { requesterId: 'ceo', action: 'fire', cascade: false });
    expect(res.status).toBe(200);
  });

  it('allows leader to fire their own worker', async () => {
    const res = await postFire('lead-worker', { requesterId: 'eng-lead', action: 'fire', cascade: false });
    expect(res.status).toBe(200);
  });

  it('prevents leader from firing a worker not under them', async () => {
    const res = await postFire('backend', { requesterId: 'eng-lead', action: 'fire', cascade: false });
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toMatch(/authority/i);
  });

  it('prevents worker from firing anyone', async () => {
    const res = await postFire('lead-worker', { requesterId: 'backend', action: 'fire', cascade: false });
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toMatch(/authority/i);
  });

  // ── Cascade protection ───────────────────────────────────────────────────

  it('blocks firing a leader with active workers when cascade=false', async () => {
    const res = await postFire('eng-lead', { requesterId: 'ceo', action: 'fire', cascade: false });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toMatch(/cascade/i);
  });

  it('message mentions "cascade: true" as the solution', async () => {
    const res = await postFire('eng-lead', { requesterId: 'ceo', action: 'fire', cascade: false });
    const body = await res.json() as Record<string, unknown>;
    expect(String(body.error)).toMatch(/cascade/i);
  });

  // ── Cascade execution ────────────────────────────────────────────────────

  it('fires subordinates first then leader when cascade=true', async () => {
    const res = await postFire('eng-lead', { requesterId: 'ceo', action: 'fire', cascade: true });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const fired = body.firedAgents as string[];
    expect(fired).toContain('lead-worker');
    expect(fired).toContain('eng-lead');
    // Worker must appear before leader (leaves-first ordering)
    expect(fired.indexOf('lead-worker')).toBeLessThan(fired.indexOf('eng-lead'));
  });

  it('marks all cascade-fired agents as archived in members.json', async () => {
    await postFire('eng-lead', { requesterId: 'ceo', action: 'fire', cascade: true });
    const members = readMembers() as Array<{ id: string; status: string }>;
    const lead = members.find(m => m.id === 'eng-lead');
    const worker = members.find(m => m.id === 'lead-worker');
    expect(lead?.status).toBe('archived');
    expect(worker?.status).toBe('archived');
  });

  // ── Fire vs Remove ───────────────────────────────────────────────────────

  it('fire: marks agent as archived in members.json', async () => {
    await postFire('backend', { requesterId: 'ceo', action: 'fire', cascade: false });
    const members = readMembers() as Array<{ id: string; status: string }>;
    const agent = members.find(m => m.id === 'backend');
    expect(agent?.status).toBe('archived');
  });

  it('fire: archives workspace directory (renames to .archived-*)', async () => {
    await postFire('backend', { requesterId: 'ceo', action: 'fire', cascade: false });
    const agentsDir = join(corpRoot, 'agents');
    const entries = rmSync ? undefined : undefined; // just check via existsSync
    const original = existsSync(join(agentsDir, 'backend'));
    const archived = existsSync(join(agentsDir, `.archived-backend-${new Date().toISOString().slice(0, 10)}`));
    // Original dir gone, archived dir present
    expect(original).toBe(false);
    expect(archived).toBe(true);
  });

  it('remove: deletes agent from members.json entirely', async () => {
    await postFire('backend', { requesterId: 'ceo', action: 'remove', cascade: false });
    const members = readMembers() as Array<{ id: string }>;
    expect(members.find(m => m.id === 'backend')).toBeUndefined();
  });

  it('remove: purges workspace directory', async () => {
    await postFire('backend', { requesterId: 'ceo', action: 'remove', cascade: false });
    expect(existsSync(join(corpRoot, 'agents', 'backend'))).toBe(false);
  });

  // ── DM channel cleanup ───────────────────────────────────────────────────

  it('strips fired agent from all channel memberIds', async () => {
    const general = {
      id: 'general', name: 'general', kind: 'group', scope: 'corp', scopeId: '',
      teamId: null, memberIds: ['ceo', 'backend'], createdBy: 'mark',
      path: 'channels/general/', createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeChannels([general]);
    await postFire('backend', { requesterId: 'ceo', action: 'fire', cascade: false });
    const channels = readChannels() as Array<{ id: string; memberIds: string[] }>;
    const gen = channels.find(c => c.id === 'general');
    expect(gen?.memberIds).not.toContain('backend');
  });

  it('[BUG] DM channel entry is removed from channels.json after fire', async () => {
    // Known bug: channel entry persists even though memberIds are stripped.
    // This test documents expected behavior — remove [BUG] tag when fixed.
    const dmChannel = makeDmChannel('mark', 'backend');
    mkdirSync(join(corpRoot, 'channels', dmChannel.name), { recursive: true });
    writeChannels([dmChannel]);

    await postFire('backend', { requesterId: 'ceo', action: 'fire', cascade: false });

    const channels = readChannels() as Array<{ id: string }>;
    const remaining = channels.find(c => c.id === dmChannel.id);
    // BUG: this currently fails — channel entry persists
    expect(remaining, 'DM channel should be removed after firing agent').toBeUndefined();
  });

  it('[BUG] DM channel directory is deleted from disk after fire', async () => {
    const dmChannel = makeDmChannel('mark', 'backend');
    const dmDir = join(corpRoot, 'channels', dmChannel.name);
    mkdirSync(dmDir, { recursive: true });
    writeChannels([dmChannel]);

    await postFire('backend', { requesterId: 'ceo', action: 'fire', cascade: false });

    // BUG: directory persists
    expect(existsSync(dmDir), 'DM channel directory should be deleted').toBe(false);
  });

  // ── Response shape ───────────────────────────────────────────────────────

  it('success response includes ok, action, firedAgents, message', async () => {
    const res = await postFire('backend', { requesterId: 'ceo', action: 'fire', cascade: false });
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.action).toBe('fire');
    expect(Array.isArray(body.firedAgents)).toBe(true);
    expect(typeof body.message).toBe('string');
  });
});
