// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — platform/evm
// Zero-dep EVM read stack: keyless JSON-RPC with failover, hand-rolled ABI
// encode/decode for the handful of selectors the bridge actually calls
// (tokenURI/ownerOf/balanceOf/…), and tokenURI-style metadata + media-scheme
// resolution (data:/ipfs:/ar:/irys:). Zero deps: node: imports + global fetch.
//
// Unifies the three hand-rolled forks of this same read stack:
//   bridge/nft.mjs, bridge/virtuals.mjs, bridge/robinhood.mjs
// so future callers share ONE codec + ONE failover implementation instead of
// three copies that can silently drift apart.
//
// Deliberately OUT of scope (stays where it is — a separate security seam):
//   nft.mjs's neural-soul origin allowlist (SOUL_ORIGINS / SOUL_GH_PREFIX /
//   soulOriginOk / soulUrl / soulFetch / soulValidate). That allowlist gates
//   what may be treated as a privileged system prompt — it must not be
//   reachable from a generic "read any chain" module.
//
// Every function here is a pure computation or a network call that NEVER
// throws across an await boundary the caller didn't ask for: failures come
// back as {ok:false, error} (rpcCall) or null (the convenience wrappers
// ethCall/resolveTokenMeta, matching the exact contract the three forks
// already rely on) — never a swallowed exception, never a silent undefined.
// ─────────────────────────────────────────────────────────────────────────────

// ── constants ────────────────────────────────────────────────────────────────

// Base mainnet (chain 8453) public RPCs — identical list/order in nft.mjs and
// virtuals.mjs today. Callers on another chain (e.g. Robinhood Chain, 4663)
// must pass their own `rpcs` array; this default only suits Base.
export const DEFAULT_RPCS = [
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://1rpc.io/base',
];

// 4-byte selectors actually used across the three forks (verified against
// each file — nothing invented). keccak256(sig)[0:4], hardcoded since we ship
// no keccak implementation.
export const SELECTORS = {
  tokenURI: '0xc87b56dd',            // tokenURI(uint256)                 — nft.mjs, virtuals.mjs
  ownerOf: '0x6352211e',             // ownerOf(uint256)                  — nft.mjs
  name: '0x06fdde03',                // name()                            — nft.mjs
  balanceOf: '0x70a08231',           // balanceOf(address)                — nft.mjs, robinhood.mjs
  tokenOfOwnerByIndex: '0x2f745c59', // tokenOfOwnerByIndex(address,uint256) — nft.mjs
  approve: '0x095ea7b3',             // approve(address,uint256)          — robinhood.mjs
  allowance: '0xdd62ed3e',           // allowance(address,address)        — robinhood.mjs
};

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const META_MAX = 1.5 * 1024 * 1024; // 1.5MB cap on fetched tokenURI metadata JSON
const RPC_TIMEOUT_MS = 8000;
const META_TIMEOUT_MS = 8000;

// ── address / uint codec (the shared math behind all three forks) ───────────

export function isAddress(a) {
  return ADDR_RE.test(String(a || ''));
}

// uint256 → left-padded 32-byte word, no 0x prefix (append directly after a
// 0x-prefixed selector). Throws on non-integer input by design — callers are
// expected to pass a real tokenId/amount; a silent NaN-word would be worse.
export function encodeUint(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}

// address → left-padded 32-byte word, no 0x prefix.
export function encodeAddr(a) {
  return String(a || '').replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

// last 20 bytes of a 32-byte word → '0x'-prefixed address (does not checksum).
export function decodeAddr(hex) {
  if (!hex) return '';
  const h = String(hex).replace(/^0x/, '');
  return '0x' + h.slice(24, 64);
}

// decode a single ABI-encoded `string`/`bytes` eth_call return
// ([offset][length][data,padded]) → utf8 string. Never throws; '' on any
// malformed input (empty result, huge/garbage length, bad hex).
export function decodeAbiString(hex) {
  if (!hex || hex === '0x') return '';
  try {
    const h = String(hex).replace(/^0x/, '');
    const len = parseInt(h.slice(64, 128), 16);
    if (!Number.isFinite(len) || len <= 0 || len > 2_000_000) return '';
    const data = h.slice(128, 128 + len * 2);
    return Buffer.from(data, 'hex').toString('utf8');
  } catch { return ''; }
}

// ── media scheme resolution (data:/ipfs:/ar:/irys: → fetchable https) ───────

function ipfsGateway(u) {
  return u.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + u.slice(7).replace(/^ipfs\//, '') : u;
}

// any tokenURI/media pointer scheme → fetchable https, so an <img>/<video>/
// fetch() can render it. http(s) and data: URIs pass through unchanged.
export function resolveMediaUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('ipfs://')) return ipfsGateway(s);
  if (s.startsWith('ar://')) return 'https://arweave.net/' + s.slice(5);
  if (s.startsWith('irys://')) return 'https://gateway.irys.xyz/' + s.slice(7);
  return s;
}

