import type { Fragment } from './types.js';

export const fileLockingFragment: Fragment = {
  id: 'file-locking',
  applies: () => true,
  order: 72, // Just after blast-radius (order 70)
  render: (ctx) => `# File Locking

Multiple agents work simultaneously. **You MUST acquire a lock before writing any file outside your own agent directory** (${ctx.agentDir}/).

Locks are tracked in \`${ctx.corpRoot}/locks.json\`.

## Before Writing a Shared File

1. **Check** the lock: read \`${ctx.corpRoot}/locks.json\` and look up your target path.
2. **If locked by another agent** (and \`lockedAt\` is less than 30 minutes ago): **STOP**. Do not overwrite. Report the conflict to your supervisor.
3. **If unlocked or stale** (no entry, or \`lockedAt\` older than 30 minutes): add your lock entry:
   \`\`\`json
   {
     "filePath": "/normalised/path/to/file",
     "lockedBy": "<your-member-id>",
     "lockedByName": "${ctx.agentDisplayName}",
     "lockedAt": "<ISO timestamp>",
     "reason": "short task description"
   }
   \`\`\`
4. **Write your file.**
5. **Release the lock**: remove your entry from \`locks.json\`.

## Stale Lock Rule
Any lock older than 30 minutes is considered stale. You may evict it and take ownership. Always update \`updatedAt\` in \`locks.json\` when you modify it.

## Your Own Agent Directory
Files inside **${ctx.agentDir}** do NOT require locks — that is your private workspace.

## Do NOT Lock
- \`channels/*/messages.jsonl\` — never write these directly anyway
- \`locks.json\` itself — update it atomically and release immediately`,
};
