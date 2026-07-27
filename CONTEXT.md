# CONTEXT — CLONE FRAME HUB ubiquitous language

> The glossary of names the codebase should use. A term here is the *canonical* word;
> everything else is a synonym to be retired. No implementation details live here — this
> is a dictionary, not a spec. Seed drafted during the architecture plan (P0 · ticket T-003).

## The product

- **Frame** — the app itself: one `index.html` + a local Node daemon. "A Unix with a face." Local-first, BYOK.
- **HUB** — the running Frame in front of the owner: the panels, the universe, the chrome.
- **HUB Bridge** (**bridge**) — the local Node daemon on `127.0.0.1` that gives the HUB a real body (shell, mail, model relay). Zero runtime dependencies by design.
- **Owner** — the human. There is no house AI; the owner wires in **their** model (**BYOK**).
- **Model-agnostic (invariant)** — the HUB is a neutral shell around *any* model the user configures
  (Anthropic, OpenAI-compatible, DeepSeek, Groq, Gemini, xAI, Ollama, local **MATRIX** cluster, any
  custom endpoint). **No path may be locked to one provider.** Every model call — interactive *and*
  background helpers — routes through the user's chosen provider/model. Keys stay on the machine.
- **Panel** — one HUB surface (CODE, EMAIL, iT, HARNESS, BROWSER…). Opened via `open-panel`; a floating window with chrome, drag, resize, dock, snap.
- **Universe / World / Grid / Cell** — the pan-zoom canvas and its frame-squares; a Cell is a live window handle (dock = hide, not destroy).
- **Widget** — a self-contained embeddable unit (`.widget`).

## Agents & harnesses

- **Agent / iCLONE** — a model given a body inside the HUB. **iCLONE** is the owner's line of agents.
- **Soul** — an agent's identity/config; carries a **soul-origin allowlist** (a security seam — never widen without a test).
- **Harness** — a crew of agents: one **Orchestrator**, non-collapsible **Gates** (SAFETY/HACKER, EVALUATOR, TREASURY, OWNER — `gate:true`), and specialists (`gate:false`).
- **Gate** — a crew role nothing irreversible passes without.

## The seams (architecture vocabulary — used exactly)

- **Module** — anything with an interface + implementation (function, file, tier-spanning slice).
- **Interface** — everything a caller must know to use a module correctly.
- **Deep / Shallow** — deep = much behaviour behind a small interface (good); shallow = interface nearly as complex as implementation (a copy-paste smell).
- **Seam** — a place you can change behaviour without editing there.
- **Port / Adapter / Fake** — a Port is an interface at an external seam; an Adapter satisfies it in production; a **Fake** is the in-memory adapter tests use. *One adapter = hypothetical seam; two = real.*
- **Service layer** (`bridge/platform/`) — the reusable operational mechanics ("the *how*"), extracted only when a mechanic repeats across **2+ callers**.
- **Action / domain module** — orchestrates domain rules ("the *why/when*"); calls the service layer.
- **RPC** — the one frontend↔bridge domain seam: `RPC(module, fn, ...args)` over `POST /mod/<name>` → `{ok, error, code}`. 188 call sites; the signature is frozen.
- **Stream** — the WS data-plane grammar (`op=shell|attach|it`, control frames, `\x00` markers) for the terminal.

## Bounded contexts (the target `bridge/domains/` split)

| Context | Owns |
|---|---|
| **Frame** | window/panel host, universe, chrome, themes |
| **Terminal** | pty, iT multiplexer, `it` CLI (data-plane behind Stream) |
| **Chat** | model chat, provider-chat, shell exec (the ex-router fat handlers) |
| **Mail** | email (IMAP/SMTP), oauth, scheduled send, approvals |
| **PIM** | notes, tasks, reminders |
| **Content** | files, folders |
| **Agent** | nft/soul, harness, models, brain, research |
| **Web3** | acp, okxai, virtuals, robinhood (on cli-gate / evm) |
| **Web** | in-app browser, proxy, search, servers, admin, permissions (SSRF-guarded) |
| **Wallet** | wallet/auth surfaces |
| **Theme** | token layer, ds4 (Instrument console), ds5 (Soft carbon) |

## Retire-these (synonyms → canonical)

- "component / service / API / boundary" → say **module / interface / seam / port**.
- `esc / esc2 / esc3 / escA` → **escHtml** (text) or **escAttr** (attribute).
- `ensureConfigDir / loadStore / saveStore` copies → **json-store** (`openStore`).
- inline Anthropic wire / `loadKey` copies → the **llm** port.
