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
| Listens on `127.0.0.1` only, never `0.0.0.0` | `bridge/hub-bridge.mjs` (`HOST` constant, `listen`) |
| Pairing token on every route except `/health` | persistent token file `~/.clone-frame-hub/bridge.token` (0600, dir 0700); bearer check before routing |
| Anti DNS-rebinding | `Host` header allowlist + loopback `remoteAddress` check, before any route |
| Token never in iframe-reachable URLs | token injected only on `Sec-Fetch-Dest: document`; `/proxy` accepts only `Sec-Fetch-Dest: iframe` and strips reflected CORS |
| `/health` (token-less) reveals nothing about the machine | returns name/version/host only — cwd, brain and model moved behind `POST /pair` |

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
  file-write and web access (e-mail autonomy stays separate).
- **Root mode**: typing `sudo` does *not* enable it — the bridge refuses until
  you switch Root mode on in Settings. The sudo password is asked per command
  and is never stored or logged.

Catastrophic patterns (`rm -rf /`, `rm -rf /*`, `rm -rf ~`, `mkfs`, `dd` to a
device, fork bombs) are refused **even in root mode**. This blocklist is a
best-effort seatbelt against accidents, not a sandbox — the boundary remains
who reaches the bridge, not which commands exist.

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
