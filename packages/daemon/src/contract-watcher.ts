import { watch, type FSWatcher, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ContractStatus,
  type Member,
  type Channel,
  readContract,
  updateContract,
  contractPath,
  readTask,
  readConfig,
  post,
  MEMBERS_JSON,
  CHANNELS_JSON,
  MESSAGES_JSONL,
} from '@claudecorp/shared';
import { writeTaskEvent, dispatchTaskToDm, logTaskAssignment } from './task-events.js';
import { hireAgent } from './hire.js';
import type { Daemon } from './daemon.js';
import { log, logError } from './logger.js';

/**
 * ContractWatcher — monitors project contracts for lifecycle events.
 *
 * Detects:
 * - All tasks complete → triggers Warden review
 * - Contract activated → notifies lead
 * - Contract rejected → notifies lead with Warden notes
 * - Contract completed → notifies lead + CEO
 */
export class ContractWatcher {
  private daemon: Daemon;
  private watchers = new Map<string, FSWatcher>();
  private contractCache = new Map<string, { status: ContractStatus; taskIds: string[] }>();
  private processing = new Set<string>();

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  start(): void {
    const projectsDir = join(this.daemon.corpRoot, 'projects');
    if (!existsSync(projectsDir)) return;

    // Watch contracts/ in each project
    try {
      const projects = readdirSync(projectsDir, { withFileTypes: true });
      for (const proj of projects) {
        if (!proj.isDirectory()) continue;
        this.watchProjectContracts(proj.name);
      }
    } catch {}

    log(`[contract-watcher] Watching contracts across ${this.watchers.size} project(s)`);
  }

  stop(): void {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private watchProjectContracts(projectName: string): void {
    const contractsDir = join(this.daemon.corpRoot, 'projects', projectName, 'contracts');
    if (!existsSync(contractsDir)) return;
    if (this.watchers.has(projectName)) return;

    // Load cache
    try {
      const files = readdirSync(contractsDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        try {
          const { contract } = readContract(join(contractsDir, file));
          this.contractCache.set(join(contractsDir, file), {
            status: contract.status,
            taskIds: contract.taskIds ?? [],
          });
        } catch {}
      }
    } catch {}

    const watcher = watch(contractsDir, (_event, filename) => {
      if (!filename || !filename.endsWith('.md')) return;
      this.onContractChange(join(contractsDir, filename), projectName);
    });
    watcher.on('error', () => {
      this.watchers.delete(projectName);
      setTimeout(() => this.watchProjectContracts(projectName), 2000);
    });

    this.watchers.set(projectName, watcher);
  }

  private onContractChange(filePath: string, projectName: string): void {
    if (!existsSync(filePath)) return;
    if (this.processing.has(filePath)) return;
    this.processing.add(filePath);
    setTimeout(() => this.processing.delete(filePath), 2000); // Debounce 2s

    try {
      const { contract } = readContract(filePath);
      const cached = this.contractCache.get(filePath);

      if (!cached) {
        // New contract
        this.contractCache.set(filePath, { status: contract.status, taskIds: contract.taskIds ?? [] });
        return;
      }

      // Status change
      if (contract.status !== cached.status) {
        this.handleStatusChange(contract, cached.status, projectName);
      }

      // Check if all tasks complete (for active contracts)
      if (contract.status === 'active' && contract.taskIds.length > 0) {
        this.checkAllTasksComplete(contract, projectName);
      }

      this.contractCache.set(filePath, { status: contract.status, taskIds: contract.taskIds ?? [] });
    } catch {}
  }

  private handleStatusChange(contract: any, prevStatus: ContractStatus, projectName: string): void {
    const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));

    // Activated → notify lead
    if (contract.status === 'active' && prevStatus === 'draft') {
      if (contract.leadId) {
        const lead = members.find((m: Member) => m.id === contract.leadId);
        if (lead) {
          log(`[contract-watcher] Contract "${contract.title}" activated — notifying lead ${lead.displayName}`);
          // Dispatch to lead's DM
          this.notifyViaDm(contract.leadId, `Contract "${contract.title}" is now ACTIVE. You're the lead. Decompose into tasks, hand them, and track progress.`);
        }
      }
    }

