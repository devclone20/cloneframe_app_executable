/**
 * goal — a self-sustaining goal loop for the Pi agent, ported from NousResearch/hermes-agent's
 * `/goal` ("our take on the Ralph loop") onto pi v0.81.1 primitives.
 *
 * The shape (research/06 §7): ONE state file + ONE command + ONE post-turn listener + ONE judge call.
 *   • `/goal <text>`  — capture a goal, with an optional 5-field completion contract written inline
 *                       as `verify: … constraints: … boundaries: … stop when: …`. Kicks off by
 *                       enqueuing the goal as a normal user message (pi.sendUserMessage).
 *   • `agent_settled` — the post-turn hook. After every turn, if a goal is active and the user did
 *                       NOT just interject, a cheap auxiliary model judges the agent's last response.
 *   • the judge       — a SEPARATE completion (temperature 0) using the agent's own BYOK model, with
 *                       Hermes' 3-verdict contract DONE / CONTINUE / WAIT. Fails OPEN to CONTINUE; the
 *                       turn budget is the backstop. 3 parse fails or 5 transport fails auto-pause.
 *   • CONTINUE        — re-enqueues the verbatim Hermes continuation prompt as a self-generated user
 *                       message (zero system-prompt mutation — the prompt cache stays intact).
 *
 * It NEVER dies: exhausting the turn budget AUTO-PAUSES (recoverable with `/goal resume`), a WAIT
 * verdict parks on a PID/seconds barrier without burning turns, and a real user message always
 * pre-empts the judge (the user comes first).
 *
 * No new deps: model calls go through pi's own `@earendil-works/pi-ai/compat` (`complete`/`getModel`)
 * and `ctx.modelRegistry` for keys — the same BYOK machinery the built-in agent uses. No provider,
 * model id, or key is ever hardcoded. Set PI_GOAL_JUDGE_MODEL="provider/model-id" to point the judge
 * at a cheaper model; otherwise it reuses the session's current model.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { complete, getModel, type Message } from "@earendil-works/pi-ai/compat";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ── Tunables ──────────────────────────────────────────────────────────────────────────────────
const DEFAULT_MAX_TURNS = clampInt(process.env.PI_GOAL_MAX_TURNS, 20);
const JUDGE_TIMEOUT_MS = 30_000;
const MAX_SNIPPET_CHARS = 4_000;
const WAIT_POLL_MS = 2_500;
const PARSE_FAIL_LIMIT = 3;
const TRANSPORT_FAIL_LIMIT = 5;

// ── Verbatim Hermes prompts (research/06 §4 + §"Prompts-chave") ─────────────────────────────────
const CONTINUATION_BASE =
	"Continue working toward this goal. Take the next concrete step. If you believe the goal is " +
	"complete, state so explicitly and stop. If you are blocked and need input from the user, say " +
	"so clearly and stop.";
const CONTRACT_CLAUSE =
	"Before claiming the goal is done, satisfy the Verification criterion and show the concrete " +
	"evidence (command output, file contents, test result).";

const JUDGE_SYSTEM = [
	"You are a strict judge deciding whether an autonomous coding agent should keep working toward a stated goal.",
	"",
	"You are given the GOAL (with an optional completion contract and extra criteria) and the agent's MOST RECENT response.",
	"Choose exactly one verdict:",
	"",
	'- DONE — the goal is fully accomplished, OR the agent is genuinely blocked / the goal is unreachable / it needs input from the user. In every DONE case, put the concrete reason (including the blocker, if any) in "reason".',
	"- CONTINUE — more work is needed. This is the default when in doubt.",
	'- WAIT — the agent is correctly idle while an EXTERNAL asynchronous process finishes on its own (a background job, a build, CI, a spawned PID). Use WAIT only to avoid burning a turn while something runs, and include how to wait: a "waitPid":<number> or a "waitSeconds":<number>.',
	"",
	'Judge by evidence, not vibes. Do NOT accept generic phrases like "all requirements met", "everything works", or "the task is complete" as proof — require specific evidence such as actual command output, file contents, or test results. If the contract specifies a Verification criterion, it must be satisfied with shown evidence before you answer DONE; otherwise answer CONTINUE.',
	"",
	"Reply with ONE line of JSON and nothing else:",
	'{"verdict":"DONE|CONTINUE|WAIT","reason":"<short reason>"}',
].join("\n");

// ── State ───────────────────────────────────────────────────────────────────────────────────────
interface GoalContract {
	verification?: string;
	constraints?: string;
	boundaries?: string;
	stopWhen?: string;
}
interface GoalState {
	goal: string;
	contract: GoalContract | null;
	subgoals: string[];
	turnsUsed: number;
	maxTurns: number;
	status: "active" | "paused" | "done";
	consecutiveJudgeParseFails: number;
	consecutiveJudgeTransportFails: number;
	/** epoch-ms barrier: park until now >= waitUntil */
	waitUntil: number | null;
	/** PID barrier: park until this process exits */
	waitPid: number | null;
}

