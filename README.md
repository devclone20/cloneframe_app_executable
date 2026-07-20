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

```mermaid
flowchart LR
    You(["🧑‍✈️ You — the pilot"])

    subgraph WIN["🪟 Window · index.html — the frame grid"]
      direction TB
      UI["Frames · panels · terminal · browser"]
    end

    subgraph BR["⚙️ HUB Bridge · local daemon · 127.0.0.1:8765"]
      direction TB
      RT["Router — transport · security · dispatch"]
    end

    subgraph MACH["💻 Your machine — the real world"]
      direction TB
      SH["Shell + real terminal"]
      FS["Your files · ~/CloneFrame"]
      NET["Network · in-app browser"]
      WAL["Your wallet · unsigned tx only"]
    end

    CLOUD["☁️ Your model<br/>cloud API key (optional)"]
    LOCAL["🧠 MATRIX<br/>local model cluster"]

    You <--> UI
    UI ==>|"CONTROL · HTTP POST /mod"| RT
    UI ==>|"DATA · token-gated WebSocket"| RT
    RT --> SH & FS & NET & WAL
    RT --> CLOUD
    RT --> LOCAL

    classDef you fill:#f85149,stroke:#b62324,color:#fff
    classDef win fill:#1f6feb,stroke:#1158c7,color:#fff
    classDef bridge fill:#e16f24,stroke:#bc4c00,color:#fff
    classDef mach fill:#30363d,stroke:#8b949e,color:#fff
    classDef ext fill:#1b7c83,stroke:#0f5c61,color:#fff
    class You you
    class UI win
    class RT bridge
    class SH,FS,NET,WAL mach
    class CLOUD,LOCAL ext
```

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

```mermaid
flowchart TD
    subgraph GATE["🛡️ Every request crosses the same gate"]
      direction TB
      A["Loopback only — binds 127.0.0.1"] --> B["Host-header allowlist — blocks DNS-rebind"]
      B --> C["Bearer pairing token — per session"]
      C --> D["Sec-Fetch-Dest gate — token only on real navigation"]
      D --> E["_private functions unreachable by RPC"]
    end

    CTRL["CONTROL<br/>HTTP POST /mod/&lt;name&gt;<br/>{ fn, args }"]:::ctrl --> GATE
    DATA["DATA<br/>WebSocket /stream<br/>token in subprotocol, never the URL"]:::data --> GATE
    GATE --> OK(["✅ Dispatched to a named module"]):::ok
    BAD(["❌ Anything else — refused"]):::bad
    GATE -.->|"fails any check"| BAD

    classDef ctrl fill:#1f6feb,stroke:#1158c7,color:#fff
    classDef data fill:#8957e5,stroke:#6e40c9,color:#fff
    classDef ok fill:#2da44e,stroke:#1a7f37,color:#fff
    classDef bad fill:#cf222e,stroke:#82071e,color:#fff
    style GATE fill:#0d1117,stroke:#f85149,color:#e6edf3
```

---

## 🪟 Inside the window

The interface is a single `index.html`, but it is not a blob — it is a small kernel,
a **panel registry**, and a fleet of self-contained panels. Every panel is registered
in one data-driven table and mounted on demand; adding a new one is a single line.

