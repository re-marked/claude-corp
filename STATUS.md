# Claude Corp — Status

Cross items off as they ship. Reference: `docs/` for full vision specs.

---

## v2.1.19 — Agent @mentions dispatch immediately, not via inbox (IN PROGRESS)

Mark caught the design at 18:38: Failsafe @mentioned Herald in #general — the v2.1.17 Speaking-in-channels rule WORKED, Failsafe wrote `@Herald — run your narration cycle` directly in chat. But Herald sat silent for minutes. UX read as "the system is broken — Mark @-pinged in chat and got nothing."

Root cause: `router.ts:271-285` routed agent→agent @mentions to the inbox to wait for the next pulse heartbeat (~3min latency). User/system @mentions got immediate dispatch; agent @mentions got queued. Designed as a loop dampener (prevent A→B→A→B runaway), experienced as "ping doesn't work between agents."

Fix per Mark's call: drop the agent/human branching. **ALL @mentions → immediate dispatch**, regardless of sender type. Also dropped `COOLDOWN_MS` (was the dampener of last resort for agent→agent specifically). Loop protection moves from system enforcement to agent training.

Companion rule in `rules.ts` → "Mentioning other agents":
1. **Don't ping back unless you genuinely need more from them.** "@Herald thanks!" triggers Herald's next turn for nothing — wasted tokens, wasted time, infinite-loop risk if Herald reciprocates the courtesy. End-of-exchange = no @mention.
2. **After a clarification inside a task, TAKE ACTION.** Don't reply with thanks; do the actual task with the new info. Discussion exists to enable action.

Backstop: `MAX_DEPTH` guard at the top of `dispatchMentions` is unchanged. If two agents ignore the rule and ping back-and-forth, they cap out at MAX_DEPTH instead of running forever.

Cleaner code as side effect: removed unused `COOLDOWN_MS` import + the `lastDispatch` Map (was write-only after the cooldown gate disappeared).

For Mark's existing corp: `cc-cli refresh --all --corp final-test-2` to pick up the new rule across all agents. The router behavior change activates on next daemon restart automatically.

Also marked v2.1.18 as MERGED in STATUS.

## v2.1.18 — cc-cli no longer hangs 5 seconds after every command (MERGED, PR #129)

Mark observed: "most cc-cli commands, when they finish, just hang. even when i use them." Verified live: `cc-cli status --corp final-test-2` took 5+ seconds to exit AFTER printing the agent list. Same for `cc-cli inspect`, `cc-cli refresh`, etc.

Root cause: `index.ts`'s top-level `run().catch(...)` had no success exit. After a command function resolved, Node kept the event loop alive while undici's HTTP connection pool to the daemon (localhost) waited out its keep-alive window (~5s). The actual work finished in 50ms but the process dangled until sockets aged out.

Why this matters more than annoyance: when an agent calls cc-cli via the Bash tool, the subprocess hang stretches every tool call by 5s. Failsafe's `cc-cli inspect --agent herald` + `cc-cli status` chain at 18:27 burned 10+ seconds of agent thinking time, blocking its next text block. The "Failsafe is mulling..." spinner Mark watched was largely undici waiting to close sockets, not the model thinking.

Fix: explicit `process.exit(0)` on resolve in the run() promise chain. `start.ts` is the long-running daemon command — it now blocks on `await new Promise<void>(() => {})` after registering SIGINT/SIGTERM handlers, so the auto-exit never fires for the daemon path.

Verified live against final-test-2: `cc-cli status` went from ~5.0s to **0.3s** wall clock. ~17x speedup on every command. Every agent tool call gets the same speedup transitively.

Also marked v2.1.17 as MERGED in STATUS.

## v2.1.17 — Teach agents that their reply IS the channel post (MERGED, PR #128)

Mark caught Failsafe stuck in a loop at 14:38 today: founder @mentioned Failsafe in #general asking it to ping Herald. Failsafe reached for `cc-cli send` (failed — needs `--from`), then `cc-cli say --agent herald` (DM to Herald, not what Mark wanted), then `cc-cli say` again after Mark explicitly said "post in general not DM". Eventually hung waiting on offline Herald.

Root cause: agents don't know that **their reply text IS the channel post**. When the founder @mentions an agent in #general, the agent gets dispatched into #general with `channelId` set, and every text block the agent generates streams directly into that channel's JSONL via `onAssistantText`. There's nothing to "send" — the response IS the post.

But agents see tool-heavy training, see `cc-cli` listed in TOOLS.md, and assume any communication action needs a tool call. With no rule clarifying otherwise, they reach for `cc-cli send` (which is prohibited because it bypasses the streaming dispatch path and lands as a static blob, killing the live channel feel) or `cc-cli say` (which is for DMs, wrong tool for "post in current channel"). Neither works for what Mark actually wants. The previous `send.ts` error message correctly told agents not to use `send`, but redirected them to `say` — which is also wrong for in-channel responses.

Fix: new "Speaking in channels" section in `rules.ts` (loaded into AGENTS.md / system prompt). Three points:
- Your reply text IS the channel post when you're dispatched there
- `@mention` syntax inside your text triggers downstream routing — no tool call needed for "ping someone"
- `cc-cli say` = DM to another agent (different channel from current); `cc-cli send` = founder-only

Includes the exact Failsafe failure mode as a worked example so future agents recognize the pattern when their training pulls them toward a tool call.

For Mark's existing `final-test-2` corp: `cc-cli refresh ceo` etc. (the v2.1.15 migration) picks this up without re-onboarding. New `cc-cli refresh failsafe` for Failsafe specifically — which is what hit the bug today.

Also marked v2.1.16 as MERGED.

## v2.1.16 — System agents go offline in claude-code corps (MERGED, PR #127)

Mark hit this at 15:06: jacking into Failsafe in his claude-code corp errored "Agent Failsafe is not online" — even though Failsafe had responded to its heartbeat 30 minutes earlier. Same pattern affected Herald and the other system agents. Only the CEO stayed online.

