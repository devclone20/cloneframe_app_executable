// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — cli-gate (fail-closed CLI execution gate, factory)
//
// Extracted from the fail-closed CLI gate duplicated verbatim in
// bridge/okxai.mjs (onchainos) and bridge/acp.mjs (acp). Both wrap a
// user-owned CLI binary behind the same four-class safety model:
//
//   read      → callable freely (queries, no side effects)
//   mutate    → requires confirm:true or approved:true (a UI click handler)
//               — audited
//   financial → requires approved:true (the amber confirm modal)
//               — audited, moves funds / signs / settles / claims
//   auth      → NEVER executes. Returns a `needsTerminal` sentinel with the
//               command line so the OWNER runs it in their own terminal
//               (these flows mint or touch live sessions/keys — the app
//               must never hold or relay them)
//
// Unknown commands are refused (fail-closed default). This module owns only
// the MECHANISM (binary discovery, longest-prefix classification, capped
// execFile, append-only jsonl audit, sentinel shape). It knows nothing about
// onchainos or acp specifically — every command tree, message, and cap is
// supplied by the caller via `makeGatedCli(config)`. That is what makes the
// existing okxai.mjs/acp.mjs CLASS maps a drop-in `classMap` here, and this
// module a strict behavioral superset of both (see cli-gate.contract.test.mjs
// for the side-by-side proof against synthetic replicas of each original).
//
// SECURITY INVARIANT: fail-closed. `auth`-classified commands are returned
// as a sentinel and are NEVER passed to execFile. Unknown/unclassified
// commands are refused, not defaulted to a permissive class. There is no
// bypass parameter that skips classification — `opts.approved`/`opts.confirm`
// only ever downgrade a `mutate`/`financial` PROMPT into an execution; they
// can never turn an `auth` command into an executable one.
// ─────────────────────────────────────────────────────────────────────────────
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;
const DEFAULT_MAX_ERROR_BYTES = 4000;
const DEFAULT_MAX_ARGV_LEN = 24;
const DEFAULT_MAX_ARG_LEN = 4000;
const DEFAULT_MAX_PREFIX_WORDS = 3;
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_TIMEOUT_MS = 180000;
const DEFAULT_MIN_TIMEOUT_MS = 1000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

// reclassify() may only move a matched command AMONG the executable classes.
// It can NEVER turn a command into 'auth' (auth is immutable, handled before
// reclassify runs) and any other/unknown return is ignored — so a buggy or
// malicious reclassify can never produce a class run() treats as ungated.
const RECLASS_ALLOWED = new Set(['read', 'mutate', 'financial']);

