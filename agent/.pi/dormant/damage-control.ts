/**
 * damage-control — an OPT-IN declarative safety guardrail for the CLONE FRAME pi agent.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Ported from disler/pi-vs-claude-code (`extensions/damage-control.ts`), MIT License,
 * Copyright (c) 2026 IndyDevDan. Porting is permitted with attribution — this header preserves it.
 * Original: https://github.com/disler/pi-vs-claude-code   ·   Adapted for CLONE FRAME by Fable.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ FACTORY-YOLO INVARIANT — read this before touching anything.
 * CLONE FRAME's pi is YOLO by default: the ONE hard limit is anti-wipe (lives in clone-frame.ts).
 * This extension does NOT change that. The disler ~90-rule ruleset must never be armed by default.
 * So this file ships DORMANT and self-arms ONLY when the owner has opted in:
 *
 *   ARMED  ⇢  a rules file EXISTS at  ~/.clone-frame-hub/guardrails/damage-control-rules.yaml
 *             (the owner's opt-in location), OR the env flag CFHUB_DAMAGE_CONTROL_RULES points
 *             at a readable YAML file, OR CFHUB_DAMAGE_CONTROL is truthy AND a rules file resolves.
 *   DORMANT ⇢  none of the above  →  a TRUE no-op: it loads nothing, logs nothing, blocks nothing,
 *              shows no status, and every tool_call / user_bash passes straight through.
 *
 * It is intentionally NOT listed in .pi/settings.json — it ships in the workspace but stays inert
 * until the L9 "guardrails" skill (or the owner) drops a rules file at the opt-in path. To arm it:
 *   1. cp .pi/guardrails/damage-control-rules.EXAMPLE.yaml \
 *        ~/.clone-frame-hub/guardrails/damage-control-rules.yaml   (edit to taste)
 *   2. add "extensions/damage-control.ts" to .pi/settings.json (or launch with `pi -e`).
 * Remove the rules file (or the settings entry) to return to pure factory YOLO.
 *
 * When armed it preserves the disler behavior verbatim: block/confirm/log per rule, the
 * "do not work around this restriction" refusal message, and the four rule classes
 * (bashToolPatterns · zeroAccessPaths · readOnlyPaths · noDeletePaths).
 */

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { parse as yamlParse } from "yaml";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";

interface Rule {
	pattern: string;
	reason: string;
	ask?: boolean;
}

interface Rules {
	bashToolPatterns: Rule[];
	zeroAccessPaths: string[];
	readOnlyPaths: string[];
	noDeletePaths: string[];
}

const EMPTY_RULES: Rules = { bashToolPatterns: [], zeroAccessPaths: [], readOnlyPaths: [], noDeletePaths: [] };

// The owner's single opt-in location. Presence of a file here arms the guardrail.
const OWNER_RULES_PATH = join(homedir(), ".clone-frame-hub", "guardrails", "damage-control-rules.yaml");

