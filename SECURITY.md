# Security model — CLONE FRAME HUB

CLONE FRAME HUB is a local app: one static `index.html` + one local daemon (the
HUB Bridge) that runs on **your** machine and holds the power. This document
describes the boundary, what is enforced in code, and the known residual risks.
Every claim below was verified against the source before publication.

## The boundary

**Whoever can reach the bridge with the pairing token has a real shell as you.**
That is the product — a deliberate real shell, not a command allowlist. The
security model therefore concentrates on *who can reach the bridge*:

| Control | Enforced by |
|---|---|
| Listens on `127.0.0.1` only, never `0.0.0.0` | `bridge/hub-bridge.mjs` (`HOST` constant, `listen`); a non-loopback bind refuses to start unless `HUB_BRIDGE_ALLOW_PUBLIC=1` says the exposure is intended |
| Pairing token on every route except `/health` | token file `~/.clone-frame-hub/bridge.token` (0600, dir 0700); constant-time bearer check before routing. The `Authorization` header is the **only** carrier — a `?token=` query param was accepted until 2026-07-26 and is not any more |
| The token can be given a lifetime, and can be replaced | `bridge/session.mjs` — permanent by default; *Settings → Session* offers an owner-chosen expiry and a rotate button. An expired token is refused **and retired**, so the failed secret never works again |
| Anti DNS-rebinding | `Host` header allowlist + loopback `remoteAddress` check, before any route |
| CORS names our own origin and nobody else's | only `http://127.0.0.1:<port>` / `localhost` / `[::1]` are echoed back. A request with no `Origin` at all (curl, the `it` CLI, the agent) used to be answered with `*`; now it gets no such header |
| Token reaches only a real browser navigation | the **full** `Sec-Fetch-*` fingerprint of a top-level, user-initiated navigation — `dest:document` + `mode:navigate` + `site:none` + `user:?1` + an HTML `Accept` — fired **once** per bridge start inside a short launch window. Automation cannot forge `Sec-Fetch-User: ?1`, so a CDP-driven window cannot pair — verified three ways |
| Remote servers need their own explicit yes | `bridge/servers.mjs` gates `run` / `test` / `runAutomation` / `deployAgent` / `provision` / `powerAction` on `Permissions.can('ssh')`, which the `machineControl` master switch deliberately does **not** imply |
| Closing an iT window ends what was running in it | `web/panels/shell.js` disposes each live surface with `kill:true` and names every session it owns to `pty.killMany`, so a tab whose socket had already dropped is reaped too. A **reload** still detaches and reattaches — that distinction is the whole point of persistent sessions |
| Security headers on every response | `nosniff`, `no-referrer`, `X-Frame-Options: SAMEORIGIN`, and a CSP carrying `frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'` |
| Persistent terminal sessions authenticate their socket | `bridge/keeper.mjs` — the socket directory must be a real, owner-owned, 0700 directory or keeper refuses to run, and every client must open with a per-session secret kept in the 0600 meta file. Sessions started by an older build have no secret and keep working unauthenticated until they end |
| `/health` (token-less) reveals nothing about the machine | returns name/version/host only — cwd, brain and model moved behind `POST /pair` |

> **Two of those rows are corrections, not features.** Until 2026-07-26 the token row read
> *"injected only on `Sec-Fetch-Dest: document`"* — a single header, which is forbidden to page
> JavaScript but free to any program, so `curl -H 'Sec-Fetch-Dest: document'` walked away with
> the pairing token and, through it, a shell. And the servers row did not exist at all: that
> module reached the owner's production machines with no permission check whatsoever. Both are
> closed and covered by tests. They are listed here as history because a security document that
> quietly edits away what it used to claim is not one you should trust.

## Bring your own key

There is **no embedded assistant** and no vendored key. Your API key lives in
your environment or `~/.env.local`, is read only by the bridge, is never
returned to the browser, and is scrubbed from log output (literal-secret
redaction plus pattern scrubbers for `sk-ant-…`, JWTs, bearer tokens and
common cloud credentials). BYOK keys entered in the UI live in
`sessionStorage` only — gone when the window closes.

