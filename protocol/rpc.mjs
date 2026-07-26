// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME HUB · protocol/rpc.mjs
//
// TICKET T-004 (Wave-1 architecture, protocol docs). PURE DOCUMENTATION-AS-CODE.
// Imported by no one yet. Every constant and shape below is transcribed BYTE-
// ACCURATE from the real running code, not from intent or the original design.
// When phase-2 wires a real client/server pair to this file, treat any mismatch
// between this file and the source below as a bug in THIS file — re-derive it.
//
// Sources of truth (read in full before touching this file again):
//   bridge/hub-bridge.mjs
//     - MODULES / MODEXPORT registries . . . . . . . . . . . . . . . . L418-432
//     - getMod() (lazy import + cache) . . . . . . . . . . . . . . . . L434-439
//     - handleMod() (the /mod/<name> router + the {ok,error} envelope) L440-452
//     - router wiring for /pair /shell /chat /provider-chat /email/*
//       and /mod/* . . . . . . . . . . . . . . . . . . . . . . . . . . L536-553
//   index.html
//     - const RPC = (()=>{ ... })()  (the ONLY client of /mod/<name>)  ~L4114-4122
//     - const Bridge = (()=>{ ... })()  (endpoint/token/pair/health)   ~L3873-3954
//     - const Mail = (()=>{ ... })()  (the parallel, NON-RPC /email/*
//       client — same envelope convention, different path shape)      ~L4088-4111
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── Transport ────────────────────────────────────────────────────────────
 * Every RPC call is a single HTTP request to the HUB Bridge daemon
 * (bridge/hub-bridge.mjs), which:
 *   - binds 127.0.0.1 ONLY (HOST = '127.0.0.1', hub-bridge.mjs L27)
 *   - listens on HUB_BRIDGE_PORT env var, default 8765 (L28)
 *   - is gated by `localOnly(req)` on EVERY request: the Host header must be
 *     exactly `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`, AND
 *     the raw socket's remoteAddress must be a loopback address. This is an
 *     anti DNS-rebinding check, not an auth check (hub-bridge.mjs L107-115).
 */
export const BRIDGE_DEFAULT_PORT = 8765; // HUB_BRIDGE_PORT env var overrides
export const BRIDGE_HOST = '127.0.0.1';

/**
 * ── Auth ─────────────────────────────────────────────────────────────────
 * A bearer token, persisted at ~/.clone-frame-hub/bridge.token (chmod 600),
 * minted with `randomBytes(24).toString('base64url')` by bridge/session.mjs,
 * which also owns its lifetime. Permanent by default; the owner may give it an
 * expiry or rotate it on demand in Settings → Session, and either one mints a
 * replacement — so no client may cache the token beyond the current window.
 *
 * The token reaches the browser one of two ways:
 *   1. Auto-pair: a real top-level navigation (`Sec-Fetch-Dest: document`)
 *      to the bridge's own static server gets the token INJECTED into the
 *      served index.html as `<script>window.__CFHUB_BRIDGE__={endpoint,token}</script>`
 *      (hub-bridge.mjs serveStatic(), L157-170). The client reads this once
 *      at boot (index.html Bridge IIFE, ~L3947-3952) and stores it via
 *      sessionStorage (NEVER localStorage — cleared when the tab closes).
 *   2. Manual paste: the owner pastes `http://127.0.0.1:8765#token=<TOKEN>`
 *      into MY MACHINE; `Bridge.parse()` (index.html ~L3880-3886) splits the
 *      URL fragment/query and `Bridge.connect()` stores the token the same way.
 *
 * Every authenticated request carries the token as:
 *   Authorization: Bearer <token>
 * and ONLY that way. (index.html RPC IIFE reads it from
 * `sessionStorage['cfhub.bridge.tok']`; server-side `authed(req)` parses the
 * header and hands the value to `Session._verify` — bridge/session.mjs — which
 * does the constant-time XOR compare and applies the owner's lifetime policy.)
 * A `?token=` query param was accepted until 2026-07-26; no client ever sent
 * one, and a URL is the wrong place for a secret (history, logs, Referer).
 *
 * /health is the ONE unauthenticated route (deliberately minimal — no cwd,
 * no brain/model — so an unauthenticated probe learns nothing; hub-bridge.mjs
 * L524-530). Everything past it requires `authed(req)` to pass (L536), except
 * GET of static files.
 */
