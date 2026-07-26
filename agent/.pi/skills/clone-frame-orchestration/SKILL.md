---
name: clone-frame-orchestration
description: Set up a multi-pane iT terminal inside CLONE FRAME and run or coordinate several jobs or agents side by side. Use when the owner asks to "open panes and orchestrate", run things in parallel in the terminal, drive the iT multiplexer, or coordinate multiple agents in the app.
---

# Orchestrating in CLONE FRAME's iT terminal

CLONE FRAME's **iT** panel is a real terminal multiplexer (workspaces ▸ split panes ▸ tabs,
a live shell per pane). You drive it with the `it` CLI, which is already on your `bash` PATH.
This skill is the reliable recipe for standing up panes and running work across them.

## Preconditions (do these first)

1. **Open iT** so the CLI has a window to talk to:
   `open_panel{panel:"shell"}`
2. Confirm it is live: `bash: it ping` (should answer). If `it: command not found`, iT is not
   open yet — open it and retry. If `iT is not open`, call `open_panel{panel:"shell"}` again.

## Create the panes

Splits apply to the focused pane. To get **four** panes (a 2×2):

```bash
it new-split right      # pane 2 (right of pane 1)
it focus-pane 1
it new-split down       # pane 3 (below pane 1)
it focus-pane 2
it new-split down        # pane 4 (below pane 2)
it list-panes           # confirm: you should see 4
```

Prefer fewer, deliberate splits over many — check `it list-panes` after each.

## Run work in each pane

- Target a pane and type into it: `it send "npm run dev" --pane pane:1` then `it send-key enter`.
- Or run-and-capture without leaving a live shell busy: `it run "git status" > /tmp/o.txt`.
- Read what a pane shows (your eyes on another agent's shell):
  `it read-screen --pane pane:2 --lines 40`.
- Long jobs auto-notify; you can also `it set-status build running` / `it set-progress 0.5`.

## Coordinate several agents

To run other coding agents (including another `pi`) side by side, `it send` their launch
command into each pane, then poll each with `it read-screen` and relay/steer. Use
`it set-status <pane> <state>` as a lightweight signal board between them.

## Verify for the owner

Finish with `read_screen{}` (app-level) and a one-line summary of what is now on screen and
running. Never claim a pane is running without an `it read-screen` that shows it.
