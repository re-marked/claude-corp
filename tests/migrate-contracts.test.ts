import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrateContractsToChits,
  contractToChit,
} from '../packages/shared/src/migrations/migrate-contracts.js';
import { chitPath, readChit } from '../packages/shared/src/chits.js';
import type { Contract } from '../packages/shared/src/types/contract.js';
import { stringify as stringifyFrontmatter } from '../packages/shared/src/parsers/frontmatter.js';

function sampleContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'swift-oak',
    title: 'Ship the feature',
    goal: 'Feature X is delivered to users',
    projectId: 'proj-fire',
    leadId: null,
    status: 'draft',
    priority: 'normal',
    taskIds: [],
    blueprintId: null,
    deadline: null,
    createdBy: 'ceo',
    completedAt: null,
    reviewedBy: null,
    reviewNotes: null,
    rejectionCount: 0,
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
    ...overrides,
  };
}

function writeContractFile(corpRoot: string, projectName: string, contract: Contract, body = ''): string {
  const contractsDir = join(corpRoot, 'projects', projectName, 'contracts');
  mkdirSync(contractsDir, { recursive: true });
  const path = join(contractsDir, `${contract.id}.md`);
  writeFileSync(
    path,
    stringifyFrontmatter(contract as unknown as Record<string, unknown>, body),
    'utf-8',
  );
  return path;
}

describe('contractToChit — pure mapping', () => {
  it('maps minimal contract to chit', () => {
    const chit = contractToChit(sampleContract());
    expect(chit.id).toBe('swift-oak');
    expect(chit.type).toBe('contract');
    expect(chit.status).toBe('draft');
    expect(chit.ephemeral).toBe(false);
    expect(chit.createdBy).toBe('ceo');
    expect(chit.fields.contract.title).toBe('Ship the feature');
    expect(chit.fields.contract.projectId).toBe('proj-fire');
  });

  it('preserves every Contract field lossless', () => {
    const chit = contractToChit(
      sampleContract({
        id: 'blue-wave',
        status: 'review',
        taskIds: ['task-1', 'task-2'],
        leadId: 'engineering-lead',
        blueprintId: 'ship-feature',
        deadline: '2026-05-01T00:00:00.000Z',
        completedAt: '2026-04-28T14:00:00.000Z',
        reviewedBy: 'warden',
        reviewNotes: 'looks good',
        rejectionCount: 2,
      }),
    );
    expect(chit.status).toBe('review');
    expect(chit.fields.contract.taskIds).toEqual(['task-1', 'task-2']);
    expect(chit.fields.contract.leadId).toBe('engineering-lead');
    expect(chit.fields.contract.blueprintId).toBe('ship-feature');
    expect(chit.fields.contract.deadline).toBe('2026-05-01T00:00:00.000Z');
    expect(chit.fields.contract.completedAt).toBe('2026-04-28T14:00:00.000Z');
    expect(chit.fields.contract.reviewedBy).toBe('warden');
    expect(chit.fields.contract.reviewNotes).toBe('looks good');
    expect(chit.fields.contract.rejectionCount).toBe(2);
  });

  it('maps every ContractStatus 1:1 to ChitStatus (no coercion needed)', () => {
    for (const status of ['draft', 'active', 'review', 'completed', 'rejected', 'failed'] as const) {
      const chit = contractToChit(sampleContract({ status }));
      expect(chit.status).toBe(status);
    }
  });
});

