# CLONE FRAME · HUB Bridge — the local daemon

Runs the HUB as a **double-click app** on your machine (a dedicated Chrome app
window). The local server serves the app **and** gives it a real body.

## Install the app

```bash
zsh bridge/make-app.sh            # creates ~/Applications/CLONE FRAME HUB.app
```

Then just **double-click** `CLONE FRAME HUB` (Spotlight/Launchpad/Applications).
It starts the local server and opens the app in a Chrome window — **auto-pairs**
(no token pasting). To start without the app: `node bridge/hub-bridge.mjs` and
open `http://127.0.0.1:8765`.

## Real e-mail (IMAP/SMTP)

The `email.mjs` engine (imapflow + nodemailer + mailparser) connects DIRECTLY to
your provider. In **EMAIL → ACCOUNTS → Add**: Gmail needs an **App Password**
(Google Account → Security → App passwords, with 2FA). Credentials live in
`~/.clone-frame-hub/accounts.json` (chmod 600) — **never** in the site or in a
log. See `EMAIL_ENGINE.md`.

---

## The terminal's real body

A local Node daemon that gives the HUB's CODE tab genuine access to your machine:

- **True shell** (`zsh`) — run any command with streaming output, persistent
  `cd`, git-branch detection and **Ctrl+C** (kills the whole process group).
- **Claude** — a relay to the Anthropic API using **your** key (BYOK). The key
  is read from your disk (`ANTHROPIC_API_KEY` in the environment or
  `~/.env.local`) and **never** enters the site.

The site is static and never contains secrets. The bridge — running **on your
machine** — holds the key and executes. The browser talks to it over
`http://127.0.0.1:8765`.

## Start

```bash
node bridge/hub-bridge.mjs
```

It prints a pairing line:

```
http://127.0.0.1:8765#token=…
```

Paste that line into the HUB → **MY MACHINE → HUB BRIDGE → CONNECT**. Done: the
terminal becomes real and CODE answers with Claude on your machine.

## Security (why this is safe to run)

- **Listens on `127.0.0.1` only** — never `0.0.0.0`. Unreachable from the network.
- **Pairing token** required on every request (except `/health`). Lives in
  `~/.clone-frame-hub/bridge.token` (chmod 600) and, in the browser, only in
  `sessionStorage`.
- **`Host` header validation** — DNS-rebinding defence: a malicious site that
  resolves `evil.com → 127.0.0.1` is rejected (403).
- **`remoteAddress` check** — loopback only.
- The Anthropic key is **never** logged and never returned to the browser.
- Limits: 512 KiB of output per command, 2-minute timeout, request body ≤ 4 MB.

> Whoever holds the token has a shell as you (it is a real shell, deliberately —
> not an allowlist). The security boundary is **who can reach the bridge**
> (loopback + token + Host), not *which commands*. Keep the token local.

## Endpoints

| Method | Route | Auth | What |
|---|---|---|---|
| GET  | `/health`    | — | liveness only (name, version, host) |
| POST | `/pair`      | token | confirms pairing; returns cwd, brain, model |
| POST | `/shell`     | token | run a command, streamed output (`\x00EXIT/CWD/ERR/CLEAR` markers) |
| POST | `/interrupt` | token | SIGINT to the running command's group (by `id`) |
| POST | `/chat`      | token | streaming relay to Claude (SSE → text) |
| POST | `/email`     | token | 501 when SMTP is not configured (the site falls back to `mailto`) |

## Configuration (optional)

| Env | Default | |
|---|---|---|
| `HUB_BRIDGE_PORT`  | `8765` | port |
| `HUB_BRIDGE_MODEL` | `claude-opus-4-8` | default Claude model |
| `ANTHROPIC_API_KEY` | (read from `~/.env.local` when absent from the environment) | your key |

## Known limitations

- Full-screen TUIs (`vim`, `top`, `htop`, interactive `less`) need a real PTY
  and do not work over a pipe — they degrade or warn. An opt-in TTY mode (via
  `script`) is future work.
- `export FOO=bar` does not persist between commands (each command is a fresh
  `zsh -lc`); `cd` **does** persist.

MIT.