export const AUTH_HEADER = 'authorization';
export const AUTH_SCHEME = 'Bearer';
// (there is no query-param carrier: the header is the only one)
export const TOKEN_STORAGE_KEY = 'cfhub.bridge.tok'; // sessionStorage key on the client
export const AUTO_PAIR_GLOBAL = '__CFHUB_BRIDGE__'; // window.__CFHUB_BRIDGE__ = {endpoint, token}

/**
 * ── The module-RPC route: POST /mod/<name> ──────────────────────────────
 * ONE route serves every backend module (hub-bridge.mjs L415-452, wired at
 * L552). Modules are lazily `import()`ed on first use and cached forever
 * per-process (`getMod()`, L434-439) — one broken module's import failure
 * never affects any other module.
 *
 * Request body (JSON):
 *   { fn: string, args?: any[] }
 *
 * `args` is spread positionally onto the target function:
 *   f.apply(obj, Array.isArray(body.args) ? body.args : [])
 * (hub-bridge.mjs L450). There is no named-parameter form — everything is
 * positional, exactly as the JS function signature expects.
 */
export const RPC_PATH_PREFIX = '/mod/';

/** Builds the request path for a module call. Mirrors `RPC(mod,fn,...args)`
 *  client-side (index.html ~L4114-4122), which POSTs to `ep + '/mod/' + mod`. */
export function rpcPath(moduleName) {
  return RPC_PATH_PREFIX + moduleName;
}

/**
 * ── fn validation (server-side, hub-bridge.mjs L444-449) ────────────────
 * A call is rejected with 400 BEFORE the module is even touched if:
 *   - `fn` is falsy/empty
 *   - `fn[0] === '_'`        (leading-underscore = private/internal convention)
 *   - `fn === 'constructor'` (blocks prototype-pollution-style access)
 * Then the module is loaded (503 on import failure) and `obj[fn]` must be a
 * function (400 "no such fn" if not).
 */
export const FN_REJECT_LEADING_CHAR = '_';
export const FN_REJECT_LITERAL = 'constructor';

/**
 * ── Response envelope — READ CAREFULLY, this is asymmetric ──────────────
 *
 * FAILURE responses are a router-enforced envelope, ALWAYS this shape:
 *   { ok: false, error: string }
 * emitted by the router's own `fail(code, e)` helper (hub-bridge.mjs L442):
 *   fail = (code, e) => { res.writeHead(code, {'Content-Type':'application/json'});
 *                          res.end(JSON.stringify({ ok:false, error: String((e&&e.message)||e) })); }
 *
 * SUCCESS responses are NOT enveloped by the router. `ok(o)` (L441) does:
 *   res.writeHead(200, {...}); res.end(JSON.stringify(o));
 * where `o` is exactly whatever the target module function returned (after
 * `await`). The router adds nothing — no `{ok:true, ...}` wrapper, no status
 * field. Individual modules conventionally return `{ ok: true, ... }` shaped
 * objects themselves (e.g. files.write, servers.run), but this is a MODULE-
 * AUTHOR CONVENTION, not a router guarantee — some module functions return a
 * bare value instead (e.g. `harness.list` returns a plain Array; the client
 * consumes it directly as `harnesses.find(...)`, index.html ~L5041/5361 —
 * never `.ok`/`.result`). A phase-2 typed client MUST treat the success shape
 * as "whatever that specific module.fn returns", not as a fixed envelope.
 *
 * HTTP status is always 200 on success, and one of the FAILURE_STATUS codes
 * below on failure. There is no 2xx/4xx split by "logical" success — a module
 * fn that itself returns `{ok:false, error:'...'}` as its OWN business-logic
 * result (e.g. "file not found") still gets HTTP 200, because from the
 * router's point of view the call itself succeeded (the function returned
 * without throwing). Only router-level failures (bad module/fn, import
 * throw, or the fn throwing) produce a non-200 status + the enforced envelope.
 */
