# CLONE FRAME HUB — App Map (the screen, for agents without eyes)

**You are an AI agent running inside this app — in an iT terminal or the </>CODE tab. You cannot
see the screen.** This file is your eyes: what is on screen, where every piece lives in the code,
and how to observe live state through commands instead of vision. Companion to `AGENTS.md`
(the laws + tool reference — read that first). Both live in `context/` in the app bundle and are
mirrored to `~/.clone-frame-hub/` on every bridge start; `it context` prints AGENTS.md, and
`cat ~/.clone-frame-hub/APP-MAP.md` prints this.

**How to use:** anchors here are **greppable names** (functions, ids, CSS families), not line
numbers — line numbers rot, names don't. To find anything: `grep -n "<anchor>" index.html` or
open `bridge/<module>.mjs`.

---

## 1. The screen at a glance

One window, five fixed pieces, everything else floats:

- **`#topbar`** — brand "clone frame · hub" · main tabs **`#hubtabs`: CODE · HARNESS · LAB ·
  MATRIX** · dev stubs `#devtabs` (GAME OVER / ACP TRACER / iIRYS FRAME — toast-only, not real
  panels) · `#wallet` sign-in · `#themesbtn` · `#gear` (Settings). Under Electron the bar drags
  the window (`html.native-shell`).
- **The universe** — `#universe > #world > #grid`, an infinite pan/zoom canvas of small square
  cells ("Frame Live Square"). Cells hold icon tiles that open panels; a minimized panel **docks
  into a cell and stays alive** (`dataset.panelKey`, dock = hide-not-destroy — a docked terminal's
  pty keeps running).
- **Floating panels** — every feature is a draggable/resizable window in `#panels` (registry
  `const DEFS`, opener `openPanel(type)`, aliases `browser`→`research`, `agent`→`terminal`).
- **`#tri` — the red double-triangle** (also the app icon, `branding/appicon.svg`). Click →
  `#flymenu`, the menu of everything (built from `const MENU`). Also holds zoom −/+/fit and
  parked items.
- **`#guide` — the guide dock**: a retractable contextual hint bar at the bottom (`const Guide`,
  CTX map per panel). It can be **docked into the ▲ tri menu** — if the user says the guide bar
  vanished, it is `Store.guideDocked`, restored via the tri menu "Show guide bar", not a bug.

Global chrome: `#pal` command palette (⌘K) · `#keys` shortcuts overlay (?) · `#toast`
notifications · `#reframe` FIT button.

---

## 2. Every panel (27) — what it is, where it lives

Columns: **key** (what `open_panel{panel}` takes) · UI title · what the user does there ·
**code anchor** in `index.html` · bridge modules it calls (`bridge/<name>.mjs`).