    // Completed → notify lead + CEO
    if (contract.status === 'completed') {
      writeTaskEvent(this.daemon.corpRoot, `[CONTRACT] "${contract.title}" COMPLETED — Warden approved`);
      this.daemon.analytics.trackTaskCompleted(contract.leadId ?? contract.createdBy);
      if (contract.leadId) {
        this.notifyViaDm(contract.leadId, `Contract "${contract.title}" APPROVED by Warden. Well done.`);
      }
      // Notify CEO
      const ceo = members.find((m: Member) => m.rank === 'master' && m.type === 'agent');
      if (ceo) {
        this.notifyViaDm(ceo.id, `Contract "${contract.title}" completed and approved by Warden. Report to Founder.`);
      }
    }

    // Rejected → notify lead with notes
    if (contract.status === 'rejected') {
      writeTaskEvent(this.daemon.corpRoot, `[CONTRACT] "${contract.title}" REJECTED by Warden`);
      if (contract.leadId) {
        const notes = contract.reviewNotes ?? 'No notes provided';
        this.notifyViaDm(contract.leadId, `Contract "${contract.title}" REJECTED by Warden: ${notes}. Fix issues and re-complete tasks.`);
      }
    }
  }

  /** Check if all tasks in a contract are completed → trigger Warden review. */
  private checkAllTasksComplete(contract: any, projectName: string): void {
    if (!contract.taskIds || contract.taskIds.length === 0) return;

    let allDone = true;
    for (const taskId of contract.taskIds) {
      try {
        // Check corp-level tasks
        let taskFile = join(this.daemon.corpRoot, 'tasks', `${taskId}.md`);
        if (!existsSync(taskFile)) {
          taskFile = join(this.daemon.corpRoot, 'projects', projectName, 'tasks', `${taskId}.md`);
        }
        if (!existsSync(taskFile)) { allDone = false; break; }

        const { task } = readTask(taskFile);
        if (task.status !== 'completed') { allDone = false; break; }
      } catch {
        allDone = false;
        break;
      }
    }

    if (allDone) {
      log(`[contract-watcher] All ${contract.taskIds.length} tasks complete for "${contract.title}" — triggering Warden review`);

      // Update contract status to 'review'
      const filePath = contractPath(this.daemon.corpRoot, projectName, contract.id);
      updateContract(filePath, { status: 'review' });

      // Log event
      writeTaskEvent(this.daemon.corpRoot, `[CONTRACT] "${contract.title}" — all tasks complete, Warden reviewing`);

      // Auto-hand review task to Warden
      this.handReviewToWarden(contract, projectName);
    }
  }

  /** Create a review task and hand it to the Warden. */
  private handReviewToWarden(contract: any, projectName: string): void {
    const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
    const warden = members.find((m: Member) => m.displayName === 'Warden' && m.type === 'agent');
    if (!warden) {
      logError('[contract-watcher] Warden agent not found — cannot review contract');
      return;
    }

    // Create a review task
    const { createTask } = require('@claudecorp/shared');
    const reviewTask = createTask(this.daemon.corpRoot, {
      title: `Review contract: "${contract.title}"`,
      description: `Review all tasks in contract ${contract.id} (project: ${projectName}).\n\nContract goal: ${contract.goal}\n\nTask IDs to review: ${contract.taskIds.join(', ')}\n\nRead each task file, verify acceptance criteria, check deliverables exist. Approve or reject.`,
      priority: 'high',
      assignedTo: warden.id,
      createdBy: 'system',
    });

    // Hand it
    logTaskAssignment(this.daemon.corpRoot, warden.id, reviewTask.title);
    dispatchTaskToDm(this.daemon, warden.id, reviewTask.title, reviewTask.id);

    log(`[contract-watcher] Review task handed to Warden for "${contract.title}"`);
  }

  /** Send a notification to an agent's DM. */
  private notifyViaDm(memberId: string, content: string): void {
    try {
      const channels = readConfig<Channel[]>(join(this.daemon.corpRoot, CHANNELS_JSON));
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const founder = members.find((m) => m.rank === 'owner');

      const dmChannel = channels.find((c) =>
        c.kind === 'direct' &&
        c.memberIds.includes(memberId) &&
        (founder ? c.memberIds.includes(founder.id) : true),
      );
      if (!dmChannel) return;

      post(dmChannel.id, join(this.daemon.corpRoot, dmChannel.path, MESSAGES_JSONL), {
        senderId: 'system',
        content,
        source: 'warden',
        mentions: [memberId],
        metadata: { taskAction: 'contract-notify' },
      });
      setTimeout(() => this.daemon.router.pokeChannel(dmChannel.id), 100);
    } catch (err) {
      logError(`[contract-watcher] DM notification failed: ${err}`);
    }
  }
}