// best-effort media kind from a resolved URL's extension, so a caller's UI
// can pick the right player (image | video | glb | html). Query/fragment
// stripped before sniffing.
export function mediaKind(url) {
  const u = String(url || '').split(/[?#]/)[0].toLowerCase();
  if (!u) return '';
  if (/\.(glb|gltf)$/.test(u)) return 'glb';
  if (/\.(mp4|webm|mov|m4v)$/.test(u)) return 'video';
  if (/\.(png|jpe?g|gif|svg|webp|avif)$/.test(u)) return 'image';
  return 'html';
}

// ── JSON-RPC with failover ───────────────────────────────────────────────────

// Generic JSON-RPC call, tried against each rpc URL in order until one
// returns a usable result. Structured, explicit failure: {ok:false, error}
// carries the LAST rpc's failure reason — never throws, never swallows.
export async function rpcCall(method, params = [], { rpcs = DEFAULT_RPCS, timeoutMs = RPC_TIMEOUT_MS, skipEmpty = false } = {}) {
  const list = Array.isArray(rpcs) && rpcs.length ? rpcs : DEFAULT_RPCS;
  let lastError = 'no rpcs configured';
  for (const url of list) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let r;
      try {
        r = await fetch(url, {
          method: 'POST',
          signal: ctl.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) { lastError = `rpc http ${r.status}`; continue; }
      const j = await r.json();
      if (j && j.error) { lastError = (j.error && j.error.message) || 'rpc error'; continue; }
      if (j && j.result !== undefined && j.result !== null) {
        // skipEmpty: a bare '0x' from an eth_call read (balanceOf/ownerOf/tokenURI)
        // is NOT a valid answer — a real zero is '0x0000…', so '0x' is exclusively
        // a rate-limited/lagging-node signal. Fail over to the next RPC instead of
        // committing to it. Restores the pre-consolidation nft.mjs failover (Wave-3
        // adversarial review, HIGH) and fixes virtuals' identity enrichment too.
        // Off by default so every other rpcCall caller/method is unaffected.
        if (skipEmpty && j.result === '0x') { lastError = 'rpc: empty (0x) result'; continue; }
        return { ok: true, result: j.result, rpc: url };
      }
      lastError = 'rpc: empty result';
    } catch (e) {
      lastError = e && e.name === 'AbortError' ? 'rpc timeout' : ((e && e.message) || 'rpc failed');
    }
  }
  return { ok: false, error: lastError };
}

// Convenience wrapper matching the exact contract nft.mjs/virtuals.mjs already
// rely on: returns the raw result hex, or null on any failure / empty ('0x')
// response. Accepts either the new `{ rpcs }` options form, or a bare rpcUrl
// string (nft.mjs/virtuals.mjs's original positional arg) prepended to the
// failover list — a superset every existing caller can drop straight in.
export async function ethCall(to, data, opts) {
  let rpcs = DEFAULT_RPCS, rpcUrl, timeoutMs = RPC_TIMEOUT_MS;
  if (typeof opts === 'string') rpcUrl = opts;
  else if (opts && typeof opts === 'object') ({ rpcs = DEFAULT_RPCS, rpcUrl, timeoutMs = RPC_TIMEOUT_MS } = opts);
  const list = rpcUrl ? [rpcUrl, ...rpcs] : rpcs;
  // skipEmpty: '0x' is a bad-node signal for these reads, so fail over past it
  // rather than committing to the first RPC that returns it.
  const r = await rpcCall('eth_call', [{ to, data }, 'latest'], { rpcs: list, timeoutMs, skipEmpty: true });
  return r.ok && r.result && r.result !== '0x' ? r.result : null;
}

// ── tokenURI-style metadata resolution ───────────────────────────────────────

// tokenURI → parsed metadata JSON, or null. Handles the on-chain form
// (data:application/json[;base64],…) locally with no network call, and the
// off-chain form (http(s)/ipfs://ar://irys://) by resolving the scheme then
// fetching (timeout + 1.5MB cap; never throws). ERC-1155 `{id}` is substituted
// with the padded hex tokenId when one is given.
export async function resolveTokenMeta(uri, { tokenId, timeoutMs = META_TIMEOUT_MS } = {}) {
  const s = String(uri || '').trim();
  if (!s) return null;
  if (s.startsWith('data:')) {
    try {
      const comma = s.indexOf(',');
      if (comma < 0) return null;
      const head = s.slice(5, comma), payload = s.slice(comma + 1);
      const raw = /;base64/i.test(head) ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
      return JSON.parse(raw);
    } catch { return null; }
  }
  let u = resolveMediaUrl(s);
  if (tokenId != null && u.includes('{id}')) u = u.replace('{id}', BigInt(tokenId).toString(16).padStart(64, '0'));
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try {
      r = await fetch(u, { signal: ctl.signal, headers: { accept: 'application/json, text/plain, */*' } });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return null;
    const text = await r.text();
    if (text.length > META_MAX) return null;
    return JSON.parse(text);
  } catch { return null; }
}

// ── aggregate export (matches the object-export idiom used across bridge/*) ─

export const Evm = {
  DEFAULT_RPCS, SELECTORS,
  isAddress, encodeUint, encodeAddr, decodeAddr, decodeAbiString,
  resolveMediaUrl, mediaKind,
  rpcCall, ethCall, resolveTokenMeta,
};
export default Evm;
