# Known issues

Ours first, before anyone else finds them.

This is the list we would want if we were the ones downloading it. It is not a
backlog and it is not marketing — everything here is either measured or a decision
we made on purpose and would defend. If you hit something that is **not** here,
that is a real bug and we want the issue.

Last reviewed 2026-07-31, against `0.3.1`.

---

## What 0.3.1 fixed, and how it was found

An eight-lens read-only audit swept the whole tree, every finding was handed to a
second reader whose only job was to **refute** it, and 34 survived. Nine are fixed here;
the rest are in this document, below, with file and line. Two are worth naming because
anyone could reach them:

- **One unauthenticated `curl 'http://127.0.0.1:8765/%'` ended the daemon.** The static
  route runs before the pairing gate (the HTML is not secret) and began with
  `decodeURIComponent`, which throws on a malformed escape. Every live terminal session,
  the scheduler and the agent went with it. Fixed at the source *and* by wrapping the
  router, because the lesson is that a throw in routing must cost one request.
- **A file NAME was a command.** FOLDERS' Reveal, and the file viewer shared by FOLDERS,
  iT and SETTINGS, wrapped paths in double quotes — inside which `$(…)`, backticks and
  `$VAR` all still expand. The correct quoter already existed in the tree, four times
  over, and the wrong one had the reach. There is now one, in the kernel.

The rest: the CODE banner said `v0.5`; the "Send email without asking" switch was not
enforced on the path the agent actually uses; approving an email twice sent it twice;
CODE silently discarded the model you picked; panning a full dock made the whole app
unclickable; MATRIX rendered every answer as raw text; SETTINGS' search never returned a
cross-module hit; `web_click{x,y}` and `web_type` always failed.

## Coverage — what has and has not been exercised by hand

The automated suite is strong and the hands-on suite is not finished. Both numbers
are real:

```
automated     890 tests, green, on every build, with a reproducible single-file artifact
hands-on      41 of 151 numbered tests run · 0 of 7 end-to-end user journeys walked
```

The thinnest areas, named so you know where to be suspicious:

| Area | State |
|---|---|
| Attachments — paste, drag-drop, the 5-image cap, folder intake | **no hands-on evidence on disk** |
| The 7 user journeys (first run → first answer → first automation) | **not walked end to end** |
| iT terminal | 1 test of its suite |
| Guardrails · email · security | 3 tests of its suite, though the invariants themselves are covered by automated tests |

The panel sweep *is* done: all 20 panels have a live pass against a paired bridge —
primary flow, empty state, error state, reload, dock — and every defect found has a
fix and a regression test.

## Install and platform

- **macOS is the primary platform.** Linux runs through the Docker path
  (`docker compose up --build`). Windows is untested; we would rather say that than
  imply support we have not exercised.
- **The double-click-the-`.app` path on a machine that has never paired is verified
  by a human, not by automation.** The bridge deliberately requires a real,
  user-initiated browser navigation to hand over the pairing token — which is
  exactly the thing a test harness cannot fake, and exactly why it is safe. If the
  window does not reach **APP** on a fresh machine, tell us; that is the one path
  where we most need reports from other people's hardware.
- A fresh clone runs with no build tools: the committed `index.html` at the repository
  root **is** the built artifact, byte-for-byte what `npm run build` writes to
  `dist/index.html`. You only need `npm install` (in `bridge/`, plus the repo root for
  `esbuild`) if you intend to **build** rather than run.
- `npm install` in `bridge/` pulls **five** small add-ons, not three: `ws` and `node-pty`
  for the live terminal, and `imapflow`/`mailparser`/`nodemailer` for email. Every one is
  behind a guarded import — the daemon boots without any of them and reports the feature
  as unavailable. `node-pty` is native, so it is almost always the one that complains.

## Design decisions people mistake for bugs

- **The permission toggles are not a sandbox.** `ssh`, `matrix` and `root` are enforced
  in the daemon, and — new in 0.3.1 — so are the three calls that put mail on the wire
  for an agent caller (`email.send`, `scheduled.schedule`, `approvals.approve`). The rest
  are enforced in the agent's tool loop. `bridge/rpcallow.mjs` says why in its own header:
  whoever holds the pairing token already has a real shell as you, so there is no boundary
  at that layer to lose. Email is the exception because the app makes a stronger, unqualified
  promise about it on screen, and because mail is irreversible and reaches other people.