## The session token — permanent by default, yours to shorten

One secret authenticates every window, terminal and agent on this machine. It is
minted here, kept at `~/.clone-frame-hub/bridge.token` (0600), and never leaves
the computer. **It is permanent unless you say otherwise** — a local app you open
twenty times a day must not log you out, so an install that never visits this
screen behaves exactly as it always did.

In *Settings → Session* you can instead give it a lifetime you choose (from 15
minutes to a year) or replace it on the spot:

- **Expiry** is enforced on the first request that presents a stale token: the
  token is refused **and immediately replaced**, so the secret that just failed is
  dead for everyone holding a copy. Your window stops being paired; relaunching
  the app pairs it again (the launcher reads the new token — it runs as you — and
  arms exactly one auto-pair). An unauthenticated caller cannot arm anything.
- **Rotate now** hands the new token to the caller that asked for it, so the
  window you clicked it in keeps working while every other copy stops.

Read it as key rotation, not as a login. A process running as you can read the
token file directly and always could; what a lifetime bounds is how long a token
that *got away* — a stale tab, a copied link, a backup, a shared screen — keeps
working.

## Sign-in with Google (optional, for e-mail)

The Gmail integration is BYOK: your own Google **Desktop** OAuth client. The flow
is the RFC 8252 loopback redirect with **PKCE (S256)** — the authorization code is
bound to a verifier that never leaves this process, so a code observed in a URL
or grabbed by another local listener cannot be redeemed elsewhere. The `state`
parameter is single-use. Tokens live in `~/.clone-frame-hub/oauth.json` (0600)
and are never returned to the browser.

## Permissions — default OFF

All agent permissions default to **false**: full machine control, root mode,
autonomous e-mail, autonomous automations, file write, web access. Two
semantics worth knowing:

- **"Full machine control" is a master switch**: when ON it implies shell,
  file-write and web access. **E-mail, SSH and MATRIX stay separate** — reaching
  your remote servers is never implied by controlling this computer.
- **Root mode**: typing `sudo` does *not* enable it — the bridge refuses until
  you switch Root mode on in Settings. The sudo password is asked per command
  and is never stored or logged.

Catastrophic patterns (`rm -rf /`, `rm -rf /*`, `rm -rf ~`, `mkfs`, `dd` to a
device, fork bombs) are refused **even in root mode**. This blocklist is a
best-effort seatbelt against accidents, not a sandbox — the boundary remains
who reaches the bridge, not which commands exist.

## The pi agent ships in YOLO — deliberately, and here is how to narrow it