```mermaid
flowchart TD
    subgraph WINDOW["🪟 index.html"]
      direction TB
      BUS["📻 Bus — pub/sub, the only wiring between modules"]
      KERNEL["🧩 Kernel<br/>escapers · panelBus · time/fetch/persisted<br/>dragGesture · URL-scheme guards"]
      REG["🗂️ Panel registry<br/>registerPanel · openPanel"]
      CLIENT["📡 BridgeClient<br/>the ONE egress — token, headers, timeouts"]

      subgraph PANELS["🧱 27 self-registering panels · web/panels/*"]
        direction LR
        P1["CODE · iT · BROWSER"]
        P2["LAB · HARNESS · MATRIX"]
        P3["NOTES · EMAIL · …"]
      end
    end

    REG --> PANELS
    PANELS --> BUS
    PANELS --> KERNEL
    PANELS --> CLIENT
    CLIENT ==> BRIDGE(["⚙️ HUB Bridge"])

    classDef core fill:#8957e5,stroke:#6e40c9,color:#fff
    classDef reg fill:#1f6feb,stroke:#1158c7,color:#fff
    classDef panel fill:#2da44e,stroke:#1a7f37,color:#fff
    classDef egress fill:#e16f24,stroke:#bc4c00,color:#fff
    class BUS,KERNEL core
    class REG reg
    class P1,P2,P3 panel
    class CLIENT egress
    class BRIDGE egress
    style WINDOW fill:#0d1117,stroke:#30363d,color:#e6edf3
    style PANELS fill:#0d1117,stroke:#2da44e,color:#e6edf3
```

Every panel reaches the outside world through **one** client (`BridgeClient`), so
there is a single place where the pairing token, headers, and timeouts live. Panels
talk to each other only through the **Bus** — never by reaching into each other.

---

## ⚙️ Inside the bridge

The daemon is layered on purpose. The router does transport, security, and dispatch —
nothing else. Domain modules hold the meaning. Underneath them, a thin **platform
service layer** owns every mechanical concern (storage, HTTP, model calls, the safety
guard) so nothing is duplicated and every dangerous edge has exactly one home.

```mermaid
flowchart TD
    IN(["📡 /mod/&lt;name&gt; from the window"]):::in

    subgraph ROUTER["🚦 Router · hub-bridge.mjs"]
      R["transport + security + dispatch only"]
    end

    subgraph DOMAINS["🗂️ Domains — the meaning"]
      direction LR
      D1["chat"]
      D2["mail"]
      D3["pim"]
      D4["content"]
      D5["agent"]
      D6["web3"]
    end

    subgraph PLATFORM["🔧 Platform service layer — one home per concern"]
      direction LR
      S1["json-store"]
      S2["http · SSRF"]
      S3["llm (model port)"]
      S4["evm"]
      S5["dav"]
      S6["cli-gate"]
      S7["shell-guard"]
      S8["redact"]
    end

    OS(["💻 Files · processes · network · your model"]):::os

    IN --> R --> DOMAINS --> PLATFORM --> OS

    classDef in fill:#1f6feb,stroke:#1158c7,color:#fff
    classDef router fill:#e16f24,stroke:#bc4c00,color:#fff
    classDef domain fill:#d4a72c,stroke:#9e6a03,color:#111
    classDef port fill:#576270,stroke:#32383f,color:#fff
    classDef os fill:#30363d,stroke:#8b949e,color:#fff
    class R router
    class D1,D2,D3,D4,D5,D6 domain
    class S1,S2,S3,S4,S5,S6,S7,S8 port
    style ROUTER fill:#0d1117,stroke:#e16f24,color:#e6edf3
    style DOMAINS fill:#0d1117,stroke:#d4a72c,color:#e6edf3
    style PLATFORM fill:#0d1117,stroke:#576270,color:#e6edf3
```

Because every dangerous operation funnels through one port — one SSRF check, one
catastrophic-command guard, one secret redactor, one fail-closed command gate — the
security promises below are **provable**, not scattered.

---

## 🧭 A request's journey

What actually happens when you type a command and press enter:

```mermaid
flowchart LR
    A["🖱️ You act in a panel"]:::a
    B["📡 BridgeClient adds the token"]:::b
    C["🚦 Router checks the gate"]:::c
    D["🗂️ Domain interprets {fn, args}"]:::d
    E["🔧 Platform port does the work"]:::e
    F["💻 Machine executes"]:::f
    G["🖥️ Result flows back to the frame"]:::g

    A --> B --> C --> D --> E --> F
    F -->|"{ ok, data }"| G --> A

    classDef a fill:#f85149,stroke:#b62324,color:#fff
    classDef b fill:#e16f24,stroke:#bc4c00,color:#fff
    classDef c fill:#cf222e,stroke:#82071e,color:#fff
    classDef d fill:#d4a72c,stroke:#9e6a03,color:#111
    classDef e fill:#576270,stroke:#32383f,color:#fff
    classDef f fill:#30363d,stroke:#8b949e,color:#fff
    classDef g fill:#2da44e,stroke:#1a7f37,color:#fff
```