function freshState(goal: string, contract: GoalContract | null): GoalState {
	return {
		goal,
		contract,
		subgoals: [],
		turnsUsed: 0,
		maxTurns: DEFAULT_MAX_TURNS,
		status: "active",
		consecutiveJudgeParseFails: 0,
		consecutiveJudgeTransportFails: 0,
		waitUntil: null,
		waitPid: null,
	};
}

// ── Pure helpers (no closure over pi) ────────────────────────────────────────────────────────────
function clampInt(v: string | undefined, fallback: number): number {
	const n = Number.parseInt(String(v ?? ""), 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** `process.kill(pid, 0)` probes liveness: no signal is sent; ESRCH means gone, EPERM means alive. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e && e.code === "EPERM";
	}
}

/** Pull the plain-text parts out of an assistant/user message content (string or block array). */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content) {
		if (b && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string") {
			parts.push((b as any).text);
		}
	}
	return parts.join("\n");
}

/** Last assistant message text along the current branch, capped to the most recent MAX_SNIPPET_CHARS. */
function lastAssistantText(ctx: ExtensionContext): string {
	let entries: any[] = [];
	try {
		entries = ctx.sessionManager.getBranch();
	} catch {
		try {
			entries = ctx.sessionManager.getEntries();
		} catch {
			entries = [];
		}
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type === "message" && e.message?.role === "assistant") {
			const t = textOf(e.message.content).trim();
			if (t) return t.length > MAX_SNIPPET_CHARS ? "…[earlier output truncated]\n" + t.slice(-MAX_SNIPPET_CHARS) : t;
		}
	}
	return "";
}

/**
 * Split a `/goal` argument into a headline + optional 5-field contract. Handles the fields written
 * either on their own lines or inline on one line: `do X  verify: tests pass  constraints: no new deps`.
 * Everything before the first field keyword is the goal headline.
 */
function parseGoalInput(raw: string): { goal: string; contract: GoalContract | null } {
	const re = /(verify|verification|constraints?|boundaries?|stop\s*when)\s*:/gi;
	const hits: { key: string; idx: number; len: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw))) hits.push({ key: m[1].toLowerCase().replace(/\s+/g, ""), idx: m.index, len: m[0].length });
	if (hits.length === 0) return { goal: raw.trim(), contract: null };
	const goal = raw.slice(0, hits[0].idx).trim();
	const contract: GoalContract = {};
	for (let i = 0; i < hits.length; i++) {
		const start = hits[i].idx + hits[i].len;
		const end = i + 1 < hits.length ? hits[i + 1].idx : raw.length;
		const val = raw.slice(start, end).trim();
		const k = hits[i].key;
		if (k.startsWith("verif")) contract.verification = val;
		else if (k.startsWith("constraint")) contract.constraints = val;
		else if (k.startsWith("boundar")) contract.boundaries = val;
		else if (k.startsWith("stopwhen")) contract.stopWhen = val;
	}
	return { goal, contract: Object.keys(contract).length ? contract : null };
}

/** Tolerant one-line-JSON verdict parser. Returns null when no usable verdict can be recovered. */
function parseVerdict(raw: string): { verdict: string; reason: string; waitPid?: number; waitSeconds?: number } | null {
	if (!raw) return null;
	let s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
	let obj: any = null;
	try {
		obj = JSON.parse(s);
	} catch {
		const braces = s.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/i);
		if (braces) {
			try {
				obj = JSON.parse(braces[0]);
			} catch {
				/* fall through */
			}
		}
	}
	if (obj && typeof obj === "object" && typeof obj.verdict === "string") {
		const verdict = String(obj.verdict).toUpperCase();
		if (verdict !== "DONE" && verdict !== "CONTINUE" && verdict !== "WAIT") return null;
		const out: any = { verdict, reason: typeof obj.reason === "string" ? obj.reason : "" };
		if (typeof obj.waitPid === "number") out.waitPid = obj.waitPid;
		if (typeof obj.waitSeconds === "number") out.waitSeconds = obj.waitSeconds;
		return out;
	}
	// last resort: bare verdict word anywhere in the text
	const vm = s.match(/\b(DONE|CONTINUE|WAIT)\b/i);
	return vm ? { verdict: vm[1].toUpperCase(), reason: "" } : null;
}

