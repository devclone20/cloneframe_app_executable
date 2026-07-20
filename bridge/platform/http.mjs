// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — platform/http
//
// Shared JSON-over-HTTP transport primitive for TRUSTED, keyless/BYOK-key
// endpoints (public RPC nodes, public indexers, model-provider APIs the user
// configured themselves). Every hand-rolled `fetch(...)` in nft.mjs,
// virtuals.mjs, robinhood.mjs and models.mjs does the same three things —
// timeout via abort, classify the failure into a stable string, never throw —
// with small variations. This module is the union of those variations: a
// superset every one of those call sites can adopt later with zero behavior
// change (Wave-2 EXPAND step; no caller is touched by this commit).
//
// Wave-2 draft — READ against (never modified):
//   bridge/nft.mjs       — rpcJson/ethCall (POST json-rpc), fetchMeta/soulFetch (GET)
//   bridge/virtuals.mjs  — fetchJson (GET, UA header, 1 retry on network error only)
//   bridge/robinhood.mjs — _rpc (POST json-rpc, queued), _fetchJson (GET)
//   bridge/models.mjs    — probeOpenAICompat/probeAnthropic(Ping) (GET/POST,
//                          AbortSignal.timeout, describeFetchError classifier)
//
// NOT a replacement for web.mjs's fetchRaw/fetchUrl — those guard against
// SSRF (private-IP / localhost / cloud-metadata blocking, DNS re-check per
// redirect hop) because they fetch arbitrary user- or page-supplied URLs.
// Every caller of THIS module fetches a URL that is either hardcoded
// (RPC/indexer endpoints) or a base URL the user themselves typed into
// Settings (BYOK provider base URL) — a materially different trust boundary.
// Do not point this module at attacker-influenced URLs, and do not fold
// web.mjs's guard logic in here or thin it out over there.
//
// Zero deps: Node built-ins + global fetch (undici) only.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;

function hasHeader(headers, name) {
  const target = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === target);
}

// Best-effort body read for a non-2xx response, used only to surface a
// diagnostic payload alongside the error — never thrown, never retried on.
async function readDiagnosticBody(res) {
  try {
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  } catch {
    return null;
  }
}

/**
 * describeFetchError(err) -> string
 *
 * ONE stable classifier for every failure shape this module (or a caller
 * migrating to it) can hit:
 *   - a non-2xx Response (duck-typed: has numeric .status and .ok===false)
 *     -> "http <status>"                          e.g. "http 404"
 *   - an abort/timeout (AbortSignal.timeout fires `TimeoutError` on Node 18+;
 *     an externally-aborted signal throws `AbortError`)
 *     -> "timeout"
 *   - a network-layer failure with a Node error `cause` (ECONNREFUSED,
 *     ENOTFOUND, EAI_AGAIN, etc. — how undici reports connect failures)
 *     -> "<code>: <message>"                      e.g. "ECONNREFUSED: fetch failed"
 *   - anything else -> err.message, or String(err) as a last resort
 *
 * Never throws. Pure — no I/O, safe to call from a fake or a real driver.
 */
export function describeFetchError(err) {
  if (err == null) return 'unknown error';
  if (typeof err === 'object' && typeof err.status === 'number' && err.ok === false) {
    return `http ${err.status}`;
  }
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  const cause = err.cause;
  if (cause && cause.code) return `${cause.code}: ${cause.message || err.message || 'network error'}`;
  if (err.message) return err.message;
  return String(err);
}

/**
 * fetchJson(url, options) -> Promise<Result>
 *
 * options:
 *   method    — default 'GET'
 *   headers   — plain object, merged as-is (caller controls casing)
 *   body      — a string/Uint8Array/URLSearchParams is sent verbatim; any
 *               other value is JSON.stringify'd and a `content-type:
 *               application/json` header is added IF the caller didn't
 *               already set one (case-insensitively)
 *   timeoutMs — default 10000; enforced via AbortSignal.timeout
 *   retries   — default 0 (no retry). A retry is taken ONLY when the
 *               `fetch()` call itself throws (network/abort/timeout) —
 *               mirrors virtuals.mjs's existing comment: "a well-formed
 *               non-2xx response is not retried, just reported back". Total
 *               attempts made = retries + 1.
 *
 * Result (discriminated on `ok`) — never throws:
 *   { ok: true,  status, data }                       — 2xx, body is JSON
 *                                                        (empty body -> data: null)
 *   { ok: false, status, error: 'http <status>', data } — non-2xx; `data` is
 *                                                        the parsed (or raw
 *                                                        text) body, best-effort
 *   { ok: false, status, error: 'invalid-json', data: null } — 2xx but the
 *                                                        body did not parse as
 *                                                        JSON (failure is
 *                                                        surfaced, never
 *                                                        silently swallowed)
 *   { ok: false, error }                               — no `status`: the
 *                                                        request never got a
 *                                                        response at all
 *                                                        (network/timeout/
 *                                                        invalid URL)
 */
export async function fetchJson(url, options = {}) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, error: 'invalid-url' };
  }

  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 0,
  } = options;

  const sendHeaders = { ...headers };
  let sendBody = body;
  if (
    sendBody !== undefined &&
    typeof sendBody !== 'string' &&
    !(sendBody instanceof Uint8Array) &&
    !(sendBody instanceof URLSearchParams)
  ) {
    sendBody = JSON.stringify(sendBody);
    if (!hasHeader(sendHeaders, 'content-type')) sendHeaders['content-type'] = 'application/json';
  }

  const maxAttempts = Math.max(0, Number(retries) || 0) + 1;
  let lastNetworkError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: sendHeaders,
        body: sendBody,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastNetworkError = err;
      if (attempt < maxAttempts - 1) continue; // retry: network/abort/timeout only, never on a real response
      return { ok: false, error: describeFetchError(err) };
    }

    if (!res.ok) {
      const data = await readDiagnosticBody(res);
      return { ok: false, status: res.status, error: describeFetchError(res), data };
    }

    let text;
    try {
      text = await res.text();
    } catch (err) {
      return { ok: false, status: res.status, error: describeFetchError(err), data: null };
    }
    if (!text) return { ok: true, status: res.status, data: null };
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) };
    } catch {
      return { ok: false, status: res.status, error: 'invalid-json', data: null };
    }
  }
  // Unreachable in practice (the loop always returns), kept as a defensive fallback.
  return { ok: false, error: lastNetworkError ? describeFetchError(lastNetworkError) : 'unreachable' };
}

export const Http = { fetchJson, describeFetchError };
export default Http;