Live terminal keystrokes take the **DATA** channel instead: they stream over the
token-gated WebSocket straight to a real pseudo-terminal, so the shell feels native —
your `zsh`, your prompt, `vim` and `tmux` all work.

---

## 🧱 The frame grid — 27 panels

Open the launcher and any of these mount instantly, each in its own draggable,
dockable frame. Dock one into a grid square and its live session keeps running.

```mermaid
flowchart TB
    subgraph CODE["💻 Code & shell"]
      direction LR
      c1["CODE"]; c2["iT terminal"]; c3["BROWSER"]; c4["FOLDERS"]
    end
    subgraph AGENTS["🤖 Agents & harness"]
      direction LR
      a1["LAB"]; a2["AGENT"]; a3["MY AGENTS"]; a4["HARNESS"]; a5["BRAIN"]
    end
    subgraph AI["🧠 Local AI"]
      direction LR
      m1["MATRIX"]; m2["MY MACHINE"]; m3["MODEL COMPARISON"]; m4["COOKBOOK"]
    end
    subgraph PIM["🗓️ Personal"]
      direction LR
      p1["NOTES"]; p2["CALENDAR"]; p3["CONTACTS"]; p4["TASKS"]; p5["REMINDERS"]
    end
    subgraph FLOW["📨 Comms & flows"]
      direction LR
      f1["EMAIL"]; f2["AUTOMATIONS"]; f3["APPROVAL"]; f4["CONNECTIONS"]
    end
    subgraph SYS["⚙️ Content & system"]
      direction LR
      s1["GALLERY"]; s2["LIBRARY"]; s3["SETTINGS"]; s4["THEME"]; s5["SEARCH"]
    end

    classDef code fill:#1f6feb,stroke:#1158c7,color:#fff
    classDef ag fill:#8957e5,stroke:#6e40c9,color:#fff
    classDef ai fill:#1b7c83,stroke:#0f5c61,color:#fff
    classDef pim fill:#2da44e,stroke:#1a7f37,color:#fff
    classDef flow fill:#e16f24,stroke:#bc4c00,color:#fff
    classDef sys fill:#576270,stroke:#32383f,color:#fff
    class c1,c2,c3,c4 code
    class a1,a2,a3,a4,a5 ag
    class m1,m2,m3,m4 ai
    class p1,p2,p3,p4,p5 pim
    class f1,f2,f3,f4 flow
    class s1,s2,s3,s4,s5 sys
```

The four families you reach from the **top bar** are **CODE · HARNESS · LAB · MATRIX**;
the rest open from the launcher, the command palette, or Settings.

| Top-bar tab | What it gives you |
|-------------|-------------------|
| **CODE** | Chat with your model, a real multi-tab terminal (xterm, file tree, diff + editor, `zsh` themes, tab-autocomplete), a project diff view, and an in-app browser. |
| **HARNESS** | Crews of agents that plan and act behind **non-collapsible safety gates** — the agent proposes, the gate holds, you decide. |
| **LAB** | Chat with any model, and **your agents** — the LAB detects every iNFT your connected wallet holds and lets you work with each one. |
| **MATRIX** | Your **local AI cluster** — turn your own devices into nodes, load models, and chat with a fully local brain (details below). |

---

## 🧠 MATRIX — your local AI cluster

MATRIX turns the machines you own into one local inference cluster. Start the engine
on this Mac, add more nodes, load a model, and chat — no cloud key, nothing leaves
your hardware. When the engine is off, MATRIX shows clearly-labelled **demo data** so
you can see the shape before you go live.

