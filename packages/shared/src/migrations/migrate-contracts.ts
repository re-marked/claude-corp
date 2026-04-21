/**
 * Migration: convert pre-chits Contract files to Chit files of type=contract.
 *
 * The pre-chits format lives at `<corpRoot>/projects/<projectName>/contracts/<id>.md`
 * — always project-scoped (contracts exist inside projects). After migration,
 * the same contract lives at `<corpRoot>/projects/<projectName>/chits/contract/<id>.md`
 * under the Chit schema with scope `project:<projectName>`.
 *
 * Field mapping — lossless:
 *
 *   Contract field      → Chit representation
 *   ------------------- → --------------------------
 *   id                  → chit.id (preserved verbatim)
 *   status              → chit.status (same enum names: draft/active/review/
 *                        completed/rejected/failed — no workflow-status split
 *                        needed since vocabularies align)
 *   title, goal         → fields.contract.title, goal
 *   taskIds             → fields.contract.taskIds
 *   priority            → fields.contract.priority
 *   leadId              → fields.contract.leadId
 *   blueprintId         → fields.contract.blueprintId
 *   deadline            → fields.contract.deadline
 *   completedAt         → fields.contract.completedAt
 *   reviewedBy          → fields.contract.reviewedBy
 *   reviewNotes         → fields.contract.reviewNotes
 *   rejectionCount      → fields.contract.rejectionCount
 *   projectId           → fields.contract.projectId (legacy cross-reference)
 *   createdBy/At/updAt  → chit common fields
 *
 * Idempotent: re-running skips already-migrated contracts unless overwrite
 * is set. Source deletion happens after target write confirmation — a
 * mid-run failure leaves a valid state (source-only or target-only).
 */

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Contract } from './../types/contract.js';
import type { Chit, ContractFields } from './../types/chit.js';
import { atomicWriteSync } from './../atomic-write.js';
import {
  parse as parseFrontmatter,
  stringify as stringifyFrontmatter,
} from './../parsers/frontmatter.js';
import { chitPath } from './../chits.js';

export interface ContractMigrationResult {
  migrated: number;
  skipped: number;
  errors: Array<{ sourcePath: string; error: string }>;
  planned: Array<{ sourcePath: string; targetPath: string }>;
}

export interface ContractMigrationOpts {
  dryRun?: boolean;
  overwrite?: boolean;
}

/**
 * Convert a Contract object (with its body) into a Chit of type=contract.
 * Pure function — no I/O. Every Contract field has a home in the new shape.
 */
export function contractToChit(contract: Contract): Chit<'contract'> {
  const fields: ContractFields = {
    title: contract.title,
    goal: contract.goal,
    taskIds: [...contract.taskIds],
    priority: contract.priority,
    leadId: contract.leadId,
    blueprintId: contract.blueprintId,
    deadline: contract.deadline,
    completedAt: contract.completedAt,
    reviewedBy: contract.reviewedBy,
    reviewNotes: contract.reviewNotes,
    rejectionCount: contract.rejectionCount,
    projectId: contract.projectId,
  };

  return {
    id: contract.id,
    type: 'contract',
    // Contract.status maps 1:1 to ChitStatus for every value the enum
    // accepts (draft / active / review / completed / rejected / failed).
    status: contract.status,
    ephemeral: false,
    createdBy: contract.createdBy,
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
    references: [],
    dependsOn: [],
    tags: [],
    fields: { contract: fields },
  } as Chit<'contract'>;
}

/**
 * Walk the corp's projects and migrate every pre-chits Contract file to
 * a Chit. Contracts are project-scoped, so migration walks only
 * `<corpRoot>/projects/*\/contracts/*.md` and writes to
 * `<corpRoot>/projects/<name>/chits/contract/<id>.md` with scope
 * `project:<name>`.
 *
 * Returns a structured result so callers (cc-cli migrate contracts, test
 * fixtures) can report success/skipped/errors.
 */
export function migrateContractsToChits(
  corpRoot: string,
  opts: ContractMigrationOpts = {},
): ContractMigrationResult {
  const result: ContractMigrationResult = {
    migrated: 0,
    skipped: 0,
    errors: [],
    planned: [],
  };

  const projectsDir = join(corpRoot, 'projects');
  if (!existsSync(projectsDir)) return result;

  for (const projEntry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projEntry.isDirectory()) continue;
    const projectName = projEntry.name;
    const contractsDir = join(projectsDir, projectName, 'contracts');
    if (!existsSync(contractsDir)) continue;

    const files = readdirSync(contractsDir).filter((f) => f.endsWith('.md'));

    for (const file of files) {
      const sourcePath = join(contractsDir, file);
      try {
        const raw = readFileSync(sourcePath, 'utf-8');
        const { meta, body } = parseFrontmatter<Contract>(raw);

        if (!meta.id) {
          result.errors.push({ sourcePath, error: 'contract has no id' });
          continue;
        }

        const chit = contractToChit(meta);
        const targetPath = chitPath(
          corpRoot,
          `project:${projectName}`,
          'contract',
          chit.id,
        );

        if (existsSync(targetPath) && !opts.overwrite) {
          result.skipped++;
          continue;
        }

        result.planned.push({ sourcePath, targetPath });

        if (opts.dryRun) continue;

        const content = stringifyFrontmatter(chit as unknown as Record<string, unknown>, body);
        atomicWriteSync(targetPath, content);
        rmSync(sourcePath);

        result.migrated++;
      } catch (err) {
        result.errors.push({ sourcePath, error: (err as Error).message });
      }
    }
  }

  return result;
}