| key | title | purpose | anchor | bridge |
|---|---|---|---|---|
| `terminal` | CODE | main agent workspace: chat/agent modes, model+harness+iNFT pickers, side terminal `❯_`, diff, browser handoff; hosts the agent tool loop | `wireTerminal` | files, models, harness, web, servers, permissions |
| `shell` | iT | terminal multiplexer: real PTYs, workspaces▸splits▸tabs, palette, canvas, SSH hosts (⚡), persistent sessions (⟳ — `bridge/keeper.mjs`, survive both disconnect and a bridge restart, scrollback replayed on reattach) | `wireShell` | pty, ssh, keeper, files, web, permissions |
| `harness` | HARNESS | build/edit agent crews (Orchestrator + gates + roles); "use in the terminal" | `wireHarness` | harness |
| `lab` | LAB | chat with any model (API or local) + manage/select iNFT agents (card deck) | `wireLab` | nft, models, servers, files |
| `matrix` | MATRIX | distributed-AI-cluster lab, CLONE FRAME's own control surface: device topology, run models across machines, cluster chat, model downloads, engine lifecycle (start/stop/status) over a local API; engine button in the header (CONNECT MACHINE / START / STOP / ONLINE) | `wireMatrix`, `#mxroot` | matrix, models |
| `machine` | MY MACHINE | connect the HUB Bridge (endpoint#token) + pick the BRAIN (BYOK key, sessionStorage only) | `wireMachine` | — |
| `agents` | MY AGENTS | connect real agents (iCLONE, VEGETA…), on-chain ERC-8004 status | `wireAgents` | — |
| `agentview` | AGENT | standalone iNFT identity card (traits, soul, 3D art); opened from a LAB card footer | `wireAgentView` | — |
| `folders` | FOLDERS | file manager over the bridge: tree, create/edit/organize, open iT at cwd | `wireFolders` | files, folders |
| `email` | EMAIL | real mail client (IMAP/SMTP/OAuth): accounts, folders, compose, scheduled, approvals | `wireEmail`, `const Mail` | oauth, scheduled, approvals (+HTTP `/email/*`) |
| `approval` | APPROVAL | approve/edit/reject agent-drafted emails before send | `wireApproval` | approvals |
| `contacts` | CONTACTS | address book: vCard/CSV import, CardDAV | `wireContacts` | contacts |
| `calendar` | CALENDAR | CalDAV month view, events | `wireCalendar` | calendar |
| `reminders` | REMINDERS | time-based reminders the agent fires | `wireReminders` | reminders |
| `tasks` | TASKS | cron-scheduled autonomous agent tasks + runs/logs | `wireTasks` | tasks |
| `automations` | AUTOMATIONS | gated-autonomy queue: propose actions, human approves/vetoes | `wireAutomations` | — |
| `notes` | NOTES | notes + to-dos, images, search, archive | `wireNotes` | notes |
| `library` | LIBRARY | document/research archive, versioning, deep-research kick-off | `wireLibrary` | library, research |
| `research` | BROWSER | the in-app web browser (tabs, direct-iframe/proxy hybrid; native WebContentsView under Electron) | `wireWebBrowser`, `#wbxroot` | web |
| `search` | SEARCH | global search across everything | `wireSearch` | search |
| `brain` | BRAIN | agent memory & skills manager | `wireBrain` | models |
| `cookbook` | COOKBOOK | local model recipes: download/launch local models | `wireCookbook` | cookbook, models |
| `compare` | MODEL COMPARISON | one prompt across many models side-by-side | `wireCompare` | compare, models |
| `gallery` | GALLERY | photos/albums/edit | `wireGallery` | gallery, images |
| `integrations` | CONNECTIONS | connect/disconnect external service integrations | `wireIntegrations` | integrations |
| `theme` | THEME | pick/customize themes | `wireTheme` | — |
| `settings` | SETTINGS | full settings hub (`#setnav` sections — see §3) | `wireSettings` | pty, models, search, integrations, reminders, permissions, admin, folders, servers |

**Gone (do not reference):** `economyos` (CLI ECONOMY OS), `wallet`, `integrate` — these panel
keys no longer exist; `open_panel` with them shows a "Coming soon" toast. The bridge modules
behind the old economy tab (`virtuals/robinhood/okxai/acp.mjs`) still exist and answer RPC, but
have no UI panel.

**Menu groups** (`const MENU` — feeds both the cell "+" add-menu and the tri flyout):
Workspace (terminal, shell, folders, harness, lab, matrix, machine, agents) · Tools (brain,
calendar, compare, cookbook, research, gallery, library, notes, tasks, theme) · Communication
(email, contacts, reminders, approval, automations, integrations) · System (search, wallet
sign-in, settings).

---

## 3. Settings sections (for `open_settings{section}`)

Canonical handles (the `SECS` array / `SEC` map anchors): `agenttools` (agent permissions — alias
`agent`, `permissions`) · `itterm` (iT — alias `it`) · `addmodels` (alias `models`; DeepSeek/custom
cloud preset) · `added` · `aidefaults` · `tools` · `appearance` (alias `theme`) · `account` ·
`folders` · `servers` · `system` · `email` · `integrations` · `reminders` · `search` ·
`shortcuts` · `licenses` · `users`.

---

## 4. Seeing without eyes — the observation surface

Three channels, all local. **Never guess screen state — read it.**

### 4a. `it` CLI (inside any iT shell)

| command | what it shows |
|---|---|
| `it ping` / `it version` | app + iT window alive; versions |
| `it context` | the AGENTS.md field guide |
| `it list-workspaces` / `it current-workspace` | the multiplexer map; where you are |
| `it list-panes` | panes in a workspace |
| **`it read-screen [--lines n]`** | **the focused terminal's rendered screen — the literal "see" primitive; also reads another agent's terminal** |
| `it list-status` | workspace status pills (inter-agent signalling via `it set-status`) |
| `it run <cmd> [--host <alias>]` | run + capture output, locally or on a saved SSH host |
| `it pipe on [--file p]` | tee a terminal's ongoing output to a file |
| `it host list` / `it host fingerprint <a>` | saved SSH hosts; host-key fingerprints |
| `it find-in-directory` | filename filter + content grep |
| `it hooks status` / `it shortcuts list` / `it group list` | agent hooks, keymap, workspace groups |

### 4b. Observation RPCs (read-only; `POST /mod/<module> {fn,args}` — in CODE these back the tools)

| module.fn | reveals |
|---|---|
| `permissions.get` / `.can` | your capability map — 9 toggles: machineControl (master), fullAccess, rootMode, autoEmail, autoAutomations, fileWrite, webAccess, **ssh**, **matrix** (email/ssh/matrix are NOT unlocked by the master switch) |
| `admin.system` / `.logs` | node version, uptime, stores, scheduler health · secrets-scrubbed tail of server.log |
| `pty.list` · `keeper.list` | live terminal sessions · persistent (keeper) sessions |
| `it.available` | whether an iT window is listening for `it` UI commands |
| `matrix.status` / `.logs` | cluster engine running? owned pid? engine log tail |
| `models.listProviders` / `.brainStatus` | BYOK provider roster + defaults; is a brain live |
| `harness.list` / `.activeForTerminal` | crews and which one CODE is running as |
| `files.list/stat/read` · `folders.surfaces` | disk contents (secret paths refused) · surface folders |
| `servers.list` · `ssh.list` | saved droplets · saved SSH hosts (secrets masked) |
| `web.search/fetchUrl/frameable` | web eyes: search, readable page text, will-it-frame |
| `search.query` | cross-app search over all HUB stores |
| per-panel stores | `notes/contacts/library/tasks/approvals/scheduled/reminders/calendar/gallery/compare/cookbook/research.list|get|count` — read any panel's data without opening it |
| `nft.known/soul` · `virtuals.byWallet` · `robinhood.status` · `acp.status` · `okxai.status` | web3 read-only state |
| HTTP `GET /health` | `{ok,name,version}` — is the bridge up (no auth) |

### 4c. State files (`~/.clone-frame-hub/` — one JSON store per module, 0600)

Live logs: `server.log` (bridge, tail via `admin.logs`) · `launch.log` · `matrix-engine.log`.
Key stores: `permissions.json` (what you may do) · `harness.json` · `models.json` ·
`ssh.json` · `servers.json` · `accounts.json` (email) ·
per-panel `{notes,tasks,approvals,…}.json` · `bridge.token` (pairing token — never print it).
Client-side state lives in the app's localStorage under `cfhub.*` keys (e.g.
`cfhub.matrix.convs.v1`, `cfhub.it.persist`, `cfhub.v3` Store: cells, pinnedAgents, guideDocked).

