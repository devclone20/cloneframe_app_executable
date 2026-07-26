/**
 * fleet — Pi's sub-agent fleet. Bulk, parallel and pipelined work, delegated to throwaway
 * children so the main model never burns its context on volume.
 *
 * Pi is the mind and the single driver of the CLONE FRAME body. When there is grunt work —
 * research a dozen repos, read a pile of files, build a well-scoped piece, adversarially verify
 * it, or get a second opinion from a stronger model — Pi calls the `fleet` tool. Each task runs
 * in a SEPARATE `pi` process with its own isolated context window, then reports back. Children
 * are drivers of nothing: they spawn with `--no-extensions -e anti-wipe.ts`, so they keep ONLY
 * the anti-wipe limit and none of the app tools.
 *
 * Mechanism (from the official pi subagent example, v0.81.1 — examples/extensions/subagent):
 *   pi --mode json -p --no-session --no-extensions -e <abs anti-wipe.ts> \
 *      [--provider cfhub --model <resolved>] [--tools a,b] \
 *      --append-system-prompt <agent .md body> "Task: <task>"
 * We read JSON events off stdout and collect the final assistant text.
 *
 * ISOLATION (the hard invariant): the owner's global ~/.pi is NEVER mutated. `--model` persists
 * to the agent dir's settings.json, so every child MUST run in a throwaway PI_CODING_AGENT_DIR.
 * The extension does NOT build that dir or touch any key — it asks the bridge, exactly like the
 * `it` CLI and clone-frame do: POST /mod/pi {fn:"buildFleetRuntime", args:[{agent}]} → the
 * bridge resolves the agent's model CLASS against the owner's BYOK providers server-side and
 * returns { ok, dir, env, provider, model }. We set PI_CODING_AGENT_DIR=dir and merge env
 * (carries CFHUB_PI_APIKEY, resolved at request time — never on disk). No provider or key is ever
 * hardcoded here.
 *
 * Modes:
 *   single    { agent, task }
 *   parallel  { tasks: [{agent, task}, ...] }        (max 8, 4 concurrent, 50KB output cap/task)
 *   chain     { chain: [{agent, task}, ...] }         (sequential, {previous} → prior output)
 *   team      { team, task }                           (parallel over a named group in teams.yaml)
 *   pipeline  { pipeline, task }                       (chain from chains.yaml; {input}/{previous})
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const TASK_TIMEOUT_MS = 180_000;

const ENDPOINT = process.env.CFHUB_BRIDGE || "http://127.0.0.1:8765";
const TOKEN_PATH = join(homedir(), ".clone-frame-hub", "bridge.token");
const INSTALLED_PI = join(homedir(), ".clone-frame-hub", "agent", ".pi");

const text = (s: string, isError = false) => ({ content: [{ type: "text" as const, text: s }], isError });

// ── Bridge access (identical token-gated pattern to clone-frame.ts) ─────────────────────────
function bridgeToken(): string {
	try {
		return readFileSync(TOKEN_PATH, "utf8").trim();
	} catch {
		return "";
	}
}
async function callModule(module: string, fn: string, args: unknown[] = []): Promise<any> {
	const t = bridgeToken();
	if (!t) throw new Error("no HUB Bridge token at ~/.clone-frame-hub/bridge.token — is CLONE FRAME installed?");
	let res: Response;
	try {
		res = await fetch(`${ENDPOINT}/mod/${module}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
			body: JSON.stringify({ fn, args }),
		});
	} catch {
		throw new Error("the HUB Bridge is not running — open CLONE FRAME first");
	}
	if (!res.ok) throw new Error(`HUB Bridge HTTP ${res.status}`);
	return await res.json();
}

// ── Locate sibling workspace files (works both in the bundle and the installed ~/.clone-frame-hub copy) ─
function here(): string | null {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return null;
	}
}
function firstExisting(paths: (string | null)[], fallback: string): string {
	for (const p of paths) if (p && existsSync(p)) return p;
	return fallback;
}
function antiWipePath(): string {
	const dir = here();
	return firstExisting(
		[dir ? join(dir, "anti-wipe.ts") : null, join(INSTALLED_PI, "extensions", "anti-wipe.ts")],
		join(INSTALLED_PI, "extensions", "anti-wipe.ts"),
	);
}
function agentsDir(): string {
	const dir = here();
	return firstExisting(
		[dir ? join(dir, "..", "agents") : null, join(INSTALLED_PI, "agents")],
		join(INSTALLED_PI, "agents"),
	);
}

// ── Agent definitions: markdown + YAML frontmatter in agents/<name>.md ──────────────────────
interface AgentDef {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
}
function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
	const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { frontmatter: {}, body: raw };
	const frontmatter: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const i = line.indexOf(":");
		if (i < 0) continue;
		const key = line.slice(0, i).trim();
		let val = line.slice(i + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
		frontmatter[key] = val;
	}
	return { frontmatter, body: m[2] || "" };
}
function loadAgent(name: string): AgentDef | null {
	const filePath = join(agentsDir(), `${name}.md`);
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	const { frontmatter, body } = parseFrontmatter(raw);
	if (!frontmatter.name) return null;
	const tools = frontmatter.tools
		?.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	return {
		name: frontmatter.name,
		description: frontmatter.description || "",
		tools: tools && tools.length > 0 ? tools : undefined,
		model: frontmatter.model,
		systemPrompt: body.trim(),
		filePath,
	};
}
function listAgentNames(): string[] {
	try {
		return readdirSync(agentsDir())
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.slice(0, -3))
			.sort();
	} catch {
		return [];
	}
}

// ── teams.yaml / chains.yaml (constrained, deterministic subset — our own files) ────────────
function readWs(file: string): string {
	try {
		return readFileSync(join(agentsDir(), file), "utf8");
	} catch {
		return "";
	}
}
function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// teams.yaml uses inline flow lists:  <name>: [a, b, c]
function loadTeam(name: string): string[] | null {
	const raw = readWs("teams.yaml");
	if (!raw) return null;
	const m = raw.match(new RegExp(`^\\s+${escapeRe(name)}\\s*:\\s*\\[(.*)\\]\\s*$`, "m"));
	if (!m) return null;
	const members = m[1]
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return members.length ? members : null;
}
interface ChainStep {
	agent: string;
	task?: string;
}
// chains.yaml:  <name>:\n    - agent: NAME\n      task: "…"
function loadChain(name: string): ChainStep[] | null {
	const raw = readWs("chains.yaml");
	if (!raw) return null;
	const lines = raw.split(/\r?\n/);
	let i = lines.findIndex((l) => new RegExp(`^\\s{2}${escapeRe(name)}\\s*:\\s*$`).test(l));
	if (i < 0) return null;
	const steps: ChainStep[] = [];
	for (i = i + 1; i < lines.length; i++) {
		const l = lines[i];
		if (l.trim() === "") continue;
		const indent = (l.match(/^\s*/) as RegExpMatchArray)[0].length;
		if (indent < 4) break; // dedented out of this chain
		const am = l.match(/^\s{4}-\s*agent:\s*(.+?)\s*$/);
		if (am) {
			steps.push({ agent: am[1].trim() });
			continue;
		}
		const tm = l.match(/^\s{6}task:\s*(.+)$/);
		if (tm && steps.length) {
			let v = tm[1].trim();
			if (v.startsWith('"')) {
				try {
					v = JSON.parse(v);
				} catch {
					/* keep raw */
				}
			}
			steps[steps.length - 1].task = v;
		}
	}
	return steps.length ? steps : null;
}

