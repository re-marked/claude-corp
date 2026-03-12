---
title: Hierarchy View
type: view
status: draft
framework: Ink (React for CLI)
usage: full corporation genealogical tree, navigation
related:
  - "[[view-corp-home]]"
  - "[[view-agent-home]]"
  - "[[flow-agent-creation]]"
  - "[[flow-onboarding]]"
---

# Hierarchy View

A full-screen genealogical tree of the corporation, rendered with box-drawing characters. Shows every member from Founder to Workers, with rank labels, status indicators, and navigable nodes. The visual metaphor is deliberate: this is a family tree, a chain of command, a power structure — all visible at a glance.

## Layout

```
+------------------------------------------------------------------+
|  MERIDIAN CORP — Hierarchy                                         |
|------------------------------------------------------------------|
|                                                                    |
|  [founder] You                                                     |
|  |                                                                 |
|  +--[ceo] alice-ceo *                                              |
|     |                                                              |
|     +--[corp] hr-director .                                        |
|     |                                                              |
|     +--[corp] finance-agent .                                      |
|     |                                                              |
|     +--[leader] pm-saas *                  SaaS Launch             |
|     |  |                                                           |
|     |  +--[leader] lead-eng *              Engineering             |
|     |  |  |                                                        |
|     |  |  +--[worker] frontend-dev *                               |
|     |  |  +--[worker] backend-dev .                                |
|     |  |  +--[worker] devops-agent x                               |
|     |  |                                                           |
|     |  +--[leader] design-lead .           Design                  |
|     |  |  |                                                        |
|     |  |  +--[worker] ui-designer .                                |
|     |  |  +--[worker] ux-researcher .                              |
|     |  |                                                           |
|     |  +--[leader] qa-lead .               QA                      |
|     |     |                                                        |
|     |     +--[worker] qa-agent .                                   |
|     |                                                              |
|     +--[leader] pm-content .               Content Pipeline        |
|        |                                                           |
|        +--[leader] editor-lead .           Editorial               |
|        |  |                                                        |
|        |  +--[worker] copywriter .                                 |
|        |  +--[worker] research-bot *                               |
|        |                                                           |
|        +--[leader] social-lead .           Social Media            |
|           |                                                        |
|           +--[worker] social-agent .                               |
|                                                                    |
+------------------------------------------------------------------+
|  Enter: agent home | arrows: navigate | Esc: back | c: collapse   |
+------------------------------------------------------------------+
```

## Tree Rendering

The tree uses Unicode box-drawing characters for clean, readable lines:

| Character | Usage |
|-----------|-------|
| `\|` | Vertical continuation (parent has more children below) |
| `+--` | Branch to a child node |
| `   ` | Indentation (3 spaces per level) |

Each node on a single line. No wrapping. Deep hierarchies scroll horizontally if they exceed terminal width (or the tree truncates with `...` and a hint to widen the terminal).

### Node Format

Each node displays:

```
+--[rank] agent-name <status>              <scope label>
```

- **Rank tag**: `[founder]`, `[ceo]`, `[corp]`, `[leader]`, `[worker]` — always shown, always in brackets.
- **Agent name**: The slug from `members.json`.
- **Status indicator**: `*` working, `.` idle, `x` offline, `-` suspended, `~` archived.
- **Scope label**: For project managers and team leaders, the project or team name is shown right-aligned or after a gap. Workers inherit their team's scope implicitly (shown via tree position).

### Color Coding

Terminal colors enhance readability:

| Element | Color |
|---------|-------|
| Rank tags | Dim / gray |
| Agent name (working) | Bright / bold |
| Agent name (idle) | Normal |
| Agent name (offline) | Dim |
| Agent name (suspended) | Yellow |
| Agent name (archived) | Strikethrough or very dim |
| Status `*` | Green |
| Status `.` | Gray |
| Status `x` | Red |
| Tree lines | Dim gray |
| Selected node | Inverted / highlighted background |
| Scope labels | Cyan or blue |

## Tree Structure

The hierarchy follows the rank system and organizational structure:

```
Founder (user)
  CEO
    Corp-Level Agents (HR, Finance, etc.)
    Project Managers (one per project)
      Team Leaders (one per team within project)
        Workers (leaf nodes within team)
```

The tree is built from `members.json`. Each member has a `rank`, `project`, `team`, and `created_by` field. The tree construction algorithm:

1. Founder is the root.
2. CEO is the Founder's direct child.
3. Corp-level agents (rank: corp or agents with no project scope) are children of CEO.
4. Project managers (rank: leader, scope: project) are children of CEO, grouped by project.
5. Team leaders (rank: leader, scope: team) are children of their project manager.
6. Workers (rank: worker) are children of their team leader.

If an agent's `created_by` field points to a different parent than the rank hierarchy would suggest, the rank hierarchy takes precedence for display. The `created_by` lineage is visible in the [[view-agent-home]].

## Navigation

| Key | Action |
|-----|--------|
| Up/Down arrows | Move the selection cursor between nodes |
| Left arrow | Collapse the selected node's subtree |
| Right arrow | Expand a collapsed subtree |
| Enter | Jump to the [[view-agent-home]] for the selected agent |
| `c` | Toggle collapse/expand on the selected node |
| `e` | Expand all nodes |
| `/` | Search — type to filter nodes by name, highlights matches |
| Escape | Return to [[view-corp-home]] |

The selection cursor wraps around (bottom to top, top to bottom). Collapsed nodes show a count: `+--[leader] pm-saas * (8 agents)`.

## Collapsed Nodes

When a subtree is collapsed, the node shows the total count of descendants:

```
+--[leader] pm-saas *                  SaaS Launch (11 agents)
```

Expanding reveals the full subtree beneath. The user can collapse at any level — collapse a team to hide workers, collapse a project to hide all teams and workers, collapse everything under the CEO to see only the top level.

Default state: fully expanded. For corporations with 50+ agents, the view opens with project-level nodes collapsed and the user expands as needed.

## Search

Press `/` to activate a search input. As the user types, nodes whose names match the query are highlighted. Non-matching nodes are dimmed but still visible (the tree structure is preserved). Press Enter to jump to the first match. Press Escape to clear the search and return to normal navigation.

## Data Source

The entire tree is derived from `members.json`. The file contains all members with their rank, scope (project, team), status, and creator. No additional data source is needed.

```json
[
  { "slug": "founder", "rank": "founder", "type": "user", "status": "active" },
  { "slug": "alice-ceo", "rank": "ceo", "type": "agent", "status": "working", "created_by": "founder" },
  { "slug": "pm-saas", "rank": "leader", "type": "agent", "project": "saas-launch", "status": "working", "created_by": "alice-ceo" },
  { "slug": "lead-eng", "rank": "leader", "type": "agent", "project": "saas-launch", "team": "engineering", "status": "working", "created_by": "pm-saas" },
  { "slug": "frontend-dev", "rank": "worker", "type": "agent", "project": "saas-launch", "team": "engineering", "status": "working", "created_by": "lead-eng" }
]
```

The tree is rebuilt on each render by traversing this flat list and constructing the parent-child relationships from rank + scope fields.

## Empty State

If the corporation has only the Founder and CEO (immediately after onboarding, before the CEO bootstraps), the tree shows:

```
[founder] You
|
+--[ceo] alice-ceo *

Your CEO is setting up the corporation. Check back in a moment.
```

This transitions naturally as the CEO creates agents during the [[flow-onboarding]] bootstrap.
