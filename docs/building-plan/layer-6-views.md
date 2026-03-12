# Layer 6 -- Views

Layers 1-5 built the engine. Layer 6 gives the Founder a command center.
Corp home, project dashboards, agent inspection, and the hierarchy tree --
all rendered in the terminal with Ink.

## Goals

- Corp home view: overview of the entire organization.
- Project home view: focused dashboard per project.
- Agent inspector: deep dive into any agent's state.
- Hierarchy tree: box-drawing visualization of the org chart.
- Navigation polish: smooth transitions between views.

---

## 1. Corp Home View

The landing page when the TUI starts (after onboarding is complete).
Shows the corporation at a glance.

```
+-------------------------------------------------------------+
|  ACME CORP                                     F1:Help      |
+-------------------------------------------------------------+
|                                                              |
|  Members: 8 active, 2 idle          Tasks: 12 (3 in prog)  |
|  Channels: 6                        Commits: 47 today      |
|                                                              |
|  --- Recent Activity ---                                    |
|                                                              |
|  10:15  CEO created task "Q1 Planning"                      |
|  10:12  Research Lead completed "Competitor Analysis"       |
|  10:08  Designer posted in #brand                           |
|  10:02  Git Janitor cleaned 3 orphaned temp files           |
|  09:55  HR Director hired "Content Writer" (worker)         |
|                                                              |
|  --- Projects ---                                           |
|                                                              |
|  [1] Genesis Project    4 members  5 tasks  active          |
|  [2] Brand Refresh      2 members  3 tasks  active          |
|                                                              |
+-------------------------------------------------------------+
|  [c]hat  [t]asks  [h]ierarchy  [p]roject  [a]gent  [q]uit  |
+-------------------------------------------------------------+
```

Data sources:
- Member count: scan `members/*/member.json`
- Task summary: scan `tasks/*.md` frontmatter
- Channel count: count directories in `channels/`
- Commit count: `git log --since=midnight --oneline | wc -l`
- Recent activity: last 10 entries from `channels/system/messages.jsonl`
  (the daemon writes system events here)

```typescript
// packages/tui/src/views/corp-home.tsx
function CorpHome(props: {
  corp: Corporation;
  stats: CorpStats;
  activity: SystemEvent[];
  projects: ProjectSummary[];
}): ReactElement;
```

## 2. Project Home View

Selecting a project (number key or `p` then picker) opens the project dashboard.

```
+-------------------------------------------------------------+
|  Genesis Project                            [Esc] back      |
+-------------------------------------------------------------+
|                                                              |
|  Leader: Project Alpha Lead                                 |
|  Members: 4                 Tasks: 5 (2 in prog, 1 done)   |
|                                                              |
|  --- Team ---                                               |
|                                                              |
|  Project Alpha Lead    project_manager    active             |
|  Research Lead         team_leader        active             |
|  Analyst               worker             busy               |
|  Writer                worker             idle                |
|                                                              |
|  --- Tasks ---                                              |
|                                                              |
|  * prog  HIGH  Research competitors           Research Lead  |
|  * prog  MED   Draft initial report           Writer         |
|    pend  MED   Review and edit report         --             |
|    done  HIGH  Set up project channels        Alpha Lead     |
|    done  LOW   Introduce team members         Alpha Lead     |
|                                                              |
|  --- Channels ---                                           |
|                                                              |
|  # genesis-general     4 members    12 messages today       |
|  # genesis-research    2 members    5 messages today        |
|                                                              |
+-------------------------------------------------------------+
|  [c]hat  [t]ask  [a]gent  [Esc] back                       |
+-------------------------------------------------------------+
```

```typescript
// packages/tui/src/views/project-home.tsx
function ProjectHome(props: {
  project: Project;
  members: Member[];
  tasks: Task[];
  channels: Channel[];
}): ReactElement;
```

## 3. Agent Inspector

Selecting an agent (from member sidebar, hierarchy tree, or project view)
opens the inspector. This is the radical transparency view -- the Founder
sees everything about the agent.

```
+-------------------------------------------------------------+
|  Research Lead (team_leader)                  [Esc] back    |
+-------------------------------------------------------------+
|                                                              |
|  Status: active          Port: 18802                        |
|  Created by: CEO         Created: 2026-03-12 08:30          |
|  Model: anthropic/claude-sonnet-4                           |
|                                                              |
|  --- SOUL.md (excerpt) ---                                  |
|                                                              |
|  You are the Research Lead for Genesis Project. Your job    |
|  is to gather intelligence, analyze competitors, and        |
|  deliver actionable reports...                              |
|                                                              |
|  --- Recent Messages ---                                    |
|                                                              |
|  10:15 in #genesis-research:                                |
|    "Competitor A charges $50/seat. Their API is limited..." |
|  10:08 in DM with CEO:                                      |
|    "Report is 80% done. Need Analyst to pull pricing."      |
|                                                              |
|  --- Tasks ---                                              |
|                                                              |
|  * prog  HIGH  Research competitors                         |
|  * asgn  MED   Train junior analyst                         |
|                                                              |
|  --- Brain (knowledge graph) ---                            |
|                                                              |
|  brain/competitors/competitor-a.md    (updated 10:15)       |
|  brain/competitors/competitor-b.md    (updated 09:45)       |
|  brain/market-trends.md               (updated yesterday)   |
|                                                              |
|  --- Git Activity (last 5 commits) ---                      |
|                                                              |
|  abc1234  Research Lead: update competitor-a pricing data   |
|  def5678  Research Lead: add competitor-b analysis          |
|  ghi9012  Research Lead: update task_abc123 to in_progress  |
|                                                              |
+-------------------------------------------------------------+
|  [d]m  [s]oul  [b]rain  [t]asks  [g]it log  [Esc] back    |
+-------------------------------------------------------------+
```

