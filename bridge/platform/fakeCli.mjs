// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — fakeCli (in-memory double for cli-gate.mjs's binary)
//
// A gated CLI has exactly two points of contact with the outside world:
// `resolveBin()` (is the binary installed, and where) and `execFileImpl()`
// (actually running it). This module fakes BOTH, entirely in memory, so
// cli-gate's contract tests can exercise the real gate logic — argv
// validation, longest-prefix classification, fail-closed sentinels, timeout
// clamping, audit writes — without spawning a process or requiring
// `onchainos`/`acp` (or anything else) to be installed on the test machine.
//
// This is a FAKE in the deep-module sense (Ousterhout): same interface
// contract as the real dependency (an execFile-shaped function, a
// resolveBin-shaped function), fully working, radically simpler — no
// process table, no OS timeout thread, just a lookup table and a
// setImmediate/setTimeout to preserve async ordering.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fake execFile with the exact (file, args, options, callback)
 * signature node:child_process's execFile uses, so it drops straight into
 * makeGatedCli's `execFileImpl` config slot.
 *
 * @param {object} [opts]
 * @param {Record<string, {stdout?:string, stderr?:string, code?:(number|'timeout'), hang?:boolean, delayMs?:number}>} [opts.responses]
 *   — keyed by the joined non-flag words of argv (same key shape cli-gate's
 *   classify() produces), so a test can script "agent whoami" → one canned
 *   reply and "wallet send" → another.
 * @param {object} [opts.defaultResponse] — used when argv doesn't match any
 *   key in `responses`. Defaults to a clean `{ stdout: '', code: 0 }`.
 * @param {Array} [opts.calls] — pass your own array to capture every
 *   invocation (`{file, args, timeout}`) for assertions like "auth never
 *   reached execFile at all".
 * @returns {{ fakeExecFile: Function, calls: Array }}
 */
export function makeFakeExecFile({ responses = {}, defaultResponse, calls = [] } = {}) {
  function fakeExecFile(file, args, options, callback) {
    calls.push({ file, args: [...args], timeout: options && options.timeout });
    // Look up by the exact argv first (lets a test script flag-sensitive
    // behavior, e.g. "agent status --big"), falling back to the same
    // non-flag word key cli-gate's classify() uses.
    const exactKey = args.join(' ');
    const wordKey = args.filter(a => !String(a).startsWith('-')).join(' ');
    const resp = responses[exactKey] || responses[wordKey] || defaultResponse || { stdout: '', stderr: '', code: 0 };

    const respond = () => {
      if (resp.code === 'timeout' || resp.hang) {
        const err = new Error('fakeCli: command timed out');
        err.killed = true;
        callback(err, resp.stdout || '', resp.stderr || '');
        return;
      }
      const code = resp.code || 0;
      const err = code !== 0 ? Object.assign(new Error('fakeCli: exit ' + code), { code }) : null;
      callback(err, resp.stdout || '', resp.stderr || '');
    };

    // Preserve execFile's async-callback contract without real process
    // scheduling latency; opt into a delay only when a test wants ordering
    // (e.g. proving a longer timeout key was actually honored).
    if (resp.delayMs) setTimeout(respond, resp.delayMs);
    else setImmediate(respond);
  }
  return { fakeExecFile, calls };
}

/**
 * Build a fake resolveBin() — "the CLI is installed at this path" (or
 * "not installed" when `installed:false`, to exercise the binNotFoundError
 * path without touching the filesystem).
 *
 * @param {string} [binPath]
 * @param {{installed?: boolean}} [opts]
 * @returns {() => (string|null)}
 */
export function makeFakeResolveBin(binPath = '/fake/bin/cli', { installed = true } = {}) {
  return () => (installed ? binPath : null);
}

/**
 * Convenience: wire a full fake gated CLI in one call — a real
 * `makeGatedCli` (pass the function in; this module has no dependency on
 * cli-gate.mjs, keeping the fake independently importable/testable) bolted
 * to fully in-memory bin resolution and execution.
 *
 * @param {Function} makeGatedCli — cli-gate.mjs's factory
 * @param {object} [config] — same shape makeGatedCli(config) takes, minus
 *   resolveBin/execFileImpl (this supplies both)
 * @param {object} [fake]
 * @param {Record<string,object>} [fake.responses]
 * @param {object} [fake.defaultResponse]
 * @param {boolean} [fake.installed=true]
 * @param {string} [fake.binPath='/fake/bin/cli']
 * @returns {{bin:Function, classify:Function, audit:Function, exec:Function, run:Function, calls:Array}}
 */
export function makeFakeGatedCli(makeGatedCli, config = {}, fake = {}) {
  const { responses, defaultResponse, installed = true, binPath = '/fake/bin/cli' } = fake;
  const { fakeExecFile, calls } = makeFakeExecFile({ responses, defaultResponse });
  const gate = makeGatedCli({
    ...config,
    resolveBin: makeFakeResolveBin(binPath, { installed }),
    execFileImpl: fakeExecFile,
  });
  return { ...gate, calls };
}

export default { makeFakeExecFile, makeFakeResolveBin, makeFakeGatedCli };