---

## 5. Live-state conventions (how the app talks to itself)

- **`Bus`** — the global pub/sub. Key events: `open-panel` (all panel opening flows through
  this) · `models:changed` (a provider/model changed → every picker refreshes; **after a models
  RPC mutation, emit this — never poke pickers**) · `harness:changed` · `inft:changed` ·
  `bridge:changed` (pairing state) · `shell:addcwd` · `it:menu` (Electron menu → iT).
- **Window identity** — a panel's `dataset.panelKey`; MULTI types (`research`, `shell`) can have
  several instances (`type#n`). Docked cell = `cell.dataset.panelKey`.
- **iT tab-name prefixes encode kind**: `⟳ name` persisted session · `⚡ host` SSH ·
  `code·` editor · `diff·` diff viewer.
- **Feature detects**: `html.native-shell` = running under Electron (real in-app browser views);
  absent = Chrome `--app` window (iframe/proxy browser). Both paths must keep working.
- **MATRIX engine** = a resident daemon behind its own `matrix` permission, managed by
  `bridge/matrix.mjs` (start/stop/status, pid tracking, crash detection) over a local API on
  `127.0.0.1:52415`; when up it auto-registers as a model provider (its models appear in every
  picker automatically).

---

## 6. Where the code lives

```
clone-frame-hub/
├─ index.html            # the whole UI — single file (~12k lines): <style> then one <script>
│                        #   find any panel: grep "function wireXxx" · registry: const DEFS
│                        #   opener: openPanel · menu: const MENU · tools: execTool
├─ bridge/               # local daemon (127.0.0.1:8765) — one .mjs per domain, ~36 RPC modules
│  ├─ hub-bridge.mjs     #   router: /mod dispatch, /shell, /chat, /provider-chat, WS /stream
│  ├─ pty.mjs · keeper.mjs · ssh.mjs      # iT: live PTYs · persistence · remote hosts
│  ├─ matrix.mjs          # cluster engine lifecycle
│  ├─ email.mjs · calendar.mjs · …        # one module per panel domain
│  └─ launch.sh          #   the double-click launcher (Chrome --app default; HUB_SHELL=electron)
├─ electron/             # optional native shell (real in-app browser views)
├─ context/              # AGENTS.md (laws+tools) · APP-MAP.md (this) — mirrored to ~/.clone-frame-hub/
├─ branding/             # the red double-triangle mark (appicon.svg · applet.icns)
└─ ARCHITECTURE/         # the restructuring plan (PLAN/EXECUTION/CONTEXT/WAVES + tickets/)
```

**Editing rules are in `AGENTS.md` §6** (backup→single-writer→read-before-write→smallest
edit→`node --check`→verify E2E). The long-term target structure (deep modules, service layer,
`web/` split) is in `ARCHITECTURE/PLAN.md` — consult it before any structural change.

---

*Living document — regenerate the mirror by restarting the bridge (`ensureContext()` copies all
`context/*.md`). Keep in step with the app; when a panel/tab/module changes, update §2/§4 here
and the version note below. · v1.0 · 2026-07-20 · CLONE FRAME · cloneframe.io*
