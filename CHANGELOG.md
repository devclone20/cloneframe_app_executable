# Changelog

What changed, and what it cost you before it changed. Written for someone deciding
whether to update, not for someone reading a diff.

Full detail lives in `git log` — every commit here says what a user would have hit.

## 0.3.2 — 2026-07-31

Closes the twenty-five findings 0.3.1 wrote down and did not fix. Nothing from the audit is
still open; what remains in [KNOWN-ISSUES.md](KNOWN-ISSUES.md) is one boundary and the
accepted residual risks, both spelled out rather than listed.

**Eight controls that reported success and changed nothing**

MY AGENTS' **USE IN CODE** wrote LAB's selection key while naming CODE. FOLDERS' **Open in
iT** did nothing when iT was already open — and left the directory set, so it landed in the
*next* iT you opened. APPROVAL's **reject** and **save edit** reported success on a refusal,
in Portuguese. `close_panel` did not resolve the aliases its two twins resolve. A docked
AGENT VIEW painted a blank square. The shortcuts overlay advertised `g a` "go to Agent",
which opens CODE, and hid `g n` and `g u`, which work. A granular permission under Full
machine control wrote `false` over `false` and flipped back on the next render. And four
CAPABILITIES switches sat under a heading that implied a gate they never had.

**Three pieces of state that outlived their window**

iT's cross-window ownership lease was never released, so reopening within nine seconds
restored no workspaces — a reload read as losing your layout. A closed window's frame square
kept its handle and adopted the next window of the same type, whose ✕ then closed it. And
docking CODE mid-answer let the orphaned closure overwrite whatever the reopened window had
written since; the store now has one owner, the newest mount, and the orphan still finishes
its write if nobody replaced it.

**Two answers to one question**

`chat.mjs` and `llm.mjs` each declared "the concrete model for a bare env `ANTHROPIC_API_KEY`"
— same sentence, same env override, different models. The `app_rpc` allowlist exempted the
`rpcallow` module, so the agent it constrains could widen it; reads pass now, writes do not.

**Gates that were claimed and not enforced**

`files.write`, `writeB64`, `mkdir`, `remove`, `move` and `copy` need the **Write files**
switch from an agent caller. `bridge/files.mjs`'s own header and the description handed to
the model both said this was already true. Reads stay open.

**HARNESS and `pi`**

0.3.1 called this "the one that changes a documented promise". It turns out to be a boundary
rather than an omission: pi's own tools run inside pi's process and never cross the bridge, so
no crew can stand in front of them. What pi does to the *app* now passes a daemon gate in
every case. The fix was to stop the interface implying otherwise — with a session on `pi` the
crew chip reads "· off for pi", and both it and the picker say why.

**Docker, and two bridge docs**

The `cfhub-data` volume was mounted at `/root/CloneFrame` while the image runs as `USER node`,
so it was real, empty and never written to. `bridge/README.md` listed three deleted routes and
`bridge/SEARCH.md` published a seven-module contract for an aggregator with four.
`Web.fetchRaw` — the reader for the removed browser proxy, with no caller anywhere — is off
the RPC surface.

  911 tests pass.

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