describe('migrateContractsToChits — file migration', () => {
  let corpRoot: string;

  beforeEach(() => {
    corpRoot = mkdtempSync(join(tmpdir(), 'migrate-contracts-'));
  });

  afterEach(() => {
    rmSync(corpRoot, { recursive: true, force: true });
  });

  it('returns empty result when projects/ does not exist', () => {
    const result = migrateContractsToChits(corpRoot);
    expect(result.migrated).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('migrates a single contract to its project-scoped chit path', () => {
    const contract = sampleContract();
    const sourcePath = writeContractFile(corpRoot, 'fire', contract, 'contract body');

    const result = migrateContractsToChits(corpRoot);
    expect(result.migrated).toBe(1);
    expect(result.errors).toEqual([]);

    expect(existsSync(sourcePath)).toBe(false);
    const targetPath = chitPath(corpRoot, 'project:fire', 'contract', contract.id);
    expect(existsSync(targetPath)).toBe(true);
  });

  it('preserves contract body content', () => {
    const contract = sampleContract();
    writeContractFile(corpRoot, 'fire', contract, 'important contract body');

    migrateContractsToChits(corpRoot);

    const { body } = readChit(corpRoot, 'project:fire', 'contract', contract.id);
    expect(body.trim()).toBe('important contract body');
  });

  it('migrates contracts across multiple projects', () => {
    writeContractFile(corpRoot, 'alpha', sampleContract({ id: 'contract-a' }));
    writeContractFile(corpRoot, 'beta', sampleContract({ id: 'contract-b' }));
    writeContractFile(corpRoot, 'gamma', sampleContract({ id: 'contract-c' }));

    const result = migrateContractsToChits(corpRoot);
    expect(result.migrated).toBe(3);

    expect(existsSync(chitPath(corpRoot, 'project:alpha', 'contract', 'contract-a'))).toBe(true);
    expect(existsSync(chitPath(corpRoot, 'project:beta', 'contract', 'contract-b'))).toBe(true);
    expect(existsSync(chitPath(corpRoot, 'project:gamma', 'contract', 'contract-c'))).toBe(true);
  });

  it('is idempotent — re-running skips already-migrated contracts', () => {
    const contract = sampleContract();
    writeContractFile(corpRoot, 'fire', contract);

    const first = migrateContractsToChits(corpRoot);
    expect(first.migrated).toBe(1);

    writeContractFile(corpRoot, 'fire', contract); // Simulate partial-state source

    const second = migrateContractsToChits(corpRoot);
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('dry-run lists planned paths without writing or deleting', () => {
    const contract = sampleContract();
    const sourcePath = writeContractFile(corpRoot, 'fire', contract);

    const result = migrateContractsToChits(corpRoot, { dryRun: true });
    expect(result.migrated).toBe(0);
    expect(result.planned).toHaveLength(1);
    expect(result.planned[0].sourcePath).toBe(sourcePath);
    expect(result.planned[0].targetPath).toBe(chitPath(corpRoot, 'project:fire', 'contract', contract.id));

    expect(existsSync(sourcePath)).toBe(true);
    expect(existsSync(chitPath(corpRoot, 'project:fire', 'contract', contract.id))).toBe(false);
  });

  it('overwrite: true clobbers existing', () => {
    const contract = sampleContract();
    writeContractFile(corpRoot, 'fire', contract);
    migrateContractsToChits(corpRoot);
    writeContractFile(corpRoot, 'fire', contract); // Re-seed

    const result = migrateContractsToChits(corpRoot, { overwrite: true });
    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('continues through per-contract errors', () => {
    const badPath = join(corpRoot, 'projects', 'fire', 'contracts', 'bad.md');
    mkdirSync(join(corpRoot, 'projects', 'fire', 'contracts'), { recursive: true });
    writeFileSync(badPath, '---\n---\nno frontmatter id', 'utf-8');

    writeContractFile(corpRoot, 'fire', sampleContract({ id: 'good-contract' }));

    const result = migrateContractsToChits(corpRoot);
    expect(result.migrated).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].sourcePath).toBe(badPath);
  });

  it('migrated chit passes chit-types validation (round-trip integrity)', () => {
    const contract = sampleContract({
      id: 'roundtrip-contract',
      status: 'review',
      priority: 'high',
      leadId: 'engineering-lead',
      taskIds: ['task-dep1', 'task-dep2'],
      rejectionCount: 1,
    });
    writeContractFile(corpRoot, 'fire', contract);

    migrateContractsToChits(corpRoot);

    // readChit parses + validates. Throws if invalid.
    const { chit } = readChit(corpRoot, 'project:fire', 'contract', contract.id);
    expect(chit.type).toBe('contract');
    expect(chit.status).toBe('review');
    expect(chit.fields.contract.taskIds).toEqual(['task-dep1', 'task-dep2']);
    expect(chit.fields.contract.priority).toBe('high');
    expect(chit.fields.contract.rejectionCount).toBe(1);
    expect(chit.fields.contract.projectId).toBe('proj-fire');
  });
});
