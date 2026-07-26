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
| Pairing token on every route except `/health` | persistent token file `~/.clone-frame-hub/bridge.token` (0600, dir 0700); bearer check before routing |
| Anti DNS-rebinding | `Host` header allowlist + loopback `remoteAddress` check, before any route |
| Token reaches only a real browser navigation | the **full** `Sec-Fetch-*` fingerprint of a top-level, user-initiated navigation — `dest:document` + `mode:navigate` + `site:none` + `user:?1` + an HTML `Accept` — fired **once** per bridge start inside a short launch window; `/proxy` accepts only `Sec-Fetch-Dest: iframe` and strips reflected CORS |
| Remote servers need their own explicit yes | `bridge/servers.mjs` gates `run` / `test` / `runAutomation` / `deployAgent` / `provision` / `powerAction` on `Permissions.can('ssh')`, which the `machineControl` master switch deliberately does **not** imply |
| Security headers on every response | `nosniff`, `no-referrer`, `X-Frame-Options: SAMEORIGIN`, and a CSP carrying `frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'` |
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

Web pages render inside an `<iframe sandbox="allow-scripts allow-forms">`
**without** `allow-same-origin` — an opaque origin. Page JavaScript can never
read the parent window, the pairing token, or call the bridge. Pages are
fetched server-side through an SSRF guard that blocks private and loopback
ranges (IPv4, IPv6, v4-mapped, NAT64, CGNAT, link-local/cloud-metadata) and
re-validates **every redirect hop**. Navigation is parent-authoritative: the
address bar always matches the content actually fetched, so a page cannot
spoof its own URL.

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

## Reporting

Found something? Open a GitHub issue with the label `security`, or report it
privately via the repository's Security tab (GitHub private vulnerability
reporting). Please do not publish exploit details before a fix ships.