function expandTilde(p: string): string {
	return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

export default function damageControl(pi: ExtensionAPI) {
	// State — stays fully inert while `armed` is false.
	let armed = false;
	let rules: Rules = EMPTY_RULES;

	function resolvePath(p: string, cwd: string): string {
		return resolve(cwd, expandTilde(p));
	}

	// Substring search that only counts a hit when the next char is not a path-word char.
	// Prevents `~/Desktop/YT` from matching `~/Desktop/YT_archive`, while still matching
	// `~/Desktop/YT`, `~/Desktop/YT/foo`, `~/Desktop/YT"`, `~/Desktop/YT ` (space = boundary).
	function commandReferencesPath(command: string, protectedPath: string): boolean {
		if (!protectedPath) return false;
		let idx = command.indexOf(protectedPath);
		while (idx >= 0) {
			const after = command[idx + protectedPath.length];
			if (!after || !/[A-Za-z0-9_-]/.test(after)) return true;
			idx = command.indexOf(protectedPath, idx + 1);
		}
		return false;
	}

	function isPathMatch(targetPath: string, pattern: string, cwd: string): boolean {
		// Expand tilde in pattern if present.
		const resolvedPattern = expandTilde(pattern);

		// If pattern ends with /, it's a directory match.
		if (resolvedPattern.endsWith("/")) {
			const absolutePattern = isAbsolute(resolvedPattern) ? resolvedPattern : resolve(cwd, resolvedPattern);
			return targetPath.startsWith(absolutePattern);
		}

		// Handle basic wildcards *.
		const regexPattern = resolvedPattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex chars
			.replace(/\*/g, ".*"); // convert * to .*

		const regex = new RegExp(`^${regexPattern}$|^${regexPattern}/|/${regexPattern}$|/${regexPattern}/`);

		// Match against absolute path and relative-to-cwd path.
		const relativePath = relative(cwd, targetPath);

		return (
			regex.test(targetPath) ||
			regex.test(relativePath) ||
			targetPath.includes(resolvedPattern) ||
			relativePath.includes(resolvedPattern)
		);
	}

	function countRules(r: Rules): number {
		return r.bashToolPatterns.length + r.zeroAccessPaths.length + r.readOnlyPaths.length + r.noDeletePaths.length;
	}

	// ── Arm-or-stay-dormant decision (opt-in gate) ────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		armed = false;
		rules = EMPTY_RULES;

		// Explicit env path wins; otherwise the owner's opt-in home location.
		const envRulesPath = process.env.CFHUB_DAMAGE_CONTROL_RULES?.trim();
		const envExplicit = envRulesPath ? expandTilde(envRulesPath) : "";
		const candidate = envExplicit && existsSync(envExplicit)
			? envExplicit
			: existsSync(OWNER_RULES_PATH)
				? OWNER_RULES_PATH
				: null;

		// DORMANT: no rules file at any opt-in location → true no-op. Log nothing, block nothing.
		// (CFHUB_DAMAGE_CONTROL alone, with no resolvable file, intentionally stays silent too —
		//  factory YOLO holds until the owner actually drops a ruleset.)
		if (!candidate) return;

		try {
			const loaded = yamlParse(readFileSync(candidate, "utf8")) as Partial<Rules>;
			rules = {
				bashToolPatterns: loaded.bashToolPatterns || [],
				zeroAccessPaths: loaded.zeroAccessPaths || [],
				readOnlyPaths: loaded.readOnlyPaths || [],
				noDeletePaths: loaded.noDeletePaths || [],
			};
			armed = true;
			const n = countRules(rules);
			ctx.ui?.notify?.(`🛡️ Damage-Control ARMED (opt-in) — ${n} guardrail rules from ${candidate}.`);
			ctx.ui?.setStatus?.(`🛡️ Damage-Control: ${n} rules`);
		} catch (err) {
			armed = false;
			rules = EMPTY_RULES;
			ctx.ui?.notify?.(`🛡️ Damage-Control: failed to load ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	// ── The core interceptor (disler logic, verbatim behavior) ────────────────────────────────
	async function evaluateToolCall(event: ToolCallEvent, ctx: any): Promise<{ block: boolean; reason?: string } | undefined> {
		if (!armed) return undefined; // dormant → pass through untouched

		let violationReason: string | null = null;
		let shouldAsk = false;

		// 1. Zero-access paths for every tool that carries a path or glob.
		const checkPaths = (pathsToCheck: string[]) => {
			for (const p of pathsToCheck) {
				const resolved = resolvePath(p, ctx.cwd);
				for (const zap of rules.zeroAccessPaths) {
					if (isPathMatch(resolved, zap, ctx.cwd)) {
						return `Access to zero-access path restricted: ${zap}`;
					}
				}
			}
			return null;
		};

		const inputPaths: string[] = [];
		if (isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
			inputPaths.push(event.input.path);
		} else if (isToolCallEventType("grep", event) || isToolCallEventType("find", event) || isToolCallEventType("ls", event)) {
			inputPaths.push(event.input.path || ".");
		}

		if (isToolCallEventType("grep", event) && event.input.glob) {
			for (const zap of rules.zeroAccessPaths) {
				if (event.input.glob.includes(zap) || isPathMatch(event.input.glob, zap, ctx.cwd)) {
					violationReason = `Glob matches zero-access path: ${zap}`;
					break;
				}
			}
		}

		if (!violationReason) {
			violationReason = checkPaths(inputPaths);
		}

		// 2. Tool-specific logic.
		if (!violationReason) {
			if (isToolCallEventType("bash", event)) {
				const command = event.input.command;

				for (const rule of rules.bashToolPatterns) {
					const regex = new RegExp(rule.pattern);
					if (regex.test(command)) {
						violationReason = rule.reason;
						shouldAsk = !!rule.ask;
						break;
					}
				}

				if (!violationReason) {
					for (const zap of rules.zeroAccessPaths) {
						if (command.includes(zap)) {
							violationReason = `Bash command references zero-access path: ${zap}`;
							break;
						}
					}
				}

				if (!violationReason) {
					for (const rop of rules.readOnlyPaths) {
						// Heuristic: might this command modify a read-only path? (redirects, sed -i, rm, mv…)
						if (command.includes(rop) && (/[\s>|]/.test(command) || command.includes("rm") || command.includes("mv") || command.includes("sed"))) {
							violationReason = `Bash command may modify read-only path: ${rop}`;
							break;
						}
					}
				}

				if (!violationReason) {
					const hasDeleteOrMove = /\brm\b/.test(command) || /\bmv\b/.test(command);
					if (hasDeleteOrMove) {
						for (const ndp of rules.noDeletePaths) {
							const expanded = expandTilde(ndp);
							const matched = commandReferencesPath(command, ndp) || (expanded !== ndp && commandReferencesPath(command, expanded));
							if (matched) {
								violationReason = `Bash command attempts to delete/move protected path: ${ndp}`;
								break;
							}
						}
					}
				}
			} else if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
				for (const p of inputPaths) {
					const resolved = resolvePath(p, ctx.cwd);
					for (const rop of rules.readOnlyPaths) {
						if (isPathMatch(resolved, rop, ctx.cwd)) {
							violationReason = `Modification of read-only path restricted: ${rop}`;
							break;
						}
					}
				}
			}
		}

		if (!violationReason) return { block: false };

		const WORKAROUND_WARNING =
			"\n\nDO NOT attempt to work around this restriction. DO NOT retry with alternative commands, " +
			"paths, or approaches that achieve the same result. Report this block to the user exactly as " +
			"stated and ask how they would like to proceed.";

		if (shouldAsk) {
			// `ask: true` → confirm with the owner. In headless/RPC surfaces where no confirm UI exists,
			// FAIL SAFE (block) — a guardrail must never silently allow a flagged command.
			const canConfirm = typeof ctx.ui?.confirm === "function";
			const confirmed = canConfirm
				? await ctx.ui.confirm(
						"🛡️ Damage-Control Confirmation",
						`Dangerous command detected: ${violationReason}\n\nCommand: ${isToolCallEventType("bash", event) ? event.input.command : JSON.stringify(event.input)}\n\nDo you want to proceed?`,
						{ timeout: 30000 },
					)
				: false;

			if (!confirmed) {
				ctx.ui?.setStatus?.(`⚠️ Last Violation Blocked: ${violationReason.slice(0, 30)}...`);
				pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: canConfirm ? "blocked_by_user" : "blocked_no_ui" });
				ctx.abort?.();
				return { block: true, reason: `🛑 BLOCKED by Damage-Control: ${violationReason} (confirmation denied)${WORKAROUND_WARNING}` };
			}
			pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "confirmed_by_user" });
			return { block: false };
		}

		ctx.ui?.notify?.(`🛑 Damage-Control: Blocked ${event.toolName} due to ${violationReason}`);
		ctx.ui?.setStatus?.(`⚠️ Last Violation: ${violationReason.slice(0, 30)}...`);
		pi.appendEntry("damage-control-log", { tool: event.toolName, input: event.input, rule: violationReason, action: "blocked" });
		ctx.abort?.();
		return { block: true, reason: `🛑 BLOCKED by Damage-Control: ${violationReason}${WORKAROUND_WARNING}` };
	}

	// Model tool calls.
	pi.on("tool_call", async (event, ctx) => {
		return evaluateToolCall(event as ToolCallEvent, ctx);
	});

	// Human-typed `!command` bash (best-effort; event shape varies by version). Only the bash
	// pattern / path checks are relevant here — reuse the same ruleset by faking a bash tool_call.
	pi.on("user_bash", async (event: any, ctx: any) => {
		if (!armed) return undefined;
		const command = event?.command ?? event?.input?.command;
		if (typeof command !== "string" || !command) return undefined;
		const synthetic = { toolName: "bash", input: { command } } as unknown as ToolCallEvent;
		const r = await evaluateToolCall(synthetic, ctx);
		return r?.block ? { block: true, reason: r.reason } : undefined;
	});
}
