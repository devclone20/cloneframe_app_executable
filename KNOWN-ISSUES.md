# Known issues

Ours first, before anyone else finds them.

This is the list we would want if we were the ones downloading it. It is not a
backlog and it is not marketing — everything here is either measured or a decision
we made on purpose and would defend. If you hit something that is **not** here,
that is a real bug and we want the issue.

Last reviewed 2026-07-31, against `0.3.3`.

---

## What 0.3.1 and 0.3.2 fixed, and how it was found

An eight-lens read-only audit swept the whole tree, every finding was handed to a second
reader whose only job was to **refute** it, and 34 survived. 0.3.1 fixed nine and wrote the
other twenty-five down here with a file and a line each; **0.3.2 closed the rest.** Two are
worth naming because anyone could reach them:

- **One unauthenticated `curl 'http://127.0.0.1:8765/%'` ended the daemon.** The static
  route runs before the pairing gate (the HTML is not secret) and began with
  `decodeURIComponent`, which throws on a malformed escape. Every live terminal session,
  the scheduler and the agent went with it. Fixed at the source *and* by wrapping the
  router, because the lesson is that a throw in routing must cost one request.
- **A file NAME was a command.** FOLDERS' Reveal, and the file viewer shared by FOLDERS,
  iT and SETTINGS, wrapped paths in double quotes — inside which `$(…)`, backticks and
  `$VAR` all still expand. The correct quoter already existed in the tree, four times
  over, and the wrong one had the reach. There is now one, in the kernel.

The rest of 0.3.1: the CODE banner said `v0.5`; the "Send email without asking" switch was
not enforced on the path the agent actually uses; approving an email twice sent it twice;
CODE silently discarded the model you picked; panning a full dock made the whole app
unclickable; MATRIX rendered every answer as raw text; SETTINGS' search never returned a
cross-module hit; `web_click{x,y}` and `web_type` always failed.

0.3.2 then took the remaining twenty-five: eight controls that reported success and changed
nothing (USE IN CODE, Open in iT, the APPROVAL buttons, `close_panel` aliases, a blank docked
square, two wrong lines in the shortcuts overlay, a permission switch that wrote what it had
already written, and four capability switches that gated nothing); three pieces of state that
outlived their window (iT's ownership lease, a frame square adopting the next window, a docked
CODE turn overwriting the live one); two answers to one question (two default models, and an
allowlist the agent could rewrite); a Docker volume mounted where the app does not write;
`files.write` ungated while two places said it was gated; two bridge docs describing routes and
modules that no longer exist; and one RPC-reachable function nothing had called in months.

## Coverage — what has and has not been exercised by hand

The automated suite is strong and the hands-on suite is not finished. Both numbers
are real:

