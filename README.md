![The Universe in Frames](docs/assets/universe-in-frames.png)

<p align="center"><em>Zoom all the way out and the app grid becomes a cosmic web — every square a frame waiting to be built.</em></p>

# CLONE FRAME · HUB

**A visual interface between you and your machine — a Unix with a face.**

[![License: MIT](https://img.shields.io/badge/License-MIT-3fb950)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS-000000)](docs/INSTALL.md)
[![Status: Preview](https://img.shields.io/badge/Status-Preview-orange)](#)
[![Bring your own model](https://img.shields.io/badge/AI-bring--your--own--model-8957e5)](#-bring-your-own-model)
[![Single file + one daemon](https://img.shields.io/badge/build-single--file%20app-1f6feb)](#-the-single-file-build)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#-support-the-developer)
[![Latest release](https://img.shields.io/github/v/release/devclone20/cloneframe_app_executable?label=download&color=2da44e)](https://github.com/devclone20/cloneframe_app_executable/releases/latest)

**→ [Download the latest build](https://github.com/devclone20/cloneframe_app_executable/releases/latest)** — with the sha256 to verify it against a build of your own.

> [!CAUTION]
> **🔒 Security comes first.**
> CLONE FRAME HUB is in an active **Production & Development phase**. Because it gives
> real access to your **shell, files, network, and wallet**, we **strongly recommend
> running it inside a container / Docker** — isolate it in a sandbox you trust rather
> than directly on your primary machine.
>
> Keep the powerful permissions **off** until you need them, and review what your
> agents do. **You are the pilot** — the app hands you the controls, it does not fly
> itself.

---

## What is this?

CLONE FRAME HUB is a local, double-click desktop app. It is made of exactly **two
pieces**: one `index.html` that draws the entire interface, and one small local
daemon — the **HUB Bridge** — that does the real work on your machine. Nothing runs
in the cloud unless you point it there.

Think of it as **Unix with a face**. Under the hood your computer already has a
shell, a filesystem, processes, and network tools. CLONE FRAME gives all of that a
calm, visual surface: a real terminal, a file tree, an in-app browser, email, crews
of agents behind safety gates, and a **local AI cluster** that serves models from
your own hardware — each one a frame in a grid you can arrange and grow.

Crucially, **there is no embedded assistant**. You bring your own model. That can be
a cloud API key that never leaves your machine, or a fully local model served by the
built-in **MATRIX** cluster on your own devices. Your keys live in your session, your
files live in plain folders on your disk, and the app is built so that neither ever
leaks into the code, the logs, or this repository.

## The Universe in Frames

The interface is a grid of squares. **Each square is a frame** — an app, a tool, a
view you have opened or one you could build. A terminal is a frame. Your model chat
is a frame. A running local-model cluster is a frame. An agent crew is a frame.

Now zoom out. The single window you are looking at is one small patch of a much
larger picture: the **universe of everything you could build** on top of your own
machine. That is the cover concept — *The Universe in Frames*. Every empty square is
not a gap, it is an invitation.

---

## 🗺️ Architecture in one picture

Everything below is one of these two boxes. **You** drive a window; the window speaks
to a **local daemon** over two narrow, checked channels; the daemon is the only thing
that ever touches your real machine.

![The whole system in one picture — you, the window, the bridge, your machine](docs/assets/arch-one-picture.svg)

The window **never** talks to a tool's port directly. There are only **two channels**:
a **CONTROL** channel (HTTP `POST /mod/<name>` with a small `{fn, args}` body the
bridge dispatches to a named module) and one **DATA** channel (a single token-gated
WebSocket that powers the live terminal). Every call is Bearer-token checked,
Host-header checked, and loopback-only. Module functions whose name starts with `_`
are never reachable from the window.

---

## 🔐 The boundary law — two channels, nothing else

This is the single most important rule in the whole system, so it gets its own
picture. A malicious web page, another local user, or a rogue script has **no path**
to your machine that skips these checks.

![The boundary law — two channels, one gate of five checks, nothing else](docs/assets/boundary-law.svg)

---

## 🪟 Inside the window

The interface is a single `index.html`, but it is not a blob — it is a small kernel,
a **panel registry**, and a fleet of self-contained panels. Every panel is registered
in one data-driven table and mounted on demand; adding a new one is a single line.

![Inside the window — Bus, Kernel, panel registry, BridgeClient, 20 panels](docs/assets/inside-window.svg)

Every panel reaches the outside world through **one** client (`BridgeClient`), so
there is a single place where the pairing token, headers, and timeouts live. Panels
talk to each other only through the **Bus** — never by reaching into each other.

---

## ⚙️ Inside the bridge

The daemon is layered on purpose. The router does transport, security, and dispatch —
nothing else. Domain modules hold the meaning. Underneath them, a thin **platform
service layer** owns every mechanical concern (storage, HTTP, model calls, the safety
guard) so nothing is duplicated and every dangerous edge has exactly one home.

![Inside the bridge — router, domains, platform service layer, your machine](docs/assets/inside-bridge.svg)

Because every dangerous operation funnels through one port — one SSRF check, one
catastrophic-command guard, one secret redactor, one fail-closed command gate — the
security promises below are **provable**, not scattered.

---

## 🧭 A request's journey

What actually happens when you type a command and press enter:

![A request's journey — panel to BridgeClient to router to domain to platform to machine and back](docs/assets/request-journey.svg)

Live terminal keystrokes take the **DATA** channel instead: they stream over the
token-gated WebSocket straight to a real pseudo-terminal, so the shell feels native —
your `zsh`, your prompt, `vim` and `tmux` all work.

---

## 🧱 The frame grid — 20 panels

Open the launcher and any of these mount instantly, each in its own draggable,
dockable frame. Dock one into a grid square and its live session keeps running.

![The frame grid — 20 panels in six families](docs/assets/frame-grid.svg)

The four families you reach from the **top bar** are **CODE · HARNESS · LAB · MATRIX**;
the rest open from the launcher, the command palette, or Settings.

| Top-bar tab | What it gives you |
|-------------|-------------------|
| **CODE** | Chat with your model, a real multi-tab terminal (xterm, file tree, diff + editor, `zsh` themes, tab-autocomplete), a project diff view, and an in-app browser. |
| **HARNESS** | Crews of agents that plan and act behind **non-collapsible safety gates** — the agent proposes, the gate holds, you decide. (Today the gates apply to the model paths you connect yourself. If you install and select the `pi` coding agent, its own tool loop runs outside them — see [KNOWN-ISSUES.md](KNOWN-ISSUES.md).) |
| **LAB** | Chat with any model, and **your agents** — the LAB detects every iNFT your connected wallet holds and lets you work with each one. |
| **MATRIX** | Your **local AI cluster** — turn your own devices into nodes, load models, and chat with a fully local brain (details below). |

---

## 🧠 MATRIX — your local AI cluster

MATRIX turns the machines you own into one local inference cluster. Start the engine
on this Mac, add more nodes, load a model, and chat — no cloud key, nothing leaves
your hardware. When the engine is off, MATRIX shows clearly-labelled **demo data** so
you can see the shape before you go live.

![MATRIX — engine, nodes, models, chat: one local brain](docs/assets/matrix-cluster.svg)

---

## 🧬 Bring your own model

CLONE FRAME does not ship a model. Every chat in the app routes to **the model you
chose** — the app itself is model-agnostic from end to end. Two ways to connect one:

![Bring your own model — cloud API key or local MATRIX cluster](docs/assets/byom.svg)

Your key stays in your **session** and is never written into the app, the logs, or
this repository. Full walkthrough: [docs/CONNECT.md](docs/CONNECT.md).

---

## 🛡️ Security model

Because every dangerous edge has exactly one home (see *Inside the bridge*), these
promises are enforced in one place each — and each one has a positive **and** a
negative regression test in the suite.

![The security model — eight invariants locked by tests, wallet signs, defaults off](docs/assets/security-invariants.svg)

- **Loopback only.** The bridge binds `127.0.0.1` and is reachable only from your own
  machine — never the network.
- **Paired and checked.** Every request carries a per-session pairing token and passes
  a Host-header allowlist that blocks DNS-rebinding. The WebSocket carries its token in
  the subprotocol (`cfhub.bearer.<token>`), never in the URL.
- **Powerful things default OFF.** Shell, file-write, web, and email autonomy are
  opt-in switches in Settings. Catastrophic commands are blocked even in root mode.
- **The web never runs inside the app.** The in-app browser is a *separate* Chrome
  process on its own profile, driven over a debugging **pipe** — no port, no socket.
  The panel paints its video frames onto a canvas, so a page has no parent window to
  reach and no frame to escape. Only a picture comes back.
- **Your secrets stay yours.** Keys live in your session or `.env` and are never
  written into the app, the logs, or this repository.
- **The wallet holds the keys, not the app.** CLONE FRAME only ever builds **unsigned**
  transactions — your connected wallet is the sole signer. The app never asks for a
  private key or seed phrase.

Full model and threat notes: [SECURITY.md](SECURITY.md).

---

## 🏗️ The single-file build

The app ships as **one** self-contained `index.html`, but it is *developed* as many
small files. A tiny build step reassembles them with a strict guarantee: the built
output is byte-for-byte reproducible, and a frozen checksum proves it never changed by
accident.

![The single-file build — many source files, one reproducible index.html, a golden sha256](docs/assets/single-file-build.svg)

A fresh clone runs with **no build tools**: the `index.html` committed at the
repository root *is* that built artifact, byte-for-byte what `npm run build` writes to
`dist/index.html`. The panels are spliced back into the same scope at build time, so the
single-file app and the modular source are always exactly the same program — and
`tools/golden/index.sha256` is the frozen checksum that proves it.

### Verify it yourself

You do not have to take our word for what is in the app you downloaded. Build it from
the source in this repository and compare the bytes:

```bash
npm install && npm run build          # web/ -> dist/index.html
shasum -a 256 dist/index.html         # must equal the line in tools/golden/index.sha256
cmp dist/index.html index.html        # and the committed app must be that same file
```

Three commands, no output, exit 0 — that is the whole proof. If any of them disagrees,
the shipped app is not what this source says it is, and we want the issue.

---

## 🧩 How it was built — eight layers

Under the hood the whole system is organised as eight layers, each resting on the one
below. This is why a change in one place cannot quietly break a distant panel.

![Eight layers — foundation to hardening, each resting on the one below](docs/assets/eight-layers.svg)

---

## 📦 Bundled integrations

The INTEGRATIONS panel installs and launches tools that run **inside** the app.

| Integration | Licence | What it does |
|-------------|---------|--------------|
| **MATRIX (local cluster)** | built-in | Serve local LLMs across your own devices — a fully local brain, no cloud key. |
| **Live Terminal** | built-in | A real interactive terminal — xterm.js over the token-gated WebSocket to a pseudo-terminal on the bridge. |
| **Framer** | bundled MV3 extension | Lets the in-app browser frame sites that normally block embedding. |
| **Runtime** | bundled | A Chrome for Testing the app launches into so the Framer extension can load. |

> [!NOTE]
> **Coming soon.** A few frames appear in the app as clearly-labelled **"in
> development"** placeholders — including **GAME OVER**, **ACP TRACER**, and **iIRYS
> FRAME**, plus deeper **Manaflow** (parallel coding agents) and **TMUX** (persistent
> agent crews) integrations. They are visible so you can see where the app is going;
> they are not wired to real actions yet.

---

## 🚀 Quick start

### 🐳 Recommended — run sandboxed in Docker

Because the app is in a **Production & Development phase**, the safest way to try it is
inside a container, where its shell, files, and network are isolated from your host.

```bash
git clone https://github.com/devclone20/cloneframe_app_executable.git
cd cloneframe_app_executable
docker compose up --build          # builds the image and starts the sandboxed bridge
# then open  http://127.0.0.1:8765  in your browser
#
# stop it with:  docker compose down
```

![Docker sandbox — host browser on loopback, bridge confined to the container, data in named volumes](docs/assets/docker-sandbox.svg)

The port is published to your host's **loopback only**; your data persists in named
Docker volumes (`cfhub-state`, `cfhub-data`). The terminal, file tree, and browser all
operate **inside** the container — that is the sandbox.

### 🖥️ Native — run directly on macOS

macOS is the primary platform for a direct install.

```bash
git clone https://github.com/devclone20/cloneframe_app_executable.git
cd cloneframe_app_executable/bridge && npm install   # 5 small add-ons — see below
./launch.sh                                            # starts the bridge on 127.0.0.1 and opens the app
# or build the double-click app:  cd bridge && ./make-app.sh   -> "CLONE FRAME HUB.app"
```

The daemon is otherwise pure Node built-ins. Those five add-ons are `ws` and `node-pty`
(the live terminal) plus `imapflow`, `mailparser` and `nodemailer` (email). **Every one
is imported behind a guard** — the bridge boots without any of them, you simply lose
that feature. `node-pty` is a native module: if `npm install` complains, it is almost
always that one wanting a prebuilt binary or the Xcode command line tools. See
[docs/INSTALL.md](docs/INSTALL.md).

You do **not** need to build anything to run it: the committed `index.html` at the
repository root *is* the app, and it is byte-for-byte what `npm run build` produces
from `web/`. If you want to change the app, or run the tests, install the one root
dev dependency too:

```bash
cd cloneframe_app_executable && npm install    # esbuild, for the single-file build
cd bridge && npm install && cd ..              # the suite exercises the real daemon modules
npm run build                                  # web/ -> dist/index.html
npm test                                       # builds first, then runs the whole suite
```

Both installs are needed for `npm test`: a good part of the suite runs against the real
bridge modules — a real `zsh`, real files, the real cron engine, a real HTTP daemon on a
scratch port — rather than against mocks. With only the root install, eleven tests fail on
a missing `imapflow`/`nodemailer`, which is a missing dependency and not a broken app.

**Requirements:** Node ≥ 18 and a Chromium browser (Chrome, Brave, Edge, or Chrome
for Testing) for the app window.

On first run the app creates `~/CloneFrame/` (with `Models`, `Agents`, `Data`,
`Cache`, `Harnesses`, `Servers`, `Downloads`, `Logs`) — ordinary folders you can open
in Finder, that every frame reads from and writes to.

**Linux and Windows** are not the primary platform yet — the bridge is portable Node,
so it will run, but the launch and packaging scripts are macOS-first. See
[docs/INSTALL.md](docs/INSTALL.md) for the manual steps.

---

## 📚 Documentation

| Doc | What is inside |
|-----|----------------|
| [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) | A friendly tour of the app and its frames. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The two pieces, the two channels, and the boundary law in depth. |
| [docs/INSTALL.md](docs/INSTALL.md) | Install and run on macOS, Linux, and Windows. |
| [docs/CONNECT.md](docs/CONNECT.md) | Connect a cloud API key or a local MATRIX model. |
| [SECURITY.md](SECURITY.md) | The full security model and how to report issues. |
| [KNOWN-ISSUES.md](KNOWN-ISSUES.md) | What is thin, what is deliberate, and the residual risks — written before anyone else finds them. |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release, and what it cost you before it changed. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The build is a splice and `dist/` is generated. Read this before your first change. |

## License

Released under the **MIT License** — see [LICENSE](LICENSE). Third-party components
keep their own licences, listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

### ⭐ Support the developer

If CLONE FRAME HUB is useful to you, the best thanks is a star.

**⭐ Support the developer — [star this repo](https://github.com/devclone20/cloneframe_app_executable).**
