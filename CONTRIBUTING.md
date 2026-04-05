# Contributing to Claude Corp

## Setup

```bash
git clone https://github.com/re-marked/claude-corp.git
cd claude-corp
pnpm install
pnpm build
cd packages/cli && npm link && cd ../tui && npm link && cd ../..
```

Requires: Node.js 22+, pnpm 10+, [OpenClaw](https://openclaw.ai) running.

## Commands

```bash
pnpm build          # Build all packages
pnpm type-check     # TypeScript strict check
pnpm test           # Run vitest (62 tests, <1s)
```

## Monorepo Structure

```
packages/
  shared/    # Types, parsers, primitives (Post, observations, IDs)
  daemon/    # Background process (router, autoemon, pulse, dreams)
  tui/       # Terminal UI (Ink/React)
  cli/       # Headless CLI (cc-cli)
```

## Branching

- `main` = stable. Never push directly.
- `feature/*` = short-lived branches off `main`.
- PRs for all merges. Squash is fine for cleanup, no-ff merge for features.

## Commits

One logical change = one commit. Not one file, not five features. If you changed 3 test config files for the same reason, that's one commit. If you added a feature and fixed a bug, that's two commits.

```
feat: SLUMBER profiles — 4 presets that change CEO behavior
fix: CEO on corp gateway — kills double dispatch
test: dispatch resilience — categorization, backoff, health
docs: GLOSSARY.md — every concept explained
chore: bump to v0.16.8
cleanup: remove dead connectRemoteAgent (-120 lines)
refactor: migrate api.ts to post()
ci: GitHub Actions workflow
```

## Key Primitives

Read [GLOSSARY.md](GLOSSARY.md) for the full list. The ones you'll touch most:

- **Post** (`packages/shared/src/post.ts`) — all channel JSONL writes go through `post()`. Mandatory senderId, 5s dedup.
- **Fragments** (`packages/daemon/src/fragments/`) — prompt chunks injected into agents. Each has `applies()`, `order`, and `render()`.
- **Autoemon** (`packages/daemon/src/autoemon.ts`) — the autonomous tick engine. State machine + tick loop.

## Testing

```bash
pnpm test              # All tests
npx vitest run <file>  # Single file
npx vitest             # Watch mode
```

Tests live in `tests/`. Cover the primitives that actually broke — Post dedup, observation parsing, profile validation, schedule parsing, dispatch resilience.

## Before Submitting a PR

1. `pnpm build` passes
2. `pnpm type-check` passes
3. `pnpm test` passes (62/62)
4. Commits are granular with meaningful messages
5. No `as any` casts unless absolutely necessary
