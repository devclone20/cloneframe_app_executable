# Known issues

Ours first, before anyone else finds them.

This is the list we would want if we were the ones downloading it. It is not a
backlog and it is not marketing — everything here is either measured or a decision
we made on purpose and would defend. If you hit something that is **not** here,
that is a real bug and we want the issue.

Last reviewed 2026-07-31, against `0.2.0`.

---

## Coverage — what has and has not been exercised by hand

The automated suite is strong and the hands-on suite is not finished. Both numbers
are real:

```
automated     847 tests, green, on every build, with a reproducible single-file artifact
hands-on      41 of 151 numbered tests run · 0 of 7 end-to-end user journeys walked
```

The thinnest areas, named so you know where to be suspicious:

| Area | State |
|---|---|
| Attachments — paste, drag-drop, the 5-image cap, folder intake | **no hands-on evidence on disk** |
| The 7 user journeys (first run → first answer → first automation) | **not walked end to end** |
| iT terminal | 1 test of its suite |
| Guardrails · email · security | 3 tests of its suite, though the invariants themselves are covered by automated tests |

The panel sweep *is* done: all 27 panels have a live pass against a paired bridge —
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
- A fresh clone runs `dist/index.html` with no build tools. You only need
  `npm install` (in `bridge/`, plus the repo root for `esbuild`) if you intend to
  **build** rather than run.

## Design decisions people mistake for bugs

- **The permission toggles are not a sandbox.** Only `ssh`, `matrix` and `root` are
  enforced in the daemon. That is deliberate and `bridge/rpcallow.mjs` says so in its
  own header: whoever holds the pairing token already has a real shell as you, so
  there is no boundary at that layer to lose. The toggles are about intent and
  friction, not containment. If you want containment, use the Docker path.
- **The catastrophic-command blocklist is not a sandbox either.** `rm -rf /`, `mkfs`
  and `dd`-to-a-disk are refused on every path, always, even with root mode on — but
  a blocklist stops accidents, not a determined attacker who already has your shell.
- **AGENTVIEW opens only when you own something to look at.** Its deck route needs a
  wallet connected and an iNFT pinned. It is always reachable from the command
  palette (⌘K → `agent` / `inft`), and its empty state says what to do.
- **The in-app browser keeps nothing.** Its profile is wiped when the engine starts
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

## Rough edges we know about

- **The RPC surface is not shape-consistent.** `notes.list`, `tasks.list`,
  `reminders.list` and `harness.list` return bare arrays; `brain.list` returns
  `{ok, memories, …}`. Nothing lies about it — the tool contract promises "the
  module fn's JSON result" and no more — but it is friction, and changing it now
  would touch roughly forty call sites for a cosmetic win. Written down instead.
- **MATRIX local models are memory-hungry.** Loading a large local weight on a
  machine without the RAM for it can take the whole machine down. Check the model
  size against your free memory before you press load; the panel shows both.
- **The version reads `0.2.0` everywhere**, from `package.json`, including places
  that used to carry their own codenamed number. If a screenshot or an old report
  quotes `v0.4 EXTRACTION` or `v0.28`, it predates that unification.

## How we triage

- **Blocker** — you cannot run the app, or something destroys data: within a day.
- **Major** — a panel or a documented promise does not work: within a week.
- **Everything else** — into the next wave.

A wave ships when its items are done, not when the queue is empty.