/**
 * Build a fail-closed gated CLI wrapper.
 *
 * @param {object} config
 * @param {() => (string|null)} config.resolveBin — locates the real binary;
 *   returns an absolute, executable path or null if not installed. Never
 *   throws (callers should swallow their own discovery errors).
 * @param {Record<string,string>} config.classMap — `"word word" -> class`
 *   where class is one of 'read'|'mutate'|'financial'|'auth'. Matched by
 *   longest-prefix (up to `maxPrefixWords`) over the argv's non-flag words.
 * @param {string} config.auditFile — absolute path to an append-only jsonl
 *   audit log. Directory is created (mode 0700) on first write.
 * @param {Set<string>} [config.longTimeoutKeys] — classify() keys that get
 *   `longTimeoutMs` instead of `defaultTimeoutMs` when the caller doesn't
 *   pass an explicit `timeoutMs`.
 * @param {string} [config.binNotFoundError] — error text when resolveBin()
 *   returns null (should tell the owner how to install/point at the CLI).
 * @param {string} [config.authMessage] — human text explaining why an
 *   `auth`-classified command was refused and must run in the owner's shell.
 * @param {string} [config.binName] — the CLI's argv0, used only to render
 *   the human-readable `command` string on the auth sentinel (e.g. "acp").
 * @param {(key:string, cls:string, argv:string[]) => (string|undefined)} [config.reclassify]
 *   — optional post-match override, e.g. acp's `trade --dry-run` is a quote
 *   (read), not an execution, even though `trade` classifies as financial.
 *   Return a class to override, or undefined/falsy to keep the matched one.
 * @param {(argv:string[], opts:object) => string[]} [config.buildExecArgv]
 *   — optional transform applied to argv right before it is spawned by
 *   run() (not by the raw exec() primitive), e.g. acp's `['--json', ...argv]`.
 * @param {(code:(number|'timeout'), stdout:string, stderr:string) => (object|undefined)} [config.detectSentinel]
 *   — optional extra sentinel(s) merged into a non-ok exec() result, e.g.
 *   `{ needsAuth: true }` when stdout/stderr smells like an expired session.
 * @param {number} [config.defaultTimeoutMs=60000]
 * @param {number} [config.longTimeoutMs=180000]
 * @param {number} [config.minTimeoutMs=1000]
 * @param {number} [config.maxTimeoutMs=180000] — hard clamp ceiling; acp's
 *   original clamps at 120000, okxai's at 180000 — pass the caller's value.
 * @param {number} [config.maxOutputBytes=204800] — stdout truncation.
 * @param {number} [config.maxErrorBytes=4000] — stderr truncation.
 * @param {number} [config.maxArgvLen=24] — argv element-count cap.
 * @param {number} [config.maxArgLen=4000] — per-argument length cap.
 * @param {number} [config.maxPrefixWords=3] — longest-prefix search depth.
 * @param {number} [config.maxBuffer=8388608] — execFile stdout/stderr buffer cap.
 * @param {Function} [config.execFileImpl] — injectable replacement for
 *   node:child_process's execFile, same (file, args, options, callback)
 *   signature. Production callers omit this; tests (and fakeCli.mjs) pass
 *   an in-memory stand-in so the SAME gate logic runs without a real binary.
 *
 * @returns {{ bin: Function, classify: Function, audit: Function, exec: Function, run: Function }}
 */