// ── Isolated runtime for a child, from the bridge (never mutates the owner's ~/.pi) ─────────
interface FleetRuntime {
	dir?: string;
	env?: Record<string, string>;
	provider?: string | null;
	model?: string | null;
}
async function buildRuntime(agentName: string): Promise<FleetRuntime> {
	const r = await callModule("pi", "buildFleetRuntime", [{ agent: agentName }]);
	if (!r || r.ok === false) throw new Error((r && r.error) || "buildFleetRuntime failed");
	return { dir: r.dir, env: r.env || {}, provider: r.provider ?? null, model: r.model ?? null };
}

// ── Resolve how to invoke pi (from the official example — handles node/bun/compiled) ────────
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

interface SingleResult {
	agent: string;
	task: string;
	ok: boolean;
	output: string;
	stderr: string;
	exitCode: number;
	stopReason?: string;
	timedOut: boolean;
	error?: string;
}

function finalAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) if (part && part.type === "text" && part.text) return part.text as string;
		}
	}
	return "";
}
function capOutput(output: string): string {
	const bytes = Buffer.byteLength(output, "utf8");
	if (bytes <= PER_TASK_OUTPUT_CAP) return output;
	let t = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(t, "utf8") > PER_TASK_OUTPUT_CAP) t = t.slice(0, -1);
	return `${t}\n\n[Output truncated: ${bytes - Buffer.byteLength(t, "utf8")} bytes omitted.]`;
}

