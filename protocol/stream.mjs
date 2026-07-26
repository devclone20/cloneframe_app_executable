// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME HUB · protocol/stream.mjs
//
// TICKET T-004 (Wave-1 architecture, protocol docs). PURE DOCUMENTATION-AS-CODE.
// Imported by no one yet. Every constant and shape below is transcribed BYTE-
// ACCURATE from the real running code, not from intent or the original design.
//
// The HUB Bridge has TWO independent "streaming" mechanisms that share nothing
// but the daemon and the auth convention. Do not conflate them:
//
//   (A) HTTP MARKER-STREAM  — POST /shell, /chat, /provider-chat. A single
//       chunked HTTP response body that is plain live text UNTIL the first
//       NUL (\x00) byte, after which everything is an out-of-band marker
//       trailer parsed once at stream end. One request = one command/turn;
//       the connection closes when the command/turn finishes.
//
//   (B) WEBSOCKET PTY/CONTROL STREAM — GET /stream (upgraded from HTTP).
//       A long-lived duplex socket: either a raw PTY (keystrokes in, terminal
//       bytes out, with small JSON control frames interleaved) or the iT
//       control-plane channel (pure JSON request/response, no PTY at all).
//
// Sources of truth (read in full before touching this file again):
//   bridge/hub-bridge.mjs
//     - streamHead() (chunked response headers) . . . . . . . . . . . . L134-141
//     - handleShell() (marker emission: CWD/EXIT/ERR/CLEAR/NEEDSUDO) . . L186-244
//     - handleChat() (Anthropic SSE → marker-stream) . . . . . . . . . . L247-282
//     - handleProviderChat() (any provider SSE/JSON → marker-stream) . . L353-413
//     - the `wss` WebSocketServer + handleProtocols + upgrade gate . . . L562-580
//     - dispatchStream() (op routing, hello construction) . . . . . . . L624-681
//     - ensureZdot() (shell env injected into op:'shell' only) . . . . . L585-623
//   bridge/pty.mjs
//     - attach() (the WS message loop: JSON control vs. literal keystrokes) L262-312
//     - resize()/signal()/kill() (what each control frame actually calls) L207-226
//     - VALID_SIGNALS (the {signal} allow-list) . . . . . . . . . . . . . L42-45
//   bridge/it.mjs
//     - attachCtl() (the op:'it' control-plane protocol) . . . . . . . . L57-68
//   index.html
//     - Bridge.streamRaw() + Bridge.marks() (the marker-stream client) . ~L3921-3945
//     - Bridge.shell()/chat()/providerChat() (the 3 marker-stream callers) ~L3942-3944
//     - Term() (the WS PTY client: xterm.js ↔ /stream) . . . . . . . . . ~L3805-3867
//     - the `it` window's control socket (op=it) . . . . . . . . . . . . ~L8209
// ─────────────────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════════
// (A) HTTP MARKER-STREAM — /shell, /chat, /provider-chat
// ═════════════════════════════════════════════════════════════════════════

/**
 * Response headers set by `streamHead(res)` for all three endpoints
 * (hub-bridge.mjs L134-141):
 *   Content-Type: text/plain; charset=utf-8
 *   Cache-Control: no-cache, no-transform
 *   X-Accel-Buffering: no
 *   Connection: keep-alive
 * HTTP status is always 200 once streaming begins — errors mid-stream are
 * reported IN-BAND via the ERR marker below, not via a non-200 status
 * (the response has already been written by the time an error can occur).
 */
export const STREAM_CONTENT_TYPE = 'text/plain; charset=utf-8';

/**
 * ── The marker vocabulary ─────────────────────────────────────────────
 * A marker is the literal byte 0x00 ('\x00') followed by an UPPERCASE key,
 * followed by another 0x00, followed by a value (which may be empty), e.g.:
 *   "\x00CWD\x00/Users/alex"
 *   "\x00EXIT\x000"
 *   "\x00ERR\x00command timed out (2m)\n"
 * Markers are written with plain `res.write(...)` / `res.end(...)` calls —
 * there is no length-prefixing or escaping. A literal 0x00 byte can in
 * practice appear ONLY as a marker delimiter because command stdout/stderr
 * bytes never legitimately contain NUL in the shapes this bridge streams.
 */
