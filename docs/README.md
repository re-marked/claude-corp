# AgentCorp

Your personal corporation. Running locally. Powered by OpenClaw.

---

## Vision
- [[core]] — What AgentCorp is
- [[principles]] — Agenticity, transparency, git-is-truth
- [[positioning]] — Open-source CLI, local-first

## Concepts
- [[corporation-of-one]] — The hierarchy: Founder, CEO, teams, agents
- [[ceo]] — Your AI CEO: the permanent executive
- [[agenticity]] — Agents that ACT, not just respond
- [[heartbeat]] — How agents stay alive (OpenClaw native)
- [[brain-framework]] — Agent memory and identity
- [[radical-transparency]] — Nothing hidden, ever — cat any file, git log any change
- [[git-corporation]] — The entire corporation is version-controlled
- [[agent-personality]] — SOUL.md and the seeds that grow
- [[externals]] — Bridges to the outside world (OpenClaw native)
- [[starter-pack]] — CEO bootstraps your first team

## Primitives
- [[members]] — Unified identity for users and agents
- [[channels]] — Communication spaces
- [[messages]] — JSONL message logs
- [[tasks]] — Markdown task files with frontmatter
- [[teams]] — Working groups

## Architecture
- [[stack]] — Node.js + TypeScript + Ink + OpenClaw
- [[daemon]] — Background process: router + process manager
- [[router]] — Message routing via fs.watch + webhooks
- [[tui]] — Terminal UI built with Ink (React)
- [[file-system]] — The file-based data model
- [[agent-runtime]] — OpenClaw gateway instances
- [[agent-lifecycle]] — Creation to archive
- [[corp-structure]] — Directory layout reference

## Flows
- [[flow-onboarding]] — Run agentcorp to first conversation
- [[flow-message]] — User sends to agent responds
- [[flow-heartbeat]] — Periodic wake-up to autonomous work
- [[flow-agent-to-agent]] — @mention chaining
- [[flow-task]] — Create to complete
- [[flow-agent-creation]] — Rank-based agent spawning

## Views
- [[view-channel]] — Chat with member sidebar (primary view)
- [[view-onboarding]] — Corporation creation wizard
- [[view-corp-home]] — Corporation overview
- [[view-project-home]] — Project overview
- [[view-task-board]] — Task list with filters
- [[view-agent-home]] — Agent inspector
- [[view-hierarchy]] — Mafia-style org tree

## Future Ideas
- [[agent-forking]] — Fork agents like GitHub repos
- [[agent-elo]] — Reputation and peer ratings
- [[agent-unions]] — Negotiation and preferences
- [[agent-economy]] — Agents pay agents
- [[crisis-channels]] — Temporary high-priority rooms
- [[agent-dreams]] — Background processing while idle
- [[web-version]] — Future web frontend on same daemon

## Building Plan
- [[building-plan]] — What to build, in what order
- [[layer-1-foundation]] — Project setup, file formats, git
- [[layer-2-ceo]] — Spawn OpenClaw, onboarding, first chat
- [[layer-3-messaging]] — Daemon router, @mention dispatch
- [[layer-4-tasks]] — Task files, heartbeat, task board
- [[layer-5-autonomy]] — Agent creation, git commits, Git Janitor
- [[layer-6-views]] — Corp home, hierarchy tree, agent inspector
- [[layer-7-externals]] — Telegram, Discord, SMS bridges
