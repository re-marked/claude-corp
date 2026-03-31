import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Contract, ContractStatus, ContractProgress } from './types/contract.js';
import type { TaskPriority } from './types/task.js';
import { parse as parseFrontmatter, stringify as stringifyFrontmatter } from './parsers/frontmatter.js';
import { contractId } from './id.js';
import { listTasks, readTask } from './tasks.js';

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

/**
 * Create a new contract inside a project.
 * Contracts live at projects/<projectName>/contracts/<id>.md
 */
export function createContract(corpRoot: string, opts: CreateContractOpts): Contract {
  const contractsDir = join(corpRoot, 'projects', opts.projectName, 'contracts');
  mkdirSync(contractsDir, { recursive: true });

  // Scratchpad created after contract ID is generated (per-contract, for Coordinator Mode)

  // Generate unique word-pair ID — retry on collision
  let id = contractId();
  for (let i = 0; i < 10 && existsSync(join(contractsDir, `${id}.md`)); i++) {
    id = contractId();
  }
  const now = new Date().toISOString();

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

  // Build body
  let body = '';
  if (opts.description) body += `${opts.description}\n\n`;
  if (opts.acceptanceCriteria?.length) {
    body += `## Acceptance Criteria\n`;
    for (const ac of opts.acceptanceCriteria) {
      body += `- [ ] ${ac}\n`;
    }
    body += '\n';
  }
  body += `## Progress\n(Updated by lead as tasks complete)\n`;

  const content = stringifyFrontmatter(contract as unknown as Record<string, unknown>, body);
  writeFileSync(join(contractsDir, `${id}.md`), content, 'utf-8');

  // Create per-contract scratchpad for Coordinator Mode (cross-worker knowledge sharing)
  mkdirSync(join(contractsDir, id, 'scratchpad'), { recursive: true });

  return contract;
}

/** Read a contract from its file path. */
export function readContract(filePath: string): { contract: Contract; body: string } {
  const raw = readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter<Contract>(raw);
  return { contract: meta, body };
}

/** Update contract frontmatter fields. */
export function updateContract(filePath: string, updates: Partial<Contract>): Contract {
  const raw = readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter<Contract>(raw);

  const updated: Contract = {
    ...meta,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const content = stringifyFrontmatter(updated as unknown as Record<string, unknown>, body);
  writeFileSync(filePath, content, 'utf-8');

  return updated;
}

/** List contracts in a project, optionally filtered. */
export function listContracts(
  corpRoot: string,
  projectName: string,
  filter?: ContractFilter,
): ContractWithBody[] {
  const contractsDir = join(corpRoot, 'projects', projectName, 'contracts');
  if (!existsSync(contractsDir)) return [];

  const files = readdirSync(contractsDir).filter(f => f.endsWith('.md'));
  const results: ContractWithBody[] = [];

  for (const file of files) {
    const filePath = join(contractsDir, file);
    try {
      const { contract, body } = readContract(filePath);

      if (filter) {
        if (filter.status && contract.status !== filter.status) continue;
        if (filter.leadId && contract.leadId !== filter.leadId) continue;
        if (filter.projectId && contract.projectId !== filter.projectId) continue;
      }

      results.push({ contract, body, path: filePath });
    } catch {
      // Skip malformed
    }
  }

  return results;
}

/** List contracts across ALL projects. */
export function listAllContracts(corpRoot: string, filter?: ContractFilter): ContractWithBody[] {
  const projectsDir = join(corpRoot, 'projects');
  if (!existsSync(projectsDir)) return [];

  const results: ContractWithBody[] = [];
  try {
    const dirs = readdirSync(projectsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const projectContracts = listContracts(corpRoot, dir.name, filter);
      results.push(...projectContracts);
    }
  } catch {}

  return results;
}

/** Get file path for a contract. */
export function contractPath(corpRoot: string, projectName: string, contractId: string): string {
  return join(corpRoot, 'projects', projectName, 'contracts', `${contractId}.md`);
}

/** Calculate contract progress from its tasks. */
export function getContractProgress(corpRoot: string, contract: Contract): ContractProgress {
  let completed = 0;
  let inProgress = 0;
  let blocked = 0;
  let pending = 0;

  for (const taskId of contract.taskIds) {
    try {
      // Try corp-level tasks first, then project-level
      let taskFile = join(corpRoot, 'tasks', `${taskId}.md`);
      if (!existsSync(taskFile)) {
        // Try project tasks
        const { getProject } = require('./projects.js');
        const project = getProject(corpRoot, contract.projectId);
        if (project) {
          taskFile = join(corpRoot, 'projects', project.name, 'tasks', `${taskId}.md`);
        }
      }
      if (!existsSync(taskFile)) { pending++; continue; }

      const { task } = readTask(taskFile);
      if (task.status === 'completed') completed++;
      else if (task.status === 'in_progress') inProgress++;
      else if (task.status === 'blocked') blocked++;
      else pending++;
    } catch {
      pending++;
    }
  }

  const total = contract.taskIds.length;
  const percentComplete = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { totalTasks: total, completedTasks: completed, inProgressTasks: inProgress, blockedTasks: blocked, pendingTasks: pending, percentComplete };
}
