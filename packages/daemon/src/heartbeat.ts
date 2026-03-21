import { join } from 'node:path';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import {
  type Member,
  readConfig,
  listTasks,
  MEMBERS_JSON,
} from '@claudecorp/shared';
import type { Daemon } from './daemon.js';
import { log, logError } from './logger.js';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // Refresh every 5 minutes
const STALE_ASSIGNED_MS = 10 * 60 * 1000;
const STALE_IN_PROGRESS_MS = 2 * 60 * 60 * 1000;

/**
 * Manages TASKS.md files for each agent — a live task inbox.
 * Also refreshes periodically so heartbeat-woken agents see current data.
 *
 * TASKS.md = "what you need to work on right now" (live, updated on change)
 * HEARTBEAT.md = "what to do when you wake up" (static standing orders)
 */
export class HeartbeatManager {
  private daemon: Daemon;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  start(): void {
    this.refreshAll();

    this.interval = setInterval(() => {
      this.refreshAll();
    }, REFRESH_INTERVAL_MS);

    log('[heartbeat] TASKS.md refresh started (every 5m)');
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  /** Refresh TASKS.md for ALL agents. Called periodically + on task changes. */
  refreshAll(): void {
    try {
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const allTasks = listTasks(this.daemon.corpRoot);
      const agents = members.filter((m) => m.type === 'agent' && m.agentDir);
      const now = new Date();
      const corpRoot = this.daemon.corpRoot.replace(/\\/g, '/');

      for (const agent of agents) {
        const myTasks = allTasks.filter((t) => t.task.assignedTo === agent.id);
        const unassigned = allTasks.filter(
          (t) => !t.task.assignedTo && t.task.status === 'pending',
        );

        const content = this.buildTasksMd(corpRoot, myTasks, unassigned, now);

        try {
          const agentDir = join(this.daemon.corpRoot, agent.agentDir!);
          if (existsSync(agentDir)) {
            writeFileSync(join(agentDir, 'TASKS.md'), content, 'utf-8');
          }
        } catch {
          // Non-fatal
        }
      }
    } catch (err) {
      logError(`[heartbeat] TASKS.md refresh failed: ${err}`);
    }
  }

  /** Refresh TASKS.md for a single agent by member ID. */
  refreshAgent(memberId: string): void {
    try {
      const members = readConfig<Member[]>(join(this.daemon.corpRoot, MEMBERS_JSON));
      const agent = members.find((m) => m.id === memberId);
      if (!agent?.agentDir) return;

      const allTasks = listTasks(this.daemon.corpRoot);
      const myTasks = allTasks.filter((t) => t.task.assignedTo === agent.id);
      const unassigned = allTasks.filter(
        (t) => !t.task.assignedTo && t.task.status === 'pending',
      );
      const corpRoot = this.daemon.corpRoot.replace(/\\/g, '/');
      const content = this.buildTasksMd(corpRoot, myTasks, unassigned, new Date());

      const agentDir = join(this.daemon.corpRoot, agent.agentDir);
      if (existsSync(agentDir)) {
        writeFileSync(join(agentDir, 'TASKS.md'), content, 'utf-8');
      }
    } catch {
      // Non-fatal
    }
  }

  private buildTasksMd(
    corpRoot: string,
    myTasks: { task: { id: string; title: string; status: string; priority: string; updatedAt: string }; body: string }[],
    unassigned: { task: { id: string; title: string; status: string; priority: string }; body: string }[],
    now: Date,
  ): string {
    const lines: string[] = [`# Tasks — updated ${now.toISOString()}`, ''];

    if (myTasks.length === 0 && unassigned.length === 0) {
      lines.push('No tasks. You\'re free.', '');
      return lines.join('\n');
    }

    // Assigned tasks
    if (myTasks.length > 0) {
      lines.push('## Assigned to you', '');
      for (const t of myTasks) {
        let note = '';
        const age = now.getTime() - new Date(t.task.updatedAt).getTime();
        if (t.task.status === 'assigned' && age > STALE_ASSIGNED_MS) {
          note = ' ⚠️ START THIS';
        } else if (t.task.status === 'in_progress' && age > STALE_IN_PROGRESS_MS) {
          note = ' ⚠️ UPDATE OR COMPLETE';
        }
        lines.push(`- **[${t.task.id}]** ${t.task.title}`);
        lines.push(`  Status: ${t.task.status} | Priority: ${t.task.priority.toUpperCase()}${note}`);
        lines.push(`  File: ${corpRoot}/tasks/${t.task.id}.md`);
        lines.push('');
      }
    }

    // Unassigned
    if (unassigned.length > 0) {
      lines.push('## Unassigned (you can claim these)', '');
      for (const t of unassigned) {
        lines.push(`- **[${t.task.id}]** ${t.task.title} (${t.task.priority.toUpperCase()})`);
        lines.push(`  File: ${corpRoot}/tasks/${t.task.id}.md`);
        lines.push('');
      }
    }

    // How to work on tasks
    lines.push('## How to work on a task', '');
    lines.push(`1. Open the task file at the path above`);
    lines.push(`2. Read the description and acceptance criteria`);
    lines.push(`3. Update the YAML frontmatter: change \`status\` to \`in_progress\``);
    lines.push(`4. Do the work`);
    lines.push(`5. Append notes to the \`## Progress Notes\` section`);
    lines.push(`6. When done, change \`status\` to \`completed\``);
    lines.push('');

    return lines.join('\n');
  }
}