export const MARKER_BYTE = '\x00';

export const MARKERS = Object.freeze({
  /** `\x00CWD\x00<absolutePath>` — the bridge's tracked cwd AFTER the command
   *  ran. Emitted by /shell on: a successful `cd` (hub-bridge.mjs L197), on
   *  `pwd` (L202, in ADDITION to the plain-text "<cwd>\n" already written
   *  live), and on every normal command completion via the EXIT marker's
   *  own trailing `+ '\x00CWD\x00' + state.cwd` (L241). Client: `marks()`
   *  sets `o.cwd = v` (index.html L3924). /chat and /provider-chat never
   *  emit CWD (they have no cwd concept). */
  CWD: 'CWD',

  /** `\x00EXIT\x00<code>` — the child process's exit code (0 if code was
   *  null/undefined — hub-bridge.mjs L241: `(code ?? 0)`). /shell-only,
   *  emitted exactly once per command, always immediately followed by a
   *  CWD marker in the SAME write (`'\x00EXIT\x00'+code+'\x00CWD\x00'+cwd`).
   *  Client: `marks()` sets `o.exit = +v` (numeric coercion). */
  EXIT: 'EXIT',

  /** `\x00ERR\x00<message>` — an out-of-band error/diagnostic that is NOT a
   *  process exit. Can appear MULTIPLE times in one stream (e.g. a stdout
   *  write after cap + a later timeout) — `marks()` ACCUMULATES all ERR
   *  values into `o.err`, newline-joined (index.html L3924:
   *  `o.err=(o.err?o.err+'\n':'')+v`). Emitted by:
   *    /shell:  catastrophic-pattern refusal (L207), sudo-without-Root-mode
   *             refusal, output cap exceeded — 512 KiB, `OUT_CAP` (L233),
   *             2-minute command timeout — `CMD_TIMEOUT` (L229), child
   *             spawn error (L238).
   *    /chat:   non-2xx from api.anthropic.com (L262), an SSE `event:error`
   *             frame from Anthropic (L274), AbortError/timeout or any
   *             fetch exception (L280).
   *    /provider-chat: non-2xx from the configured provider (L374, L401,
   *             L403), any fetch exception (L411). (OpenAI-compatible SSE
   *             `delta.content` is written as PLAIN text, not wrapped in
   *             ERR — only actual error frames use the marker.) */
  ERR: 'ERR',

  /** `\x00CLEAR\x00` (no value) — /shell only, emitted verbatim when the
   *  command IS exactly `clear` (hub-bridge.mjs L203: `res.end('\x00CLEAR\x00')`).
   *  Client: `marks()` sets `o.clear = true`; the terminal UI clears its
   *  scrollback. This is the ONLY /shell built-in besides `cd`/`pwd` that
   *  short-circuits the real `zsh -lc` spawn entirely. */
  CLEAR: 'CLEAR',

  /** `\x00NEEDSUDO\x00` (no value) — /shell only. Emitted when the command
   *  starts with `sudo`, Root-mode permission IS granted (`Permissions.can('root')`),
   *  but the request carried no `sudoPass` field yet (hub-bridge.mjs L216).
   *  This is a REQUEST BACK to the client to prompt for a password and retry
   *  the SAME command with `body.sudoPass` set — the daemon does not hold a
   *  cached password. If Root mode is OFF, the daemon instead emits a plain
   *  ERR ("root/sudo is OFF...") and never reaches this marker (L214). */
  NEEDSUDO: 'NEEDSUDO',
});

/**
 * ── Client-side parser: `Bridge.marks(post)` (index.html L3921-3926) ────
 * Exact reference implementation:
 *
 *   function marks(post) {
 *     const o = {};
 *     const parts = post.split('\x00');
 *     for (let i = 1; i < parts.length; i += 2) {
 *       const k = parts[i], v = parts[i + 1] || '';
 *       if (k === 'CWD') o.cwd = v;
 *       else if (k === 'EXIT') o.exit = +v;
 *       else if (k === 'CLEAR') o.clear = true;
 *       else if (k === 'ERR') o.err = (o.err ? o.err + '\n' : '') + v;
 *       else if (k === 'NEEDSUDO') o.needSudo = true;
 *     }
 *     return o;
 *   }
 *
 * `post` is everything AFTER the first 0x00 byte seen anywhere in the whole
 * response body — see `streamRaw()` below for exactly how that boundary is
 * found. Splitting on '\x00' means `parts[0]` is always empty (the boundary
 * byte itself starts the split), so the loop starts at index 1 and reads
 * (key, value) pairs two at a time. An odd/unpaired trailing key silently
 * gets `v=''` via `parts[i+1]||''`.
 */
