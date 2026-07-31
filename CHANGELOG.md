# Changelog

What changed, and what it cost you before it changed. Written for someone deciding
whether to update, not for someone reading a diff.

Full detail lives in `git log` — every commit here says what a user would have hit.

## 0.3.4 — 2026-08-01

Two rules the app had never chosen between, one promise it never kept, and a repository
that had been publishing the workshop instead of the product.

**Every panel is one window now. iT is the exception, and it always was the point.**

Opening NOTES twice gave you two NOTES windows: the same store drawn twice, with two
scroll positions and one set of data underneath. Asking for a panel you already have
means *show it to me*. So it does — including a window you had tucked away in a frame
square, which now comes back instead of a second, empty copy opening on top of it.

**iT is untouched by that, and infinite on purpose.** Terminal windows side by side,
each with its own workspaces, split panes and live shells, is the whole reason iT
exists. Nothing about it changed except that it is now the only panel that does it.

BROWSER lost its second window, and it was never a decision that it had one. One list
answered two different questions — *may this panel have several windows?* and *does
docking hide this window or destroy it?* — and BROWSER needed the second answer, because
a docked browser must keep its live pages. It got the first for free. Two lists now.
The browser is one window with tabs, docking it still keeps every page alive, and its
"New browser window" button is gone: it could only ever have opened a copy of the window
you were already looking at, and the tab strip's ＋ is the control that does what that
icon depicted.

**Closing an iT window now closes what was inside it**

This is the one that was costing you something. The code claimed to "reap every live pty
session"; it dropped the sockets instead. For a *persistent* session — the default — a
dropped socket means DETACH, not close. So every shell in a window you closed went on
running for the full sixty-minute detach timeout: builds still building, dev servers
still holding ports, agents still spending tokens, invisible, against a 24-session cap
you could not see. Nothing told you, because from the app's side the window was gone.

Now closing the window ends its sessions three ways, because a socket is not the only
way a session stays alive: live tabs are killed in band; every session id the window
owns is named to the daemon, which reaches the ones whose sockets had already dropped
and no in-band kill could touch; and workspaces you restored but never opened — which
have no terminal on screen at all, yet whose shells are real and running — are reaped
by the window that owns that layout.

Measured against a real daemon with real login shells and a real marker process:

```
new  18/18   close kills · reload survives · detached sessions reachable
old  12/18   "no such fn: killMany" — the marker process still running, unreachable
```

**A reload still keeps your shells.** That distinction is the entire value of persistent
sessions and it is untouched: ⌘R detaches and reattaches, scrollback and all. Only
closing the window is a close. Keeper sessions — the ⟳ "persistent sessions" tab —
survive too, on purpose: they are this app's tmux, created deliberately, listed by
`it sess list`, ended by `it sess kill`. Closing a terminal window does not kill your
tmux, and nothing about them is hidden from you.

**This repository is the app now, not a copy of the workshop**

It used to mirror the whole development tree — panel sources, a 108-file test suite,
build tooling, an Electron shell, planning notes — and ask you to find `index.html` in
it. What you want from this page is an app you can run.

So: download the release, double-click **`install.command`**, and you have
`CLONE FRAME HUB.app` in `~/Applications` with the entire program inside the bundle —
the app, the daemon, its dependencies. The folder you downloaded can then go in the
Trash. To update: Trash the old app, download the new release, run its installer. Your
data is never inside the app, so an update never touches it. To remove: `uninstall.command`,
which stops the daemon, removes the app, and asks *separately* about your data.

Two consequences worth saying out loud rather than letting you find them:

- **You can no longer rebuild `index.html` from this clone** — the sources that build
  it are not here. You can read it (it is one plain document) and check its hash against
  the release. `bridge/` is different: that **is** its source, every line, and it is the
  half that touches your machine.
- The publisher's file list went from *everything except a denylist* to *exactly these
  paths*. A denylist fails open — anything not named leaks by default, so every new
  folder was public until someone remembered to exclude it. Now a folder added tomorrow
  is private until it is named.

**Also fixed**