function contractLines(c: GoalContract): string[] {
	const out: string[] = [];
	if (c.verification) out.push(`- Verification: ${c.verification}`);
	if (c.constraints) out.push(`- Constraints: ${c.constraints}`);
	if (c.boundaries) out.push(`- Boundaries: ${c.boundaries}`);
	if (c.stopWhen) out.push(`- Stop when: ${c.stopWhen}`);
	return out;
}

function buildKickoff(s: GoalState): string {
	const b: string[] = ["New goal — work toward this autonomously until it is done:", "", s.goal];
	if (s.contract) b.push("", "Completion contract:", ...contractLines(s.contract));
	if (s.subgoals.length) b.push("", "Additional criteria:", ...s.subgoals.map((x) => `- ${x}`));
	b.push("", CONTINUATION_BASE);
	if (s.contract) b.push("", CONTRACT_CLAUSE);
	return b.join("\n");
}

function buildContinuation(s: GoalState): string {
	return s.contract ? CONTINUATION_BASE + "\n\n" + CONTRACT_CLAUSE : CONTINUATION_BASE;
}

function buildJudgeUser(s: GoalState, snippet: string): string {
	const b: string[] = ["GOAL:", s.goal];
	if (s.contract) b.push("", "Completion contract:", ...contractLines(s.contract));
	if (s.subgoals.length) b.push("", "Additional criteria:", ...s.subgoals.map((x) => `- ${x}`));
	b.push("", "AGENT'S MOST RECENT RESPONSE:", '"""', snippet || "(the agent produced no text this turn)", '"""', "", "Return your one-line JSON verdict now.");
	return b.join("\n");
}

/**
 * Resolve the model for auxiliary (judge / draft) calls WITHOUT hardcoding a provider or key.
 * Optional override PI_GOAL_JUDGE_MODEL="provider/model-id" points at a cheaper model; otherwise we
 * reuse the session's current model. The key is always fetched via ctx.modelRegistry (BYOK).
 */
function resolveAuxModel(ctx: ExtensionContext): any {
	const ov = (process.env.PI_GOAL_JUDGE_MODEL || "").trim();
	const slash = ov.indexOf("/");
	if (slash > 0) {
		try {
			// Cast: getModel() types the provider as a builtin-provider union; an env override is a
			// free-form "provider/model-id", validated at runtime by getModel returning undefined.
			const m = getModel(ov.slice(0, slash) as any, ov.slice(slash + 1) as any);
			if (m) return m;
		} catch {
			/* fall back to the current model */
		}
	}
	return ctx.model;
}

/** One auxiliary completion through pi's own BYOK machinery. Throws on missing model/key/transport. */
async function auxComplete(ctx: ExtensionContext, system: string, user: string, temperature?: number): Promise<string> {
	const model: any = resolveAuxModel(ctx);
	if (!model) throw new Error("no model configured");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`no API key for ${model.provider}/${model.id}`);
	const opts: Record<string, unknown> = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
	};
	// Some reasoning models reject a non-default temperature (model.supportsTemperature === false).
	if (temperature != null && model.supportsTemperature !== false) opts.temperature = temperature;
	const messages: Message[] = [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }];
	const resp = await complete(model, { systemPrompt: system, messages }, opts);
	return (resp.content || [])
		.filter((c: any): c is { type: "text"; text: string } => c && c.type === "text")
		.map((c: any) => c.text)
		.join("")
		.trim();
}