export function parseMarkers(post) {
  const o = {};
  const parts = String(post).split(MARKER_BYTE);
  for (let i = 1; i < parts.length; i += 2) {
    const k = parts[i], v = parts[i + 1] || '';
    if (k === MARKERS.CWD) o.cwd = v;
    else if (k === MARKERS.EXIT) o.exit = Number(v);
    else if (k === MARKERS.CLEAR) o.clear = true;
    else if (k === MARKERS.ERR) o.err = (o.err ? o.err + '\n' : '') + v;
    else if (k === MARKERS.NEEDSUDO) o.needSudo = true;
  }
  return o;
}

/**
 * ── Client-side transport: `Bridge.streamRaw(path, bodyObj, onText, signal)`
 * (index.html L3927-3941). Exact behavior:
 *   1. POST `endpoint + path` with the auth header + `JSON.stringify(bodyObj)`.
 *   2. 401/403 → throw "not paired — paste the bridge link in MY MACHINE".
 *   3. non-ok or no body → throw "bridge http <status>".
 *   4. Read the body via a streaming reader. Before the FIRST 0x00 byte is
 *      seen ANYWHERE in the stream, each decoded chunk (or the prefix of a
 *      chunk before its first 0x00) is handed LIVE to `onText(chunk)` — this
 *      is what makes shell output / chat tokens appear incrementally.
 *   5. From the first 0x00 byte onward (inclusive), NOTHING further is
 *      handed to `onText` — all remaining bytes, across all remaining
 *      chunks, are buffered into `post` and parsed ONCE at stream end via
 *      `marks(post)`.
 *   6. Returns the parsed marker object (`{cwd?, exit?, clear?, err?, needSudo?}`).
 *
 * CONSEQUENCE (a real wire-contract detail, not a hypothetical): if a NUL
 * byte ever appeared in the MIDDLE of legitimate live output, everything
 * after it would silently stop streaming live and get swallowed into the
 * marker buffer instead — the protocol relies on the daemon never emitting
 * 0x00 except as a deliberate marker boundary.
 *
 *   const shell        = (cmd, onText, signal, id, extra) =>
 *     streamRaw('/shell', Object.assign({ cmd, id: id || '' }, extra || {}), onText, signal);
 *   const chat         = (messages, onTok, signal, opts) =>
 *     streamRaw('/chat', Object.assign({ messages }, opts || {}), onTok, signal);
 *   const providerChat = (providerId, model, messages, onTok, signal, opts) =>
 *     streamRaw('/provider-chat', Object.assign({ providerId, model, messages }, opts || {}), onTok, signal);
 */
export const MARKER_STREAM_ENDPOINTS = Object.freeze({
  shell:        { path: '/shell',         body: ['cmd', 'id', '...extra'] },
  chat:         { path: '/chat',          body: ['messages', '...opts (e.g. model, system, max_tokens)'] },
  providerChat: { path: '/provider-chat', body: ['providerId', 'model', 'messages', '...opts (e.g. system, max_tokens)'] },
});

/** `/shell` request body fields actually read server-side (hub-bridge.mjs L186-218). */
export const SHELL_REQUEST_FIELDS = Object.freeze({
  cmd: 'string — the shell command (required; trimmed; empty → immediate res.end())',
  id: 'string — client-chosen correlation id for POST /interrupt (defaults to a random 8-hex if omitted)',
  sudoPass: 'string — sudo password, ONLY sent on the retry after a NEEDSUDO marker; never stored, never logged',
});

/** `/chat` request body fields (hub-bridge.mjs L247-260; talks to Anthropic
 *  with the daemon's OWN key from env/~/.env.local — never the client's). */
