import { listTasks } from '@claudecorp/shared';
import { getCorpRoot, getMembers } from '../client.js';

export async function cmdTasks(opts: { status?: string; assigned?: string; json: boolean }) {
  const corpRoot = await getCorpRoot();
  const members = getMembers(corpRoot);

  const filter: Record<string, string> = {};
  if (opts.status) filter.status = opts.status;
  if (opts.assigned) {
    // Resolve name to member ID
    const member = members.find((m) =>
      m.displayName.toLowerCase() === opts.assigned!.toLowerCase() ||
      m.agentDir?.includes(opts.assigned!.toLowerCase()),
    );
    if (member) filter.assignedTo = member.id;
  }

  const tasks = listTasks(corpRoot, filter as any);

  if (opts.json) {
    console.log(JSON.stringify(tasks.map((t) => t.task), null, 2));
    return;
  }

  if (tasks.length === 0) {
    console.log('No tasks found.');
    return;
  }

  for (const { task } of tasks) {
    const assignee = members.find((m) => m.id === task.assignedTo);
    const icon = { pending: '\u25C7', assigned: '\u25C6', in_progress: '\u25C6', completed: '\u2713', failed: '\u2717', blocked: '\u25C8', cancelled: '\u2500' }[task.status] ?? '?';
    console.log(`${icon} [${task.priority.toUpperCase().padEnd(8)}] ${task.title}`);
    console.log(`  Status: ${task.status}  Assigned: ${assignee?.displayName ?? 'unassigned'}  ID: ${task.id}`);
    console.log('');
  }
}