```typescript
// packages/tui/src/views/agent-inspector.tsx
function AgentInspector(props: {
  member: Member;
  recentMessages: ChannelMessage[];
  tasks: Task[];
  brainFiles: string[];
  gitLog: GitLogEntry[];
  soulExcerpt: string;
}): ReactElement;
```

### Sub-views

| Key | Opens |
|-----|-------|
| `d` | DM chat with this agent |
| `s` | Full SOUL.md in a pager (scrollable) |
| `b` | Brain directory listing, select to view file contents |
| `t` | Filtered task board showing only this agent's tasks |
| `g` | Full git log filtered to this agent's commits |

## 4. Hierarchy Tree

The org chart rendered as a box-drawing tree. Accessible from corp home
via `h`.

```
+-------------------------------------------------------------+
|  Organization Hierarchy                       [Esc] back    |
+-------------------------------------------------------------+
|                                                              |
|  You (Founder)                                              |
|  +-- CEO                                     active         |
|  |   +-- HR Director                         active         |
|  |   +-- Chief Adviser                       idle           |
|  |   +-- Git Janitor                         active         |
|  |   +-- Genesis Project                                    |
|  |       +-- Project Alpha Lead              active         |
|  |           +-- Research Lead                active         |
|  |           |   +-- Analyst                  busy           |
|  |           +-- Writer                       idle           |
|  +-- Brand Refresh                                          |
|      +-- Brand Lead                           active         |
|          +-- Designer                         busy           |
|                                                              |
+-------------------------------------------------------------+
|  [Enter] inspect  [arrows] navigate  [Esc] back            |
+-------------------------------------------------------------+
```

The tree is built from the member hierarchy:

```typescript
// packages/shared/src/hierarchy.ts
interface HierarchyNode {
  member: Member;
  children: HierarchyNode[];
}

export function buildHierarchy(members: Member[], projects: Project[]): HierarchyNode;
```

The hierarchy is derived from:
- `member.rank` determines the level.
- `member.createdBy` determines the parent.
- Projects group their members under the project node.

### Box-Drawing Characters

```
+--   branch to child
|     vertical line (parent has more children below)
+--   last child branch
```

Use Unicode box-drawing characters for cleaner rendering:

```
\u251C\u2500\u2500  (tee + horizontal)    for middle children
\u2514\u2500\u2500  (corner + horizontal)  for last child
\u2502    (vertical)                for continuing parent line
```

### Navigation

Arrow keys move a cursor through the tree. Enter opens the agent inspector
for the selected node. The cursor wraps at top and bottom. Typing a letter
jumps to the first node starting with that letter.

### Status Indicators

Each node shows the agent's status with color:
- `active` -- green
- `idle` -- yellow
- `busy` -- cyan
- `offline` -- dim/gray

## 5. Navigation Polish

### Global Key Bindings

| Key | From Anywhere | Action |
|-----|--------------|--------|
| `Ctrl+K` | Yes | Channel switcher (fuzzy finder) |
| `Ctrl+H` | Yes | Corp home |
| `Ctrl+T` | Yes | Task board |
| `Ctrl+G` | Yes | Hierarchy tree |
| `Tab` | Yes | Cycle between main views (home, chat, tasks, tree) |
| `?` or `F1` | Yes | Help overlay showing all key bindings |
| `q` | Most views | Back / quit to previous view |
| `Esc` | Modal views | Close modal, return to parent |

### View Stack

The TUI maintains a view stack for navigation history:

```typescript
// packages/tui/src/navigation.ts
type View =
  | { type: "corp-home" }
  | { type: "project-home"; projectId: string }
  | { type: "chat"; channelId: string }
  | { type: "task-board"; filter?: TaskFilter }
  | { type: "task-detail"; taskId: string }
  | { type: "agent-inspector"; memberId: string }
  | { type: "hierarchy" }
  | { type: "onboarding" };

const viewStack: View[] = [];

export function push(view: View): void;
export function pop(): View;
export function current(): View;
```

Pressing Escape or `q` pops the stack and returns to the previous view.
`Ctrl+H` clears the stack and returns to corp home.

### Transitions

No animation (this is a terminal), but the TUI should:
- Clear the screen cleanly between views (no flicker).
- Preserve scroll position when returning to a view from the stack.
- Show a breadcrumb bar at the top: `Home > Genesis Project > Research Lead`.

## Deliverables Checklist

- [ ] Corp home view with stats, activity feed, project list
- [ ] Project home view with team, tasks, channels
- [ ] Agent inspector with SOUL excerpt, messages, tasks, brain, git log
- [ ] Agent inspector sub-views (DM, SOUL pager, brain browser, filtered tasks, git log)
- [ ] Hierarchy tree with box-drawing characters
- [ ] Hierarchy tree navigation (arrows, enter, letter jump)
- [ ] Status color indicators in hierarchy tree
- [ ] `buildHierarchy()` function from member data
- [ ] Global key bindings (Ctrl+K, Ctrl+H, Ctrl+T, Ctrl+G, Tab)
- [ ] View stack navigation with push/pop
- [ ] Breadcrumb bar
- [ ] Help overlay (? or F1)

## Key Decisions

- **Views read from filesystem, not from daemon state.** Each view scans the
  relevant files when it renders. This keeps views simple and ensures they
  always show current data. The cost is disk I/O per render, which is negligible
  for local filesystems.
- **Agent inspector is the transparency tool.** The Founder should be able to
  see everything about any agent: its identity, its recent behavior, its
  knowledge, its git footprint. No hidden state.
- **Hierarchy is derived, not stored.** The tree is computed from `createdBy`
  relationships and rank. There is no separate hierarchy file to keep in sync.
  This means the tree always reflects reality.