export const CHAT_REQUEST_FIELDS = Object.freeze({
  messages: 'Array — Anthropic Messages API `messages`',
  model: "string — default DEFAULT_MODEL (HUB_BRIDGE_MODEL env var, else 'claude-opus-4-8')",
  system: 'string — default is a fixed HUB system prompt (hub-bridge.mjs L252)',
  max_tokens: 'number — default 2048',
});

/** `/provider-chat` request body fields (hub-bridge.mjs L353-413; routes to
 *  Anthropic OR any OpenAI-compatible endpoint, using a provider record the
 *  OWNER configured via the `models` module — never a client-supplied key). */
export const PROVIDER_CHAT_REQUEST_FIELDS = Object.freeze({
  providerId: 'string — required; looked up via Models._raw(providerId); 404 if not found',
  model: "string — falls back to raw.models[0], else 'auto'",
  messages: 'Array',
  system: 'string — default \'\'',
  max_tokens: 'number — default 2048',
});

/** `POST /interrupt {id}` — NOT a marker-stream itself, but the companion
 *  to /shell: sends SIGINT to the process group tracked under `id`
 *  (hub-bridge.mjs L543-547). Response: `{ ok: boolean }` where `ok` is
 *  true only if a running command with that `id` was found. */
export const INTERRUPT_REQUEST_FIELDS = Object.freeze({ id: 'string — must match the id passed to /shell' });

// ═════════════════════════════════════════════════════════════════════════
// (B) WEBSOCKET PTY/CONTROL STREAM — GET /stream (upgrade)
// ═════════════════════════════════════════════════════════════════════════

export const WS_PATH = '/stream';

/**
 * ── Subprotocol handshake (the token carrier for this transport) ────────
 * The client offers TWO subprotocols on the WebSocket constructor:
 *   ['cfhub', 'cfhub.bearer.<token>']
 * (index.html L3834: `new WebSocket(url, ['cfhub', 'cfhub.bearer.'+b.token])`)
 *
 * Server `handleProtocols` (hub-bridge.mjs L562-563) accepts the connection
 * ONLY if 'cfhub' is among the offered protocols, and echoes back JUST
 * 'cfhub' (never the bearer one) — so the token subprotocol is write-only
 * from the client's side and is deliberately never reflected.
 *
 * The upgrade handler (L569-580) then, in order:
 *   1. Requires `url.pathname === '/stream'` (destroys the socket otherwise).
 *   2. Requires `localOnly(req)` (loopback Host + loopback remoteAddress).
 *   3. Parses `Sec-WebSocket-Protocol` into a list, finds the one prefixed
 *      `cfhub.bearer.`, strips the prefix, and compares the remainder to
 *      TOKEN with the same constant-time XOR loop used for HTTP auth.
 *   4. On ANY failure at any of these 3 steps: `socket.destroy()` — no HTTP
 *      error status, no close frame, just a raw TCP reset. This is why the
 *      token is carried in the subprotocol and NEVER the URL: a URL would
 *      leak into proxy/access logs; the subprotocol header does not.
 */
export const WS_SUBPROTOCOL_BASE = 'cfhub';
export const WS_SUBPROTOCOL_BEARER_PREFIX = 'cfhub.bearer.'; // + <token>, client-offered only, never echoed

/**
 * ── Query parameters accepted by GET /stream (dispatchStream, L624-681) ──
 * All parsed from the upgrade request's URL query string.
 */
export const WS_QUERY_PARAMS = Object.freeze({
  op: "'shell' (default) | 'ssh' | 'keeper' | 'it' — selects the branch below",
  cols: 'number, clamped [1,1000], default 80 — initial PTY width (ignored for op=it)',
  rows: 'number, clamped [1,1000], default 24 — initial PTY height (ignored for op=it)',
  cwd: 'string — initial working directory for the spawned process (op=shell/ssh/keeper)',
  host: "string — a SAVED ssh alias name (never a raw hostname), op='ssh' only",
  sess: "string, must match /^[A-Za-z0-9_-]{1,64}$/ — keeper session id, op='keeper' only",
  sid: 'string, must match /^[A-Za-z0-9_-]{8,64}$/ — a client-minted STABLE session id enabling Phase-4 reattach (survives page reload); op=shell/ssh',
  persist: "'1' to keep the pty alive across a detach (used together with sid)",
  ws: 'string, must match /^[\\w-]{1,64}$/ — iT workspace id, forwarded into the shell env as CFHUB_IT_WORKSPACE (op=shell only)',
  surf: 'string, must match /^[\\w-]{1,64}$/ — iT surface id, forwarded as CFHUB_IT_SURFACE (op=shell only)',
});

