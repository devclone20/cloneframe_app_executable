// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — platform/json-store
//
// The one shared persistence primitive for every ~/.clone-frame-hub/*.json
// store in the bridge. Behavior-compatible superset of the ~27 hand-rolled
// load()/save() pairs duplicated today (see permissions.mjs, notes.mjs,
// servers.mjs, nft.mjs, browser.mjs, harness.mjs, scheduled.mjs, tasks.mjs,
// ssh.mjs, oauth.mjs, …). EXPAND-ONLY: this module changes no caller; a later
// wave swaps each module's local load/save for openStore() with zero behavior
// change for RPC clients.
//
// Contract (each is a from-scratch invariant, not "whatever fs happened to do"):
//   • directory is created (and re-chmod'd) 0700 on every access that needs it
//   • every write is atomic: write to a same-directory tmp file, chmod it
//     0600, then rename() over the target — a reader never observes a
//     partially-written file, and a crash mid-write leaves the OLD file intact
//     (never a torn one)
//   • a missing file (ENOENT) or corrupt/hand-edited JSON degrades to the
//     caller's `shape` defaults — read() NEVER throws for that case
//   • every persisted object is stamped with the store's configured `version`
//     on both read and write (read: reflects the current shape's version
//     regardless of what an older file happened to contain; write: same)
//   • read() re-reads from disk on EVERY call — there is no cached singleton.
//     This is the fix for the stale-read bug in nft.mjs / servers.mjs /
//     browser.mjs / harness.mjs, each of which does `let store = load()` once
//     at import time and never refreshes it, so a second bridge process (or a
//     hand-edited file) writing to the same path is invisible until restart.
//   • mutate(fn) performs one read-modify-write per call, and calls on the
//     SAME store handle are serialized through an in-process queue — even if
//     `fn` awaits I/O mid-mutation (as scheduled.mjs's tick() does while it
//     awaits Email.send() for each due item before its single trailing
//     saveStore(store)). Today, any RPC call that loads/mutates/saves the
//     scheduled store WHILE tick() is mid-flight races tick()'s final save
//     and the other call's update is silently lost (last-write-wins on two
//     independently-loaded copies). mutate() closes that window: only one
//     read-modify-write section runs at a time per store handle.
//
// Explicitly OUT of scope (stays the domain module's job, same as today):
//   per-field shape validation/sanitization (e.g. "notes must be an array of
//   valid note objects", tag de-duplication, secret-masking on the way out to
//   the client). This module only guarantees the TOP-LEVEL container is the
//   right shape after a read; callers keep doing their own defensive
//   coercion on the fields inside it, exactly as notes.mjs's sanitizeNote()
//   and servers.mjs's Array.isArray(s.servers) guard do today.
//
// Deliberate, additive tightening vs. today's originals (documented, not
// hidden): mkdir/write failures here PROPAGATE (throw) rather than being
// swallowed to `false`/`undefined` the way servers.mjs/nft.mjs/browser.mjs/
// harness.mjs's save() do today. A caller that wants the old "swallow and
// report false" behavior gets it for free with `try { store.write(x); } catch
// { return false }` at the call site — but a shared platform primitive must
// never itself hide a disk-full/permission error from every caller built on
// top of it. permissions.mjs/notes.mjs/scheduled.mjs already surface write
// failures (their saveStore() call sites are wrapped in the domain module's
// own try/catch, e.g. notes.create()'s `catch (e) { return {ok:false,...} }`)
// — this module generalizes THAT pattern, not the swallow-everything one.
//
// Zero deps. Node >=18 built-ins only.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_ROOT = path.join(homedir(), '.clone-frame-hub');

/**
 * @param {object} opts
 * @param {string} opts.name     store name; backing file is `${name}.json`
 * @param {number} [opts.version=1]  stamped onto every read()/write() result
 * @param {object} [opts.shape={}]   default top-level shape merged under a
 *   loaded file (or returned outright on ENOENT/corrupt) — e.g. {notes: []}
 * @param {string} [opts.root]   override the containing directory; defaults
 *   to ~/.clone-frame-hub. Tests point this at a tmp dir; real callers omit it.
 * @returns {{ read(): object, write(data:object): object,
 *   mutate(fn:(data:object)=>any|Promise<any>): Promise<any>, path: string }}
 */
export function openStore({ name, version = 1, shape = {}, root = DEFAULT_ROOT } = {}) {
  if (!name || typeof name !== 'string') throw new TypeError('openStore: name is required');
  const dir = root;
  const file = path.join(dir, `${name}.json`);

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort on odd/shared filesystems */ }
  }

  function defaults() {
    // structuredClone so callers mutating what they get back never corrupt
    // the shape template shared across every read().
    return { version, ...structuredClone(shape) };
  }

  // Read-path: NEVER throws for a missing or corrupt file — that is expected,
  // tolerated input (first run, or a hand-edited/half-written JSON file).
  // Anything else (e.g. mkdir failing because the parent is unwritable) is a
  // real, exceptional failure and propagates.
  function read() {
    // Pure read: NO ensureDir side-effect (Opus review T-010). A missing dir or
    // file surfaces as ENOENT below and degrades to defaults; only a genuine
    // EACCES on an existing file propagates. write()/mutate() own dir creation.
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return defaults();
      return { ...defaults(), ...data, version };
    } catch (e) {
      if (e instanceof SyntaxError || e?.code === 'ENOENT') return defaults();
      throw e; // e.g. EACCES reading the file — not something to silently paper over
    }
  }

  // Write-path: atomic tmp-write + chmod + rename. Throws on any failure
  // (disk full, permission denied, …) — callers decide whether/how to
  // downgrade that to a soft {ok:false} result, same as notes.mjs/
  // scheduled.mjs already do at their call sites.
  function write(data) {
    ensureDir();
    const payload = { ...data, version };
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return payload;
  }

  // Read-modify-write in one shot. Calls on THIS handle are serialized via an
  // in-process promise queue, so a slow `fn` (one that awaits network I/O
  // between reading and the implicit save, like scheduled.mjs's tick()) can't
  // interleave with another mutate() call and lose that call's update.
  //
  // `fn` receives the freshly-read data object and mutates it in place (push/
  // splice/assign fields) — the same idiom every existing module already uses
  // (`const store = loadStore(); store.notes.push(x); saveStore(store);`).
  // Whatever `fn` returns is handed back to the caller (e.g. a new note's id,
  // or an {ok, error} result) — it is NOT treated as a replacement store.
  // If `fn` throws/rejects, the write is skipped entirely and the rejection
  // propagates to the caller; the queue still advances for later callers.
  //
  // NOTE (scope of the atomicity guarantee): serialization is per PROCESS,
  // per store handle (in-memory queue) — it does not add cross-process file
  // locking. That matches the bridge's actual deployment (a single daemon
  // process owns each store file); see `risks` in the port's writeup.
  let queue = Promise.resolve();
  function mutate(fn) {
    const run = queue.then(async () => {
      const data = read();
      const result = await fn(data);
      write(data);
      return result;
    });
    // Keep the queue alive even if this turn rejects, so later mutate() calls
    // still run in order instead of piling up behind a permanently-rejected link.
    queue = run.then(() => {}, () => {});
    return run;
  }

  return { read, write, mutate, path: file };
}

export default { openStore };
