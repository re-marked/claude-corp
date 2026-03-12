# Layer 1 -- Foundation

Everything else sits on top of this layer. Get the file formats, directory
structure, and type system right; the rest follows.

## Goals

- Scaffold the monorepo with pnpm workspaces.
- Define every file format AgentCorp uses.
- Create the corporation directory structure generator.
- Establish the type system in `packages/shared`.
- Wire up SimpleGit for atomic commits.

---

## 1. Monorepo Setup

```
agentcorp/
  package.json              # root, workspaces config
  pnpm-workspace.yaml
  tsconfig.json             # base config, path aliases
  packages/
    shared/                 # types, parsers, constants
      src/
        types/              # TypeScript interfaces
        parsers/            # JSONL, frontmatter, JSON
        constants.ts
    daemon/                 # long-running process
      src/
        index.ts            # entry point
    tui/                    # Ink terminal UI
      src/
        index.ts            # entry point
```

All three packages share a root `tsconfig.json` with project references.
`packages/shared` is imported by both daemon and TUI.

## 2. File Format Parsers

Three formats. Three parsers. All in `packages/shared/src/parsers/`.

### JSONL (messages)

Each line is a self-contained JSON object. Append-only. No locking needed for
reads; writes use `fs.appendFileSync` with `\n` termination.

```typescript
// packages/shared/src/parsers/jsonl.ts
export function appendMessage(filePath: string, message: ChannelMessage): void;
export function readMessages(filePath: string, opts?: { after?: string }): ChannelMessage[];
export function tailMessages(filePath: string, n: number): ChannelMessage[];
```

Message schema:

```jsonl
{"id":"msg_01","ts":"2026-03-12T10:00:00Z","from":"member_ceo","content":"Morning report ready.","mentions":[],"depth":0}
{"id":"msg_02","ts":"2026-03-12T10:00:05Z","from":"member_user","content":"@CEO summarize it","mentions":["member_ceo"],"depth":0}
```

### Markdown + Frontmatter (tasks, identity)

YAML frontmatter delimited by `---`. Body is free-form markdown.

```typescript
// packages/shared/src/parsers/frontmatter.ts
export function parse<T>(raw: string): { meta: T; body: string };
export function stringify<T>(meta: T, body: string): string;
```

Task example:

```markdown
---
id: task_abc123
title: Research competitor landscape
status: pending
priority: high
assignee: member_research_lead
parent_task_id: null
created_at: 2026-03-12T08:00:00Z
updated_at: 2026-03-12T08:00:00Z
---

Analyze the top 5 competitors in the AI agent space.
Deliver a markdown report to #research channel.
```

### JSON (config files)

Plain JSON. No JSON5, no comments. Parsed with `JSON.parse`, validated at
runtime with a thin schema check (no Zod -- keep deps minimal).

```typescript
// packages/shared/src/parsers/config.ts
export function readConfig<T>(filePath: string, validate: (raw: unknown) => T): T;
export function writeConfig<T>(filePath: string, data: T): void;
```

## 3. Corporation Directory Structure

When a user runs `agentcorp init`, the daemon creates this tree:

```
~/.agentcorp/corps/<corp-name>/
  corp.json                     # corporation metadata
  .git/                         # SimpleGit initializes this
  members/
    user/
      member.json               # { id, name, rank: "founder", type: "user" }
  channels/
    general/
      channel.json              # { id, name, kind: "broadcast" }
      messages.jsonl             # append-only message log
    ceo-dm/
      channel.json              # { id, name, kind: "direct" }
      messages.jsonl
  tasks/                        # task markdown files go here
  teams/                        # team directories (layer 5+)
  projects/                     # project directories (layer 5+)
```

Generator function:

```typescript
// packages/shared/src/corp-structure.ts
export function scaffoldCorp(corpName: string, userName: string): string; // returns corp path
```

This function creates every directory, writes initial JSON files, initializes
git, and makes the first commit: `"init: create corporation <name>"`.

## 4. Global Config

`~/.agentcorp/config.json` -- user-level settings.

```json
{
  "defaultCorp": "my-corp",
  "openclawBinary": "openclaw",
  "editor": "vim",
  "theme": "dark"
}
```

Read once at startup. The daemon and TUI both reference it.

## 5. Type Definitions

All in `packages/shared/src/types/`. One file per domain.

### Core Types

```typescript
// types/member.ts
interface Member {
  id: string;
  name: string;
  rank: "founder" | "ceo" | "corp_level" | "project_manager" | "team_leader" | "worker";
  type: "user" | "agent";
  status: "active" | "idle" | "offline";
  agentConfig?: AgentConfig;
}

// types/channel.ts
interface Channel {
  id: string;
  name: string;
  kind: "broadcast" | "team" | "direct" | "system";
  memberIds: string[];
  teamId?: string;
  projectId?: string;
}

// types/message.ts
interface ChannelMessage {
  id: string;
  ts: string;           // ISO 8601
  from: string;         // member ID
  content: string;
  mentions: string[];   // member IDs extracted from @mentions
  depth: number;        // agent-to-agent chain depth
  parentId?: string;    // thread parent
  originId?: string;    // original message that started the chain
}

// types/task.ts
interface Task {
  id: string;
  title: string;
  status: "pending" | "assigned" | "in_progress" | "completed" | "failed" | "cancelled";
  priority: "low" | "medium" | "high" | "critical";
  assignee?: string;    // member ID
  parentTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

// types/corp.ts
interface Corporation {
  id: string;
  name: string;
  createdAt: string;
  rootPath: string;
}

// types/agent-config.ts
interface AgentConfig {
  model: string;
  provider: string;
  port: number;
  soulPath: string;     // relative path to SOUL.md
  brainPath: string;    // relative path to brain/ directory
}
```

## 6. SimpleGit Integration

Wrap SimpleGit in a thin helper that enforces conventions:

```typescript
// packages/shared/src/git.ts
import simpleGit from "simple-git";

export function corpGit(corpPath: string) {
  const git = simpleGit(corpPath);

  return {
    init: () => git.init(),
    commitAll: (message: string) =>
      git.add(".").then(() => git.commit(message)),
    log: (n?: number) => git.log({ maxCount: n ?? 20 }),
    diff: () => git.diff(),
    status: () => git.status(),
  };
}
```

Every mutation to the corp filesystem should be followed by a commit.
Layer 5 formalizes this with the [[layer-5-autonomy#Git Janitor]], but even
in layer 1, the scaffolding commits on `init`.

## Deliverables Checklist

- [ ] pnpm workspace with three packages (`shared`, `daemon`, `tui`)
- [ ] `tsconfig.json` with project references and strict mode
- [ ] JSONL parser (append, read, tail)
- [ ] Frontmatter parser (parse, stringify)
- [ ] Config parser (read, write with runtime validation)
- [ ] Corp directory structure generator (`scaffoldCorp`)
- [ ] Global config file (`~/.agentcorp/config.json`)
- [ ] All type definitions in `packages/shared/src/types/`
- [ ] SimpleGit wrapper (`corpGit`)
- [ ] First commit on `agentcorp init`

## Key Decisions

- **No database.** The filesystem is the source of truth. JSONL for append-heavy
  data (messages). Markdown for human-readable documents (tasks, identity).
  JSON for machine-readable config. Git for history.
- **No Zod.** Keep dependencies minimal. Runtime validation is a thin function
  per config type. TypeScript handles the rest at compile time.
- **Append-only JSONL.** No message editing or deletion in layer 1. Messages are
  immutable log entries. This simplifies concurrency (daemon writes, TUI reads,
  fs.watch notifies).
