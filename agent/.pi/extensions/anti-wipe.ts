/**
 * anti-wipe — the ONLY extension a fleet CHILD loads.
 *
 * Fleet children are spawned by fleet.ts with `pi --no-extensions -e <this file>`, so they run
 * with NONE of the parent's powers (no clone-frame app tools, no fleet, no goal) — a child is a
 * throwaway worker, not a second driver of the body. But the ONE hard limit must still hold on a
 * child's bash, so it loads this: it re-uses the exact same `catastrophic` guard as the main
 * session (single source of truth in ./lib/anti-wipe-core) and wires the same two bash hooks.
 *
 * Result: a child can read, write, run bash freely (owner's YOLO) — but can never `rm -rf /`,
 * `mkfs`, or `dd` to a raw disk. The guard fires on both the model's `bash` tool and a
 * human-typed `!command`, identically to clone-frame.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { catastrophic } from "./lib/anti-wipe-core";

export default function antiWipe(pi: ExtensionAPI) {
	// ── Anti-wipe on the model's bash tool ────────────────────────────────────────────────
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
	// ── Same guard on a human-typed `!command` (best-effort; shapes vary by version) ────────
	pi.on("user_bash", async (event) => {
		const why = catastrophic((event as any)?.command ?? (event as any)?.input?.command);
		if (why) return { block: true, reason: `CLONE FRAME anti-wipe: refusing ${why}.` };
		return undefined;
	});
}