```mermaid
flowchart TD
    ENGINE["🟢 MATRIX engine — this machine"]:::engine

    subgraph NODES["🖥️ Your nodes"]
      direction LR
      N1["This Mac"]; N2["＋ add node"]; N3["＋ add node"]
    end

    MODELS["📦 Models loaded across the cluster"]:::models
    CHAT["💬 Chat with your local brain"]:::chat

    ENGINE --> NODES --> MODELS --> CHAT

    classDef engine fill:#2da44e,stroke:#1a7f37,color:#fff
    classDef node fill:#1b7c83,stroke:#0f5c61,color:#fff
    classDef models fill:#8957e5,stroke:#6e40c9,color:#fff
    classDef chat fill:#1f6feb,stroke:#1158c7,color:#fff
    class N1,N2,N3 node
    style NODES fill:#0d1117,stroke:#1b7c83,color:#e6edf3
```

---

## 🧬 Bring your own model

CLONE FRAME does not ship a model. Every chat in the app routes to **the model you
chose** — the app itself is model-agnostic from end to end. Two ways to connect one:

```mermaid
flowchart TD
    Start(["Connect a model"]):::start
    Start --> A["☁️ Cloud API key<br/>Anthropic · OpenAI · DeepSeek · Gemini ·<br/>+ any OpenAI-compatible endpoint"]:::cloud
    Start --> B["🧠 Local — MATRIX cluster<br/>your own hardware, no key"]:::local
    A --> Done(["✅ Live in every panel"]):::done
    B --> Done

    classDef start fill:#f85149,stroke:#b62324,color:#fff
    classDef cloud fill:#1b7c83,stroke:#0f5c61,color:#fff
    classDef local fill:#2da44e,stroke:#1a7f37,color:#fff
    classDef done fill:#1f6feb,stroke:#1158c7,color:#fff
```

Your key stays in your **session** and is never written into the app, the logs, or
this repository. Full walkthrough: [docs/CONNECT.md](docs/CONNECT.md).

---

## 🛡️ Security model

Because every dangerous edge has exactly one home (see *Inside the bridge*), these
promises are enforced in one place each — and each one has a positive **and** a
negative regression test in the suite.

```mermaid
flowchart TD
    subgraph INV["🔒 Invariants — locked by tests"]
      direction TB
      I1["Loopback bind + pairing token"]
      I2["Sec-Fetch-Dest gate — token only on real navigation"]
      I3["SSRF re-checked on EVERY redirect hop"]
      I4["Soul / origin allowlist for privileged inputs"]
      I5["Command gate fails CLOSED"]
      I6["rm -rf / · mkfs · dd blocked — even in root mode"]
      I7["Secrets redacted from every log line"]
      I8["Media URL scheme guard — no javascript:/data:text/html"]
    end

    WALLET["👛 Wallet is the sole signer<br/>the app only builds UNSIGNED transactions"]:::wallet
    PERMS["🔘 Powerful things default OFF<br/>shell · file-write · web · email autonomy"]:::perms

    classDef inv fill:#cf222e,stroke:#82071e,color:#fff
    classDef wallet fill:#d4a72c,stroke:#9e6a03,color:#111
    classDef perms fill:#576270,stroke:#32383f,color:#fff
    class I1,I2,I3,I4,I5,I6,I7,I8 inv
    style INV fill:#0d1117,stroke:#cf222e,color:#e6edf3
```

- **Loopback only.** The bridge binds `127.0.0.1` and is reachable only from your own
  machine — never the network.
- **Paired and checked.** Every request carries a per-session pairing token and passes
  a Host-header allowlist that blocks DNS-rebinding. The WebSocket carries its token in
  the subprotocol (`cfhub.bearer.<token>`), never in the URL.
- **Powerful things default OFF.** Shell, file-write, web, and email autonomy are
  opt-in switches in Settings. Catastrophic commands are blocked even in root mode.