- `make-app.sh` read the version through `${BASH_SOURCE[0]}` under a `#!/bin/zsh`
  shebang. zsh leaves that empty, so the version came from whatever directory you were
  standing in — it looked right only because everyone ran it from `bridge/`.
- The model's own tool list told it that `browse{newWindow:true}` opens "a SEPARATE
  browser window… use several to research side-by-side", and that `open_panel` reached
  27 panels. There are 20, and there is one browser window.
- The publisher's secret scan aborted mid-pass with `GITLEAKS_CFG[@]: unbound variable`
  the first time it ran without its config in staging — bash 3.2 under `set -u`. It
  died on the safety gate, skipping the two checks after it.

## 0.3.3 — 2026-07-31

0.3.2 shipped, and then a regression sweep read every line of the twelve commits behind it,
with a second reader trying to refute each finding. Fifteen survived. **Six were mine, and
one of them made 0.3.2's headline fix worthless.** They are listed first because that is the
honest order.

**The gate could be switched off by the thing it gated**

0.3.2 made `email.send`, the file writes and `scheduled.schedule` need the owner's switch when
the caller marks itself as the agent. `permissions` is an ordinary routed module, and
`permissions.set` was not on any list. Measured against a real daemon:

    AGENT email.send                        → 403 refused, the switch is off
    AGENT permissions.set {autoEmail:true}  → 200 OK
    AGENT email.send                        → 200, straight through

Three calls. The fix is not a longer list — a hand-written list is also what let
`scheduled.reschedule` through in the same release. It is a principle: **an agent may not
change the rules that constrain it.** `permissions`, `rpcallow`, `admin` and `session` are a
control plane, deny-by-default inside each module, with their read functions named explicitly
so the agent can still see what it is allowed to do. A function added to one of them tomorrow
is already out of reach.

**The daemon could still be killed — by the one route left un-awaited**

0.3.1 wrapped the router so a throw costs one request rather than the process. `POST /shell`
was called without `await`, so its rejection threw into nobody and ended the daemon exactly as
before. `POST /shell` with a body of literal `null` was enough.

**An approval could be stranded forever**

0.3.1 made `approve()` claim the item on disk before opening the socket, and roll it back if
the send returned an error. It does not always return one: a Gmail account whose refresh token
has expired makes `Email.send` **throw**, which skipped the rollback. The item stayed
'approved' — not pending, so the panel showed a badge with no buttons; not sent, so it never
went; and the queue cap deletes non-pending items first. The owner's draft became unreachable
from both sides. Every exit now puts the claim back.

**And three more of mine**

`close_panel` began resolving aliases in 0.3.2 — through a resolver that normalises with
`/[^a-z0-9 ]/g`, so the instance key `shell#2` became `shell2`, matched nothing, and fell
through to a prefix rule that closed the FIRST shell window. `list_panels` hands the agent
exactly those keys. An exact on-screen key now wins before any normalising.

MY AGENTS' USE IN CODE pinned `contract: undefined`, because it copied fields off a *card*
object that never had them. LAB matches pins on (contract, tokenId), so pressing ✓ there
pushed a second pin instead of toggling — and LAB's toggle is the only unpin control there is.
The contract is in the card's own key.

EMAIL's copy of the APPROVAL buttons still reported success on a refusal. Its twin was fixed
in 0.3.2 and this one was left behind — and the refusals it hides became newly common the same
day, when approve and reject started refusing anything not 'pending'.

**Two that were not mine, and one the sweep got wrong**

The Docker volume needed its mount point to pre-exist owned by `node`, or Docker creates it as
root at runtime and the app cannot write. And `make-app.sh` reads `${BASH_SOURCE[0]}` under a
`#!/bin/zsh` shebang, where it is empty.

One confirmed finding was refuted on re-reading: `close()`'s release guard was called inverted,
but the singleton dock path really does destroy the window and really does need the square to
keep its key. The original guard was right and the "fix" was reverted before it shipped.

  912 tests pass · 41/41 live checks against a real daemon on a scratch HOME

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
