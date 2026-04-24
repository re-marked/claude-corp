import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChit } from '../packages/shared/src/chits.js';
import { parseAlarumDecision } from '../packages/daemon/src/continuity/alarum-prompt.js';
import {
  sextonLastHandoff,
  observationCountSince,
  buildAlarumContext,
} from '../packages/daemon/src/continuity/alarum-state.js';

/**
 * Project 1.9.3 — Alarum coverage.
 *
 * Two concerns, different test depths:
 *
 *   1. `parseAlarumDecision` — high-value. LLM output is unpredictable;
 *      the parser is the contract boundary between Alarum's prose and
 *      the dispatcher's structured consumer. Every subtle parse error
 *      could silently wake Sexton on garbage or skip a real wake.
 *      Exercise the happy path + every rejection path.
 *
 *   2. State primitives + buildAlarumContext — medium-value. Pure
 *      functions over corp state; the real risk is TypeScript type
 *      assumptions meeting runtime data (member records, chit files,
 *      process statuses). Cover the ones that read chits directly
 *      against a real tmpdir corp; skip daemon-dependent primitives
 *      that would need full ProcessManager setup (those get integration-
 *      tested in PR 2 when the whole chain runs).
 *
 * Subprocess dispatcher + Pulse tick wiring aren't tested here —
 * mocking claude-CLI spawns to unit-test the dispatcher layers a lot
 * of test-only machinery for limited real-bug coverage. They get
 * integration-tested in PR 2 when the chain actually runs against a
 * real (or sandboxed) claude binary.
 */

// ─── parseAlarumDecision ────────────────────────────────────────────

describe('parseAlarumDecision', () => {
  it('extracts a valid fenced JSON block with all four actions', () => {
    const cases: Array<'start' | 'wake' | 'nudge' | 'nothing'> = [
      'start',
      'wake',
      'nudge',
      'nothing',
    ];
    for (const action of cases) {
      const output = `\`\`\`json
{ "action": "${action}", "reason": "test reason" }
\`\`\``;
      const result = parseAlarumDecision(output);
      expect(result).not.toBeNull();
      expect(result!.action).toBe(action);
      expect(result!.reason).toBe('test reason');
    }
  });

  it('tolerates surrounding prose (permissive matcher)', () => {
    const output = `Here's my analysis of the corp state — quiet tick.

\`\`\`json
{ "action": "nothing", "reason": "no activity since last handoff" }
\`\`\`

Exiting.`;
    const result = parseAlarumDecision(output);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('nothing');
  });

  it('returns null when no JSON block is present', () => {
    const output = 'Alarum forgot to return a decision block.';
    expect(parseAlarumDecision(output)).toBeNull();
  });

  it('returns null on malformed JSON inside the block', () => {
    const output = `\`\`\`json
{ "action": "wake", "reason": "trailing comma", }
\`\`\``;
    expect(parseAlarumDecision(output)).toBeNull();
  });

  it('returns null when action is not one of the four enums', () => {
    const output = `\`\`\`json
{ "action": "escalate", "reason": "Alarum invented a new action" }
\`\`\``;
    expect(parseAlarumDecision(output)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const missingReason = `\`\`\`json
{ "action": "wake" }
\`\`\``;
    const missingAction = `\`\`\`json
{ "reason": "she emitted only a reason" }
\`\`\``;
    expect(parseAlarumDecision(missingReason)).toBeNull();
    expect(parseAlarumDecision(missingAction)).toBeNull();
  });

  it('returns null when action or reason have wrong types', () => {
    const actionNumber = `\`\`\`json
{ "action": 42, "reason": "wrong type on action" }
\`\`\``;
    const reasonArray = `\`\`\`json
{ "action": "wake", "reason": ["wrong", "type"] }
\`\`\``;
    expect(parseAlarumDecision(actionNumber)).toBeNull();
    expect(parseAlarumDecision(reasonArray)).toBeNull();
  });

  it('returns null on a top-level array (not an object)', () => {
    const output = `\`\`\`json
[{ "action": "wake", "reason": "wrapped in array" }]
\`\`\``;
    expect(parseAlarumDecision(output)).toBeNull();
  });
});

// ─── State primitives ───────────────────────────────────────────────

describe('alarum state primitives (chit-dependent)', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'alarum-state-'));
    // Minimal members.json so readConfig doesn't throw.
    writeFileSync(
      join(corpRoot, 'members.json'),
      JSON.stringify([
        {
          id: 'mark',
          displayName: 'Mark',
          rank: 'owner',
          type: 'user',
          status: 'active',
          scope: 'corp',
          scopeId: 'test-corp',
        },
      ]),
      'utf-8',
    );
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      // Windows fs-handle race — best effort.
    }
  });

  it('sextonLastHandoff returns null when no handoff chit exists', () => {
    expect(sextonLastHandoff(corpRoot)).toBeNull();
  });

  it('sextonLastHandoff returns the latest handoff with correct age', () => {
    // Create a handoff chit at agent:sexton scope. Age should be small
    // (just written) — we assert it's within a generous window rather
    // than exact value since the test has sub-millisecond drift.
    mkdirSync(join(corpRoot, 'agents', 'sexton'), { recursive: true });
    const chit = createChit(corpRoot, {
      type: 'handoff',
      scope: 'agent:sexton',
      createdBy: 'sexton',
      fields: {
        handoff: {
          predecessorSession: 'sess-prior',
          currentStep: 'patrol/health-check step-1',
          completed: [],
          nextAction: 'continue patrol on next wake',
        },
      },
    });

    const result = sextonLastHandoff(corpRoot);
    expect(result).not.toBeNull();
    expect(result!.chitId).toBe(chit.id);
    expect(result!.ageMs).toBeGreaterThanOrEqual(0);
    expect(result!.ageMs).toBeLessThan(10_000); // within 10s of creation
  });

  it('observationCountSince(null) returns count of all observations in the store', () => {
    expect(observationCountSince(corpRoot, null)).toBe(0);

    for (let i = 0; i < 3; i++) {
      createChit(corpRoot, {
        type: 'observation',
        scope: 'corp',
        createdBy: 'mark',
        fields: {
          observation: {
            category: 'NOTICE',
            subject: 'test',
            importance: 1,
          },
        },
      });
    }

    expect(observationCountSince(corpRoot, null)).toBe(3);
  });

  it('observationCountSince filters by createdAt — older obs excluded', () => {
    // Create an observation NOW, then sample counts with a future
    // timestamp that excludes it. Count must be 0 (obs was created
    // before the cutoff) even though the store has one observation.
    createChit(corpRoot, {
      type: 'observation',
      scope: 'corp',
      createdBy: 'mark',
      fields: {
        observation: {
          category: 'NOTICE',
          subject: 'past',
          importance: 1,
        },
      },
    });

    const farFuture = new Date(Date.now() + 60_000).toISOString();
    expect(observationCountSince(corpRoot, farFuture)).toBe(0);
  });
});

