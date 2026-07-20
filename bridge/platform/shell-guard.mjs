// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — shell-guard (catastrophic-command guard)
// The SINGLE SOURCE OF TRUTH for the pattern that refuses obviously destructive
// shell invocations across the bridge. Today the same check is hand-copied in:
//   - hub-bridge.mjs   /shell        handleShell()   (inline regex chain)
//   - pty.mjs          open()        isDestructive()
//   - ssh.mjs          run()         destructive()
// All three currently carry a byte-for-byte IDENTICAL regex. This module IS that
// regex, kept verbatim as `LEGACY_*` below, OR'd with a set of hardening
// extensions that close known gaps (multi-token rm flags, quoted dd targets,
// named fork bombs) — so this port can never be weaker than any of the three
// existing copies, only ever a superset. ADOPTED: all three callers now import
// this port — ssh.mjs + pty.mjs (Wave-3, T-023) and the router's /shell handler
// in domains/chat/shell.mjs (Wave-4, T-030). No inline copy of the regex remains
// in the bridge; this file is the single source of truth for the guard.
//
// isDestructive(line) is pure, synchronous, allocates no state, and has ZERO
// dependencies (no imports at all) — safe to import from any layer, including
// RPC-reachable modules, with no risk of pulling in native/npm deps.
//
// SCOPE: this is a best-effort static guard against the canonical catastrophic
// one-liners (rm -rf /, mkfs, dd of=/dev/*, fork bombs) — a last defensive line,
// not a sandbox and not a full shell parser. It cannot see through command
// substitution, variable expansion, base64 payloads, or heredocs; it is defence-
// in-depth alongside permission gates (Root mode, ssh permission, localhost-only
// bind), not a replacement for them.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── legacy patterns (verbatim from hub-bridge.mjs / pty.mjs / ssh.mjs) ──────
// Do not "clean up" these regexes — they are the compatibility floor. Any of the
// three real copies would match iff one of these four matches.
const LEGACY_RM_RF = /\brm\s+-[a-z]*[rf][a-z]*\s+(\/\*{0,2}(\s|$)|~(\/|\s|$)|\$HOME)/;
const LEGACY_MKFS = /\bmkfs\b/;
const LEGACY_DD = /\bdd\b[^\n]*of=\/dev\//;
const LEGACY_FORKBOMB = /:\(\)\s*\{\s*:\|:/;

// ── hardening extensions (superset — ADD coverage, never remove it) ────────

// dd of=/dev/*, tolerant of a quote wrapping the target (`of="/dev/sda"`).
const HARDENED_DD = /\bdd\b[^\n]*\bof=["']?\/dev\//;

// Fork bomb using ANY self-referencing function name, not just the classic `:`
// e.g. `bomb(){ bomb|bomb & };bomb`. Mirrors the legacy pattern's shape/spacing.
const HARDENED_FORKBOMB = /([:\w]+)\s*\(\)\s*\{\s*\1\s*\|\s*\1/;

// rm -rf targeting root/home, tolerant of:
//   - flags split across multiple tokens: `rm -r -f /`, `rm --recursive --force /`
//   - flags AFTER the target: `rm -rf --verbose /` or `rm / -rf`
//   - a dangerous target buried among other arguments: `rm -rf /tmp/safe /`
//   - `rm` reached via a path (`/bin/rm`, `/usr/bin/rm`)
// The legacy regex only catches a SINGLE flag token immediately followed by the
// target — this closes that gap without narrowing anything it already caught.
const CMD_SEPARATOR = new Set([';', '&&', '||', '|', '&']);
const RM_DANGEROUS_TARGETS = new Set([
  '/', '/*', '/**', '~', '~/', '$HOME', '"$HOME"', "'$HOME'", '"/"', "'/'",
]);

function tokenize(line) {
  return line.match(/"[^"]*"|'[^']*'|\S+/g) || [];
}

function isRmToken(tok) {
  return tok === 'rm' || /\/rm$/.test(tok);
}

// A short cluster (`-rf`, `-r`, `-fr`, `-Rf`) or long flag (`--recursive`,
// `--force`) that implies recursive-or-force — matching the legacy regex's own
// looseness of requiring only ONE of r/f, not both (never weaker than legacy).
function tokenImpliesRecursiveOrForce(tok) {
  if (tok === '--recursive' || tok === '--force') return true;
  if (/^-[a-zA-Z]+$/.test(tok)) return /[rf]/i.test(tok.slice(1));
  return false;
}

function hasHardenedRmRf(line) {
  const tokens = tokenize(line);
  for (let i = 0; i < tokens.length; i++) {
    if (!isRmToken(tokens[i])) continue;
    let flagOk = false;
    let targetOk = false;
    for (let j = i + 1; j < tokens.length; j++) {
      const tok = tokens[j];
      if (CMD_SEPARATOR.has(tok)) break; // end of this rm invocation
      if (tokenImpliesRecursiveOrForce(tok)) flagOk = true;
      if (RM_DANGEROUS_TARGETS.has(tok)) targetOk = true;
    }
    if (flagOk && targetOk) return true;
  }
  return false;
}

/**
 * isDestructive(line) -> boolean
 * Returns true iff `line` contains a catastrophic shell pattern: an `rm -rf`
 * (or equivalent) targeting `/`, `~`, or `$HOME`; `mkfs`; `dd ... of=/dev/*`;
 * or a fork bomb. Pure — no I/O, no throw (a non-string input is coerced and
 * never crashes the caller).
 *
 * @param {string} line - a single shell command line (raw, pre-exec)
 * @returns {boolean}
 */
export function isDestructive(line) {
  const s = typeof line === 'string' ? line : String(line ?? '');
  if (!s.trim()) return false;
  return LEGACY_RM_RF.test(s)
    || LEGACY_MKFS.test(s)
    || LEGACY_DD.test(s)
    || LEGACY_FORKBOMB.test(s)
    || HARDENED_DD.test(s)
    || HARDENED_FORKBOMB.test(s)
    || hasHardenedRmRf(s);
}

export const ShellGuard = { isDestructive };
export default ShellGuard;