// ── Extension ─────────────────────────────────────────────────────────────────────────────────
export default function goalExtension(pi: ExtensionAPI) {
	// In-memory state, keyed by session id (one pi process can hold several sessions over its life).
	const states = new Map<string, GoalState>();
	const hydrated = new Set<string>();
	const fileBySid = new Map<string, string>();
	// Self-generated messages we enqueue (so we can tell our own continuations from real user input).
	const selfTexts = new Set<string>();
	// Session ids where a real user message pre-empted the current settle cycle.
	const preempted = new Set<string>();
	let waitTimer: ReturnType<typeof setInterval> | null = null;

	const norm = (t: string) => t.trim();

	function resolveFile(ctx: ExtensionContext | null, sid: string): string {
		let dir = "";
		try {
			dir = (ctx?.sessionManager as any)?.getSessionDir?.() || "";
		} catch {
			/* ignore */
		}
		if (!dir) {
			try {
				dir = join(ctx?.cwd || process.cwd(), ".pi");
			} catch {
				dir = join(process.cwd(), ".pi");
			}
		}
		return join(dir, `goal.${sid}.json`);
	}

	/** Load state from the JSON file, else from the latest persisted `goal_state` session entry. */
	function hydrate(ctx: ExtensionContext, sid: string): GoalState | undefined {
		fileBySid.set(sid, resolveFile(ctx, sid));
		if (hydrated.has(sid)) return states.get(sid);
		hydrated.add(sid);
		let s: GoalState | undefined;
		try {
			s = JSON.parse(readFileSync(fileBySid.get(sid)!, "utf8"));
		} catch {
			/* no file yet */
		}
		if (!s) {
			try {
				const entries = ctx.sessionManager.getEntries();
				for (let i = entries.length - 1; i >= 0; i--) {
					const e: any = entries[i];
					if (e?.type === "custom" && e.customType === "goal_state" && e.data) {
						s = e.data as GoalState;
						break;
					}
				}
			} catch {
				/* ignore */
			}
		}
		if (s) {
			// Defensive defaults for forward/backward compatibility.
			s.subgoals ||= [];
			s.maxTurns ||= DEFAULT_MAX_TURNS;
			s.waitUntil ??= null;
			s.waitPid ??= null;
			s.consecutiveJudgeParseFails ||= 0;
			s.consecutiveJudgeTransportFails ||= 0;
			states.set(sid, s);
			if (s.status === "active" && (s.waitUntil || s.waitPid)) ensureWaitTimer();
		}
		return s;
	}

	function persist(sid: string, s: GoalState): void {
		states.set(sid, s);
		const file = fileBySid.get(sid);
		if (file) {
			try {
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, JSON.stringify(s, null, 2));
			} catch {
				/* read-only FS: fall through to the session-entry snapshot */
			}
		}
		try {
			pi.appendEntry("goal_state", s);
		} catch {
			/* ignore */
		}
	}

	/** One-liner status report: persisted (appendEntry) + surfaced (notify) — never a user turn. */
	function report(sid: string, line: string, ctx?: ExtensionContext | null, level: "info" | "warning" = "info"): void {
		try {
			pi.appendEntry("goal_report", { line, ts: Date.now() });
		} catch {
			/* ignore */
		}
		if (ctx?.hasUI) {
			try {
				ctx.ui.notify(line, level);
			} catch {
				/* ignore */
			}
		}
	}

	function sendSelf(text: string): void {
		selfTexts.add(norm(text));
		try {
			pi.sendUserMessage(text);
		} catch {
			// Agent was mid-stream: queue as a follow-up so the goal never gets dropped.
			try {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			} catch {
				/* give up quietly; the wait timer / next settle will retry */
			}
		}
	}

	// ── State transitions ──────────────────────────────────────────────────────────────────────
	function issueContinuation(sid: string, s: GoalState, reason: string, ctx?: ExtensionContext | null): void {
		preempted.delete(sid);
		if (s.turnsUsed >= s.maxTurns) {
			s.status = "paused";
			persist(sid, s);
			report(sid, `⏸ Goal paused — turn budget spent (${s.turnsUsed}/${s.maxTurns}). Run /goal resume to renew.`, ctx, "warning");
			return;
		}
		s.turnsUsed += 1;
		persist(sid, s);
		report(sid, `↻ Continuing toward goal (${s.turnsUsed}/${s.maxTurns}): ${reason || "next step"}`, ctx);
		sendSelf(buildContinuation(s));
	}

	function markDone(sid: string, s: GoalState, reason: string, ctx?: ExtensionContext | null): void {
		s.status = "done";
		s.waitUntil = null;
		s.waitPid = null;
		persist(sid, s);
		report(sid, `✓ Goal achieved: ${reason || "the completion criteria are satisfied"}`, ctx);
	}

	function autoPause(sid: string, s: GoalState, why: string, ctx?: ExtensionContext | null): void {
		s.status = "paused";
		persist(sid, s);
		report(sid, `⏸ Goal paused — ${why}`, ctx, "warning");
	}

	function parkWait(sid: string, s: GoalState, opts: { pid?: number; seconds?: number; reason?: string }, ctx?: ExtensionContext | null): void {
		if (opts.pid && Number.isFinite(opts.pid)) {
			s.waitPid = opts.pid;
			s.waitUntil = null;
		} else {
			const secs = opts.seconds && opts.seconds > 0 ? opts.seconds : 30;
			s.waitUntil = Date.now() + secs * 1000;
			s.waitPid = null;
		}
		persist(sid, s);
		const what = s.waitPid ? `waiting for PID ${s.waitPid} to finish` : `waiting ~${Math.round((s.waitUntil! - Date.now()) / 1000)}s`;
		report(sid, `⏳ Goal parked — ${what}${opts.reason ? ` (${opts.reason})` : ""}. It resumes on its own.`, ctx);
		ensureWaitTimer();
	}

	/** Poll parked goals; when a barrier clears, resume the loop with a continuation. */
	function ensureWaitTimer(): void {
		if (waitTimer) return;
		waitTimer = setInterval(() => {
			let anyWaiting = false;
			for (const [sid, s] of states) {
				if (s.status !== "active" || (!s.waitUntil && !s.waitPid)) continue;
				const cleared = s.waitPid ? !pidAlive(s.waitPid) : Date.now() >= (s.waitUntil ?? 0);
				if (!cleared) {
					anyWaiting = true;
					continue;
				}
				s.waitUntil = null;
				s.waitPid = null;
				issueContinuation(sid, s, "resuming — the awaited work finished", null);
			}
			if (!anyWaiting && waitTimer) {
				clearInterval(waitTimer);
				waitTimer = null;
			}
		}, WAIT_POLL_MS);
		// Don't keep the process alive just for the poll.
		(waitTimer as any)?.unref?.();
	}

	// ── The post-turn hook: judge, then continue / finish / wait ─────────────────────────────────
	pi.on("agent_settled", async (_event, ctx) => {
		try {
			const sid = ctx.sessionManager.getSessionId();
			const s = hydrate(ctx, sid);
			if (!s || s.status !== "active") return;
			if (s.waitUntil || s.waitPid) return; // parked; the wait timer owns resumption
			if (!ctx.isIdle()) return; // safety: only act when truly settled
			if (preempted.has(sid)) {
				// A real user message drove this turn — the user comes first, so we step aside and do
				// NOT judge or auto-continue. The goal stays active; /goal resume re-engages the loop.
				preempted.delete(sid);
				report(sid, "⏸ Goal on hold — you took the wheel. Run /goal resume to continue autonomously.", ctx, "warning");
				return;
			}

			const snippet = lastAssistantText(ctx);
			let raw: string;
			try {
				raw = await auxComplete(ctx, JUDGE_SYSTEM, buildJudgeUser(s, snippet), 0);
			} catch {
				// Transport failure → FAIL OPEN to CONTINUE; the turn budget is the backstop.
				s.consecutiveJudgeTransportFails += 1;
				if (s.consecutiveJudgeTransportFails >= TRANSPORT_FAIL_LIMIT) {
					autoPause(sid, s, `the judge model was unreachable ${TRANSPORT_FAIL_LIMIT}× — check your model / API key (BYOK), then /goal resume`, ctx);
					return;
				}
				persist(sid, s);
				issueContinuation(sid, s, "judge unavailable — continuing (fail-open)", ctx);
				return;
			}
			s.consecutiveJudgeTransportFails = 0;

			const v = parseVerdict(raw);
			if (!v) {
				// Parse failure → also FAIL OPEN to CONTINUE.
				s.consecutiveJudgeParseFails += 1;
				if (s.consecutiveJudgeParseFails >= PARSE_FAIL_LIMIT) {
					autoPause(sid, s, `the judge returned unparseable output ${PARSE_FAIL_LIMIT}× — /goal resume to retry`, ctx);
					return;
				}
				persist(sid, s);
				issueContinuation(sid, s, "judge output unclear — continuing (fail-open)", ctx);
				return;
			}
			s.consecutiveJudgeParseFails = 0;
			persist(sid, s);

			if (v.verdict === "DONE") {
				markDone(sid, s, v.reason, ctx);
			} else if (v.verdict === "WAIT") {
				parkWait(sid, s, { pid: v.waitPid, seconds: v.waitSeconds, reason: v.reason }, ctx);
			} else {
				issueContinuation(sid, s, v.reason, ctx);
			}
		} catch {
			// A goal loop must never crash the agent.
		}
	});

	// ── Pre-emption detection: flag real user input that isn't one of our continuations ──────────
	pi.on("input", (event, ctx) => {
		try {
			const txt = norm(event.text || "");
			if (!txt) return;
			if (txt.startsWith("/")) return; // slash command — control, not a goal message
			if (event.source === "extension") return; // our own sendUserMessage
			if (selfTexts.has(txt)) {
				selfTexts.delete(txt); // our continuation echoed back through the input pipeline
				return;
			}
			const sid = ctx.sessionManager.getSessionId();
			const s = states.get(sid);
			if (s && s.status === "active") preempted.add(sid); // the user is steering; skip the next judge
		} catch {
			/* ignore */
		}
		return; // never transform user input
	});

	// ── /goal ────────────────────────────────────────────────────────────────────────────────────
	pi.registerCommand("goal", {
		description:
			"Set a self-driving goal the agent pursues after every turn until done. Subcommands: status | pause | resume | clear | wait <pid|secs> | unwait | draft <objective>. Set a goal with an optional inline contract: /goal <text> verify: … constraints: … boundaries: … stop when: …",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sid = ctx.sessionManager.getSessionId();
			const s = hydrate(ctx, sid);
			const raw = (args || "").trim();
			const sub = raw.split(/\s+/)[0]?.toLowerCase() || "";
			const rest = raw.slice(sub.length).trim();

			// ── read-only ────────────────────────────────────────────────────────────────────────
			if (raw === "" || sub === "status" || sub === "show") {
				ctx.ui.notify(renderStatus(s), s ? "info" : "warning");
				return;
			}

			// ── mutate existing goal ───────────────────────────────────────────────────────────────
			if (sub === "pause") {
				if (!s) return ctx.ui.notify("No goal set.", "warning");
				s.status = "paused";
				persist(sid, s);
				report(sid, "⏸ Goal paused by you.", ctx, "warning");
				return;
			}
			if (sub === "clear") {
				if (!s) return ctx.ui.notify("No goal set.", "warning");
				s.status = "done";
				s.waitUntil = null;
				s.waitPid = null;
				persist(sid, s);
				states.delete(sid);
				ctx.ui.notify("Goal cleared.", "info");
				return;
			}
			if (sub === "resume") {
				if (!s) return ctx.ui.notify("No goal to resume.", "warning");
				if (s.status === "done") return ctx.ui.notify("That goal is already done. Set a new one with /goal <text>.", "info");
				s.status = "active";
				s.turnsUsed = 0; // renew the budget
				s.consecutiveJudgeParseFails = 0;
				s.consecutiveJudgeTransportFails = 0;
				s.waitUntil = null;
				s.waitPid = null;
				preempted.delete(sid);
				persist(sid, s);
				report(sid, "▶ Goal resumed — budget renewed.", ctx);
				if (!ctx.isIdle()) await ctx.waitForIdle().catch(() => {});
				issueContinuation(sid, s, "resumed by user", ctx);
				return;
			}
			if (sub === "wait") {
				if (!s || s.status !== "active") return ctx.ui.notify("No active goal to park.", "warning");
				const pidM = rest.match(/^pid\s+(\d+)/i);
				const secM = rest.match(/^(\d+)\s*s?$/i);
				if (pidM) parkWait(sid, s, { pid: Number(pidM[1]), reason: "parked by you" }, ctx);
				else if (secM) parkWait(sid, s, { seconds: Number(secM[1]), reason: "parked by you" }, ctx);
				else ctx.ui.notify("Usage: /goal wait <seconds>  |  /goal wait pid <PID>", "warning");
				return;
			}
			if (sub === "unwait") {
				if (!s) return ctx.ui.notify("No goal set.", "warning");
				s.waitUntil = null;
				s.waitPid = null;
				persist(sid, s);
				if (s.status === "active") {
					if (!ctx.isIdle()) await ctx.waitForIdle().catch(() => {});
					issueContinuation(sid, s, "unparked by user", ctx);
				} else ctx.ui.notify("Wait barrier cleared.", "info");
				return;
			}

			// ── /goal draft <objective> — auxiliary model writes the 5-field contract ──────────────
			if (sub === "draft") {
				const objective = rest;
				if (!objective) return ctx.ui.notify("Usage: /goal draft <objective>", "warning");
				if (ctx.hasUI) ctx.ui.notify("Drafting a completion contract…", "info");
				const draftSystem = [
					"You turn a one-line objective into a crisp completion contract for an autonomous coding agent.",
					"Reply with ONE line of JSON and nothing else, with exactly these string fields:",
					'{"outcome":"…","verification":"…","constraints":"…","boundaries":"…","stop_when":"…"}',
					"- outcome: a sharp restatement of the goal.",
					"- verification: the concrete, checkable evidence that proves it is done (a command to run, a file/test to inspect).",
					"- constraints: what must hold throughout (style, deps, compatibility).",
					"- boundaries: what is explicitly out of scope / must not be touched.",
					"- stop_when: the condition under which the agent should stop and ask the user.",
				].join("\n");
				let drafted: any;
				try {
					const out = await auxComplete(ctx, draftSystem, `Objective: ${objective}`, 0.2);
					const clean = out.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
					drafted = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] ?? clean);
				} catch (e: any) {
					return ctx.ui.notify(`Could not draft a contract (${String(e?.message || e)}). Set it manually with /goal <text> verify: …`, "warning");
				}
				const contract: GoalContract = {
					verification: str(drafted?.verification),
					constraints: str(drafted?.constraints),
					boundaries: str(drafted?.boundaries),
					stopWhen: str(drafted?.stop_when ?? drafted?.stopWhen),
				};
				const ns = freshState(str(drafted?.outcome) || objective, hasAny(contract) ? contract : null);
				persist(sid, ns);
				report(sid, `🎯 Goal set (drafted): ${ns.goal}`, ctx);
				if (!ctx.isIdle()) await ctx.waitForIdle().catch(() => {});
				sendSelf(buildKickoff(ns));
				return;
			}

			// ── set a new goal (headline + optional inline contract) ───────────────────────────────
			const parsed = parseGoalInput(raw);
			if (!parsed.goal) return ctx.ui.notify("Give the goal a headline: /goal <what to accomplish>", "warning");
			const ns = freshState(parsed.goal, parsed.contract);
			persist(sid, ns);
			report(sid, `🎯 Goal set: ${ns.goal}`, ctx);
			if (!ctx.isIdle()) await ctx.waitForIdle().catch(() => {});
			sendSelf(buildKickoff(ns)); // kick off — enqueue as a normal (self-generated) user message
		},
	});

	// ── /subgoal <text> — add a criterion to the active goal mid-flight ────────────────────────────
	pi.registerCommand("subgoal", {
		description: "Add an extra success criterion to the active goal (folded into every future judge check).",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sid = ctx.sessionManager.getSessionId();
			const s = hydrate(ctx, sid);
			const text = (args || "").trim();
			if (!s || s.status === "done") return ctx.ui.notify("No active goal. Set one with /goal <text>.", "warning");
			if (!text) return ctx.ui.notify("Usage: /subgoal <criterion>", "warning");
			s.subgoals.push(text);
			persist(sid, s);
			report(sid, `＋ Subgoal added (${s.subgoals.length}): ${text}`, ctx);
		},
	});

	// ── helpers that close over nothing but read state ────────────────────────────────────────────
	function renderStatus(s: GoalState | undefined): string {
		if (!s) return "No goal set. Start one with /goal <what to accomplish>  (optionally: … verify: … constraints: … boundaries: … stop when: …)";
		const lines: string[] = [`🎯 Goal [${s.status}]  ${s.turnsUsed}/${s.maxTurns} turns`, s.goal];
		if (s.contract) lines.push("Contract:", ...contractLines(s.contract));
		if (s.subgoals.length) lines.push("Subgoals:", ...s.subgoals.map((x) => `- ${x}`));
		if (s.waitPid) lines.push(`Parked: waiting for PID ${s.waitPid}`);
		else if (s.waitUntil) lines.push(`Parked: ~${Math.max(0, Math.round((s.waitUntil - Date.now()) / 1000))}s left`);
		return lines.join("\n");
	}
}

// ── tiny value helpers ────────────────────────────────────────────────────────────────────────
function str(v: unknown): string {
	return typeof v === "string" ? v.trim() : "";
}
function hasAny(c: GoalContract): boolean {
	return Boolean(c.verification || c.constraints || c.boundaries || c.stopWhen);
}