// ─── buildAlarumContext composition ─────────────────────────────────

describe('buildAlarumContext', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'alarum-ctx-'));
    writeFileSync(
      join(corpRoot, 'members.json'),
      JSON.stringify([{ id: 'mark', displayName: 'Mark', rank: 'owner', type: 'user' }]),
      'utf-8',
    );
  });

  afterEach(() => {
    try {
      rmSync(corpRoot, { recursive: true, force: true });
    } catch {
      // Windows fs-handle race.
    }
  });

  it('composes a context struct with all fields populated against a minimal corp', () => {
    // Build a stub daemon that satisfies the three surfaces alarum-state
    // reads: corpRoot, processManager.listAgents(), getAgentWorkStatus().
    // Sexton absent from members → sextonSessionAlive returns false.
    const stubDaemon = {
      corpRoot,
      processManager: {
        listAgents: () => [],
        getAgent: (_id: string) => null,
      },
      getAgentWorkStatus: (_id: string) => 'idle' as const,
    };

    const ctx = buildAlarumContext(stubDaemon as Parameters<typeof buildAlarumContext>[0]);

    expect(ctx.sextonAlive).toBe(false);
    expect(ctx.sextonHandoff).toBeNull();
    expect(ctx.agentStatus).toEqual({ idle: 0, busy: 0, broken: 0, offline: 0 });
    expect(ctx.observationsSinceHandoff).toBe(0);
    expect(ctx.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('agentStatus reflects process-manager state (ready/crashed/stopped classifications)', () => {
    const stubDaemon = {
      corpRoot,
      processManager: {
        listAgents: () => [
          { memberId: 'a1', displayName: 'A1', port: 1001, status: 'ready' as const },
          { memberId: 'a2', displayName: 'A2', port: 1002, status: 'ready' as const },
          { memberId: 'a3', displayName: 'A3', port: null, status: 'crashed' as const },
          { memberId: 'a4', displayName: 'A4', port: null, status: 'stopped' as const },
          { memberId: 'a5', displayName: 'A5', port: null, status: 'starting' as const },
        ],
        getAgent: (_id: string) => null,
      },
      // a1 busy, a2 idle; crashed/stopped/starting never hit work-status branch
      getAgentWorkStatus: (id: string) => (id === 'a1' ? 'busy' : 'idle') as 'busy' | 'idle',
    };

    const ctx = buildAlarumContext(stubDaemon as Parameters<typeof buildAlarumContext>[0]);

    expect(ctx.agentStatus.busy).toBe(1); // a1
    expect(ctx.agentStatus.idle).toBe(1); // a2
    expect(ctx.agentStatus.broken).toBe(1); // a3
    expect(ctx.agentStatus.offline).toBe(2); // a4 + a5
  });
});