async function runSingleAgent(
	agentName: string,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<SingleResult> {
	const base: SingleResult = { agent: agentName, task, ok: false, output: "", stderr: "", exitCode: 0, timedOut: false };

	const agent = loadAgent(agentName);
	if (!agent) {
		const avail = listAgentNames().join(", ") || "none";
		return { ...base, exitCode: 1, error: `Unknown agent "${agentName}". Available: ${avail}.` };
	}

	// Isolated throwaway runtime (PI_CODING_AGENT_DIR + key by env) — bridge is the authority.
	let rt: FleetRuntime;
	try {
		rt = await buildRuntime(agent.name);
	} catch (e: any) {
		return { ...base, exitCode: 1, error: `could not build isolated runtime for "${agentName}": ${String(e?.message || e)}` };
	}

	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "-e", antiWipePath()];
	if (rt.provider) args.push("--provider", rt.provider);
	if (rt.model) args.push("--model", rt.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	// Agent .md body → the child's system prompt, via a temp file (mode 0600), cleaned up after.
	let tmpDir: string | null = null;
	if (agent.systemPrompt) {
		try {
			tmpDir = mkdtempSync(join(tmpdir(), "cf-fleet-"));
			const promptFile = join(tmpDir, `system-${agent.name.replace(/[^\w.-]+/g, "_")}.md`);
			writeFileSync(promptFile, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", promptFile);
		} catch {
			tmpDir = null;
		}
	}
	args.push(`Task: ${task}`);

	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		PI_SKIP_VERSION_CHECK: "1",
		...(rt.dir ? { PI_CODING_AGENT_DIR: rt.dir } : {}),
		...(rt.env || {}),
	};

	try {
		const messages: any[] = [];
		let deltas = "";
		let stderr = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let timedOut = false;

		const exitCode = await new Promise<number>((resolve) => {
			const inv = getPiInvocation(args);
			const proc = spawn(inv.command, inv.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });
			let buffer = "";

			const onLine = (line: string) => {
				if (!line.trim()) return;
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					return;
				}
				if (ev.type === "message_end" && ev.message) {
					const msg = ev.message;
					messages.push(msg);
					if (msg.role === "assistant") {
						if (msg.stopReason) stopReason = msg.stopReason;
						if (msg.errorMessage) errorMessage = msg.errorMessage;
					}
				} else if (ev.type === "message_update") {
					const a = ev.assistantMessageEvent;
					if (a && a.type === "text_delta" && a.delta) deltas += a.delta;
				}
			};

			proc.stdout.on("data", (d) => {
				buffer += d.toString();
				const parts = buffer.split("\n");
				buffer = parts.pop() || "";
				for (const p of parts) onLine(p);
			});
			proc.stderr.on("data", (d) => {
				stderr += d.toString();
			});

			const timer = setTimeout(() => {
				timedOut = true;
				try {
					proc.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				setTimeout(() => {
					try {
						if (!proc.killed) proc.kill("SIGKILL");
					} catch {
						/* ignore */
					}
				}, 4000);
			}, TASK_TIMEOUT_MS);

			const onAbort = () => {
				timedOut = true;
				try {
					proc.kill("SIGTERM");
				} catch {
					/* ignore */
				}
			};
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			proc.on("close", (code) => {
				clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);
				if (buffer.trim()) onLine(buffer);
				resolve(code ?? 0);
			});
			proc.on("error", () => {
				clearTimeout(timer);
				resolve(1);
			});
		});

		const output = finalAssistantText(messages) || deltas.trim();
		const failed = exitCode !== 0 || timedOut || stopReason === "error" || stopReason === "aborted";
		return {
			...base,
			ok: !failed,
			output,
			stderr,
			exitCode,
			stopReason,
			timedOut,
			error: failed ? errorMessage || (timedOut ? `timed out after ${TASK_TIMEOUT_MS / 1000}s` : "") || stderr : undefined,
		};
	} finally {
		if (tmpDir)
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
	}
}

