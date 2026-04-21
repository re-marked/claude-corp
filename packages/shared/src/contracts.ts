/**
 * contracts.ts — thin compatibility wrapper over the chit primitive.
 *
 * Post-0.4-migration, contracts live as Chits of type=contract under
 * project scope. This module preserves the pre-chits external API
 * (createContract, readContract, updateContract, listContracts,
 * listAllContracts, contractPath, getContractProgress) so call sites
 * across daemon (contract-watcher) and tui keep compiling without edit.
 *
 * Internal storage moves to chits; same field semantics end-to-end.
 */

import { basename, dirname } from 'node:path';
import { join } from 'node:path';
import type { Contract, ContractStatus, ContractProgress } from './types/contract.js';
import type { TaskPriority } from './types/task.js';
import type { Chit, ContractFields } from './types/chit.js';
import {
  createChit,
  readChit,
  updateChit,
  queryChits,
  chitPath,
  chitScopeFromPath,
} from './chits.js';
import { contractId } from './id.js';
import { findTaskById } from './tasks.js';
import { contractToChit } from './migrations/migrate-contracts.js';

export interface CreateContractOpts {
  title: string;
  goal: string;
  projectId: string;
  projectName: string;
  leadId?: string | null;
  priority?: TaskPriority;
  deadline?: string | null;
  blueprintId?: string | null;
  createdBy: string;
  description?: string;
  acceptanceCriteria?: string[];
}

export interface ContractFilter {
  status?: ContractStatus;
  leadId?: string;
  projectId?: string;
}

export interface ContractWithBody {
  contract: Contract;
  body: string;
  path: string;
}

// ─── Chit → Contract reverse mapping ───────────────────────────────

function chitToContract(chit: Chit<'contract'>): Contract {
  const f = chit.fields.contract;
  return {
    id: chit.id,
    title: f.title,
    goal: f.goal,
    projectId: f.projectId ?? '',
    leadId: f.leadId ?? null,
    status: chit.status as ContractStatus,
    priority: f.priority ?? 'normal',
    taskIds: [...f.taskIds],
    blueprintId: f.blueprintId ?? null,
    deadline: f.deadline ?? null,
    createdBy: chit.createdBy,
    completedAt: f.completedAt ?? null,
    reviewedBy: f.reviewedBy ?? null,
    reviewNotes: f.reviewNotes ?? null,
    rejectionCount: f.rejectionCount ?? 0,
    createdAt: chit.createdAt,
    updatedAt: chit.updatedAt,
  };
}

// ─── Path handling ──────────────────────────────────────────────────

/**
 * Extract corpRoot + projectName + id from a contract file path. Accepts
 * both old-format (<corpRoot>/projects/<name>/contracts/<id>.md) and
 * new chit-format (<corpRoot>/projects/<name>/chits/contract/<id>.md)
 * so callers that cached pre-migration paths keep working.
 */
function parseContractFilePath(filePath: string): {
  corpRoot: string;
  projectName: string;
  id: string;
} {
  const id = basename(filePath).replace(/\.md$/, '');
  const dir = dirname(filePath);
  const dirBase = basename(dir);

  // Case 1: <corpRoot>/projects/<name>/contracts/<id>.md (pre-migration)
  if (dirBase === 'contracts') {
    const projectDir = dirname(dir);
    const projectName = basename(projectDir);
    const corpRoot = dirname(dirname(projectDir));
    return { corpRoot, projectName, id };
  }
  // Case 2: <corpRoot>/projects/<name>/chits/contract/<id>.md (post-migration)
  if (dirBase === 'contract' && basename(dirname(dir)) === 'chits') {
    const projectDir = dirname(dirname(dir));
    const projectName = basename(projectDir);
    const corpRoot = dirname(dirname(projectDir));
    return { corpRoot, projectName, id };
  }
  throw new Error(`cannot parse contract file path: ${filePath}`);
}

/**
 * Filesystem path for a contract. Returns the chit-based path
 * (<corpRoot>/projects/<name>/chits/contract/<id>.md) since that's where
 * contracts live post-migration. Callers caching the old path will still
 * work via readContract/updateContract's dual-path support.
 */
export function contractPath(
  corpRoot: string,
  projectName: string,
  contractIdValue: string,
): string {
  return chitPath(corpRoot, `project:${projectName}`, 'contract', contractIdValue);
}

// ─── CRUD wrappers ──────────────────────────────────────────────────

/**
 * Create a new contract inside a project. Goes through chit CRUD;
 * returns Contract shape for existing callers.
 */
