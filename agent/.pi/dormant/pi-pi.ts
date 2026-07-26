/**
 * pi-pi — the meta-agent that teaches CLONE FRAME's pi to build ITSELF.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Ported from disler/pi-vs-claude-code (`extensions/pi-pi.ts`), MIT License,
 * Copyright (c) 2026 IndyDevDan. Porting is permitted with attribution — preserved here.
 * Original: https://github.com/disler/pi-vs-claude-code   ·   Adapted for CLONE FRAME by Fable.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * A team of read-only domain experts (extensions, themes, skills, settings, prompts, agents, cli,
 * keybindings) research pi's OWN subsystems in PARALLEL as concurrent `pi` subprocesses. The
 * primary agent (pi-orchestrator) synthesizes their findings and WRITES the actual component files.
 * This is the engine behind "pi edits its own body" — it forges extensions/themes/skills/agents.
 *
 * Experts live in  agent/.pi/agents/experts/*.md  (each an authoritative persona). The orchestrator
 * system prompt is  agent/.pi/agents/experts/pi-orchestrator.md.
 *
 * Commands:
 *   /experts          — list available experts and their status
 *   /experts-grid N   — set dashboard column count (default 3)
 *
 * ⚠️ SHIPS DORMANT. This extension is NOT in .pi/settings.json (advanced tooling). The owner enables
 *    it deliberately by adding "extensions/pi-pi.ts" to settings.json, or launching with `pi -e`.
 *
 * ⚠️ ISOLATED-RUNTIME CONCERN (identical to the fleet — see extensions/fleet.ts). Each expert is a
 *    spawned child `pi`. The CLONE FRAME invariant: the owner's global ~/.pi is NEVER mutated by a
 *    spawned child. fleet.ts solves this by asking the bridge for a throwaway runtime
 *    (POST /mod/pi {fn:"buildFleetRuntime"} → { dir, env }: an isolated PI_CODING_AGENT_DIR + a
 *    request-time CFHUB_PI_APIKEY, never on disk) AND spawning children with `-e anti-wipe.ts` so the
 *    ONE hard limit still fires inside the child.
 *
 *    This port keeps that SAME shape but STUBS the bridge call, to stay dormant + dependency-free:
 *      • production path (STUBBED) — wire childRuntime() to the bridge's buildFleetRuntime exactly as
 *        fleet.ts does, once pi-pi is armed for real.
 *      • today's path — inherit the parent session's already-isolated PI_CODING_AGENT_DIR (the bridge
 *        launches the parent pi with one), so ~/.pi is untouched and the BYOK key flows via env.
 *      • last resort — a throwaway temp dir, so we NEVER silently fall back to ~/.pi.
 *    Experts also spawn with `-e anti-wipe.ts` when present — the same guard fleet children keep.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// ── Types ────────────────────────────────────────

interface ExpertDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
}

interface ExpertState {
	def: ExpertDef;
	status: "idle" | "researching" | "done" | "error";
	question: string;
	elapsed: number;
	lastLine: string;
	queryCount: number;
	timer?: ReturnType<typeof setInterval>;
}

// ── Helpers ──────────────────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function parseAgentFile(filePath: string): ExpertDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}

// Isolated runtime dir for a spawned expert child (honors the ~/.pi-never-mutated invariant).
// Returns the dir to use as PI_CODING_AGENT_DIR + whether we created a throwaway to clean up.
function childRuntime(): { dir: string | undefined; ephemeral: boolean } {
	// PRODUCTION (stubbed): call the bridge's buildFleetRuntime here, exactly like fleet.ts, to get a
	// fresh throwaway { dir, env } seeded with the BYOK key at request time. Left unwired to keep
	// pi-pi dormant + dependency-free.
	// TODAY: inherit the parent session's already-isolated PI_CODING_AGENT_DIR (the bridge launches
	// the parent pi with one), so a child touches that isolated dir — never the owner's global ~/.pi.
	const inherited = process.env.PI_CODING_AGENT_DIR?.trim();
	if (inherited) return { dir: inherited, ephemeral: false };
	// LAST RESORT (e.g. launched from a bare shell): a throwaway dir so we never default to ~/.pi.
	try {
		return { dir: mkdtempSync(join(tmpdir(), "cfhub-pi-pi-")), ephemeral: true };
	} catch {
		return { dir: undefined, ephemeral: false };
	}
}

// ── Expert card colors ────────────────────────────
// Each expert gets a unique hue: bg fills the card interior, br is the matching brighter border.
const EXPERT_COLORS: Record<string, { bg: string; br: string }> = {
	"agent-expert":      { bg: "\x1b[48;2;20;30;75m",  br: "\x1b[38;2;70;110;210m"  }, // navy
	"config-expert":     { bg: "\x1b[48;2;18;65;30m",  br: "\x1b[38;2;55;175;90m"   }, // forest
	"ext-expert":        { bg: "\x1b[48;2;80;18;28m",  br: "\x1b[38;2;210;65;85m"   }, // crimson
	"keybinding-expert": { bg: "\x1b[48;2;50;22;85m",  br: "\x1b[38;2;145;80;220m"  }, // violet
	"prompt-expert":     { bg: "\x1b[48;2;80;55;12m",  br: "\x1b[38;2;215;150;40m"  }, // amber
	"skill-expert":      { bg: "\x1b[48;2;12;65;75m",  br: "\x1b[38;2;40;175;195m"  }, // teal
	"theme-expert":      { bg: "\x1b[48;2;80;18;62m",  br: "\x1b[38;2;210;55;160m"  }, // rose
	"cli-expert":        { bg: "\x1b[48;2;60;80;20m",  br: "\x1b[38;2;160;210;55m"  }, // olive/lime
};
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

// ── Extension ────────────────────────────────────

export default function piPi(pi: ExtensionAPI) {
	const experts: Map<string, ExpertState> = new Map();
	let gridCols = 3;
	let widgetCtx: any;

	function loadExperts(cwd: string) {
		// CLONE FRAME experts live in agent/.pi/agents/experts/ (adapted from disler's .pi/agents/pi-pi/).
		const expertsDir = join(cwd, ".pi", "agents", "experts");

		experts.clear();

		if (!existsSync(expertsDir)) return;
		try {
			for (const file of readdirSync(expertsDir)) {
				if (!file.endsWith(".md")) continue;
				if (file === "pi-orchestrator.md") continue; // the orchestrator is the primary, not an expert
				const fullPath = resolve(expertsDir, file);
				const def = parseAgentFile(fullPath);
				if (def) {
					const key = def.name.toLowerCase();
					if (!experts.has(key)) {
						experts.set(key, {
							def,
							status: "idle",
							question: "",
							elapsed: 0,
							lastLine: "",
							queryCount: 0,
						});
					}
				}
			}
		} catch {}
	}

	// ── Grid Rendering ───────────────────────────

	function renderCard(state: ExpertState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		const statusColor = state.status === "idle" ? "dim"
			: state.status === "researching" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "idle" ? "○"
			: state.status === "researching" ? "◉"
			: state.status === "done" ? "✓" : "✗";

		const name = displayName(state.def.name);
		const nameStr = theme.fg("accent", theme.bold(truncate(name, w)));
		const nameVisible = Math.min(name.length, w);

		const statusStr = `${statusIcon} ${state.status}`;
		const timeStr = state.status !== "idle" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const queriesStr = state.queryCount > 0 ? ` (${state.queryCount})` : "";
		const statusLine = theme.fg(statusColor, statusStr + timeStr + queriesStr);
		const statusVisible = statusStr.length + timeStr.length + queriesStr.length;

		const workRaw = state.question || state.def.description;
		const workText = truncate(workRaw, Math.min(50, w - 1));
		const workLine = theme.fg("muted", workText);
		const workVisible = workText.length;

		const lastRaw = state.lastLine || "";
		const lastText = truncate(lastRaw, Math.min(50, w - 1));
		const lastLineRendered = lastText ? theme.fg("dim", lastText) : theme.fg("dim", "—");
		const lastVisible = lastText ? lastText.length : 1;

		const colors = EXPERT_COLORS[state.def.name];
		const bg  = colors?.bg ?? "";
		const br  = colors?.br ?? "";
		const bgr = bg ? BG_RESET : "";
		const fgr = br ? FG_RESET : "";

		// br colors the box-drawing characters; bg fills behind them so the whole card is one block.
		const bord = (s: string) => bg + br + s + bgr + fgr;

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";

		const border = (content: string, visLen: number) => {
			const pad = " ".repeat(Math.max(0, w - visLen));
			return bord("│") + bg + content + bg + pad + bgr + bord("│");
		};

		return [
			bord(top),
			border(" " + nameStr, 1 + nameVisible),
			border(" " + statusLine, 1 + statusVisible),
			border(" " + workLine, 1 + workVisible),
			border(" " + lastLineRendered, 1 + lastVisible),
			bord(bot),
		];
	}

	function updateWidget() {
		if (!widgetCtx || typeof widgetCtx.ui?.setWidget !== "function") return;

		widgetCtx.ui.setWidget("pi-pi-grid", (_tui: any, theme: any) => {

			return {
				render(width: number): string[] {
					if (experts.size === 0) {
						return ["", theme.fg("dim", "  No experts found. Add agent .md files to .pi/agents/experts/")];
					}

					const cols = Math.min(gridCols, experts.size);
					const gap = 1;
					const colWidth = Math.floor((width - gap * (cols - 1)) / cols) - 1;
					const allExperts = Array.from(experts.values());

					const lines: string[] = [""]; // top margin

					for (let i = 0; i < allExperts.length; i += cols) {
						const rowExperts = allExperts.slice(i, i + cols);
						const cards = rowExperts.map(e => renderCard(e, colWidth, theme));

						while (cards.length < cols) {
							cards.push(Array(6).fill(" ".repeat(colWidth)));
						}

						const cardHeight = cards[0].length;
						for (let line = 0; line < cardHeight; line++) {
							lines.push(cards.map(card => card[line] || "").join(" ".repeat(gap)));
						}
					}

					return lines;
				},
				invalidate() {},
			};
		});
	}

	// ── Query one Expert (spawns an isolated, read-only child `pi`) ───────────

	function queryExpert(
		expertName: string,
		question: string,
		ctx: any,
	): Promise<{ output: string; exitCode: number; elapsed: number }> {
		const key = expertName.toLowerCase();
		const state = experts.get(key);
		if (!state) {
			return Promise.resolve({
				output: `Expert "${expertName}" not found. Available: ${Array.from(experts.values()).map(s => s.def.name).join(", ")}`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		if (state.status === "researching") {
			return Promise.resolve({
				output: `Expert "${displayName(state.def.name)}" is already researching. Wait for it to finish.`,
				exitCode: 1,
				elapsed: 0,
			});
		}

		state.status = "researching";
		state.question = question;
		state.elapsed = 0;
		state.lastLine = "";
		state.queryCount++;
		updateWidget();

		const startTime = Date.now();
		state.timer = setInterval(() => {
			state.elapsed = Date.now() - startTime;
			updateWidget();
		}, 1000);

		// Model: reuse the session's current model (BYOK). If the host doesn't expose it, OMIT --model
		// and let the child resolve its own default — never hardcode a vendor (model-agnostic invariant).
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";

		// Carry the anti-wipe guard into the child (same as fleet children): experts are read-only but
		// hold `bash`, so the ONE hard limit must still fire inside them. Best-effort: only if present.
		const antiWipe = ctx?.cwd ? join(ctx.cwd, ".pi", "extensions", "anti-wipe.ts") : "";
		const antiWipeArgs = antiWipe && existsSync(antiWipe) ? ["-e", antiWipe] : [];

		const args = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--no-extensions",
			...antiWipeArgs,
			...(model ? ["--model", model] : []),
			"--tools", state.def.tools,
			"--thinking", "off",
			"--append-system-prompt", state.def.systemPrompt,
			question,
		];

		// Isolated runtime dir so a child never mutates the owner's global ~/.pi (see childRuntime()).
		const rt = childRuntime();
		const childEnv = { ...process.env };
		if (rt.dir) childEnv.PI_CODING_AGENT_DIR = rt.dir;

		const textChunks: string[] = [];

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
			});

			let buffer = "";

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") {
								textChunks.push(delta.delta || "");
								const full = textChunks.join("");
								const last = full.split("\n").filter((l: string) => l.trim()).pop() || "";
								state.lastLine = last;
								updateWidget();
							}
						}
					} catch {}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", () => {});

			const finish = (code: number | null) => {
				if (rt.ephemeral && rt.dir) {
					try { rmSync(rt.dir, { recursive: true, force: true }); } catch {}
				}

				clearInterval(state.timer);
				state.elapsed = Date.now() - startTime;
				state.status = code === 0 ? "done" : "error";

				const full = textChunks.join("");
				state.lastLine = full.split("\n").filter((l: string) => l.trim()).pop() || "";
				updateWidget();

				ctx.ui?.notify?.(
					`${displayName(state.def.name)} ${state.status} in ${Math.round(state.elapsed / 1000)}s`,
					state.status === "done" ? "success" : "error",
				);

				resolve({
					output: full,
					exitCode: code ?? 1,
					elapsed: state.elapsed,
				});
			};

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_update") {
							const delta = event.assistantMessageEvent;
							if (delta?.type === "text_delta") textChunks.push(delta.delta || "");
						}
					} catch {}
				}
				finish(code);
			});

			proc.on("error", (err) => {
				if (rt.ephemeral && rt.dir) {
					try { rmSync(rt.dir, { recursive: true, force: true }); } catch {}
				}
				clearInterval(state.timer);
				state.status = "error";
				state.lastLine = `Error: ${err.message}`;
				updateWidget();
				resolve({
					output: `Error spawning expert: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
				});
			});
		});
	}

	// ── query_experts Tool (parallel fan-out) ───────────

	pi.registerTool({
		name: "query_experts",
		label: "Query Experts",
		description: `Query one or more CLONE FRAME pi domain experts IN PARALLEL. All experts run simultaneously as concurrent subprocesses.

Pass an array of queries — each with an expert name and a specific question. All experts start at the same time and their results are returned together.

Available experts:
- ext-expert: Extensions — tools, events, commands, shortcuts, rendering, state management
- theme-expert: Themes — JSON format, 51 color tokens, vars, color values
- skill-expert: Skills — SKILL.md packages, scripts, references, frontmatter
- config-expert: Settings — settings.json, providers, models, packages, keybindings
- prompt-expert: Prompt templates — single-file .md commands, arguments ($1, $@)
- agent-expert: Agent definitions — .md personas, tools, teams.yaml, chains, orchestration
- cli-expert: CLI — flags, output modes (json/rpc), env vars, isolated/headless spawn
- keybinding-expert: Keyboard shortcuts — registerShortcut(), Key IDs, reserved keys, macOS terminal compatibility

Ask specific questions about what you need to BUILD. Each expert returns documentation excerpts, code patterns, and implementation guidance for CLONE FRAME's pi (@earendil-works/pi-coding-agent).`,

		parameters: Type.Object({
			queries: Type.Array(
				Type.Object({
					expert: Type.String({
						description: "Expert name: ext-expert, theme-expert, skill-expert, config-expert, prompt-expert, agent-expert, cli-expert, or keybinding-expert",
					}),
					question: Type.String({
						description: "Specific question about what you need to build. Include context about the target component.",
					}),
				}),
				{ description: "Array of expert queries to run in parallel" },
			),
		}),

		async execute(_toolCallId: string, params: any, _signal: any, onUpdate: any, ctx: any) {
			const { queries } = params as { queries: { expert: string; question: string }[] };

			if (!queries || queries.length === 0) {
				return {
					content: [{ type: "text", text: "No queries provided." }],
					details: { results: [], status: "error" },
				};
			}

			const names = queries.map(q => displayName(q.expert)).join(", ");
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Querying ${queries.length} experts in parallel: ${names}` }],
					details: { queries, status: "researching", results: [] },
				});
			}

			// Launch ALL experts concurrently — allSettled so one failure never discards the others.
			const settled = await Promise.allSettled(
				queries.map(async ({ expert, question }) => {
					const result = await queryExpert(expert, question, ctx);
					const truncated = result.output.length > 12000
						? result.output.slice(0, 12000) + "\n\n... [truncated — ask follow-up for more]"
						: result.output;
					const status = result.exitCode === 0 ? "done" : "error";
					return {
						expert,
						question,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						output: truncated,
						fullOutput: result.output,
					};
				}),
			);

			const results = settled.map((s, i) =>
				s.status === "fulfilled"
					? s.value
					: {
						expert: queries[i].expert,
						question: queries[i].question,
						status: "error" as const,
						elapsed: 0,
						exitCode: 1,
						output: `Error: ${(s.reason as any)?.message || s.reason}`,
						fullOutput: "",
					},
			);

			const sections = results.map(r => {
				const icon = r.status === "done" ? "✓" : "✗";
				return `## [${icon}] ${displayName(r.expert)} (${Math.round(r.elapsed / 1000)}s)\n\n${r.output}`;
			});

			return {
				content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
				details: {
					results,
					status: results.every(r => r.status === "done") ? "done" : "partial",
				},
			};
		},

		renderCall(args: any, theme: any) {
			const queries = (args as any).queries || [];
			const names = queries.map((q: any) => displayName(q.expert || "?")).join(", ");
			return new Text(
				theme.fg("toolTitle", theme.bold("query_experts ")) +
				theme.fg("accent", `${queries.length} parallel`) +
				theme.fg("dim", " — ") +
				theme.fg("muted", names),
				0, 0,
			);
		},

		renderResult(result: any, options: any, theme: any) {
			const details = result.details as any;
			if (!details?.results) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "researching") {
				const count = details.queries?.length || "?";
				return new Text(
					theme.fg("accent", `◉ ${count} experts`) +
					theme.fg("dim", " researching in parallel..."),
					0, 0,
				);
			}

			const lines = (details.results as any[]).map((r: any) => {
				const icon = r.status === "done" ? "✓" : "✗";
				const color = r.status === "done" ? "success" : "error";
				const elapsed = typeof r.elapsed === "number" ? Math.round(r.elapsed / 1000) : 0;
				return theme.fg(color, `${icon} ${displayName(r.expert)}`) +
					theme.fg("dim", ` ${elapsed}s`);
			});

			const header = lines.join(theme.fg("dim", " · "));

			if (options.expanded && details.results) {
				const expanded = (details.results as any[]).map((r: any) => {
					const output = r.fullOutput
						? (r.fullOutput.length > 4000 ? r.fullOutput.slice(0, 4000) + "\n... [truncated]" : r.fullOutput)
						: r.output || "";
					return theme.fg("accent", `── ${displayName(r.expert)} ──`) + "\n" + theme.fg("muted", output);
				});
				return new Text(header + "\n\n" + expanded.join("\n\n"), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("experts", {
		description: "List available Pi Pi experts and their status",
		handler: async (_args: any, _ctx: any) => {
			widgetCtx = _ctx;
			const lines = Array.from(experts.values())
				.map(s => `${displayName(s.def.name)} (${s.status}, queries: ${s.queryCount}): ${s.def.description}`)
				.join("\n");
			_ctx.ui?.notify?.(lines || "No experts loaded", "info");
		},
	});

	pi.registerCommand("experts-grid", {
		description: "Set expert grid columns: /experts-grid <1-5>",
		handler: async (args: any, _ctx: any) => {
			widgetCtx = _ctx;
			const n = parseInt((args?.trim?.() ?? args) || "", 10);
			if (n >= 1 && n <= 5) {
				gridCols = n;
				_ctx.ui?.notify?.(`Grid set to ${gridCols} columns`, "info");
				updateWidget();
			} else {
				_ctx.ui?.notify?.("Usage: /experts-grid <1-5>", "error");
			}
		},
	});

	// ── System Prompt (loads the pi-orchestrator persona, fills the expert catalog) ────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		const expertCatalog = Array.from(experts.values())
			.map(s => `### ${displayName(s.def.name)}\n**Query as:** \`${s.def.name}\`\n${s.def.description}`)
			.join("\n\n");

		const expertNames = Array.from(experts.values()).map(s => displayName(s.def.name)).join(", ");

		const orchestratorPath = join(_ctx.cwd, ".pi", "agents", "experts", "pi-orchestrator.md");
		let systemPrompt = "";
		try {
			const raw = readFileSync(orchestratorPath, "utf-8");
			const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			const template = match ? match[2].trim() : raw;

			systemPrompt = template
				.replace("{{EXPERT_COUNT}}", experts.size.toString())
				.replace("{{EXPERT_NAMES}}", expertNames)
				.replace("{{EXPERT_CATALOG}}", expertCatalog);
		} catch {
			systemPrompt = "Error: Could not load pi-orchestrator.md. Make sure it exists in .pi/agents/experts/.";
		}

		return { systemPrompt };
	});

	// ── Session Start ────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		if (widgetCtx && typeof widgetCtx.ui?.setWidget === "function") {
			widgetCtx.ui.setWidget("pi-pi-grid", undefined);
		}
		widgetCtx = _ctx;

		loadExperts(_ctx.cwd);
		updateWidget();

		const expertNames = Array.from(experts.values()).map(s => displayName(s.def.name)).join(", ");
		_ctx.ui?.setStatus?.("pi-pi", `Pi Pi (${experts.size} experts)`);
		_ctx.ui?.notify?.(
			`Pi Pi loaded — ${experts.size} experts: ${expertNames}\n\n` +
			`/experts          List experts and status\n` +
			`/experts-grid N   Set grid columns (1-5)\n\n` +
			`Ask me to build any CLONE FRAME pi component (extension, theme, skill, agent)!`,
			"info",
		);

		// Custom footer (skipped gracefully on headless hosts that don't expose setFooter).
		if (typeof _ctx.ui?.setFooter !== "function") return;
		_ctx.ui.setFooter((_tui: any, theme: any, _footerData: any) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				const usage = typeof _ctx.getContextUsage === "function" ? _ctx.getContextUsage() : null;
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const active = Array.from(experts.values()).filter(e => e.status === "researching").length;
				const done = Array.from(experts.values()).filter(e => e.status === "done").length;

				const left = theme.fg("dim", ` ${model}`) +
					theme.fg("muted", " · ") +
					theme.fg("accent", "Pi Pi");
				const mid = active > 0
					? theme.fg("accent", ` ◉ ${active} researching`)
					: done > 0
					? theme.fg("success", ` ✓ ${done} done`)
					: "";
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(mid) - visibleWidth(right)));

				return [truncateToWidth(left + mid + pad + right, width)];
			},
		}));
	});
}