- **Sandboxed browser.** In-app pages render in an opaque-origin sandbox behind an
  SSRF-guarded proxy that re-validates on every redirect, so page JavaScript can never
  reach the token or the bridge.
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

```mermaid
flowchart LR
    subgraph SRC["✍️ Source — many small files"]
      direction TB
      MAIN["web/index.html<br/>shell + styles"]
      PAN["web/panels/*.js<br/>27 panels"]
      KRN["web/scripts/core/kernel.js"]
    end

    BUILD["🔧 tools/build.mjs"]:::build
    OUT["📦 dist/index.html<br/>ONE self-contained file"]:::out
    GOLD["🔒 golden sha256<br/>identity guarantee"]:::gold

    PAN -->|"//@cfbuild-include · raw splice"| BUILD
    KRN -->|"esbuild bundle"| BUILD
    MAIN --> BUILD --> OUT
    OUT -.->|"checked against"| GOLD

    classDef src fill:#2da44e,stroke:#1a7f37,color:#fff
    classDef build fill:#e16f24,stroke:#bc4c00,color:#fff
    classDef out fill:#1f6feb,stroke:#1158c7,color:#fff
    classDef gold fill:#d4a72c,stroke:#9e6a03,color:#111
    class MAIN,PAN,KRN src
    style SRC fill:#0d1117,stroke:#2da44e,color:#e6edf3
```

A fresh clone runs `dist/index.html` with **no build tools** — the panels are spliced
back into the same scope at build time, so the single-file app and the modular source
are always exactly the same program.

---

## 🧩 How it was built — eight layers

Under the hood the whole system is organised as eight layers, each resting on the one
below. This is why a change in one place cannot quietly break a distant panel.

```mermaid
flowchart BT
    L0["L0 · Foundation — single-file build · tests · hygiene"]:::l0
    L1["L1 · Platform service layer — storage · http · model · guards"]:::l1
    L2["L2 · Domains — mail · pim · content · agent · web3 · chat"]:::l2
    L3["L3 · Protocol & router — /mod is the only seam"]:::l3
    L4["L4 · Frontend kernel — escapers · bus · utils · scheme guards"]:::l4
    L5["L5 · Design system — UI primitives · panel registry"]:::l5
    L6["L6 · Panels — 27 self-registering frames"]:::l6
    L7["L7 · Hardening — the security regression suite"]:::l7

    L0 --> L1 --> L2 --> L3 --> L4 --> L5 --> L6 --> L7

    classDef l0 fill:#30363d,stroke:#8b949e,color:#fff
    classDef l1 fill:#576270,stroke:#32383f,color:#fff
    classDef l2 fill:#1b7c83,stroke:#0f5c61,color:#fff
    classDef l3 fill:#e16f24,stroke:#bc4c00,color:#fff
    classDef l4 fill:#8957e5,stroke:#6e40c9,color:#fff
    classDef l5 fill:#1f6feb,stroke:#1158c7,color:#fff
    classDef l6 fill:#2da44e,stroke:#1a7f37,color:#fff
    classDef l7 fill:#cf222e,stroke:#82071e,color:#fff
```

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

macOS is the primary platform today.

```bash
git clone https://github.com/devclone20/cloneframe_app_executable.git
cd cloneframe_app_executable/bridge && npm install   # only 3 optional email deps; rest is Node built-ins
./launch.sh                                            # starts the bridge on 127.0.0.1 and opens the app
# or build the double-click app:  cd bridge && ./make-app.sh   -> "CLONE FRAME HUB.app"
```

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

## License

Released under the **MIT License** — see [LICENSE](LICENSE). Third-party components
keep their own licences, listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

### ⭐ Support the developer

If CLONE FRAME HUB is useful to you, the best thanks is a star.

**⭐ Support the developer — [star this repo](https://github.com/devclone20/cloneframe_app_executable).**
