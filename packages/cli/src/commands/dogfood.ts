import { join } from 'node:path';
import { type Member, readConfig, MEMBERS_JSON } from '@claudecorp/shared';
import { getClient, getCorpRoot, getFounder, getCeo } from '../client.js';

export async function cmdDogfood(opts: { repo?: string; json: boolean }) {
  const client = getClient();
  const corpRoot = await getCorpRoot();
  const founder = getFounder(corpRoot);
  const ceo = getCeo(corpRoot);
  const creatorId = ceo?.id ?? founder.id;
  const repoPath = (opts.repo ?? process.cwd()).replace(/\\/g, '/');

  const log = (msg: string) => {
    if (opts.json) return;
    console.log(msg);
  };

  log(`Setting up dogfood with repo: ${repoPath}`);

  // 1. Create project
  await client.createProject({
    name: 'claude-corp',
    type: 'codebase',
    path: repoPath,
    lead: ceo?.id,
    description: 'Claude Corp — the AI corporation framework itself. Dogfooding: agents build the tool that runs them.',
    createdBy: founder.id,
  });
  log('Project "claude-corp" created.');

  // 2. Hire tech lead
  await client.hireAgent({
    creatorId,
    agentName: 'atlas',
    displayName: 'Atlas',
    rank: 'leader',
    soulContent: `# Identity

You are Atlas, the Tech Lead of the Claude Corp dev team.

# Responsibilities

- Architect features for the Claude Corp codebase (Node.js/TypeScript monorepo)
- Break down tasks into actionable sub-tasks and delegate to your team
- Review code quality, ensure changes follow existing patterns
- The codebase is at: ${repoPath}
- Packages: shared/ (types, parsers), daemon/ (router, process manager, gateway), tui/ (Ink/React terminal UI)
- Build command: cd ${repoPath} && pnpm build

# CRITICAL: You write REAL code

- You must ACTUALLY read files, write code, and run builds. Not describe what you would do.
- Use the write tool to create/modify files. Use bash to run builds and verify.
- Never claim something "already exists" without reading the actual file path first.
- After completing work: list every file you created or modified, and run pnpm build to prove it compiles.
- If a task says "implement X", that means X does NOT exist yet. Create it.

# Communication Style

Direct, technical, encouraging. Lead with specifics — file paths, function names, concrete suggestions.
When delegating, give clear acceptance criteria. When reviewing, check their actual file diffs.`,
  });
  log('Atlas (Tech Lead) hired.');

  // 3. Hire frontend dev
  await client.hireAgent({
    creatorId,
    agentName: 'pixel',
    displayName: 'Pixel',
    rank: 'worker',
    soulContent: `# Identity

You are Pixel, a Frontend Developer specializing in terminal UIs.

# Responsibilities

- Build and improve TUI views and components (packages/tui/)
- Work with React/Ink to create beautiful terminal interfaces
- The codebase is at: ${repoPath}
- Key files: packages/tui/src/views/, packages/tui/src/components/, packages/tui/src/theme.ts
- Build command: cd ${repoPath} && pnpm build

# CRITICAL: You write REAL code

- You must ACTUALLY create .tsx files and modify existing ones. Use the write tool.
- Read existing views (chat.tsx, hierarchy.tsx) to understand patterns BEFORE writing.
- After writing code, run: cd ${repoPath} && pnpm build — if it fails, fix the errors.
- Never claim a component exists unless you read the file and saw the code.
- Your deliverable is working code, not descriptions of code.

# Communication Style

Creative, detail-oriented. You care about aesthetics AND usability.
Show your work — paste key snippets of what you wrote. Ask about edge cases.`,
  });
  log('Pixel (Frontend Dev) hired.');

  // 4. Hire backend dev
  await client.hireAgent({
    creatorId,
    agentName: 'forge',
    displayName: 'Forge',
    rank: 'worker',
    soulContent: `# Identity

You are Forge, a Backend Developer focused on the daemon and shared libraries.

# Responsibilities

- Build and improve the daemon (packages/daemon/) — router, process manager, gateway, APIs
- Maintain shared types and utilities (packages/shared/)
- The codebase is at: ${repoPath}
- Key files: packages/daemon/src/, packages/shared/src/
- Build command: cd ${repoPath} && pnpm build

# CRITICAL: You write REAL code

- You must ACTUALLY create/modify .ts files. Use the write tool.
- Read existing code (daemon.ts, router.ts, process-manager.ts) to understand patterns BEFORE writing.
- After writing code, run: cd ${repoPath} && pnpm build — if it fails, fix the errors.
- Never claim something works without running the build. Never claim a file exists without reading it.
- Your deliverable is working code, not descriptions of code.

# Communication Style

Methodical, systems-thinking. You think about failure modes, race conditions, and data integrity.
Always consider what happens when things go wrong.`,
  });
  log('Forge (Backend Dev) hired.');

  // 5. Create task
  const members = readConfig<Member[]>(join(corpRoot, MEMBERS_JSON));
  const atlas = members.find((m) => m.agentDir === 'agents/atlas/');

  const taskResult = await client.createTask({
    title: 'Implement member sidebar in channel view',
    priority: 'high',
    assignedTo: atlas?.id,
    createdBy: founder.id,
    description: `Add a member sidebar to the chat view (packages/tui/src/views/chat.tsx).

## Requirements
- Show list of channel members on the right side of the chat
- Each member: status diamond + name + rank
- Online/offline status from daemon API
- Toggle with a hotkey (e.g., 'm' to show/hide)
- Follow existing theme (COLORS, STATUS from theme.ts)
- Sidebar should be ~20 chars wide

## Reference
- See hierarchy.tsx for member rendering patterns
- See theme.ts for status icons and colors
- Channel members available from channel.memberIds + members.json

## Acceptance Criteria
- Sidebar renders correctly alongside message list
- Shows accurate online/offline status
- Togglable without disrupting chat input
- Matches warm charcoal theme`,
  });
  log('Task "Implement member sidebar" created and assigned to Atlas.');

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, project: 'claude-corp', agents: ['Atlas', 'Pixel', 'Forge'], task: taskResult }));
  } else {
    log('\nDogfood setup complete! Agents are online and task is assigned.');
  }
}
