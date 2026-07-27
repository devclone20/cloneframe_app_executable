---
name: clone-frame-connect
description: Get the CLONE FRAME HUB app connected to the owner's machine, and diagnose it when it will not connect. Use whenever someone says the app is disconnected, stuck on WEB, cannot open a terminal, says "HUB Bridge not connected", cannot pair, lost their session, or wants to add/replace/disable an API key (BYOK). Keywords - connect, pair, pairing, bridge, disconnected, WEB mode, token, launch, start the app, BYOK, API key, model, keychain.
allowed-tools: Bash, Read, Grep
---

# Connecting the HUB to the machine

You are helping someone get CLONE FRAME HUB working on their own computer. Be calm and
concrete. They are usually one small thing away from working, and that thing is almost
always visible in a log or a health check — so **look before you advise**.

## The two pieces

- **HUB** — the window. One HTML file. Can draw, plan, chat. Cannot touch the machine.
- **HUB Bridge** — a Node daemon on `127.0.0.1:8765`. The app's hands: real shell, files,
  browser engine, chain reads.

They are joined by a **pairing token**. The Bridge hands it to the window; nothing else on
the machine can drive the app without it. Bottom-right of the app reads `APP` when paired
and `WEB` when not.

Canonical checkout: `~/Desktop/iFRAME/apps/clone-frame-hub`.
Owner's state and logs: `~/.clone-frame-hub/`.

## First: find out what is actually true

Never guess at this. Three commands settle almost every case.

```bash
curl -s http://127.0.0.1:8765/health          # Bridge alive?
tail -20 ~/.clone-frame-hub/launch.log        # what the launcher did last time
tail -30 ~/.clone-frame-hub/server.log        # what the daemon said
```

`{"ok":true,...}` means the Bridge is up. If it is up and the app still says WEB, the
problem is **pairing**, not the daemon — those are different problems with different fixes.

## Starting it

Preferred, and what you should suggest first:

```bash
zsh ~/Desktop/iFRAME/apps/clone-frame-hub/bridge/launch.sh
```

That one script starts the daemon if it is not already healthy, arms pairing, opens the
window, and checks the macOS permissions. It is also what the double-click app runs.

No app icon yet? Build it once — it is a one-time step, not something to repeat:

```bash
zsh ~/Desktop/iFRAME/apps/clone-frame-hub/bridge/make-app.sh
```

Daemon only, when they want to watch it:

```bash
node ~/Desktop/iFRAME/apps/clone-frame-hub/bridge/hub-bridge.mjs
```

## Why pairing sometimes does not happen — the part people get wrong

The Bridge injects the token into a served page **only** when three things are all true:

1. the pairing latch is armed (the launcher arms it; it is also armed for 120s after the
   daemon starts),
2. the latch has not already been spent by another window,
3. the request carries a **real human navigation** — `Sec-Fetch-User: ?1`, which a browser
   sets only for a navigation a person performed.

That third condition is deliberate, and it is the one that surprises people. A page opened
by a script, by automation, or fetched with curl will **never** be given the token, no
matter how many times it is retried. This is what stops other software on the machine from
silently taking control of the app.

So: **do not try to work around it.** The fix is always to relaunch through `launch.sh` or
the app icon, which arms the latch and opens a genuine window.

If a second window is needed while one is already running, `launch.sh` handles it — it
re-arms the latch by proving ownership with the 0600 token file.

## Symptom → cause

**"disconnected" right after a double-click.**
Node is missing or not on the GUI PATH. `node -v`. The launcher also reports this itself
in `launch.log` and shows a macOS alert.

**App says connected, but a terminal pane says "HUB Bridge not connected".**
A real bug, fixed 2026-07-27: live sockets used to read a one-shot injected global instead
of the stored token, so any reload more than two minutes after launch broke every terminal
while the rest of the app carried on. If someone still sees it they are on an old build:
`npm run build` in the checkout, then ⌘R in the window. Note the app now distinguishes
"session expired" from "not connected" — read which one it says.

**Everything worked, then a reload broke it.**
Relaunch through `launch.sh`. It re-arms pairing every time.

**macOS refuses screen capture or file access.**
Grant it in System Settings → Privacy & Security, then **relaunch**. macOS evaluates these
permissions when a process starts, so granting one while the Bridge runs changes nothing
until it restarts. This catches people out constantly — say it plainly.

**Port already in use.**

```bash
HUB_BRIDGE_PORT=8790 zsh ~/Desktop/iFRAME/apps/clone-frame-hub/bridge/launch.sh
```

**Daemon serving old code after an update.**
`/health` reports `"stale":true` when the files on disk are newer than the running process.
Restart the daemon; reloading the window is not enough.

## BYOK — connecting a model

There is no house AI. The owner brings a model and the key stays theirs.

MY MACHINE → BRAIN → paste the key. The app detects the provider from the key prefix, asks
that provider which models the key may call, and stores the list. **A key the provider
rejects is not stored** — the owner is told at that moment instead of discovering it later.
Then pick the model on that row.

Each key has an **ON/OFF** switch. OFF parks it: the key is kept, nothing routes to it, one
click restores it. Pasting a new key for a provider that already has one replaces it.

Where keys live: macOS Keychain when the Bridge is running; otherwise this browser session
only. Never in the HTML, never in a log. A file-based alternative is `ANTHROPIC_API_KEY` or
`DEEPSEEK_API_KEY` in `~/.env.local`, read by the Bridge at startup.

If a model answers with an error, **read the error to the owner as written** — it carries
the provider's own words (billing, quota, invalid key). Do not paraphrase it into something
vaguer, and never suggest the app is at fault before checking it.

## Rules for you

- **Never print, echo, copy or log the pairing token or an API key.** Reading a file to
  check that it exists is fine; showing its contents is not.
- Never suggest exposing the Bridge beyond `127.0.0.1`. It binds to loopback on purpose.
- Never propose defeating the navigation check to force pairing.
- Prefer the launcher over hand-rolled commands: it does the permission probes and the
  latch arming that a bare `node hub-bridge.mjs` does not.
- When you fix something, say what was wrong, not just what to type.

Full owner-facing guide: `~/Desktop/iFRAME/apps/clone-frame-hub/CONNECT.md`.