async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let next = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const cur = next++;
			if (cur >= items.length) return;
			results[cur] = await fn(items[cur], cur);
		}
	});
	await Promise.all(workers);
	return results;
}

function resultOutput(r: SingleResult): string {
	if (!r.ok) return r.error || r.stderr || r.output || "(no output)";
	return r.output || "(no output)";
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the fleet agent to run (scout, reader, builder, critic, consult, …)." }),
	task: Type.String({ description: "The task to delegate to that agent." }),
});
const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the fleet agent to run." }),
	task: Type.String({ description: "Task, with an optional {previous} placeholder for the prior step's output." }),
});

export default function fleet(pi: ExtensionAPI) {
	pi.registerTool({
		name: "fleet",
		label: "Fleet",
		description: [
			"Delegate work to a fleet of sub-agents, each in its own isolated pi process (separate context window).",
			"Use it for VOLUME and PARALLELISM so you never burn your own context on grunt work: research, reading, well-scoped building, adversarial verification, or a second opinion from a stronger model.",
			"Factory agents: scout (web/GitHub research), reader (read/summarize files & repos), builder (well-scoped code), critic (adversarial verification), consult (the STRONGEST configured model — a smarter second opinion that reviews/corrects your work).",
			"Modes: single {agent,task}; parallel {tasks:[…]} (max 8, 4 at a time); chain {chain:[…]} (sequential, use {previous} for the prior output); team {team,task} (parallel over a named group in teams.yaml, e.g. 'research' or 'full'); pipeline {pipeline,task} (a named chain in chains.yaml, e.g. 'research-build-verify'; {input}=your task, {previous}=prior step).",
			"Children keep only the anti-wipe limit (no app tools). Models are the owner's BYOK — resolved per agent class by the bridge, never hardcoded.",
		].join(" "),
		promptSnippet:
			"Delegate to sub-agents: fleet{agent,task} | {tasks:[…]} | {chain:[…]} | {team,task} | {pipeline,task}. consult = a stronger LLM's second opinion.",
		promptGuidelines: [
			"Reach for the fleet BEFORE doing repetitive research/reading yourself — spawn scout/reader in parallel and synthesize their reports.",
			"When you are stuck or want your work checked, run consult (the strongest model) — that is the engineer's escalation, not a weakness.",
			"Give each child a closed, self-contained task: it cannot see this conversation or the app, only its system prompt and the task text.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Single mode: the agent to run." })),
			task: Type.Optional(Type.String({ description: "The task text (single / team / pipeline modes)." })),
			tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel mode: array of {agent, task}." })),
			chain: Type.Optional(Type.Array(ChainItem, { description: "Chain mode: sequential {agent, task}; {previous} threads prior output." })),
			team: Type.Optional(Type.String({ description: "Team mode: a named group in teams.yaml — every member runs `task` in parallel." })),
			pipeline: Type.Optional(Type.String({ description: "Pipeline mode: a named chain in chains.yaml — {input}=task, {previous}=prior step." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for the child processes (defaults to the current one)." })),
		}),

		async execute(_id, params, signal, _onUpdate, ctx) {
			const cwd = params.cwd || ctx?.cwd || process.cwd();

			// Expand team → parallel tasks, pipeline → chain, up front.
			let tasks = params.tasks;
			let chain = params.chain as ChainItem[] | undefined;

			if (params.team) {
				const members = loadTeam(params.team);
				if (!members) return text(`Unknown team "${params.team}". Teams are defined in agents/teams.yaml.`, true);
				if (!params.task) return text(`team mode needs a task: fleet{team:"${params.team}", task:"…"}.`, true);
				tasks = members.map((m) => ({ agent: m, task: params.task as string }));
			}
			if (params.pipeline) {
				const steps = loadChain(params.pipeline);
				if (!steps) return text(`Unknown pipeline "${params.pipeline}". Pipelines are defined in agents/chains.yaml.`, true);
				const objective = params.task || "";
				chain = steps.map((s, idx) => {
					const tmpl =
						s.task ??
						(idx === 0
							? "{input}"
							: "Continue the pipeline toward the objective.\n\nObjective:\n{input}\n\nPrevious step output:\n{previous}");
					return { agent: s.agent, task: tmpl.replace(/\{input\}/g, objective) };
				});
			}

			const hasSingle = Boolean(params.agent && params.task) && !params.team && !params.pipeline;
			const hasTasks = (tasks?.length ?? 0) > 0;
			const hasChain = (chain?.length ?? 0) > 0;
			const modeCount = Number(hasSingle) + Number(hasTasks) + Number(hasChain);
			if (modeCount !== 1) {
				const avail = listAgentNames().join(", ") || "none";
				return text(
					`Provide exactly one of: {agent,task} · {tasks:[…]} · {chain:[…]} · {team,task} · {pipeline,task}.\nAvailable agents: ${avail}`,
					true,
				);
			}

			// ── chain (also serves pipeline) ────────────────────────────────────────────────
			if (hasChain && chain) {
				const results: SingleResult[] = [];
				let previous = "";
				for (let i = 0; i < chain.length; i++) {
					const step = chain[i];
					const task = step.task.replace(/\{previous\}/g, previous);
					const r = await runSingleAgent(step.agent, task, cwd, signal);
					results.push(r);
					if (!r.ok)
						return text(`Chain stopped at step ${i + 1} (${step.agent}): ${resultOutput(r)}`, true);
					previous = r.output;
				}
				const last = results[results.length - 1];
				const trail = results
					.map((r, i) => `### Step ${i + 1} · ${r.agent} ✓\n\n${capOutput(resultOutput(r))}`)
					.join("\n\n---\n\n");
				return text(`Pipeline complete (${results.length} steps).\n\n${trail}\n\n---\n\nFinal output:\n\n${capOutput(resultOutput(last))}`);
			}

			// ── parallel (also serves team) ─────────────────────────────────────────────────
			if (hasTasks && tasks) {
				if (tasks.length > MAX_PARALLEL_TASKS)
					return text(`Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`, true);
				const results = await mapWithConcurrency(tasks, MAX_CONCURRENCY, (t) =>
					runSingleAgent(t.agent, t.task, cwd, signal),
				);
				const okCount = results.filter((r) => r.ok).length;
				const blocks = results
					.map((r) => `### [${r.agent}] ${r.ok ? "completed" : `failed${r.stopReason ? ` (${r.stopReason})` : ""}`}\n\n${capOutput(resultOutput(r))}`)
					.join("\n\n---\n\n");
				return text(`Fleet: ${okCount}/${results.length} succeeded\n\n${blocks}`, okCount === 0);
			}

			// ── single ──────────────────────────────────────────────────────────────────────
			const r = await runSingleAgent(params.agent as string, params.task as string, cwd, signal);
			if (!r.ok) return text(`Agent ${r.agent} ${r.stopReason || (r.timedOut ? "timed out" : "failed")}: ${resultOutput(r)}`, true);
			return text(capOutput(resultOutput(r)));
		},
	});
}