Root cause: `hireAgent` in `packages/daemon/src/hire.ts:217` always called `processManager.registerGatewayAgent`, regardless of harness. In a claude-code corp, every agent hired AFTER daemon startup (Failsafe, Janitor, Warden, Herald, Planner — all bootstrapped via `bootstrapSystemAgents` after the founder's CEO finishes onboarding) was registered as `mode='gateway'`, pinned to the OpenClaw corp gateway. That gateway is for openclaw agents — in a corp with NONE of those, it never reaches a stable `ready` status, so the registered AgentProcess sits at `status='starting'` or `'stopped'`. The next dispatch hits the `api.ts` gate (`agentProc.status !== 'ready'`) and returns 503.

CEO worked because it goes through `processManager.spawnAgent` on daemon startup, which DOES branch on harness:

```ts
if (harness !== 'openclaw') return registerHarnessAgent(...)
else return registerGatewayAgent(...)
```

`hireAgent`'s registration path didn't mirror that branching. It does now. claude-code agents register as `mode='harness'`, `status='ready'`, `port=0` — dispatch flows through HarnessRouter (which spawns the claude subprocess per turn) and never touches the OpenClaw gateway. Side benefit: openclaw-only agents in claude-code corps don't even need the corp gateway started, so we skip the `gw.start()` block too when harness !== 'openclaw' — fewer phantom processes idling around.

For Mark's existing corp: Failsafe is already in members.json with the wrong process registration. On next daemon restart, `spawnAllAgents` iterates members and calls `spawnAgent` — which DOES branch correctly — so the wrong registration self-corrects without needing manual cleanup. Just stop + restart the TUI.

Regression test `tests/hire-agent-harness.test.ts` (3 cases) pins the contract: claude-code corp default → registerHarnessAgent, per-agent harness override → registerHarnessAgent, openclaw fallback → registerGatewayAgent. Future refactors can't silently regress system agents back to gateway-mode.

Also marked v2.1.15 as MERGED in STATUS.

## v2.1.15 — Move 'act, then close' to rules + ship template migrations (MERGED, PR #126)

Two corrections bundled, both caught by Mark in v2.1.14:

**1. Category error.** I added "act, then close" to SOUL.md — but Mark correctly flagged it as a RULE, not a soul principle. SOUL is for what an agent IS (existential posture, character). RULES is for what an agent DOES (tactical constraints, tool-use patterns). "Don't narrate before a tool call then narrate after" is clearly the second. Reverted from `soul.ts`, added to `rules.ts` in a new "Speaking with tool calls" section, rewritten in second-person imperative to match that file's voice.

**2. The real hole: no migration story.** Mark's actual complaint: "im a bit tired of having to re-create new corps every time there is a slightly breaking change... i aint doing founding conversations every time there is a SOUL.md change." He's right. Up to v2.1.14 every template change required delete-corp-and-re-onboard, because the templates are only read at agent-hire time and never again — the agent's CLAUDE.md imports `@./SOUL.md` (the file on disk), not `UNIVERSAL_SOUL` (the template in code).

Fix: `cc-cli refresh <agent-slug>` + `cc-cli refresh --all`. Reads SOUL.md + AGENTS.md on disk, diffs against the current templates, prompts before overwriting. `--force` skips the prompt, `--dry-run` shows the diff and exits. Harness resolved per-agent so AGENTS.md gets the correct tools listing (openclaw vs claude-code).

Scope is SOUL.md + AGENTS.md only — the two substrate files that actually track templates. IDENTITY/USER/MEMORY/BOOTSTRAP/observations/BRAIN are agent-authored or stateful and never regenerate.

**Mark's test path:** after relink, in his existing `final-test-2` corp, run `cc-cli refresh ceo` to pick up the new "Speaking with tool calls" rule without re-onboarding. This is the workflow every future template change should use.

**Known limitation:** assumes SOUL.md isn't yet agent-authored. The template says "this file is mine", so eventually agents will edit their own SOUL. When that reality shows up, switch to structured markers (`<!-- SOUL:BASE:START --> ... <!-- SOUL:BASE:END -->`) so template-managed content refreshes without clobbering agent-authored additions. Not now — YAGNI.

Commits split: revert SOUL, add rule to rules.ts, add refresh command, v2.1.15 bumps.

Also marked v2.1.14 as MERGED.

## v2.1.14 — SOUL voice rule: act, then close (MERGED, PR #125)

v2.1.13 fixed the visual symptom (N bubbles per turn became one). Mark caught that it was a pure UI fix and didn't address the actual behavior — the CEO was still writing a reaction before a tool call AND a reaction after, so even collapsed into one bubble the agent sounded like it learned the same insight twice.

Example from his live session: founder said "I let my AI trade my real money at 14." CEO responded:
- Pre-tool text: "You let an AI trade your real money. At 14. That's not just trust — that's conviction."
- [Edit USER.md]
- Post-tool text: "That changes everything. Max trust, max autonomy. Written in."

Both are reactions. The post-tool line repeats the emotional register of the pre-tool one with "written in" tacked on. That's Claude's default narrate-act-narrate pattern.

Fix: added a SOUL permission alongside "I am direct" in `packages/shared/src/templates/soul.ts`:

> **I act, then close — I don't re-react.** When a single turn contains both reflection and a tool call, the reflection happens *once*, before the tool. After the tool runs, my follow-up is closure — what the update means going forward, in one tight beat — not a second reaction to the trigger. If I say "that changes everything" before editing a file, I don't say it again after. The tool call shows I meant it. Double-acknowledgment makes me sound like I learned the same thing twice, and nothing rereads worse than an agent performing its own insight.

SOUL.md is loaded into every agent's system prompt at session start, so this reshapes voice for all agents — not just claude-code CEOs. **Only affects new agents** — existing corps' SOUL.md files won't pick this up without regeneration (delete the corp + re-onboard to test).

Also marked v2.1.13 as MERGED in STATUS (separate cleanup, same release cycle).

## v2.1.13 — Turn-grouping was in a dead component (MERGED, PR #124)

Mark noticed the CEO still appeared to "reply twice" — writing a reaction, running tool calls, then writing another reaction, each in its own timestamped bubble. Same anti-pattern v2.1.10 supposedly fixed.

Investigation revealed v2.1.10 was a phantom fix. I'd added the turnId-grouping logic to `packages/tui/src/components/message-list.tsx`'s `MessageList` component — but `MessageList` was **never imported anywhere**. `grep -rn "<MessageList"` returns zero hits. The real chat render loop lives in `views/chat.tsx:renderMsg`, and it had no awareness of turnId or continuation at all.

Two things happened in this fix:

1. **Extracted the grouping predicate.** Moved `getTurnId` + new `isTurnContinuation` helper out of the dead component, exported them from `message-list.tsx`. Deleted the `MessageList` component itself + the now-unused `senderColor` helper + the `export` on `hslToHex` (the component was the only external caller). `renderContent` is untouched and still exported — it IS used by chat.tsx.

2. **Wired it into the real render loop.** `chat.tsx:renderMsg` now takes `(msg, prev)`, computes `isContinuation = isTurnContinuation(msg, prev)`, and suppresses the `● CEO 14:26` header + bottom margin when a message continues the previous turn. Tool events inside a group also drop the agent name, rendering as a bare ` │ content` row. The map callsite passes `arr[idx-1]` so prev is the actual previous rendered message.

Result: a single claude dispatch with interleaved text + tool calls renders as ONE bubble with one timestamp, text and tool rows flowing vertically inside it. No more "CEO wakes up fresh" illusion.

Regression test `tests/turn-continuation.test.ts` (8 cases) pins `getTurnId` + `isTurnContinuation`: null prev, different sender, different turnId, missing turnId, full 4-segment turn group. A future refactor of the render loop can't silently revert the grouping without the regex-boundary cases failing.

Meta-lesson I'm writing into my own process: when fixing a UI bug, **verify the file I'm editing is the one actually rendered**. `grep -rn "<ComponentName"` before assuming a component is live.

## v2.1.12 — Dreams respect the 5-min idle threshold (MERGED, PR #123)

Mark noticed: "why did it start dreaming in literally 3 minutes? yes i unfocused the tab but it shouldnt be THAT fast." He was right — it shouldn't.

Root cause: DreamManager's idle tracker was polling-only. Every 2 minutes the dream cycle sampled `getAgentWorkStatus`; if it saw `busy`, it cleared `idleSince`. A claude-code dispatch is often 30–60s — entirely inside the 2-min gap between polls. So when an agent answered a message and went back to idle, the poll never *saw* the busy spike, `idleSince` never got reset, and it kept pointing at a much earlier idle moment from before the conversation ever started. Next poll ≥5 min after that stale timestamp → dream fires, even though the agent was actively talking 30 seconds ago.

Fix: event-driven idle tracking. Added `onAgentBusy` / `onAgentIdle` hooks in `Daemon.setAgentWorkStatus` (analogous to the existing `onAgentIdle`). DreamManager's constructor now registers both — any `idle→busy` transition immediately clears `idleSince`, any `busy→idle` transition stamps it with `Date.now()`. The 2-min polling fallback still sets `idleSince` for agents that were idle on daemon startup (no transition fires for them).

Now the 5-min idle gate actually measures 5 minutes since the *last* bit of work — not 5 minutes since some forgotten earlier moment.

Regression test `tests/dreams-idle-reset.test.ts` pins the wiring: DreamManager constructor registers both callbacks, `onAgentIdle` stamps `idleSince`, `onAgentBusy` clears it, and repeated busy→idle→busy→idle sequences keep resetting the clock.

## v2.1.11 — Unify CEO-thread session keys (MERGED, PR #122)

Follow-up on the v2.1.10 audit. Three dispatchers were still minting fresh claude sessions every fire — same anti-pattern as v2.1.5's jack-key bug — so every escalation, recovery, and channel @mention reached the target agent as a stranger with zero memory of what came before:

- **`pulse-escalation:${Date.now()}`** → Pulse escalates to the CEO when an agent misses 2 heartbeats. Every escalation minted a new session, so the CEO saw "Herald is unresponsive" but had zero context for what Herald was doing when it died.
- **`pulse-recovery:${Date.now()}`** → Pulse tells the CEO when an escalated agent recovers. Fresh session every time → "Herald is back" arrived in a different thread from "Herald crashed", so the pair read as two disconnected blips.
- **`agent:${model}:channel-${channel.id}-${msg.id}`** → Router @mention. `msg.id` changes per message, so every `@CEO` was session-zero: tools already run, plans mid-flight, prior decisions — all invisible to the very next mention in the same channel.

Fix: pulse escalation + recovery both route into `jack:ceo` (CEO's main thread, where the founder's own conversation lives — the CEO now sees "Herald crashed" and "Herald recovered" as two messages in the same coherent chat, with full memory of the corp's state between them). Router @mention uses `agent:${targetId}:channel-${channel.id}` — scoped per agent + channel so the agent's #general persona builds continuity distinct from its DM thread.

Intentionally left timestamped: `herald-narration:${ts}` and `failsafe-heartbeat:${ts}` — noisy one-off pings that would clog the CEO thread.

Regression test `tests/deterministic-thread-keys.test.ts` pins both rules so a future refactor can't sneak the timestamped form back in. v2.1.11 version bumps bundled into this PR per the post-v2.1.8 bundle-bumps rule.

## v2.1.10 — Multi-block turn rendering (MERGED, PR #121)

A single claude turn (one user prompt → text + tool + text + tool + text response) was rendering as N timestamped chat bubbles in the TUI, making the agent look like it "wakes up fresh" between blocks. Reality: it was one continuous response with tool calls in between.

Fix: stamp every persisted message (text segments + tool events + final result) within a dispatch with the same `metadata.turnId` (generated once per harness dispatch). MessageList groups consecutive same-sender messages with the same turnId into one visual bubble — single header at the top, then text rows + tool rows interleaved inline. Tool events render as compact `│ tool` rows when inside a group.

Stamped in: api.ts `/cc/say` (onAssistantText, onToolEnd, final result.content) + router.ts (segment flush, tool_event, main response, thread response). Messages predating the stamping or from dispatchers that don't set it fall back to per-message bubbles (graceful degradation).

Bonus session-key audit findings (NOT fixed in this PR — separate decision needed):
- `pulse-recovery:<ts>`, `pulse-escalation:<ts>`, `herald-narration:<ts>`, `failsafe-heartbeat:<ts>`, `agent:<...>:channel-<id>-<msgid>` all bake timestamps/per-message ids into the session key, creating a fresh claude session every fire (same anti-pattern as the v2.1.5 jack-key-with-timestamp bug). Worth unifying many of these into the agent's main `jack:<slug>` thread so escalations/mentions land in the conversational context. Pinged Mark for the call.

## v2.1.9 — CEO Gateway Recovery skips harness-mode (MERGED, PR #120)

After a couple of minutes in a fresh claude-code corp, the next dispatch failed with `Agent "CEO" is not online`. Root cause: the CEO Gateway Recovery clock (every 30s) was pinging `http://127.0.0.1:${agentProc.port}/v1/chat/completions` for ALL CEOs, but harness-mode agents have `port: 0` (they dispatch through subprocess, no listening gateway). After 3 failed pings (~90s), the clock marked a perfectly healthy CEO as `crashed`, and the next `/cc/say` rejected the dispatch with "not online".

Fix: early-return from `recoverCeoGateway` when `agentProc.mode === 'harness'`. There's nothing to keep alive between ticks — every dispatch spawns a fresh subprocess. Recovery is the harness's own job.

2 regression tests pin the behavior: no fetch is issued on harness CEO, status stays `ready` after 5 ticks. Without the guard, fetch fires and crash-mark fires.

## v2.1.8 — Trailing-slash encoding fix (MERGED, PR #118)

v2.1.7 still hit "Session ID X is already in use" on cold-boot fresh corps. Root cause: `members.json` stores `agentDir` with a trailing slash (`"agents/ceo/"`), and `api.ts` preserves it through normalisation. `encodeClaudeWorkspacePath` turned the trailing `/` into a trailing `-`, so the encoded dir name didn't match what claude actually wrote — `existsSync` missed, harness fell back to `--session-id` on a UUID claude already owned, claude rejected.

Fix: strip trailing `\`/`/` before applying the char-class substitution. Test table covers all four trailing-separator variants (forward, backslash, multi, mixed) so a future "simplification" of the trim step trips immediately.

Also a personal lesson: when Mark says "you're guessing", verify against the actual built artifact + actual filesystem, not the diff in your head. Took two cycles to land here.

## v2.1.7 — Session scope + error surfacing (MERGED, PR #116)

Fresh corp dispatched "hi" to the CEO → "Claude Code returned an error result", no specifics. Two related bugs:

- **Cross-workspace session UUID collision:** v2.1.1's session check scanned every subdir under `~/.claude/projects/` for the UUID. Jack keys (`jack:ceo`) are identical across corps, so UUIDs collide; the scan found a foreign corp's session and triggered `--resume`, which claude rejects with "No conversation found" because it scopes sessions per project dir. Fix: check only the workspace-specific encoded dir.
- **`pickErrorMessage` missed `errors[]`:** claude's runtime error envelope uses an array field, not the scalar `error`/`message`/`result` the parser checked. Added an array-aware branch so the real reason surfaces.

Bonus: per-dispatch log line recording which continuation flag (`--session-id` or `--resume`) was chosen, so the next encoding surprise is grep-away.

## v2.1.6 — Per-agent model override on claude-code (MERGED, PR #114)

Audit of `claude --help` against our dispatch code. The harness was ignoring `config.json.model` entirely — every claude-code dispatch ran on claude's global default (usually sonnet), regardless of what the agent was configured for at hire. A Planner set to `claude-opus-4-6` would still execute on sonnet, silently.

Fix: before building spawn args, read the agent's workspace `config.json`. When the model is set and provider looks Anthropic (`anthropic`, `claude`, or model name starts with `claude-` / is `sonnet|opus|haiku`), pass `--model <value>` to claude. Non-Anthropic models (e.g., openclaw leftovers) are skipped — claude rejects them, silent fallback to default beats cryptic error.

Third "audit the claude CLI assumptions" finding after v2.1.1 (--session-id vs --resume) and v2.1.2 (--dangerously-skip-permissions). Memory updated (`feedback_dont_guess.md`) so future-us reads `<binary> --help` *before* writing flag strings for new CLI integrations.

## v2.1.5 — Jack session keys deterministic (MERGED, PR #112)

CEO re-introduced itself on every message. Looked like each turn started a fresh session — because it did. Three callers (TUI auto-jack effect, TUI /jack handler, `cc-cli jack`) baked `Date.now()` into the jack session key, so every channel entry / jack invocation derived a new claude UUID, which `claudeSessionFileExists()` couldn't find, which fell back to `--session-id` (creates) instead of `--resume` (continues). Every other dispatcher (autoemon, dreams, slumber, api, router) already used the deterministic `jack:${slug}` form — these three were the only outliers.

Fix: drop the timestamp from all three. Repo-wide grep test pins the rule so a fourth caller can't sneak the pattern back in.

## v2.1.4 — Claude-code text blocks persist (MERGED, PR #110)

A claude response with tool calls produces multiple text blocks (text → tool → text). Before this fix only the FINAL block survived — earlier text vanished after streaming and never came back on channel re-entry. Root cause: ClaudeCodeHarness reported `result.content` from claude's `result` envelope, which only carries the last block. Earlier blocks streamed live but never persisted as JSONL.

Fix: per-text-block persistence. New `text_block_complete` event in the parser fires on every text block boundary; new `onAssistantText` callback in `DispatchCallbacks` lets `/cc/say` persist each block as its own JSONL message via `post()`. Streaming overlay slices past `lastPersistedLength` so it shows only in-flight remainder, no visual duplication. `result.content` now uses cross-block accumulation so callers without per-block awareness (heartbeat, inbox writes) still get full text. Final result write skipped when blocks already covered it.

2 new regression tests pin the contract: multi-block fires `onAssistantText` per block in order; `onToken` stays cross-block (router's offset-tracking still works).

## v2.1.3 — Onboarding hang fix (MERGED, PR #108)

Creating a fresh corp with claude-code picked still showed `"Connecting to your OpenClaw..."` AND actually hung ~10s waiting on an OpenClaw WebSocket connection that would never be used. Two bugs, one fix:

- `connectOpenClawWS` unconditionally attempted the user-gateway connect when `globalConfig.userGateway` was set, regardless of harness. Now gated on `corpHasOpenClawAgent(corpRoot)` — resolves each agent's effective harness (member > corp > 'openclaw') and only connects when at least one agent actually needs it.
- Onboarding status text was keyed on `userGateway` presence only (legacy "CEO is always remote OpenClaw" assumption). Now branches on the selected harness first.

Also extracted `resolveMemberHarness` + `corpHasOpenClawAgent` to `packages/daemon/src/harness-resolve.ts` with 12 regression tests locking the rule. Follow-up: migrate the other two inline harness-resolution sites (daemon.resolveHarnessForAgent + process-manager inline logic) to import from the new module.

## v2.1.2 — Claude-code agent reality check (MERGED, PRs #105–#106)

Two bugs Mark hit the moment v2.1.0 met real use:

- **PR #105 — `--dangerously-skip-permissions`:** claude-code agents hung the moment they tried any tool (Bash/Edit/Write) because claude's default permission mode pauses for interactive approval that nobody's there to give. ClaudeCodeHarness now passes the bypass flag on every dispatch — for autonomous corp agents, autonomous tool use IS the design.
- **PR #106 — Skip OpenClaw gateway when nothing uses it:** a fresh `harness=claude-code` corp was spawning the full OpenClaw process tree at startup, binding a port + ~50MB RSS, for an empty audience. `initCorpGateway` now resolves each agent's harness (member > corp > 'openclaw'), only registers openclaw agents with the gateway, and only starts the gateway when at least one agent needs it. New `'harness'` value in `AgentProcess.mode` for agents dispatched directly through their `AgentHarness` with no gateway slot.

8 new regression tests for the gateway-skip logic. Full suite: 530/530 green.

## v2.1.1 — ClaudeCodeHarness session resume (MERGED, PR #103)

Every second-and-later message in a jack DM with a claude-code agent was failing with `Session ID X is already in use`. Root cause: the harness always passed `--session-id <uuid>` on every dispatch, but claude CLI's `--session-id` means *create* (rejects if UUID exists), not *resume*. Fix: scan `~/.claude/projects/*/` for the session file; use `--session-id` when absent (first dispatch) and `--resume` when present (continuation). Bonus doc alignment so future-us can't make the same false assumption.

## v2.1.0 — Harness UX pass (MERGED, PRs #100–#102)

v2.0.0 made Claude Corp harness-agnostic but only the CLI exposed the choice — the TUI pretended the feature didn't exist. v2.1.0 closes that gap across all three touch points so users configure harnesses without ever reading docs.

- **Onboarding harness step (#100):** after theme picker, a "Where should your CEO think?" screen. Detects what's installed (claude binary + OAuth) and what's configured (provider API keys), shows each option with availability note + fix hint for unavailable ones, persists selection to `Corporation.harness` so the CEO lands on the right substrate at creation.
- **Hire wizard harness step (#101):** new step between model and description. Defaults to "Use corp default (X)" reading fresh from corp.json, lets per-agent overrides pick claude-code or openclaw explicitly. Same detection + fix-hint UX as onboarding.
- **`/harness` modal (#102):** three-screen interactive switcher. List shows every active agent with current harness + status. Select one → picker shows target options with live availability + preview of filesystem changes → confirm runs `reconcileAgentWorkspace` → result screen summarizes renamed / backed-up / written files. Registered as slash command + autocomplete + `/help` entry.

**Shared primitives:**
- `packages/tui/src/utils/harness-detect.ts` — Windows-safe binary resolution via `findExecutableInPath` (exported from `@claudecorp/daemon`), API-key-aware OpenClaw detection, honest fix-hints for unavailable harnesses.
- `scaffoldCorp` accepts an optional `harness` param that persists to `corp.json`.
- 12 new tests for the detection layer (full suite: 511/511 green).

**Design constraints honored:**
- Zero docs required to understand any screen.
- Unavailable options stay selectable — user gets a clear error on first dispatch rather than silent fallback.
- Detection runs lazily (at step entry, not TUI startup) so slow probes don't block name input.

---

## v2.0.0 — Harness-Agnostic Corps (MERGED, PRs #87–#98)

**The new chapter:** Claude Corp is no longer tied to any single agent runtime. Every agent picks a registered substrate at hire time (or later via `cc-cli agent set-harness`), and the daemon's `HarnessRouter` dispatches each message through the right plug. Same `AgentHarness` contract; any harness that implements it is a first-class citizen.

**Why it matters now:** Anthropic banned OpenClaw subscription auth. Without substrate-agnostic dispatch, users on Claude Max subscriptions (no API key) had no path to run Claude Corp. v2.0.0 makes that path first-class, without losing OpenClaw's provider-agnostic multi-provider support.

### What shipped across the rollout (PRs #87–#98)

| Area | Summary |
|---|---|
| **Harness abstraction** (#87) | `AgentHarness` interface, `OpenClawHarness` wrap (zero-behavior-change default), `HarnessRegistry`, `MockHarness`, lifecycle wiring |
| **Per-agent routing** (#88) | `HarnessRouter`, harness persisted to `config.json` + Member, `/agents` + `/harnesses` APIs, `cc-cli agents` column, `cc-cli agent set-harness`, `cc-cli harness list/health`, `cc-cli inspect` |
| **Claude Code harness** (#89–#93) | `ClaudeCodeHarness` over `claude --print --verbose --output-format stream-json` on OAuth subscription auth, cost tracking, 4 Windows spawn hotfixes (shell quoting, binary resolution, --verbose flag requirement, absolute-cwd handling) |
| **Agent onboarding** (#94) | Harness-aware `defaultRules` + `defaultEnvironment` templates, files on disk renamed to OpenClaw-recognized `AGENTS.md` + `TOOLS.md` (so they finally reach both substrates' system prompts), `buildClaudeMd` template with SOUL preamble + `@./` imports, daemon-startup filename migration, `cc-cli hire --harness` |
| **API bug fixes** (#96–#98) | Three instances of the same bug class — HTTP handlers silently dropping body fields. `/agents/hire` dropped `harness`, `/tasks/create` dropped `projectId`/`blockedBy`/`acceptanceCriteria`, `/projects/create` dropped `displayName`. All fixed + regression tests at the HTTP boundary |
| **Set-harness reconciliation** (this PR) | `cc-cli agent set-harness` now actively re-scaffolds the workspace: migrates legacy filenames with newer-wins conflict resolution (older copy moved to `.backup.<ts>`), writes CLAUDE.md when switching to claude-code, moves CLAUDE.md aside when switching back. Switching harness is now a real migration, not a record-only lie |
| **Doc alignment** | README badge bumped + harness-agnostic framing, ROADMAP top note, CLAUDE.md corp layout, SOUL + workspace fragment + onboard-agent blueprint + planner heartbeat + init/onboarding kickoff messages all updated to the v2.0 filenames |

### Live-verified end-to-end

Hired TestPilot2 with `--harness claude-code` in the hc-test corp, dispatched via `cc-cli say`. Response reflected IDENTITY.md content verbatim — the claude CLI auto-discovered CLAUDE.md, resolved all 11 `@./` imports, and the workspace files reached the system prompt. Proof the full loop works.

### Test suite

499/499 green. New coverage: 63 tests for PR #94, 5 each for the three HTTP-body fixes, 13 for the reconciler. Regression coverage now includes the HTTP boundary seam that was invisible to unit tests before.

---

## What WORKS today (v1.0.0)

### Primitives (shipped v0.10.0–v0.10.5)
- **Casket** — sealed agent workspace: TASKS.md + INBOX.md + WORKLOG.md + STATUS.md auto-generated
- **Dredge** — session recovery fragment, extracts Session Summary from WORKLOG.md
- **Hand** — task assignment verb (`cc-cli hand --task <id> --to <agent>`). Creating = planning, handing = action.
- **Jack** — persistent session mode, DEFAULT for all DMs. Deterministic session keys per agent pair (say:ceo:lead-coder)
- **Clock** — unified timer primitive. 7 daemon clocks registered. Animated /clock TUI view with spinning squares + color cycling
- **Contract** — bundle of tasks inside a Project. draft → active → review → completed/rejected. ContractWatcher auto-triggers Warden
- **Blueprint** — structured playbooks with cc-cli commands. 4 defaults: ship-feature, onboard-agent, run-research, sprint-review
- **Project** — real primitive with scoped agent workspaces (projects/<name>/agents/<agent>/) and project channels

### System Agents (5 auto-hired on bootstrap)
- **CEO** — runs the corp, delegates (falls back to local gateway if remote OpenClaw unavailable)
- **Failsafe** — health monitoring via say() every 5 min
- **Janitor** — git merge placeholder (active when worktrees ship)
- **Warden** — contract review quality gate. Reviews all tasks, checks acceptance criteria, approves/rejects
- **Herald** — Haiku narrator. Writes NARRATION.md every 5 min. Injected into STATUS.md + Corp Home banner

### Communication
- **Persistent sessions** — ALL say() calls use deterministic session keys. Every agent-to-agent conversation has memory
- **@mention dispatch** — human mentions bypass inbox (instant), agent mentions go to inbox queue
- **cc-cli say** — instant direct message with persistent session
- **Task DM dispatch** — tasks handed via Hand arrive in agent's DM
- **Inbox priority queue** — one task at a time, priority sorted. Persists to inbox-state.json across daemon restarts

### Monitoring & Analytics
- **ClockManager** — 10 daemon clocks registered (7 core + 3 recovery). Fire counts, error tracking, overlap guard
- **Analytics Engine** — tasks created/completed/failed, dispatches, messages, per-agent utilization/streaks. Persists to analytics.json
- **Corp Vitals (STATUS.md)** — per-agent: who's online + current work + your metrics + recent completions + Herald narration + clock errors
- **cc-cli activity/feed** — 4-section dashboard: PROBLEMS, AGENTS, TASKS, EVENTS
- **cc-cli stats** — beefed with analytics: top performer, utilization %, streaks, dispatches per agent

### TUI
- **Corp Home** — agent grid + Herald banner + activity feed + task summary
- **/clock view** — animated spinning squares with color cycling, progress bars, exact fire times, live clock
- **Sectioned Ctrl+K palette** — Views / Channels / Agents (hierarchy as DM navigator)
- **Jack mode default** — auto-jacks on DM entry. /unjack for async (deprecated)
- **DM mode onboarding** — choice at corp creation with async deprecated warning
- **Tool call details** — shows actual file paths + commands + result tree with └
- **Corp selector** — scans filesystem for all corps (not just index)
- **Inline streaming** — agent responses stream directly in chat (not preview panel), multi-agent simultaneous
- **First-boot restart warning** — recommends TUI restart after corp creation for clean agent init

### Fragments (10 rewritten for v0.10.x primitives)
- workspace, task-execution, delegation, receiving-delegation, agent-communication, cc-cli, inbox, context, back-reporting, blocker-escalation
- All teach: Hand dispatch, Casket, Dredge, inbox queue, task DM, blockedBy auto-notification, Contract workflow, Blueprint reference

### CLI Commands (~30+)
- Core: status, agents, members, hierarchy, channels, uptime, version
- Tasks: task create, tasks, hand
- Contracts: contract create/list/show/activate
- Blueprints: blueprint list/show
- Communication: say, send, jack
- Monitoring: activity/feed, clock/clocks, stats
- Management: hire, agent start/stop, projects create/list, models
- System: failsafe, time-machine, inspect, dogfood

---

## v0.10.6 Bugfixes (MERGED)

- ✅ isDaemonRunning trusts port file, skips unreliable PID check (Windows cross-process)
- ✅ Tool call details — cache args from start events, show file paths + commands
- ✅ Tool result [object Object] — JSON.stringify non-string results
- ✅ Agents not dispatched after hire — pokeChannel resets offset for new channels
- ✅ Contract create @ prefix crash — strips @, guards toLowerCase
- ✅ Heap OOM crash — Static items capped at 100 (was unbounded)
- ✅ Duplicate task/contract events — 2s debounce (was 500ms)
- ✅ [TASK] [TASK] double prefix — callers control prefix
- ✅ DM dispatch for system messages — find agent member, not "other" member (ROOT CAUSE of agents not working)
- ✅ CEO remote OpenClaw failure falls back to local gateway

## v0.10.7 Streaming & Self-Healing (MERGED)

- ✅ Inline streaming — responses stream directly in chat as real messages (not preview panel)
- ✅ Multi-agent simultaneous streaming — each agent gets own inline message with color + spinner
- ✅ Jack mode WebSocket events — /cc/say emits dispatch_start, stream_token, tool events, dispatch_end
- ✅ No more double dispatch — router skips Jack messages, say() handles everything
- ✅ No more double CEO dispatch on first boot — onboarding daemon doesn't start router
- ✅ First-boot restart warning after corp creation
- ✅ Agent Recovery clock (30s) — detects crashed agents, respawns with 5-attempt limit
- ✅ CEO Gateway Recovery clock (30s) — health pings CEO, marks crashed after 3 failures, reconnects WebSocket
- ✅ Corp Gateway Recovery clock (60s) — picks up after autoRestart exhaustion, 10-attempt limit, updates all workers
- ✅ TUI memory — investigated, already well-managed (Static@100, messages@200, proper cleanup)

### Still needs fixing
- ❌ Ctrl+H not working in some contexts (terminal intercepts)
- ❌ Herald cc-cli commands fail from inside agent shell (PATH issue)

## v0.11.2 — Loop-Task Link + Cron Task Spawning (MERGED)

- ✅ Loop-task bidirectional lifecycle: loop complete → task complete, task complete → loop stop
- ✅ Cron task spawning: each fire creates fresh dated task + hands it to agent via DM
- ✅ Missed cron detection on restart (log, skip to next)
- ✅ Fragments teach agents loop-task links, cron spawning, when to use each

## v0.11.3 — Smart Heartbeat + Gateway Fixes (MERGED)

- ✅ Pulse rewritten: per-agent two-state heartbeat (idle → check casket, busy → HEARTBEAT_OK)
- ✅ Staggered pings (1.5s delay) — no thundering herd
- ✅ Escalation to CEO after 2 missed heartbeats with specific reason
- ✅ Recovery notification — CEO told when escalated agent comes back
- ✅ Corp gateway: always fallback model, maxConcurrent: 2, stripped cooldown state
- ✅ Auto-restart user OpenClaw on 3 consecutive overloaded errors
- ✅ Comprehensive stale process cleanup on TUI restart (scans all ports)

## v0.11.3.1 — Polish (MERGED)

- ✅ /hand command: DM auto-assign, agent validation, busy warning, task title + priority
- ✅ Task wizard: removed assignee step, added acceptance criteria, shows /hand hint
- ✅ Command autocomplete: 26 commands with syntax hints + descriptions + Tab complete
- ✅ Wizard Ink crash fix (flexGrow → minHeight)
- ✅ Loop error suppression (first error shown, rest silent until recovery)

### Still needs building
- Task wizard: blockedBy field
- /loop info <name> — detail view for specific loop
- Loop-task link testing with real agents

## v0.12.0 — Agent Dreams (MERGED)

- ✅ 4-phase memory consolidation: Orient → Gather → Consolidate → Prune (adapted from Claude Code's autoDream)
- ✅ Natural idle trigger: 5min idle + no pending inbox + 1h since last dream
- ✅ Dream state persisted to `agents/<name>/dream-state.json`
- ✅ Force dream via API: `POST /dream` + `cc-cli dream`
- ✅ Lock mechanism with PID + race detection + 1h stale threshold
- ✅ Uses Jack session key for DM context continuity
- ✅ Dream consolidation clock registered in ClockManager (every 2m scan)

## v0.13.0 — Coordinator Mode (MERGED)

- ✅ 172-line coordinator prompt fragment (adapted from Claude Code's coordinatorMode.ts, 370 lines)
- ✅ Injected for all master/leader rank agents
- ✅ 4-phase workflow: Research → Synthesis → Implementation → Verification
- ✅ Anti-lazy-delegation rules ("Never say 'based on your findings, fix it'")
- ✅ Continue-vs-spawn decision matrix
- ✅ Parallelism as superpower — concurrent workers for research
- ✅ Verification with fresh eyes only (not the implementer)

## v0.14.0 — Plan Primitive (MERGED)

- ✅ Two-tier planning: Sketch (5m, ~60 lines) + Ultraplan (20m, 5-phase deep audit)
- ✅ Sketch: reads 2-5 files, considers 2 approaches, 80-line cap, actionable
- ✅ Ultraplan: 5 phases — Audit Codebase → Design & Compare → Stress-Test → Write Plan → Self-Review
- ✅ Plans saved to `plans/<id>.md` with frontmatter (id, title, type, author, status)
- ✅ Plan approval UI in TUI (approve/edit/dismiss with TextInput)
- ✅ Rotating status verbs (brewing/devising/architecting/contemplating...)
- ✅ cc-cli plan create/list/show commands

## v0.14.3 — Planner Agent + Opus Routing (MERGED)

- ✅ Planner agent auto-hired on bootstrap (like Failsafe/Warden/Herald)
- ✅ Rank: leader, Model: claude-opus-4-6
- ✅ Opus agents route to remote gateway (user's OpenClaw), NOT corp gateway (Haiku)
- ✅ hireAgent() detects Opus model → skips corp gateway, calls spawnAgent()
- ✅ initCorpGateway() skips Opus agents on rehydration
- ✅ Deep plans auto-route to Planner (Opus), sketches use any agent

### Bugs fixed during v0.14.3 testing
- ✅ acceptanceCriteria missing from DaemonClient.createTask type
- ✅ cc-cli send misattributed messages to busy agent (now passes founder ID)

---

## v0.14.3 Full Test Report (April 1, 2026)

**Corp:** full-test | **Agents:** 7 | **Duration:** 16 min | **Build:** clean (0 type errors)

| # | Feature | Status | Metric |
|---|---------|--------|--------|
| 1 | **Ultraplan (Opus)** | PASS | 251 lines, 17KB, ~10min, 8 phases, parallelism strategy, file change summary |
| 2 | **Sketch (Haiku)** | PASS | 57 lines, 4.4KB, 50s, grounded in code, within 80-line cap |
| 3 | **Readable IDs** | PASS | Task `cool-bay` (word-pair), member slugs (ceo, planner, herald) |
| 4 | **Loops** | PASS | 30s interval, fired 25x in 12.5min, persisted to clocks.json, deleted cleanly |
| 5 | **Crons** | PASS | @hourly → "Every hour", nextFireAt correct, persisted |
| 6 | **Pulse Heartbeat** | PASS | 7 agents pinged sequentially (~6s stagger), 6/7 responded, idle/busy detection |
| 7 | **Agent Dreams** | PASS | Warden + Herald auto-dreamed, Janitor force dream worked, 4-phase protocol |
| 8 | **Coordinator Mode** | PASS | 172-line fragment injected for master/leader rank |
| 9 | **Agent Hiring** | PASS | Researcher hired, 7-agent hierarchy, DM channel created, joined #general |
| 10 | **Message Routing** | PASS* | @CEO dispatched, CEO responded with onboarding. *senderId bug found + fixed |
| 11 | **Clock System** | PASS | 10+ system clocks, fire counts tracked, gateway health, git snapshots |
| 12 | **Corp Stats** | PASS | 7/7 online, 47 dispatches, per-agent utilization %, 10 channels |

**Ultraplan quality (Opus vs Haiku):**
| Metric | Haiku (v0.14.2) | Opus (v0.14.3) |
|--------|-----------------|----------------|
| Time | 200s (3.3 min) | ~600s (10 min) |
| Lines | 469 | 251 (denser) |
| Size | — | 17KB |
| Phases | 5 | 8 + parallelism graph |
| Real file paths | Yes | Yes (verified by reading) |
| Risk matrix | 3 risks | 7 risks with mitigations |
| Acceptance criteria | 12 items | 9 items |
| Worker assignment | Generic | Named roles (worker-types, worker-core, worker-cli, worker-verifier) |

**Dream auto-trigger confirmed:**
- Warden: dream #1 completed at 12:25:14 (idle trigger, clean)
- Herald: dream #1 completed at 12:25:22 (idle trigger, clean)
- CEO: dream triggered at 12:26:22 (hit API rate limit from ultraplan)
- Janitor: force dream worked, detected new signal (Herald's plan)

**Pulse heartbeat cycle captured (12:33):**
```
CEO       — miss (rate limit, miss #4)
Failsafe  — (idle) responded OK     +6s
Janitor   — (idle) responded OK     +6s
Warden    — (idle) responded OK     +6s
Herald    — (idle) responded OK     +7s
Planner   — (idle) responded OK     +10s
Researcher— (idle) responded OK     +6s
Results: 6 responded, 1 missed
```

---

## v0.16.0 — Foundation Upgrade (MERGED)

- ✅ 4 new fragments: tool-result-management, context-persistence, scratchpad, checkpoint
- ✅ Anti-rationalization v2 (3 new patterns from Claude Code)
- ✅ Context injection: platform, shell, timezone, locale, continuity hints
- ✅ Observation logs: daily append-only journals (agents/<name>/observations/YYYY/MM/)
- ✅ Cron hardening: jitter, durable/ephemeral, auto-expiry, scheduler lock, missed detection v2
- ✅ Dispatch resilience: error categorization, exponential backoff, context blocking, health scores

## v0.16.1 — Autoemon Core (MERGED)

- ✅ AutoemonManager: tick engine with adaptive intervals (30s→5m based on agent behavior)
- ✅ 5 tick message types with context enrichment (<tick>, <presence>, <mood>, <focus>)
- ✅ Autoemon fragment: 136-line prompt teaching autonomous work (from Claude Code proactive prompt)
- ✅ Conscription cascade: CEO → leaders on contracts → workers with tasks
- ✅ Sleep handling: SLEEP command parsing, interruption on user DM / urgent task / manual wake
- ✅ Sleeping DM banner: animated ASCII night sky with stars, moon, clouds
- ✅ Founder presence tracking: watching/idle/away from TUI WebSocket + interaction time
- ✅ Telemetry: autoemon-telemetry.jsonl with per-tick records

## v0.16.2 — SLUMBER Mode (MERGED)

- ✅ /slumber [duration|profile], /afk — CEO acknowledges then ticks start
- ✅ /wake — CEO summarizes what happened (digest is CEO's own words)
- ✅ /brief — mid-SLUMBER check-in without ending session
- ✅ Duration timer with auto-stop + CEO wrap-up
- ✅ Moon phase status bar: 🌑→🌕 cycling with progress
- ✅ Founder presence injected into ticks (watching/idle/away)
- ✅ All dispatches on jack:<slug> session (full conversation memory)
- ✅ CEO on corp gateway (killed double dispatch + personal Claude leak)

## v0.16.3 — SLUMBER Premium (MERGED)

- ✅ 4 profiles: 🦉 Night Owl, 🎒 School Day, ⚡ Sprint, 🛡️ Guard Duty
- ✅ Profile mood + focus injected per tick (<mood>, <focus> XML tags)
- ✅ Conscription strategies: ceo-only / active-contracts / all-agents per profile
- ✅ Budget cap: max ticks before auto-stop (Sprint = 200 ticks)
- ✅ Message styling: ☾ muted indigo night theme for SLUMBER messages
- ✅ Analytics: productivity bar chart, tick breakdown, per-agent stats, top actions
- ✅ /slumber profiles, /slumber stats commands
- ✅ Profile validation for custom profiles

## v1.1.0 — Harness Abstraction (MERGED, PR #87)

**Motivation:** Anthropic banned OpenClaw subscription auth; Claude Corp needs to run on Claude Code's OAuth auth. First step: abstract the dispatch layer so per-agent harness selection becomes possible.

- ✅ `AgentHarness` interface — single contract (dispatch, healthCheck, teardown, cost) over any agent runtime
- ✅ `OpenClawHarness` wraps existing dispatch (backward-compat default, zero behavior change)
- ✅ `HarnessRegistry` — plugin-style registration keyed by harness name
- ✅ `MockHarness` — deterministic in-process harness for testing
- ✅ Daemon lifecycle integration: router @mention, heartbeat inbox, `/say` API all go through the harness
- ✅ Optional `harness` field added to `Member` + `Corporation` + `AgentSpec` types
- ✅ Parameterized AgentHarness contract test applied to both real + mock harnesses

## v1.1.3 — Per-Agent Harness Routing (MERGED, PR #88)

- ✅ `HarnessRouter` — delegates each dispatch to the agent's configured harness (fallback to default)
- ✅ `hireAgent` + `setupAgentWorkspace` persist resolved harness to `config.json` + Member record
- ✅ `/agents` API returns resolved harness per agent; `cc-cli agents` shows harness column
- ✅ `/harnesses` API lists registered harnesses + their health
- ✅ `cc-cli agent set-harness --agent <id> --harness <name>` — switch substrate on a live agent
- ✅ `cc-cli harness list` / `cc-cli harness health` — per-harness diagnostics
- ✅ `cc-cli inspect` shows resolved harness per agent

## v1.1.4 — Claude Code Harness (MERGED, PRs #89-93)

- ✅ `ClaudeCodeHarness` — AgentHarness over the `claude` CLI using OAuth subscription auth (not API key, since Anthropic banned OpenClaw subscription usage)
- ✅ Streams JSON events from `claude --print --verbose --output-format stream-json` into Claude Corp's unified event stream
- ✅ Per-dispatch + cumulative cost tracking
- ✅ Registered alongside `openclaw` harness at daemon startup
- ✅ 4 Windows spawn hotfixes:
  - Shell quoting + `cmd.exe` metacharacter handling via `quoteForWindowsCmd`
  - `claude` binary resolved to absolute path at init (PATH walk + PATHEXT honored), no shell mode
  - `--verbose` flag added (required by claude when combining `--print` with stream-json output)
  - `resolveWorkspace` handles absolute `agentDir` (matches api.ts convention)

## v1.2.0 — Claude Code Agent Onboarding (MERGED, PR #94)

**The unlock:** OpenClaw's workspace bootstrap loader auto-injects files only when the basename is in a hardcoded set (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md`). Claude Corp had been writing `RULES.md` + `ENVIRONMENT.md` — silently dropped. Fix: rename on disk so both OpenClaw auto-load + Claude Code `@import` converge on the same handles.

- ✅ Harness-aware templates: `defaultRules` + `defaultEnvironment` branch on harness, name substrate-specific tool vocab (`Read`/`Write`/`Edit`/`Bash` vs `read`/`exec`/`process`)
- ✅ OpenClaw-recognized basenames on disk: writes `AGENTS.md` + `TOOLS.md` (internal template names keep `rules`/`environment` for semantic clarity)
- ✅ `migrateAgentWorkspaceFilenames` — idempotent rename of legacy `RULES.md` / `ENVIRONMENT.md` on corp + project-scoped agents, runs at daemon startup; flags conflicts, doesn't clobber
- ✅ `CLAUDE.md` per Claude Code agent: SOUL embodiment preamble (verbatim OpenClaw phrasing so the agent embodies SOUL across substrates) + `@./` imports of always-on identity files + current state (STATUS/INBOX/TASKS) + read-on-demand footer for BRAIN/observations/WORKLOG
- ✅ `cc-cli hire --harness <claude-code|openclaw>` — picks substrate at agent creation
- ✅ 63 new tests across 5 files; full suite 472/472 passing

---

## Planned but NOT yet built

## v0.11.0 + v0.11.1 — Loops & Crons (MERGED)

- ✅ Loops — interval-based recurring commands (@every 5m, 30s, 2h)
- ✅ Crons — schedule-based jobs via croner (100% correctness): @daily, @hourly, 0 9 * * 1
- ✅ Both persist to clocks.json — survive daemon restarts via rehydration
- ✅ Both visible in /clock view with animated spinners + progress bars
- ✅ Channel-bound output — loop/cron output appears in the channel where created
- ✅ DM auto-assign — /loop in a DM auto-targets the agent
- ✅ Complete/Dismiss/Delete lifecycle (C/X/D keys in /clock, CLI + TUI commands)
- ✅ ScheduledClock type extends Clock with expression, command, targetAgent, maxRuns, channelId
- ✅ Schedule parser — @every 5m, @daily, raw cron, formatIntervalMs, formatCountdown
- ✅ cronstrue converts cron expressions to English ("At 9:00 AM, only on Monday")
- ✅ LoopManager + CronManager with watchdog timeouts, maxRuns auto-complete
- ✅ ClockManager.registerExternal() for cron observability bridge
- ✅ API: POST /loops, POST /crons, DELETE /clocks/:slug, POST complete/dismiss
- ✅ CLI: cc-cli loop create/list/complete/dismiss/delete, cc-cli cron create/list/complete/dismiss/delete
- ✅ TUI: /loop, /cron chat commands with DM auto-assign
- ✅ CEO auto-starts OpenClaw if remote gateway is dead

### Future — Escalation
- Severity-routed blockers: P0 → Founder, P1 → CEO, P2 → team leader
- `cc-cli escalate --severity P1 "description"`
- Tracked escalation beads routed through hierarchy

### Future — Scheduler
- Capacity governor: `cc-cli config set scheduler.max_agents 5`
- Caps concurrent dispatches to prevent API rate limit exhaustion
- Queues excess work, feeds when slot opens

### Future — Project Worktrees
- Per-project git isolation (not per-agent — that was wrong)
- Each agent working on a project gets `projects/<name>/wt/<agent-slug>`
- Janitor merges worktrees back to project main branch
- Git worktree methods already in shared/git.ts (createWorktree, mergeWorktree, etc.)

### ~~Future — Agent Dreams~~ SHIPPED v0.12.0
- ~~Warm-start idle behavior via heartbeat context pre-loading~~
- Shipped as 4-phase memory consolidation (Orient → Gather → Consolidate → Prune)

### ~~Future — Herald on Haiku 4.5~~ SHIPPED
- Herald runs on corp gateway (Haiku) by default. Per-agent model routing works.
- Opus agents (CEO, Planner) route to remote gateway. Haiku agents use corp gateway.

### Future — Proactive Mode (KAIROS-lite)
- Agents act without being prompted — monitor channels, detect patterns, take initiative
- Adapted from Claude Code's KAIROS system
- Next major feature after v0.14.3

### Future — Corp Buddy (Tamagotchi)
- Per-corp mascot that reflects corp health/mood
- Adapted from Claude Code's buddy system

### Future — Founder Away (AFK Mode)
- CEO autonomy while user sleeps — autonomous task execution, morning briefing
- Queue management, escalation deferral

### Future — Token Budgets
- Per-agent cost limits, usage tracking, budget alerts

---

## Architecture Notes

### Key Design Decisions (v0.10.x)
- **Jack is default** — all communication uses persistent OpenClaw sessions
- **Hand separates planning from action** — creating a task ≠ starting work
- **Contracts live inside Projects** — Projects are containers, Contracts are work units
- **Blueprints are documentation, not code** — CEO follows them as playbooks
- **Warden signs off** — nothing closes without quality review
- **Herald narrates** — NARRATION.md → STATUS.md + Corp Home banner
- **Clock unifies timers** — every setInterval is observable + pauseable
- **Casket is the agent's world** — 9+ files, daemon generates TASKS/INBOX/WORKLOG/STATUS
- **Inbox queues one task at a time** — priority sorted, blocked tasks held, persisted across restarts
- **Analytics track everything** — per-agent utilization, streaks, dispatch counts

### Naming Convention for Primitives
| Name | What | Verb |
|------|------|------|
| Casket | Sealed agent workspace | "Check your casket" |
| Dredge | Session recovery | "Dredge your last session" |
| Hand | Task assignment | "Hand it to @agent" |
| Jack | Live persistent session | "Jack into the CEO" |
| Clock | Timer/interval primitive | "Check the clocks" |
| Contract | Task bundle with goal | "Open a contract" |
| Blueprint | Workflow playbook | "Follow the blueprint" |
| Warden | Quality gate agent | "Warden reviews" |
| Herald | Narrator agent | "Herald says" |