/**
 * ── `op` values and what each becomes server-side ────────────────────────
 * Every op except 'it' ends by loading the `pty` module and calling
 * `Pty.attach(ws, hello)` with a `hello` object built as described. 'it'
 * never touches Pty at all — it is a pure JSON control channel.
 */
export const WS_OPS = Object.freeze({
  shell: {
    default: true,
    hello: "{ cmd: $SHELL||'zsh', args:['-l'], cwd, cols, rows, env?, id?, persist? }",
    notes: [
      "env.ZDOTDIR is set (only when the shell is zsh) to a generated dir under ~/.clone-frame-hub/zdot — see ensureZdot(), L585-623 — that sources the user's OWN dotfiles untouched, then layers an OSC 7 cwd-tracking hook, a 15s+ long-command OSC 777 notifier, and puts the `it` CLI on PATH.",
      'env.CFHUB_IT_WORKSPACE / CFHUB_IT_SURFACE are set from the ws/surf query params when they match their regex.',
      'env.CFHUB_BRIDGE is always set to http(s)://<host>:<port> — the `it` CLI reads the pairing token from disk, never from this env.',
      'hello.id/hello.persist are set only when `sid` matches its regex — this is the Phase-4 reattach path (pty.mjs reuses a live session by id instead of spawning a new one).',
    ],
  },
  ssh: {
    hello: '{ cmd, args, cwd, cols, rows, id?, persist? } — cmd/args come from Ssh._connectArgs(alias), server-side only',
    notes: [
      "Gated by the 'ssh' permission (default OFF) — closes 1008 'ssh permission is off' if not granted.",
      '`host` is an alias name, NEVER a raw hostname/IP — resolution happens entirely server-side so the real address never crosses to the client.',
      'ssh is only the TRANSPORT for iT-remote — this is CLONE FRAME\'s own remote engine.',
      'hello.id/hello.persist set from `sid` (must match /^[A-Za-z0-9_-]{8,64}$/) + `persist` — reattach to a live ssh pty after reload.',
    ],
  },
  keeper: {
    hello: "{ cmd: process.execPath, args: [keeperPath, 'attach', sess], cwd, cols, rows }",
    notes: [
      'Rejects (ws.close(1008)) if `sess` fails /^[A-Za-z0-9_-]{1,64}$/.',
      'Session lives in a DETACHED daemon process that outlives both this WS connection AND a full bridge restart; this WS attach is just an ephemeral `keeper attach` child bridging to it.',
      'Calls `Keeper.ensure(sess, {cwd, cols, rows})` first; closes 1011 on failure.',
    ],
  },
  it: {
    hello: 'N/A — no PTY, no Pty.attach() call at all',
    notes: [
      'Routes straight to `It.attachCtl(ws)` (bridge/it.mjs) — see the IT CONTROL PLANE section below.',
      'One socket per open iT window; this is the ONLY op that is not a terminal.',
    ],
  },
});

/**
 * ── PTY data-plane message protocol (bridge/pty.mjs attach(), L262-312) ──
 * Applies to op = shell | attach | ssh | keeper (anything that reaches
 * Pty.attach). Direction: SERVER → CLIENT is always raw terminal bytes
 * (`ws.send(buf)`, whatever the child process wrote to its pty). Direction
 * CLIENT → SERVER is inspected on every message:
 *
 *   - Binary frames: ALWAYS treated as literal keystrokes —
 *     `pty.write(raw.toString('utf8'))` (pty.mjs L306). No control parsing.
 *   - Text frames: if the string does NOT start with '{', it's written
 *     straight to the pty as literal keystrokes (L303). If it DOES start
 *     with '{', the daemon attempts `JSON.parse`; on parse failure OR a
 *     parsed object that matches none of the 3 recognized shapes below, it
 *     ALSO falls through to literal-keystroke `pty.write()` (L301-303) — so
 *     typing a literal `{` as the first character of a real command is safe
 *     as long as the rest doesn't happen to parse into one of the 3 shapes.
 *
 * Recognized JSON control shapes (checked in this order; first match wins,
 * each `return`s immediately without writing to the pty):
 */