- **The catastrophic-command blocklist is not a sandbox either.** `rm -rf /`, `mkfs`
  and `dd`-to-a-disk are refused on every path, always, even with root mode on — local
  shell, PTY, and (since 0.3.1) both remote paths — but a blocklist stops accidents,
  not a determined attacker who already has your shell.
- **AGENTVIEW opens only when you own something to look at.** Its deck route needs a
  wallet connected and an iNFT pinned. It is always reachable from the command
  palette (⌘K → `agent` / `inft`), and its empty state says what to do.
- **The in-app browser keeps nothing, and never runs inside the app.** The page lives in
  a separate Chrome process on its own profile, driven over a debugging pipe; the panel
  paints its video frames onto a canvas. The profile is wiped when the engine starts
  *and* when it stops, and a docked browser square does not write the page address to
  disk. If you wanted history, that is not a bug — it is the promise.
- **No built-in assistant.** Every chat routes to a model *you* connect. There is no
  key of ours anywhere in the app, and there never will be.

## Accepted residual risks

These are in `SECURITY.md` with their full reasoning; repeated here so nobody has to
go looking.

- **SSRF DNS TOCTOU.** The outbound guard resolves a hostname to check it and the
  fetch resolves again. A TTL-0 rebinding attacker could in theory pass the check.
  Redirect-hop re-validation narrows it; it does not close it.
- **The DigitalOcean token is at rest in plaintext**, in
  `~/.clone-frame-hub/servers.json`, protected by file permissions (0600 in a 0700
  dir) rather than the Keychain. Masked on read-back, never returned to the client.
- **No `script-src` / `connect-src` in the CSP.** The app is one large inline script
  calling external APIs directly, so neither can be set correctly without measuring
  every call site first — and a CSP that silently breaks a panel is worse than an
  honest gap.
- **Terminal sessions started by an older build keep working unauthenticated until
  they end.** New sessions carry a per-session secret; we did not want to kill
  someone's running work to close a gap that closes itself.

---

## Open, confirmed, and not yet fixed

Every item below was found by the 0.3.1 audit, survived a second reader trying to refute
it, and is written here with a file and line rather than a promise. Ordered by what it
costs you.

### The one that changes a documented promise

**HARNESS gates do not apply to the default `pi` path.** `web/panels/terminal.js:1395`.
There are two implementations of "run one CODE turn". `agentRun` enforces the harness —
`run_shell`, `write_file`, `send_email` and `server_*` raise an inline APPROVE/REJECT card
before they run, which is the behaviour the README describes as "the agent proposes, the
gate holds, you decide". `piRun` does none of it: it streams pi's own agentic loop, and
pi's tools do not pass through the gate. If you have `pi` installed and selected, the crew
you built is not standing between you and the tool call.

This is not a one-line fix — it means intercepting pi's tool stream mid-turn and blocking
on a decision, which is a feature with a design, not a patch. It is named first because it
is the largest gap between what the app says and what it does. Until it lands: the harness
is real on the BYOK model paths and absent on the `pi` path.

### Silent no-ops — the control works, the effect does not

