/**
 * clone-frame — the extension that makes CLONE FRAME the Pi agent's BODY.
 *
 * Pi is the mind; CLONE FRAME is the arm. This extension gives Pi native tools to DRIVE
 * the running app — open any of its 27 panels, read what is on screen right now, and reach
 * every one of the ~36 HUB Bridge modules (files, web, models, harness, notes, tasks,
 * research, servers, matrix, …) as its own tools. It also installs the ONE hard safety
 * limit the owner chose: an anti-wipe guard on bash. Everything else runs freely — Pi has
 * no sandbox and no per-command approval by design (the owner runs it YOLO).
 *
 * How it reaches the app: exactly like the `it` CLI — read the pairing token from
 * ~/.clone-frame-hub/bridge.token and POST http://127.0.0.1:8765/mod/<module> with an
 * Authorization: Bearer header (loopback-only, token-gated). Panel-driving + live screen
 * state go through the `app` module (op=app control channel to the running window); every
 * other capability is a direct module call via app_rpc.
 *
 * Load: shipped in the CLONE FRAME agent workspace (.pi/extensions/) and also passed
 * explicitly with `pi -e <this file>` by the bridge's RPC launcher, so it loads even in
 * headless --mode rpc where project trust is not prompted.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { catastrophic } from "./lib/anti-wipe-core";

const ENDPOINT = process.env.CFHUB_BRIDGE || "http://127.0.0.1:8765";
const TOKEN_PATH = join(homedir(), ".clone-frame-hub", "bridge.token");

function bridgeToken(): string {
	try {
		return readFileSync(TOKEN_PATH, "utf8").trim();
	} catch {
		return "";
	}
}

// One token-gated POST to a HUB Bridge module. Returns the module fn's JSON result.
async function callModule(module: string, fn: string, args: unknown[] = []): Promise<any> {
	const t = bridgeToken();
	if (!t) throw new Error("no HUB Bridge token at ~/.clone-frame-hub/bridge.token — is CLONE FRAME installed?");
	let res: Response;
	try {
		res = await fetch(`${ENDPOINT}/mod/${module}`, {
			method: "POST",
			// Marks this call as the AGENT's, so the owner's app_rpc allowlist applies to it
			// (Settings → Agent Tools). The owner's own UI calls the same route without it and
			// is never constrained. This is a guardrail on the agent, not a boundary: anything
			// already holding the token can simply omit the header — see bridge/rpcallow.mjs.
			headers: { "Content-Type": "application/json", Authorization: "Bearer " + t, "X-CFHub-Caller": "agent" },
			body: JSON.stringify({ fn, args }),
		});
	} catch {
		throw new Error("the HUB Bridge is not running — open CLONE FRAME first");
	}
	if (!res.ok) throw new Error(`HUB Bridge HTTP ${res.status}`);
	return await res.json();
}

// Drive the app window (open/close/focus a panel, read live screen state) via the op=app
// control channel. Returns { ok, ... }. A closed app yields a clear, actionable error.
function driveApp(action: string, params: Record<string, unknown> = {}): Promise<any> {
	return callModule("app", "cmd", [action, params]);
}

const text = (s: string, isError = false) => ({ content: [{ type: "text" as const, text: s }], isError });
const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

// ── The ONE hard limit: anti-wipe. Pi's bash is free (owner's YOLO choice); we refuse ONLY
// the catastrophic patterns the CLONE FRAME invariant forbids everywhere — rm -rf on a
// root/system path, mkfs, dd to a raw disk. The guard now lives in ONE shared place
// (./lib/anti-wipe-core) so the fleet's `anti-wipe.ts` child extension enforces the exact same
// rule — never two copies of the regexes drifting apart. `catastrophic` is imported above.

export default function cloneFrame(pi: ExtensionAPI) {
	// The underlying LLM (which model pi runs on) is chosen by the bridge per session via an
	// isolated PI_CODING_AGENT_DIR + models.json — NOT here — so pi's model persistence never
	// touches the owner's global ~/.pi config. This extension only gives pi its hands (app
	// tools) and its one hard limit (anti-wipe).

	// ── Anti-wipe on the model's bash tool ──────────────────────────────────────────────
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return undefined;
		const why = catastrophic((event.input as any)?.command);
		if (why)
			return {
				block: true,
				reason: `CLONE FRAME anti-wipe: refusing ${why}. This is the ONLY hard limit here — every other command runs freely.`,
			};
		return undefined;
	});
	// ── Same guard on a human-typed `!command` (best-effort; shapes vary by version) ──────
	pi.on("user_bash", async (event) => {
		const why = catastrophic((event as any)?.command ?? (event as any)?.input?.command);
		if (why) return { block: true, reason: `CLONE FRAME anti-wipe: refusing ${why}.` };
		return undefined;
	});

	// ── open_panel — open/focus one of the app's 27 panels (drives the real window) ───────
	pi.registerTool({
		name: "open_panel",
		label: "Open panel",
		description:
			"Open one of CLONE FRAME's panels (tabs) in the running app window and focus it. Keys: terminal (CODE), shell (iT terminal), research (web browser), harness, lab, matrix, machine, agents, folders, email, notes, tasks, reminders, approval, automations, search, brain, agentview, theme, settings. There is no calendar, contacts, library, cookbook, compare, gallery or integrations panel — those were removed from the app; do not offer them. Titles like 'browser' (→research) or 'My Agents' (→agents) also resolve. This physically opens the tab on screen.",
		promptSnippet: "Open/focus a CLONE FRAME panel: open_panel{panel} (e.g. research, shell, notes, harness, settings)",
		parameters: Type.Object({
			panel: Type.String({ description: "Panel key or title, e.g. 'research', 'shell', 'notes'." }),
		}),
		async execute(_id, params) {
			try {
				const r = await driveApp("open_panel", { panel: params.panel });
				return text(r.ok ? r.out || `opened panel: ${r.key || params.panel}` : r.error || "failed", !r.ok);
			} catch (e: any) {
				return text(String(e?.message || e), true);
			}
		},
	});

	// ── read_screen — the agent's eyes: what is open/focused right now ────────────────────
	pi.registerTool({
		name: "read_screen",
		label: "Read screen",
		description:
			"See the CLONE FRAME screen RIGHT NOW: which panels are open, which is focused, which are docked/minimized, plus the active model, harness and iNFT for the CODE session. Your eyes on the app — call this before assuming any on-screen state instead of guessing.",
		promptSnippet: "Read the live app screen (open/focused/docked panels + active model): read_screen{}",
		parameters: Type.Object({}),
		async execute() {
			try {
				const r = await driveApp("read_screen", {});
				return text(r.ok ? asText(r.screen ?? r) : r.error || "failed", !r.ok);
			} catch (e: any) {
				return text(String(e?.message || e), true);
			}
		},
	});

	// ── list_panels — the static capability map (every openable panel) ────────────────────
	pi.registerTool({
		name: "list_panels",
		label: "List panels",
		description: "List every CLONE FRAME panel you can open — key, title and one-line purpose. The app's capability map.",
		promptSnippet: "List all openable CLONE FRAME panels: list_panels{}",
		parameters: Type.Object({}),
		async execute() {
			try {
				const r = await driveApp("list_panels", {});
				return text(r.ok ? asText(r.panels ?? r) : r.error || "failed", !r.ok);
			} catch (e: any) {
				return text(String(e?.message || e), true);
			}
		},
	});

	// ── close_panel / focus_panel ─────────────────────────────────────────────────────────
	pi.registerTool({
		name: "close_panel",
		label: "Close panel",
		description: "Close an open CLONE FRAME panel by key (the CODE panel that may host you cannot be closed).",
		promptSnippet: "Close an open panel: close_panel{panel}",
		parameters: Type.Object({ panel: Type.String({ description: "Panel key to close." }) }),
		async execute(_id, params) {
			try {
				const r = await driveApp("close_panel", { panel: params.panel });
				return text(r.ok ? r.out || `closed: ${params.panel}` : r.error || "failed", !r.ok);
			} catch (e: any) {
				return text(String(e?.message || e), true);
			}
		},
	});
	pi.registerTool({
		name: "focus_panel",
		label: "Focus panel",
		description: "Bring an already-open CLONE FRAME panel to the front (opens it if needed).",
		promptSnippet: "Focus/raise a panel: focus_panel{panel}",
		parameters: Type.Object({ panel: Type.String({ description: "Panel key to focus." }) }),
		async execute(_id, params) {
			try {
				const r = await driveApp("focus_panel", { panel: params.panel });
				return text(r.ok ? r.out || `focused: ${params.panel}` : r.error || "failed", !r.ok);
			} catch (e: any) {
				return text(String(e?.message || e), true);
			}
		},
	});

	// ── app_rpc — the full app as a tool: call ANY HUB Bridge module function ──────────────
	pi.registerTool({
		name: "app_rpc",
		label: "App RPC",
		description:
			"Call ANY CLONE FRAME HUB Bridge module function directly — the whole app is your toolbox. Useful modules: web (fn 'search'[q,{limit}], 'fetchUrl'[url]); files (read/list — write respects the owner's file permission); models (listProviders, brainStatus, keyAudit); harness (list, add, setActiveForTerminal); servers (list, run); matrix (status); search (query). THE OWNER'S OWN THINGS — these five are how you remember, plan and act for them, and each one is a panel they are looking at: brain (list, add[{text,topic:'identity'|'preference'|'project'|'fact',source}], update, remove — write a memory the moment they tell you a lasting fact about themselves); notes (list, get, create[{title,body,tags}], update, remove); tasks (list, add[{name,category,cron,action:'custom',prompt}], setState[id,'running'|'paused'], remove, runNow — a job the daemon runs on a clock, with or without a window open); reminders (list, create[{text,at}], snooze, markDone, due, counts); approvals (list, add[{type:'ai_email',accountId,to,subject,body,generatedBy}], approve, reject, count — an email you wrote WAITS here for the owner unless the autoEmail permission is on; queue it rather than dropping it); scheduled (schedule/list/cancel — email queued to leave at a set time). email (accounts, folders, list, message, send, removeAccount). YOUR OWN MAP: pi (fn 'refreshTree' — regenerate STRUCTURE.md from the real sources RIGHT NOW; run it after you change the body, so the map you navigate by is never older than the body it describes. 'docPaths' says where AGENTS.md, STRUCTURE.md and APPEND_SYSTEM.md live on disk. 'brain' — your own skills, extensions, sub-agents and curriculum, counted from disk). WEB3 (all public, keyless, READ-ONLY): nft (scanWallet[address,{}] — every token the wallet holds, each tagged isAgent; read[{contract,tokenId}]; balance; known; soul); virtuals (profile[address] — the person and EVERY wallet linked to them; holdings[address,{}] — their agents across all of those wallets, from the catalog, ACP incl. created-but-never-activated ones, and ERC-8004, each with its source wallet, activation state and real ACP job counts); robinhood (tokens, nfts); okxai (status, agents). Read calls are safe; state-changing calls respect the app's permission gates and may return REFUSED. Example: {\"module\":\"virtuals\",\"fn\":\"holdings\",\"args\":[\"0x…\",{}]}.",
		promptSnippet: "Call any CLONE FRAME bridge module: app_rpc{module,fn,args} (web.search, files.read, harness.list, nft.scanWallet, virtuals.holdings, …)",
		promptGuidelines: [
			"Use app_rpc for app data/actions that aren't a panel — searching the web via the app, reading files, listing/creating harnesses, operating servers.",
			"The owner's notes, tasks, reminders, approvals and memories are YOURS to read and write on their behalf. When they tell you a lasting fact about themselves, write it: brain.add. When they ask for something to happen later, put it where it will actually happen — reminders.create for a time they should be told, tasks.add for work the daemon should run on a clock. Telling them you will remember is not remembering.",
			"These five refer to each other. An email you want to send goes to approvals.add and waits; a task that should also nudge the owner gets a reminders.create beside it; a note that turns into work becomes a tasks.add with the note's text as the prompt. Say which panel you put it in, so they can go and look.",
			"Prefer the app's own web via app_rpc{module:'web',fn:'search'} or your web_search tool for facts — never invent.",
			"For anything on-chain — what a wallet owns, which agents the owner has, whether one is activated, what it has traded — call these modules BEFORE the open web: they are what the owner sees on screen, and a difference between your answer and theirs is a bug worth reporting. Start with virtuals.profile: a wallet is a graph, and an agent is owned by its OWN wallet, not the login one.",
		],
		parameters: Type.Object({
			module: Type.String({ description: "Bridge module, e.g. 'web', 'files', 'harness', 'notes', 'models', 'servers'." }),
			fn: Type.String({ description: "Function to call on the module." }),
			args: Type.Optional(Type.Array(Type.Unknown(), { description: "Positional arguments for the function." })),
		}),
		async execute(_id, params) {
			try {
				const r = await callModule(String(params.module), String(params.fn), (params.args as unknown[]) || []);
				return text(asText(r));
			} catch (e: any) {
				return text(String(e?.message || e), true);
			}
		},
	});

	// ── web_* — drive the real in-app browser (CDP engine via /mod/webengine) ─────────────
	// The BROWSER panel renders a real Chromium tab; these tools let pi navigate it, read it
	// (accessibility tree with stable refs), click/type, and screenshot it. With no `key`
	// they act on the tab the user is looking at — pi drives the browser on screen.
	const web = (fn: string, args: Record<string, unknown> = {}) => callModule("webengine", fn, [args]);

	pi.registerTool({
		name: "web_navigate",
		label: "Web navigate",
		description:
			"Open a URL (or go back/forward/reload) in the real in-app BROWSER — a live Chromium tab, full JS/WebGL/video. Renders the page the user sees. Use this, not fetch_content, when you need to interact with a page (click, type, log in) rather than just read static text.",
		promptSnippet: "Navigate the in-app browser: web_navigate{url} | {dir:'back'|'forward'|'reload'}",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "http(s) URL to open." })),
			dir: Type.Optional(Type.String({ description: "'back' | 'forward' | 'reload' instead of a url." })),
		}),
		async execute(_id, params) {
			try {
				const dir = String(params.dir || "");
				// dir routes to the engine's real history fns — navigate() ignores dir.
				if (!params.url && (dir === "back" || dir === "forward" || dir === "reload")) {
					const r = await web(dir, {});
					return text(asText(r), !r.ok);
				}
				const r = await web("navigate", { url: params.url });
				return text(asText(r), !r.ok);
			}
			catch (e: any) { return text(String(e?.message || e), true); }
		},
	});
	pi.registerTool({
		name: "web_read_page",
		label: "Web read page",
		description:
			"Read the current browser page as a compact accessibility tree: every interactive element gets a stable ref (r1, r2…) you can click, plus headings and text. Cheap and robust — call this before web_click to find what to click.",
		promptSnippet: "Read the browser page (a11y tree with click refs): web_read_page{}",
		parameters: Type.Object({}),
		async execute() {
			try { const r = await web("readPage", {}); return text(asText(r), !r.ok); }
			catch (e: any) { return text(String(e?.message || e), true); }
		},
	});
	pi.registerTool({
		name: "web_get_text",
		label: "Web get text",
		description: "Get the visible text (innerText) of the current browser page — for reading/summarizing content.",
		promptSnippet: "Get the browser page's visible text: web_get_text{}",
		parameters: Type.Object({}),
		async execute() {
			try { const r = await web("read", {}); return text(r.ok ? (r.text || "") : asText(r), !r.ok); }
			catch (e: any) { return text(String(e?.message || e), true); }
		},
	});
	pi.registerTool({
		name: "web_find",
		label: "Web find",
		description: "Find elements on the current browser page by a text query (searches the accessibility tree). Returns matching refs to click.",
		promptSnippet: "Find elements on the page: web_find{query}",
		parameters: Type.Object({ query: Type.String({ description: "Text to search for among page elements." }) }),
		async execute(_id, params) {
			try { const r = await web("find", { query: params.query }); return text(asText(r), !r.ok); }
			catch (e: any) { return text(String(e?.message || e), true); }
		},
	});
	pi.registerTool({
		name: "web_click",
		label: "Web click",
		description: "Click an element in the browser by its ref (from web_read_page/web_find), or by raw x,y pixel coordinates.",
		promptSnippet: "Click in the browser: web_click{ref} or web_click{x,y}",
		parameters: Type.Object({
			ref: Type.Optional(Type.String({ description: "Element ref from web_read_page (e.g. 'r3')." })),
			x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			try {
				const r = params.ref ? await web("clickRef", { ref: params.ref }) : await web("click", { x: params.x, y: params.y });
				return text(asText(r), !r.ok);
			} catch (e: any) { return text(String(e?.message || e), true); }
		},
	});
	pi.registerTool({
		name: "web_type",
		label: "Web type",
		description: "Type text into the browser. With a ref, it clicks that field first, then types; without a ref it types into whatever is focused.",
		promptSnippet: "Type into the browser: web_type{text, ref?}",
		parameters: Type.Object({
			text: Type.String({ description: "Text to type." }),
			ref: Type.Optional(Type.String({ description: "Optional field ref to focus first." })),
		}),
		async execute(_id, params) {
			try {
				if (params.ref) await web("clickRef", { ref: params.ref });
				const r = await web("type", { text: params.text });
				return text(asText(r), !r.ok);
			} catch (e: any) { return text(String(e?.message || e), true); }
		},
	});
	pi.registerTool({
		name: "web_screenshot",
		label: "Web screenshot",
		description: "Capture a JPEG screenshot of the current browser page (base64). Use it to SEE a page — its layout, a chart, a UI you're about to adapt.",
		promptSnippet: "Screenshot the browser page: web_screenshot{}",
		parameters: Type.Object({}),
		async execute() {
			try { const r = await web("screenshot", {}); return text(r.ok ? `[jpeg screenshot, ${Math.round((r.data || "").length * 0.75)} bytes base64 below]\n${r.data}` : asText(r), !r.ok); }
			catch (e: any) { return text(String(e?.message || e), true); }
		},
	});
	pi.registerTool({
		name: "web_downloads",
		label: "Web downloads",
		description:
			"What the browser has fetched to disk this session, newest first, with the real paths — so a file the owner just downloaded can be read, moved or worked on without asking where it went.",
		promptSnippet: "List what the browser downloaded: web_downloads{}",
		parameters: Type.Object({}),
		async execute() {
			try { const r = await web("downloads", {}); return text(asText(r), !r.ok); }
			catch (e: any) { return text(String(e?.message || e), true); }
		},
	});
	pi.registerTool({
		name: "web_selection",
		label: "Web selection",
		description:
			"Read the text currently selected on the page, or select the whole page first with all:true. The engine renders in its own process, so this is how text leaves a page — a copy keystroke inside it reaches nobody.",
		promptSnippet: "Read the page selection: web_selection{} · select everything first: web_selection{all:true}",
		parameters: Type.Object({
			all: Type.Optional(Type.Boolean({ description: "Select the whole page (or the focused field) before reading." })),
		}),
		async execute(_id, params) {
			try {
				if (params.all) await web("selectAll", {});
				const r = await web("selection", {});
				return text(r.ok ? (r.text || "(nothing is selected)") : asText(r), !r.ok);
			} catch (e: any) { return text(String(e?.message || e), true); }
		},
	});
	pi.registerTool({
		name: "web_console",
		label: "Web console",
		description: "Read the browser page's recent console messages and network responses — for debugging a page or verifying an app you built loads cleanly.",
		promptSnippet: "Read the page console + network: web_console{}",
		parameters: Type.Object({}),
		async execute() {
			try { const c = await web("consoleLog", {}); const n = await web("network", {}); return text(asText({ console: c.entries || c, network: n.requests || n })); }
			catch (e: any) { return text(String(e?.message || e), true); }
		},
	});
}