export const ENVELOPE_FAILURE_SHAPE = Object.freeze({ ok: false, error: '' /* string */ });

/**
 * ── Failure status codes (hub-bridge.mjs handleMod, L440-452) ───────────
 * All reachable ONLY via the /mod/<name> route. (/pair, /shell, /chat,
 * /provider-chat, /email/* have their own status codes — see below.)
 */
export const MOD_ERROR = Object.freeze({
  UNKNOWN_MODULE: { status: 404, when: 'MODULES[name] does not exist', error: 'unknown module' },
  BAD_FN:         { status: 400, when: "fn missing, fn[0]==='_', or fn==='constructor'", error: 'bad fn' },
  MODULE_UNAVAILABLE: { status: 503, when: 'import(MODULES[name]) threw', error: '<name> unavailable: <message>' },
  NO_SUCH_FN:     { status: 400, when: 'typeof obj[fn] !== "function"', error: 'no such fn: <fn>' },
  FN_THREW:       { status: 500, when: 'the module function rejected/threw during the call', error: '<exception message>' },
});

/**
 * ── The client wrapper: `RPC(mod, fn, ...args)` (index.html ~L4114-4122) ─
 * Exact reference implementation the client actually runs:
 *
 *   const RPC = (() => {
 *     const tok = () => sessionStorage.getItem('cfhub.bridge.tok') || '';
 *     return async function (mod, fn, ...args) {
 *       const ep = Store.get().bridge.endpoint; if (!ep) throw new Error('no HUB Bridge');
 *       const r = await fetch(ep + '/mod/' + mod, {
 *         method: 'POST',
 *         headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok() },
 *         body: JSON.stringify({ fn, args }),
 *       });
 *       if (!r.ok) {
 *         let t = ''; try { t = (await r.json()).error || ''; } catch (e) {}
 *         throw new Error(mod + '.' + fn + ' ' + r.status + (t ? ' · ' + t : ''));
 *       }
 *       return r.json();
 *     };
 *   })();
 *
 * Notes:
 *   - There is NO retry, NO timeout, NO AbortController on this path (unlike
 *     Bridge.streamRaw — see stream.mjs). A hung module fn hangs the call.
 *   - On non-2xx, the thrown Error's message is `"<mod>.<fn> <status>[ · <error>]"`.
 *     Callers almost always wrap in try/catch and degrade (e.g. `catch(_){}`
 *     then treat the feature as unavailable) rather than surface the error.
 *   - The endpoint (`Store.get().bridge.endpoint`) is separate from the token:
 *     endpoint persists in the app's own Store (survives reload); the token
 *     lives ONLY in sessionStorage and is never written to disk by the site.
 */
export function describeRpcCall(mod, fn, args = []) {
  return { method: 'POST', path: rpcPath(mod), body: { fn, args } };
}

/**
 * ── Module registry (hub-bridge.mjs MODULES + MODEXPORT, L418-432) ──────
 * `name` is the path segment after /mod/ AND the RPC(mod, ...) first arg.
 * `file` is resolved relative to bridge/ via `import(MODULES[name])`.
 * `exportName` is the property `getMod()` pulls off the imported module
 * (falling back to `m.default`, then the whole module object):
 *   const obj = m[MODEXPORT[name]] || m.default || m;
 * This list is the COMPLETE and ONLY set of valid `mod` values for RPC() —
 * anything else is a 404 UNKNOWN_MODULE.
 */