```
automated     912 tests, green, on every build, with a reproducible single-file artifact
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
- **This repository publishes the app, not the source that builds it.** As of
  2026-08-01 the panel sources, build tooling and test suite are no longer here: what
  is published is the built `index.html`, the daemon (`bridge/`, which *is* its own
  source), the runtime assets and the installer. So you cannot rebuild the interface
  from this clone, and there is no `npm run build` or `npm test` to run. What you can
  do instead is `shasum -a 256 index.html` and compare it with the release notes.
  Stated here rather than left for you to discover.
- `npm install` in `bridge/` pulls **five** small add-ons, not three: `ws` and `node-pty`
  for the live terminal, and `imapflow`/`mailparser`/`nodemailer` for email. Every one is
  behind a guarded import — the daemon boots without any of them and reports the feature
  as unavailable. `node-pty` is native, so it is almost always the one that complains.

## Design decisions people mistake for bugs

- **The permission toggles are not a sandbox — but the outward-facing ones are now real.**
  Enforced in the daemon for a caller that marks itself as the agent: `ssh`, `matrix`, `root`,
  the three calls that put mail on the wire (`email.send`, `scheduled.schedule`,
  `approvals.approve`), and the six that write to your disk (`files.write`/`writeB64`/`mkdir`/
  `remove`/`move`/`copy`). `rpcallow.set` and `reset` are refused outright — the allowlist is
  yours, not the agent's. Everything else is still enforced in the agent's tool loop, and
  `bridge/rpcallow.mjs` says why in its own header: whoever holds the pairing token already has
  a real shell as you, so there is no boundary at that layer to lose. The exceptions above are
  the acts that are irreversible, reach other people, or that the app promises about on screen.
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

## Where the boundaries are

Nothing from the audit is still open. What follows is the one place where the shape of the
system — not an omission — limits what a control can promise, and it is written out in full
because knowing that is worth more than a shorter document.

### The HARNESS gates and `pi` — what they can and cannot cover

`agentRun` drives the tool loop for the models you connect: it holds the gated-tool list,
reads the crew's gates, and puts an APPROVE/REJECT card in the chat before `run_shell`,
`write_file`, `send_email` or `server_*`. That is the behaviour the README describes, and it
is real on those paths.

`piRun` does not use that loop. It streams **pi's own** agentic loop, and pi's own tools — its
bash, its editor — run inside pi's process and never cross the bridge. There is no seam
between pi and its shell for CLONE FRAME to stand in. This was listed here as an unfixed
defect; it is better described as a boundary: a crew cannot gate a tool the app never sees.

What pi does **to the app** does cross the bridge, and as of 0.3.2 every one of those calls
passes a gate in the daemon:

| pi calls | needs |
|---|---|
| `email.send` · `scheduled.schedule` · `approvals.approve` | the **Send email without asking** switch |
| `files.write` · `writeB64` · `mkdir` · `remove` · `move` · `copy` | the **Write files** switch |
| `servers.*` · `ssh.*` | the **Remote servers (SSH)** switch |
| MATRIX engine start/stop | the **MATRIX engine control** switch |
| `rpcallow.set` / `reset` | refused outright — the policy is yours, not the agent's |
| any command reaching a shell | the catastrophic-pattern blocklist, on every path |

So the fix was not a gate that cannot exist. It was to stop the interface implying one: with a
session on `pi`, the crew chip now reads **"· off for pi"** and both it and the crew picker say
why. If you want an approval card in front of every tool call, choose a connected model rather
than `pi` — that is the path the gates govern.

**Still open, and it is a feature rather than a fix:** routing pi's own tool calls back through
the bridge so a crew could gate them. That means pi asking the daemon for permission mid-turn,
which is a change to how pi runs, not a patch to this app.

### Everything else the audit confirmed — all closed in 0.3.2

Kept here as a record rather than deleted, because "we found this and fixed it" is more
useful to a reader than a shorter list. Each has a regression test that was watched failing
against the old code first.

| Was | Now |
|---|---|
| MY AGENTS **USE IN CODE** wrote LAB's key; CODE binds another | writes both, in LAB's shape, and the toast says "pinned" |
| FOLDERS **Open in iT** did nothing with iT already open, and poisoned the next one | takes the live path `open_terminal` already used |
| APPROVAL **reject** / **save edit** reported success on a refusal | both go through `act()`, which reads `{ok:false}` |
| `close_panel` did not resolve aliases its two twins resolve | one resolver for all three tools |
| a docked **AGENT VIEW** painted a blank square | paints through `Grid.iconFor`, which has the fallback |
| the shortcuts overlay named `g a` "go to Agent" (it opens CODE) and hid `g n` / `g u` | lists what exists |
| a granular permission under **Full machine control** wrote false over false | derives from the stored flag, and says when the master governs it |
| four **CAPABILITIES** switches under a heading that implied a gate | relabelled as what they are: a record of what you have used |
| iT lost its layout if reopened within ~9s | the ownership lease and its heartbeat are released on dispose |
| a closed window's frame square adopted the next window of that type | a real close releases the square; docking still keeps the link |
| docking CODE mid-answer let a dead closure overwrite the live one | the store has one owner — the newest mount |
| two different default models for the same "auto" idea | one definition, in `llm.mjs`, and the doc reads the real value |
| the `app_rpc` allowlist exempted `rpcallow`, so the agent could widen it | reads pass, `set`/`reset` are refused |
| `files.write` ungated while two places said it was gated | six write ops need the **Write files** switch; reads stay open |
| the Docker volume mounted at `/root` while the image runs as `node` | mounted at `/home/node/CloneFrame`; the test derives it from the Dockerfile |
| `bridge/README.md` listed three deleted routes; `SEARCH.md` published seven modules for four | both corrected, both saying what happened |
| `Web.fetchRaw` on the RPC surface with no caller anywhere | off the surface; the function stays defined |

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
