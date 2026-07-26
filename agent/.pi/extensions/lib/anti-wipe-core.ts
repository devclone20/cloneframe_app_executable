/**
 * anti-wipe-core — the SINGLE SOURCE OF TRUTH for CLONE FRAME's one hard limit.
 *
 * CLONE FRAME runs Pi YOLO: no sandbox, no per-command approval. The owner chose exactly
 * ONE non-negotiable exception — the anti-wipe guard: refuse a `rm -rf` on a root/home/system
 * path, `mkfs`, or `dd`/redirect to a raw disk device. Everything else runs freely.
 *
 * This function is shared verbatim by:
 *   - the main-session `clone-frame` extension (imports it, wires the two bash hooks),
 *   - the lightweight `anti-wipe` extension that fleet CHILDREN load with `-e` under
 *     `--no-extensions` (so a spawned sub-agent keeps ONLY this limit, nothing else).
 *
 * Never fork this logic — one set of regexes, one place to reason about it. `catastrophic`
 * returns a human-readable REASON string when a command must be blocked, or null to allow.
 * It auto-decides and never prompts (a prompt would hang the agent in headless/RPC mode).
 *
 * Zero dependencies — pure string logic, safe to load in a child with `--no-extensions`.
 */
export function catastrophic(command: unknown): string | null {
	const c = String(command ?? "");
	if (!c) return null;
	if (/--no-preserve-root/i.test(c)) return "rm --no-preserve-root";
	// rm invoked with BOTH recursive and force (any flag arrangement: -rf, -fr, -r -f, --recursive --force)
	const rmRecursiveForce =
		/\brm\b/i.test(c) &&
		((/\brm\b[^\n|;&]*?\s-\S*r\S*/i.test(c) && /\brm\b[^\n|;&]*?\s-\S*f\S*/i.test(c)) ||
			/\brm\b[^\n|;&]*?\s-\S*(?:rf|fr)\S*/i.test(c) ||
			(/\brm\b[^\n|;&]*?\s--recursive\b/i.test(c) && /\brm\b[^\n|;&]*?\s--force\b/i.test(c)));
	if (rmRecursiveForce) {
		// Only WHOLE catastrophic targets — never a deep subpath, so normal work like
		// `rm -rf /Users/alex/project/dist` or `rm -rf ~/tmp/x` or `rm -rf /var/folders/x`
		// still runs freely (the owner's YOLO promise).
		if (/(?:\s|["'])\/(?:\s|["']|\*|$)/.test(c)) return "rm -rf on the filesystem root (/)";
		if (/(?:\s|["'])(?:~|\$HOME)(?:\/?(?:\s|["']|\*|$))/.test(c)) return "rm -rf on the whole home directory";
		if (/(?:\s|["'])\/(?:System|usr|bin|sbin|etc|var|Library|private|lib|boot|dev|cores)(?:\/?(?:\s|["']|\*|$))/i.test(c))
			return "rm -rf on a top-level system directory";
	}
	if (/\bmkfs(?:\.\w+)?\b/i.test(c)) return "mkfs (format a filesystem)";
	if (/\bdd\b[^\n]*\bof=\/dev\/(?:r?disk|sd|nvme|hd)/i.test(c)) return "dd to a raw disk device";
	if (/>\s*\/dev\/(?:r?disk|sd|nvme)\d/i.test(c)) return "redirect to a raw disk device";
	return null;
}