export const MODULES = Object.freeze({
  tasks:        { file: './tasks.mjs',        exportName: 'Tasks' },
  approvals:    { file: './approvals.mjs',    exportName: 'Approvals' },
  style:        { file: './style.mjs',        exportName: 'Style' },
  contacts:     { file: './contacts.mjs',     exportName: 'Contacts' },
  integrations: { file: './integrations.mjs', exportName: 'Integrations' },
  models:       { file: './models.mjs',       exportName: 'Models' },
  calendar:     { file: './calendar.mjs',     exportName: 'Calendar' },
  notes:        { file: './notes.mjs',        exportName: 'Notes' },
  library:      { file: './library.mjs',      exportName: 'Library' },
  research:     { file: './research.mjs',     exportName: 'Research' },
  cookbook:     { file: './cookbook.mjs',     exportName: 'Cookbook' },
  gallery:      { file: './gallery.mjs',      exportName: 'Gallery' },
  compare:      { file: './compare.mjs',      exportName: 'Compare' },
  reminders:    { file: './reminders.mjs',    exportName: 'Reminders' },
  admin:        { file: './admin.mjs',        exportName: 'Admin' },
  scheduled:    { file: './scheduled.mjs',    exportName: 'Scheduled' },
  oauth:        { file: './oauth.mjs',        exportName: 'OAuth' },
  images:       { file: './images.mjs',       exportName: 'Images' },
  search:       { file: './search.mjs',       exportName: 'Search' },
  web:          { file: './web.mjs',          exportName: 'Web' },
  browser:      { file: './browser.mjs',      exportName: 'Browser' },
  harness:      { file: './harness.mjs',      exportName: 'Harness' },
  nft:          { file: './nft.mjs',          exportName: 'NFT' },
  files:        { file: './files.mjs',        exportName: 'Files' },
  permissions:  { file: './permissions.mjs',  exportName: 'Permissions' },
  folders:      { file: './folders.mjs',      exportName: undefined },
  servers:      { file: './servers.mjs',      exportName: undefined },
  acp:          { file: './acp.mjs',          exportName: 'Acp' },
  robinhood:    { file: './robinhood.mjs',    exportName: 'Robinhood' },
  okxai:        { file: './okxai.mjs',        exportName: 'OkxAi' },
  virtuals:     { file: './virtuals.mjs',     exportName: 'Virtuals' },
  pty:          { file: './pty.mjs',          exportName: 'Pty' },
  it:           { file: './it.mjs',           exportName: 'It' },
  ssh:          { file: './ssh.mjs',          exportName: 'Ssh' },
  keeper:       { file: './keeper.mjs',       exportName: 'Keeper' },
  matrix:       { file: './matrix.mjs',       exportName: 'Matrix' },
  assistant:    { file: './assistant.mjs',    exportName: 'Assistant' },
});
// NOTE: `folders` and `servers` appear in MODULES but have NO entry in
// MODEXPORT — for those, `getMod()` falls through straight to
// `m.default || m` (the whole module namespace object). (The old `proxy`
// module was retired with the proxy-reader browser — L1 CDP rebuild.)

/**
 * ── Sibling, NON-RPC module routes on the SAME daemon ────────────────────
 * These are NOT reachable through RPC(mod,fn,...args) / POST /mod/<name>.
 * They exist alongside it, share the same auth (`authed(req)`) and the same
 * unenveloped-success / enveloped-failure convention, but have their own
 * fixed path per operation instead of an {fn,args} body.
 *
 *   POST /pair            → { ok, cwd, brain: 'anthropic'|null, model }   (hub-bridge.mjs L538-541)
 *   POST /shell           → marker-stream, see stream.mjs                (L542, L186-244)
 *   POST /interrupt {id}  → { ok: boolean }  (SIGINT the running /shell cmd, L543-547)
 *   POST /chat            → marker-stream (Anthropic BYOK relay), see stream.mjs (L548, L247-282)
 *   POST /provider-chat   → marker-stream (any configured provider), see stream.mjs (L549, L353-413)
 *   POST /email/<route>   → same ok()/fail() convention as /mod, fixed route table
 *                           (accounts/account.get/add/test/remove/default/folders/list/
 *                           message/attachment/send/flag/move/drafts/draft.save/
 *                           draft.delete/refresh), hub-bridge.mjs L293-320, wired L550-551
 *   GET  /health           → { ok, name, version, host }  — the ONLY unauthenticated route (L526-530)
 */
export const SIBLING_ROUTES = Object.freeze([
  '/pair', '/shell', '/interrupt', '/chat', '/provider-chat', '/email/*', '/health',
]);