export function makeGatedCli(config = {}) {
  const {
    resolveBin,
    classMap,
    auditFile,
    longTimeoutKeys = new Set(),
    binNotFoundError = 'CLI binary not found',
    authMessage = 'this command runs in YOUR terminal, never through the app',
    binName = '',
    reclassify,
    buildExecArgv,
    detectSentinel,
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    longTimeoutMs = DEFAULT_MAX_TIMEOUT_MS,
    minTimeoutMs = DEFAULT_MIN_TIMEOUT_MS,
    maxTimeoutMs = DEFAULT_MAX_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxErrorBytes = DEFAULT_MAX_ERROR_BYTES,
    maxArgvLen = DEFAULT_MAX_ARGV_LEN,
    maxArgLen = DEFAULT_MAX_ARG_LEN,
    maxPrefixWords = DEFAULT_MAX_PREFIX_WORDS,
    maxBuffer = DEFAULT_MAX_BUFFER,
    execFileImpl = nodeExecFile,
  } = config;

  if (typeof resolveBin !== 'function') throw new TypeError('makeGatedCli: resolveBin(fn) is required');
  if (!classMap || typeof classMap !== 'object') throw new TypeError('makeGatedCli: classMap(object) is required');
  if (!auditFile || typeof auditFile !== 'string') throw new TypeError('makeGatedCli: auditFile(path) is required');

  function bin() {
    try { return resolveBin() || null; } catch { return null; }
  }

  // Longest-prefix classification: try the first 3 non-flag words, then 2,
  // then 1. Conservative by construction — an entry NOT in classMap is
  // unclassifiable, never silently downgraded to 'read'.
  function classify(argv) {
    if (!Array.isArray(argv)) return null;
    const words = argv.filter(a => typeof a === 'string' && !a.startsWith('-'));
    for (let n = Math.min(maxPrefixWords, words.length); n >= 1; n--) {
      const key = words.slice(0, n).join(' ');
      const cls = classMap[key];
      if (cls) {
        // Fail-closed: 'auth' is IMMUTABLE — reclassify never even runs on it,
        // so an auth command can never be downgraded into an executable one.
        if (cls === 'auth') return { key, cls: 'auth' };
        // reclassify may only move among executable classes; any other/unknown
        // return is coerced back to the matched class (never an ungated class).
        const override = typeof reclassify === 'function' ? reclassify(key, cls, argv) : undefined;
        return { key, cls: RECLASS_ALLOWED.has(override) ? override : cls };
      }
    }
    return null;
  }

  // Best-effort, append-only, never throws — an audit failure must never
  // block or mask the underlying command's result.
  function audit(entry) {
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(auditFile, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', { mode: 0o600 });
    } catch { /* best-effort */ }
  }

  // Raw primitive: spawn argv through the resolved binary with hard caps.
  // No classification, no gating, no argv transform — `run()` composes
  // those around this. Exposed directly for callers' own status()/probe
  // calls (e.g. `--version`, unauthenticated `whoami`) that don't need the
  // gate at all.
  function exec(argv, { timeoutMs } = {}) {
    const b = bin();
    if (!b) return Promise.resolve({ ok: false, error: binNotFoundError });
    const t = Math.min(Math.max(timeoutMs ?? defaultTimeoutMs, minTimeoutMs), maxTimeoutMs);
    return new Promise(resolve => {
      execFileImpl(b, argv, { timeout: t, maxBuffer, env: { ...process.env, NO_COLOR: '1' } },
        (err, stdout, stderr) => {
          const out = String(stdout || '').slice(0, maxOutputBytes);
          const errText = String(stderr || '').slice(0, maxErrorBytes);
          let json = null; try { json = JSON.parse(out); } catch { /* not JSON */ }
          const code = err ? (err.killed ? 'timeout' : (err.code ?? 1)) : 0;
          const sentinel = (code !== 0 && typeof detectSentinel === 'function') ? (detectSentinel(code, out, errText) || {}) : {};
          resolve({
            ok: code === 0,
            code,
            json,
            text: json ? undefined : out,
            error: code === 0 ? undefined : (errText || out || String(err && err.message)),
            ...sentinel,
          });
        });
    });
  }

  // The single gate every caller-facing CLI call must go through.
  async function run(argv, opts = {}) {
    if (!Array.isArray(argv) || !argv.length || argv.length > maxArgvLen) return { ok: false, error: 'bad argv' };
    if (!argv.every(a => typeof a === 'string' && a.length <= maxArgLen && !a.includes('\0'))) return { ok: false, error: 'bad argv' };

    const c = classify(argv);
    if (!c) return { ok: false, error: `refused: unknown or unsupported command "${argv.slice(0, 3).join(' ')}"` };

    // Fail-closed invariant: auth NEVER executes, regardless of opts.
    if (c.cls === 'auth') {
      return {
        ok: false,
        needsTerminal: true,
        class: 'auth',
        command: (binName ? binName + ' ' : '') + argv.join(' '),
        error: authMessage,
      };
    }
    if (c.cls === 'financial' && opts.approved !== true) {
      return { ok: false, needsApproval: true, class: 'financial', command: c.key };
    }
    if (c.cls === 'mutate' && opts.confirm !== true && opts.approved !== true) {
      return { ok: false, needsConfirm: true, class: 'mutate', command: c.key };
    }

    const timeoutMs = opts.timeoutMs ?? (longTimeoutKeys.has(c.key) ? longTimeoutMs : defaultTimeoutMs);
    const execArgv = typeof buildExecArgv === 'function' ? buildExecArgv(argv, opts) : argv;
    const r = await exec(execArgv, { timeoutMs });
    if (c.cls !== 'read') audit({ cmd: argv.join(' ').slice(0, 200), class: c.cls, ok: r.ok, code: r.code });
    return { ...r, class: c.cls };
  }

  // Narrow, SAFE probe for the caller's OWN unauthenticated read-only calls
  // (e.g. `--version`, a status query). Runs ONLY commands unknown to classMap
  // (bare flags) or classified 'read'; anything auth/mutate/financial is REFUSED
  // here. The ungated exec() primitive is deliberately NOT exposed — there is no
  // path to run an auth-classified command outside run()'s fail-closed gate.
  function probe(argv, opts = {}) {
    const c = classify(argv);
    if (c && c.cls !== 'read') return Promise.resolve({ ok: false, error: `refused: "${c.key}" (${c.cls}) is not probeable` });
    return exec(argv, opts);
  }

  return { bin, classify, audit, run, probe };
}

export default makeGatedCli;
