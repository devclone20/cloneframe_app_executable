# Changelog

What changed, and what it cost you before it changed. Written for someone deciding
whether to update, not for someone reading a diff.

Full detail lives in `git log` — every commit here says what a user would have hit.

## 0.3.1 — 2026-07-31

An eight-lens audit read the whole tree, a second reader tried to refute every finding,
and 34 survived. Nine are fixed here. The rest are in [KNOWN-ISSUES.md](KNOWN-ISSUES.md)
with a file and a line each, including the one that changes a documented promise.

**Anyone could have done this to your daemon**

- One unauthenticated `curl 'http://127.0.0.1:8765/%'` ended the bridge — and with it
  every live terminal session, the task scheduler and the agent. The static route runs
  before the pairing gate on purpose (the HTML is not secret) and its first statement
  threw on a malformed percent-escape. Fixed at the source, and the router now catches,
  because a throw in routing must cost one request rather than the process.
- A file **name** was a command. FOLDERS' Reveal and the file viewer shared by FOLDERS,
  iT and SETTINGS wrapped paths in double quotes, inside which `$(…)`, backticks and
  `$VAR` all still expand. The correct quoter already existed four times over in the
  tree; there is now one, in the kernel, and a test runs thirteen payloads through a
  real `zsh`.
- `servers.run` — the primitive the agent reaches for remote work — had no
  catastrophic-command guard, while its sibling `ssh.run` has had one since it was
  written. Both now share `platform/shell-guard.mjs`.

**Things that said they worked**

- **"Send email without asking", off, did not stop the agent.** `Permissions.can('email')`
  had no call site in the entire daemon; the only check lived in the browser's tool loop,
  which `pi` does not go through. The three calls that put mail on the wire —
  `email.send`, `scheduled.schedule`, `approvals.approve` — now need the switch when the
  caller marks itself as the agent. Your own Send button is untouched.
- **The same email could leave twice.** Approving was a read-modify-write wrapped around
  a 1–3 second SMTP send, so two approvals both passed the pending check and both sent,
  and any other write during the send was overwritten. The item is now claimed on disk
  before the socket opens, and the outcome is applied to a fresh read. The three send
  buttons that said `sending…` without disabling anything now disable.
- **CODE threw away the model you picked**, and saved the loss. The list was emptied and
  refilled across two awaits, so anything repainting in that window found your model
  "missing" and cleared it. The list is now published in one step.
- **MATRIX rendered every finished answer as raw text** — it asked for `window.MDLite`,
  which is never set.
- **SETTINGS' search never returned a cross-module hit** — it read `g.items`; the daemon
  returns `g.results`.
- **`web_click{x,y}` and `web_type` always failed** with "no such tab". They route through
  the one function that still demanded an explicit tab id while all its siblings default
  to the on-screen one.

**The dock**

- Panning a full rail once made **the entire app unclickable** until reload: the pan's
  window-level `pointerup` went on with `{capture:true}` and came off without it, so every
  pan left another permanent capturing handler calling `stopPropagation`. Both listeners
  now hang off one `AbortController`.

**One version**

- The CODE banner printed `v0.5`. Both lockfiles and `make-app.sh` carried older numbers
  still. There is one carrier now — the `@@CF_VERSION@@` build token — and a test that
  fails if a literal version appears anywhere a user can read it.

**Documentation**

- The published architecture described the in-app browser as a sandboxed iframe behind an
  SSRF-guarded `/proxy`. That was demolished and rebuilt as a separate Chrome process
  driven over a debugging pipe, and `/proxy` no longer exists. README, SECURITY,
  ARCHITECTURE, HOW-IT-WORKS, CONNECT and two diagrams now describe what ships.
- Four places advertised **27 panels**. There are 20, and the frame-grid diagram named
  seven that do not exist. Redrawn.
- The README claimed a fresh clone runs `dist/`, which the public repository does not
  ship, and called the bridge's dependencies "3 optional email deps" when there are five,
  two of which power the live terminal.

## 0.3.0 — 2026-07-30

The DEBUG3 run: twenty fixes, and the version finally tells the truth. See the release
notes on the tag.

Earlier history predates this file; `git log` has it.