export function createContract(corpRoot: string, opts: CreateContractOpts): Contract {
  // Generate word-pair id via contractId() for backward compat (same
  // format existing tasks/contracts use — isChitIdFormat accepts legacy
  // word-pair shape since 0.3).
  const id = contractId();
  const now = new Date().toISOString();

  // Build the Contract object first, convert via the migration helper
  // for consistency with everything else in the substrate.
  const contract: Contract = {
    id,
    title: opts.title,
    goal: opts.goal,
    projectId: opts.projectId,
    leadId: opts.leadId ?? null,
    status: 'draft',
    priority: opts.priority ?? 'normal',
    taskIds: [],
    blueprintId: opts.blueprintId ?? null,
    deadline: opts.deadline ?? null,
    createdBy: opts.createdBy,
    completedAt: null,
    reviewedBy: null,
    reviewNotes: null,
    rejectionCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  const chitShape = contractToChit(contract);

  // Body assembly preserved from pre-chits behavior.
  let body = '';
  if (opts.description) body += `${opts.description}\n\n`;
  if (opts.acceptanceCriteria?.length) {
    body += `## Acceptance Criteria\n`;
    for (const ac of opts.acceptanceCriteria) body += `- [ ] ${ac}\n`;
    body += '\n';
  }
  body += `## Progress\n(Updated by lead as tasks complete)\n`;

  const createdChit = createChit(corpRoot, {
    type: 'contract',
    scope: `project:${opts.projectName}`,
    id,
    fields: { contract: chitShape.fields.contract },
    createdBy: contract.createdBy,
    status: chitShape.status,
    ephemeral: false,
    references: [],
    dependsOn: [],
    tags: [],
    body,
  });

  return chitToContract(createdChit);
}

/**
 * Read a contract by filesystem path. Accepts old or new path format;
 * routes through the chit primitive. Returns Contract shape + body.
 */
export function readContract(filePath: string): { contract: Contract; body: string } {
  const { corpRoot, projectName, id } = parseContractFilePath(filePath);
  const { chit, body } = readChit(corpRoot, `project:${projectName}`, 'contract', id);
  return { contract: chitToContract(chit as Chit<'contract'>), body };
}

/**
 * Update contract frontmatter fields. Reads current chit, merges the
 * partial Contract update, converts back to chit shape, writes via
 * updateChit. Bumps updatedAt automatically.
 */
export function updateContract(filePath: string, updates: Partial<Contract>): Contract {
  const { corpRoot, projectName, id } = parseContractFilePath(filePath);

  const { chit: currentChit } = readChit(corpRoot, `project:${projectName}`, 'contract', id);
  const currentContract = chitToContract(currentChit as Chit<'contract'>);
  const merged: Contract = {
    ...currentContract,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const mergedChit = contractToChit(merged);

  const updatedChit = updateChit(corpRoot, `project:${projectName}`, 'contract', id, {
    status: mergedChit.status,
    fields: { contract: mergedChit.fields.contract } as Partial<{ contract: ContractFields }>,
    updatedBy: 'system',
  });

  return chitToContract(updatedChit as Chit<'contract'>);
}

/**
 * List contracts in a specific project. Uses queryChits with project-
 * scoped filter, converts each to Contract shape, applies caller-side
 * filters in-memory.
 */
export function listContracts(
  corpRoot: string,
  projectName: string,
  filter?: ContractFilter,
): ContractWithBody[] {
  const { chits } = queryChits(corpRoot, {
    types: ['contract'],
    scopes: [`project:${projectName}`],
    limit: 0,
  });

  let results: ContractWithBody[] = chits.map(({ chit, body, path }) => ({
    contract: chitToContract(chit as Chit<'contract'>),
    body,
    path,
  }));

  if (filter) {
    results = results.filter(({ contract }) => {
      if (filter.status && contract.status !== filter.status) return false;
      if (filter.leadId && contract.leadId !== filter.leadId) return false;
      if (filter.projectId && contract.projectId !== filter.projectId) return false;
      return true;
    });
  }

  return results;
}

/**
 * List contracts across ALL projects in the corp. Uses queryChits with
 * no scope filter (walks all project scopes automatically).
 */
export function listAllContracts(
  corpRoot: string,
  filter?: ContractFilter,
): ContractWithBody[] {
  const { chits } = queryChits(corpRoot, { types: ['contract'], limit: 0 });

  let results: ContractWithBody[] = chits.map(({ chit, body, path }) => ({
    contract: chitToContract(chit as Chit<'contract'>),
    body,
    path,
  }));

  if (filter) {
    results = results.filter(({ contract }) => {
      if (filter.status && contract.status !== filter.status) return false;
      if (filter.leadId && contract.leadId !== filter.leadId) return false;
      if (filter.projectId && contract.projectId !== filter.projectId) return false;
      return true;
    });
  }

  return results;
}

/**
 * Calculate contract progress from its tasks. findTaskById resolves
 * tasks across every scope (corp + project + team) via the chit primitive.
 */
export function getContractProgress(corpRoot: string, contract: Contract): ContractProgress {
  let completed = 0;
  let inProgress = 0;
  let blocked = 0;
  let pending = 0;

  for (const taskId of contract.taskIds) {
    const found = findTaskById(corpRoot, taskId);
    if (!found) {
      pending++;
      continue;
    }
    if (found.task.status === 'completed') completed++;
    else if (found.task.status === 'in_progress') inProgress++;
    else if (found.task.status === 'blocked') blocked++;
    else pending++;
  }

  const total = contract.taskIds.length;
  const percentComplete = total > 0 ? Math.round((completed / total) * 100) : 0;

  return {
    totalTasks: total,
    completedTasks: completed,
    inProgressTasks: inProgress,
    blockedTasks: blocked,
    pendingTasks: pending,
    percentComplete,
  };
}

/**
 * Resolve a contract by id without caller-supplied project. Walks all
 * project scopes via queryChits. Returns null if not found.
 */
export function findContractById(
  corpRoot: string,
  id: string,
): ContractWithBody | null {
  const { chits } = queryChits(corpRoot, { types: ['contract'], limit: 0 });
  const match = chits.find(({ chit }) => chit.id === id);
  if (!match) return null;
  return {
    contract: chitToContract(match.chit as Chit<'contract'>),
    body: match.body,
    path: match.path,
  };
}