| What you do | What happens | Where |
|---|---|---|
| MY AGENTS → **USE IN CODE** | Toast says "active in CODE"; CODE is unchanged. It writes `activeAgent` (LAB's key); CODE reads `pinnedAgents`. Pin it in LAB instead. | `web/panels/agents.js:187` |
| FOLDERS → **Open in iT**, with iT already open | Nothing happens, and the pending directory poisons the *next* iT you open. | `web/panels/folders.js:43` |
| SETTINGS → **Capabilities** switches | Written by two places, read by none; opening a panel silently re-enables its capability. | `web/index.html:5236` |
| SETTINGS → a granular permission, under **Full machine control** | The row renders the *effective* value and the click writes the *raw* one, so turning one off under the master switch reports success and changes nothing. | `web/panels/settings.js:413` |
| Agent tool `close_panel` with an alias (`browser`, `it`, `my machine`) | `open_panel` and `read_panel` resolve aliases; their twin does not. | `web/panels/terminal.js:1071` |
| APPROVAL → **save edit** / **reject** | Reports success without reading the `{ok:false}` the daemon returns; `act()` exists for exactly this and is used one line above. | `web/panels/approval.js:13` |
| Shortcuts overlay → `g a` "go to Agent" | Opens CODE. The two working bindings, `g n` and `g u`, are undocumented. | `web/index.html:2819` |
| Docking **AGENT VIEW** | Blank square. `Grid.iconFor` has a fallback; the function that paints the square indexes the map directly. | `web/index.html:3784` |

### State that outlives what created it

- **iT does not restore its layout if you reopen it within ~9 seconds** of the previous
  window closing. The cross-window ownership lease is never released on dispose and the
  heartbeat keeps writing for up to 3s after, so the new window demotes itself to
  live-only. Wait longer and it restores. `web/panels/shell.js:14`
- **Docking CODE mid-answer orphans the turn.** The reply lands in a closure whose window
  is gone, and that stale writer can overwrite the session store. If you leave it docked
  until the turn finishes, the answer is there when you reopen. `web/panels/terminal.js:1578`
- **Panel keys are recycled**, so a frame square left behind by a closed window can adopt —
  and its ✕ can close — an unrelated new window of the same type. `web/index.html:5241`
  Same root as the dock's "a chip exists for a square, not for a window".

### Docs that describe something that is no longer there

- `bridge/README.md`'s endpoint table lists `GET /proxy`, `GET /email/accounts` and
  `POST /email/<op>`. All three were removed — `/proxy` with the browser rewrite,
  `/email/*` in T-033 when email moved onto the generic `/mod` router.
- `bridge/SEARCH.md` documents `Search.modules()` returning seven module keys. The code
  has four, and three of the documented ones (`library`, `contacts`, `cookbook`) do not
  exist as modules at all. Nothing user-facing reads it; a contributor would.
- `bridge/README.md` documents one default model (`HUB_BRIDGE_MODEL`). There are two
  hardcoded defaults for the same "auto" idea — `bridge/domains/chat/chat.mjs:28` backs
  the CODE console, `bridge/llm.mjs:116` backs everything else.

### Docker

- **`~/CloneFrame` does not persist in the named volume.** `docker-compose.yml` mounts
  `cfhub-data:/root/CloneFrame`, but the Dockerfile runs as `USER node`, so `homedir()`
  resolves to `/home/node` and the tree is written there instead. `bridge/folders.mjs` is
  the only store in the daemon that resolves its root from `homedir()` rather than the
  shared `hubRoot()` seam; every other store persists correctly.

### Smaller, still real

- **The app_rpc allowlist exempts the `rpcallow` module**, so an agent constrained by the
  list can call `rpcallow.set` and widen it. `bridge/hub-bridge.mjs:251`. The module's own
  header already notes that a token-holder can bypass the list by omitting the header, so
  nothing is *gained* — but a policy an agent can edit is not a policy.
- **`files.write` is not gated in the daemon**, despite `bridge/files.mjs`'s own header
  saying the permission decides it and the pi extension repeating that claim to the model.
  This is the disclosed design (see *the toggles are not a sandbox*), but those two places
  say otherwise and should be corrected, or the gate added.
- **`Web.fetchRaw` is reachable over RPC and has no caller.** It was the server-side reader
  for the old browser proxy; the proxy went, it did not. It is SSRF-guarded, so it is
  surface without a purpose rather than a hole.

## Rough edges we know about

- **The RPC surface is not shape-consistent.** `notes.list`, `tasks.list`,
  `reminders.list` and `harness.list` return bare arrays; `brain.list` returns
  `{ok, memories, …}`. Nothing lies about it — the tool contract promises "the
  module fn's JSON result" and no more — but it is friction, and changing it now
  would touch roughly forty call sites for a cosmetic win. Written down instead.
- **MATRIX local models are memory-hungry.** Loading a large local weight on a
  machine without the RAM for it can take the whole machine down. Check the model
  size against your free memory before you press load; the panel shows both.

## How we triage

- **Blocker** — you cannot run the app, or something destroys data: within a day.
- **Major** — a panel or a documented promise does not work: within a week.
- **Everything else** — into the next wave.

A wave ships when its items are done, not when the queue is empty.