CLONE FRAME runs the [pi](https://pi.dev) coding agent with **no sandbox and no
per-command approval**. Its bash is free. That is the owner's choice, not an
oversight, and it is what makes the app what it is: one prompt drives the whole
machine. Exactly **one** hard limit is wired in and cannot be turned off — the
anti-wipe: `rm -rf /` (root, a top-level system directory, or your whole home),
`mkfs`, and `dd` to a raw device are always refused, even with root mode on.

If you want a narrower agent, you have two independent layers, and they compose:

1. **pi's own guardrails — recommended.** They live *inside* the agent, so they
   apply to everything it does rather than to one tool. Install and configure them
   from [pi.dev](https://pi.dev); CLONE FRAME does not override them, and the
   in-app `guardrails` skill can set them up for you on request.
2. **The `app_rpc` allowlist — in-app, zero setup.** Through `app_rpc` the agent
   can call any bridge module. **It ships wide open.** In
   *Settings → Agent Tools → app_rpc allowlist* you write your own policy:
   leave it open and block specific entries, or flip it to allowlist mode where
   nothing is reachable except what you name. Entries are `module` or
   `module.fn`, one per line. It constrains **the agent's** calls only — the app's
   own interface drives the same route and is never restricted by it, so a narrow
   list can never brick your UI.

Be clear about what layer 2 is: **a guardrail on the agent's own tool, not a
security boundary.** It keys off a header the agent sets on its own calls, so it
shapes what the agent reaches for — the realistic risk being a prompt injection
in a page it reads. Anything that already holds the pairing token can call a
module directly and skip it entirely. That is not a weakness of the allowlist; it
is the first line of this document — whoever has the token already has a shell.

The agent's file tools cannot read secret stores: `~/.clone-frame-hub`,
`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, Keychains, `~/.env*`,
`~/.netrc` and `~/.npmrc` are blocked server-side.

## In-app browser

**The page never runs in this document.** The BROWSER panel does not embed the web
at all — no iframe, no HTML-rewriting proxy. `bridge/webengine.mjs` runs a dedicated
Chrome instance on its own profile (`~/.clone-frame-hub/web-engine`) and the panel
paints its `Page.startScreencast` JPEG frames onto a `<canvas>`, forwarding pointer
and keyboard events back. A page's JavaScript therefore has no parent window to reach
and no frame to escape: the only thing that crosses back is a picture.

The engine is reached over `--remote-debugging-pipe` — CDP rides file descriptors 3
and 4 as NUL-delimited JSON. **There is no debugging port and no debugging WebSocket**,
so nothing else on the machine can attach to it, and Chrome exits when the bridge dies
because its end of the pipe closes. The panel and the agent both drive it only through
the token-gated `POST /mod/webengine`, whose router refuses every `_`-prefixed
function — and every internal in that module is `_`-prefixed.

Two limits on what may cross that boundary:

- **Scheme.** RPC navigation accepts `http`, `https` and `about:blank` only. `file://`
  and `chrome://` are refused, because the engine runs with the user's filesystem and
  either would be an exfiltration path.
- **No raw CDP.** No caller-supplied method name and no caller-supplied JavaScript
  reaches Chrome. Input maps through a fixed whitelist; `read()` evaluates one fixed
  expression.

The profile is wiped when the engine starts **and** when it stops, and a docked browser
square never writes the page address to disk. That is the ephemeral-browser promise,
enforced in two places rather than trusted in one.

> Until 2026-07-25 this panel was a sandboxed iframe fed by a token-less `GET /proxy`
> reader with a server-side SSRF guard. **That route no longer exists** — it was removed
> with the panel rewrite. If you are auditing against an older copy of this document,
> that is the surface you will not find.

The iT panel's split preview is a different frame: it renders **loopback dev
servers** directly (`allow-scripts allow-same-origin`, which a real dev server
needs for its own cookies, storage and HMR), and hands every other address to the
BROWSER window. For every origin but one, the browser's same-origin policy still
stands between that frame and the app. The exception is the app's *own* origin —
a page served from the bridge's port would share this document's origin and could
reach through `parent` for the pairing token — so that one address, in every
spelling, is refused.

## Known residual risks (accepted, documented)

- **SSRF DNS TOCTOU** — the guard resolves a hostname to check it, then the
  fetch resolves again; a TTL-0 rebinding attacker could theoretically pass the
  check and fetch a private address. Redirect-hop re-validation narrows but
  does not eliminate this. Do not treat the outbound fetcher as
  rebinding-immune.
- **DigitalOcean token at rest** — the optional Online Server feature stores
  your DO API token in `~/.clone-frame-hub/servers.json` in plaintext,
  protected by file permissions (0600 in a 0700 dir), not by the macOS
  Keychain. It is never returned to the client (masked on read-back).
- **The blocklist is not a sandbox** — see above.
- **No `script-src` / `connect-src` in the CSP** — the app is one large inline
  script that calls external APIs directly, so neither can be set correctly
  without measuring every call site first, and a CSP that silently breaks a
  panel is worse than an honest gap. Until `script-src` lands, a stored-XSS in
  the UI is still script execution; the headers that *are* set close
  clickjacking, MIME confusion, base-tag hijack, referrer leakage and form
  exfiltration, and nothing more.
- **Terminal sessions started before the socket-auth change** keep running with
  no socket authentication until they end. Closing that for a live session would
  mean killing the user's shell out from under them; new sessions are gated.

## Reporting

Found something? Open a GitHub issue with the label `security`, or report it
privately via the repository's Security tab (GitHub private vulnerability
reporting). Please do not publish exploit details before a fix ships.
