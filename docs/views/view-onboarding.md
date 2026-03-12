---
title: Onboarding View
type: view
status: draft
framework: Ink (React for CLI)
usage: first-run only, transitions to channel view
related:
  - "[[flow-onboarding]]"
  - "[[view-channel]]"
  - "[[view-corp-home]]"
---

# Onboarding View

A minimal TUI wizard that appears exactly once — the first time the user runs `agentcorp` with no existing corporation. The goal is to get from zero to a DM conversation with the CEO in under 10 seconds. One meaningful input, one wait, then straight into the product.

## Sequence

### Step 1 — Name Your Corporation

```
+--------------------------------------------------+
|                                                    |
|                                                    |
|                                                    |
|           Name your corporation                    |
|                                                    |
|           > _                                      |
|                                                    |
|           This is your company. You are            |
|           the founder. Your AI CEO will            |
|           handle the rest.                         |
|                                                    |
|                                                    |
|                                                    |
+--------------------------------------------------+
```

A centered text input. No dropdown, no selection, no options. Just a name. The prompt text is plain and direct. The subtext sets expectations: you own this, the CEO runs it.

Input validation:
- Non-empty
- Valid directory name (no slashes, special characters)
- Not already taken (no existing directory at `~/.agentcorp/<name>/`)

On error, a red hint appears below the input (e.g., "A corporation with that name already exists"). The input field stays focused.

Press Enter to proceed.

### Step 2 — CEO Spawning

```
+--------------------------------------------------+
|                                                    |
|                                                    |
|                                                    |
|           Setting up Meridian Corp...              |
|                                                    |
|           Founding your CEO  ...                   |
|                                                    |
|                                                    |
|                                                    |
|                                                    |
+--------------------------------------------------+
```

A spinning indicator (or animated dots) while the daemon:
1. Creates the corporation directory structure
2. Initializes git
3. Writes CEO agent files (SOUL.md, config.json, HEARTBEAT.md)
4. Starts the OpenClaw process
5. Waits for the health check to pass

This should take 2-5 seconds. The user sees the corp name they chose and a brief status line. No progress bar, no percentage, no verbose logging. Just a clear indication that something is happening.

If the spawn fails (port conflict, OpenClaw not installed, etc.), the view shows an error message with the path to the log file and exits cleanly.

### Step 3 — Transition to DM

Once the CEO process is healthy, the onboarding view dissolves and the TUI transitions directly to the [[view-channel]] showing the DM with the CEO. The CEO sends its first message immediately — no waiting, no "welcome" splash screen.

The transition is seamless. The onboarding view unmounts and the channel view mounts in its place. The user's cursor is already in the input bar, ready to type.

## Ink Component Structure

```
<App>
  {step === 'name' && <NameInput onSubmit={setCorpName} />}
  {step === 'spawning' && <SpawnIndicator corpName={corpName} />}
  {step === 'ready' && <ChannelView channel={ceoDmChannel} />}
</App>
```

Three components, hard-switched by step. No animations between steps — the terminal does not benefit from slide transitions. Instant swap.

### NameInput

- Ink `<TextInput>` component, centered in the viewport
- `onSubmit` validates and proceeds
- Focus is auto-set on mount

### SpawnIndicator

- Ink `<Spinner>` from `ink-spinner` with the corp name displayed
- Polls daemon status or listens for a signal file

### ChannelView

- The full [[view-channel]] component, initialized with the CEO DM channel path
- Same component used everywhere else — no special onboarding variant

## Design Principles

- **One input**: The user makes exactly one decision (the corp name). Everything else is the CEO's job.
- **Fast**: Target is under 10 seconds from command to conversation.
- **No jargon**: "corporation" and "CEO" are the only domain terms. No mention of agents, processes, daemons, or configs.
- **No return**: This view never appears again after the first run. Subsequent `agentcorp` launches go directly to the [[view-corp-home]] or the last-open channel.