export const PTY_CONTROL_FRAMES = Object.freeze({
  resize: {
    shape: '{ resize: { cols: number, rows: number } }',
    effect: 'calls pty.resize(cols, rows) — SIGWINCH to the child. Client sends this via Term()\'s ResizeObserver, debounced 300ms, and only when the grid actually changed (index.html L3841-3850).',
  },
  signal: {
    shape: '{ signal: string }',
    effect: "calls pty.kill(normalizeSignal(sig)) — sends a real POSIX signal to the pty's foreground process. normalizeSignal() upper-cases, prefixes 'SIG' if missing, and falls back to SIGTERM for anything not in VALID_SIGNALS. Not currently sent by index.html's Term() client, but is live, gated wire surface.",
    validSignals: ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGQUIT', 'SIGTSTP', 'SIGCONT', 'SIGWINCH', 'SIGUSR1', 'SIGUSR2'],
    fallback: 'SIGTERM',
  },
  kill: {
    shape: '{ kill: true }',
    effect: "ends the session outright (endSession(sess,'closed by client')) — used when a tab/pane is closed ON PURPOSE. Client: Term().dispose(kill=true) sends this before closing the socket; dispose(kill=false/undefined) — e.g. a reload — just closes the socket WITHOUT this frame, which lets a persistent session DETACH instead of dying (pty.mjs onWsGone(), L249-260).",
  },
});

/** Reference client sender for the two control frames actually in use
 *  (index.html L3848, L3864 — `signal` is documented above but unsent). */
export function ptyResizeFrame(cols, rows) {
  return JSON.stringify({ resize: { cols, rows } });
}
export function ptyKillFrame() {
  return JSON.stringify({ kill: true });
}

/**
 * ── IT CONTROL PLANE — op='it' (bridge/it.mjs, L1-69) ────────────────────
 * A pure JSON request/response channel, no PTY, no shell. Purpose: the `it`
 * CLI (invoked from inside an iT-managed shell, via POST /mod/it {fn:'cmd',
 * args:[argv, ctx]}) needs to ferry a command over to the iT WINDOW itself
 * (e.g. "split the pane", "focus tab 3") and get an answer back.
 *
 * Up to 8 concurrent iT-window control sockets are kept in a STACK (not a
 * single slot) — `ctls` array, oldest evicted (closed 1000) past 8
 * (it.mjs L59-60). Commands are always sent to the MOST RECENTLY attached
 * socket that is still open (`liveCtl()`, L15-21) — older windows are
 * silent fallbacks, never force-kicked.
 *
 * Connect handshake: immediately on attach, the daemon sends:
 *   { hello: 'it-ctl' }
 *
 * Bridge → iT window (one per pending `It.cmd(argv, ctx)` call):
 *   { id: string, argv: string[], ctx: { workspace?: string, surface?: string } }
 * where `id` is `'it' + <monotonic seq>`, and `ctx` fields are included only
 * if they matched /^[\w-]{1,64}$/.
 *
 * iT window → bridge (the answer):
 *   { id: string, result: any }
 * `result` is passed through as-is if it's an object, else coerced to
 * `{ ok: true, out: String(result ?? '') }` (it.mjs settle(), L23-28).
 *
 * Timeout: 6000ms (`TIMEOUT_MS`) per command — if no matching `{id,result}`
 * arrives in time, the CLI call resolves with
 *   { ok: false, error: 'iT did not answer (timeout) — is the iT window responsive?' }
 * If there is no live control socket at all when a command is issued:
 *   { ok: false, error: 'iT is not open — open the iT terminal in CLONE FRAME first' }
 */
export const IT_CTL_MAX_SOCKETS = 8;
export const IT_CTL_TIMEOUT_MS = 6000;
export const IT_CTL_HELLO = Object.freeze({ hello: 'it-ctl' });

export function itCtlRequestFrame(id, argv, ctx) {
  return JSON.stringify({ id, argv, ctx: ctx || {} });
}
export function itCtlResponseFrame(id, result) {
  return JSON.stringify({ id, result });
}
