// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — platform/evm — fakeChain
// In-memory fake of the evm.mjs read stack for tests: no network, canned
// eth_call/JSON-RPC reads keyed by `${rpcUrl}::${method}::${params}`, canned
// tokenURI metadata keyed by URI. Pure functions (codec + media resolution)
// are re-exported straight from the real module — they're deterministic, so
// faking them would only add a second place for them to drift.
// ─────────────────────────────────────────────────────────────────────────────
import * as RealEvm from './evm.mjs';

const {
  DEFAULT_RPCS, SELECTORS,
  isAddress, encodeUint, encodeAddr, decodeAddr, decodeAbiString,
  resolveMediaUrl, mediaKind,
} = RealEvm;

// seed.reads:  { [`${rpcUrl}::${method}::${JSON.stringify(params)}`]: { result } | { error } }
// seed.metas:  { [uri]: parsedMetadataObjectOrNull }
export function createFakeChain({ reads = {}, metas = {} } = {}) {
  const calls = []; // every ethCall/rpcCall/resolveTokenMeta invocation, for assertions

  async function rpcCall(method, params = [], { rpcs = DEFAULT_RPCS, timeoutMs, skipEmpty = false } = {}) {
    const list = Array.isArray(rpcs) && rpcs.length ? rpcs : DEFAULT_RPCS;
    calls.push({ kind: 'rpcCall', method, params, rpcs: list.slice() });
    let lastError = 'no rpcs configured';
    for (const url of list) {
      const key = `${url}::${method}::${JSON.stringify(params)}`;
      if (!Object.prototype.hasOwnProperty.call(reads, key)) { lastError = 'fake: rpc unreachable'; continue; }
      const canned = reads[key];
      if (canned && canned.error) { lastError = canned.error; continue; }
      if (canned && canned.result !== undefined && canned.result !== null) {
        // Mirror the real port: with skipEmpty a bare '0x' fails over to the next RPC.
        if (skipEmpty && canned.result === '0x') { lastError = 'rpc: empty (0x) result'; continue; }
        return { ok: true, result: canned.result, rpc: url };
      }
      lastError = 'rpc: empty result';
    }
    return { ok: false, error: lastError };
  }

  async function ethCall(to, data, opts) {
    let rpcs = DEFAULT_RPCS, rpcUrl, timeoutMs;
    if (typeof opts === 'string') rpcUrl = opts;
    else if (opts && typeof opts === 'object') ({ rpcs = DEFAULT_RPCS, rpcUrl, timeoutMs } = opts);
    const list = rpcUrl ? [rpcUrl, ...rpcs] : rpcs;
    const r = await rpcCall('eth_call', [{ to, data }, 'latest'], { rpcs: list, timeoutMs, skipEmpty: true });
    return r.ok && r.result && r.result !== '0x' ? r.result : null;
  }

  async function resolveTokenMeta(uri, opts = {}) {
    calls.push({ kind: 'resolveTokenMeta', uri, opts });
    const s = String(uri || '').trim();
    if (!s) return null;
    // data: URIs are pure/local — exercise the REAL decode so this path can
    // never silently diverge from production behavior.
    if (s.startsWith('data:')) return RealEvm.resolveTokenMeta(uri, opts);
    // Scheme resolution + ERC-1155 {id} substitution are ALSO pure — replicate
    // them exactly (same functions the real module uses) so only the actual
    // network fetch is faked, keyed by the fully-resolved URL.
    let u = resolveMediaUrl(s);
    const tokenId = opts && opts.tokenId;
    if (tokenId != null && u.includes('{id}')) u = u.replace('{id}', BigInt(tokenId).toString(16).padStart(64, '0'));
    if (!/^https?:\/\//i.test(u)) return null;
    if (Object.prototype.hasOwnProperty.call(metas, u)) return metas[u];
    return null; // unseeded remote URL
  }

  return {
    DEFAULT_RPCS, SELECTORS,
    isAddress, encodeUint, encodeAddr, decodeAddr, decodeAbiString,
    resolveMediaUrl, mediaKind,
    rpcCall, ethCall, resolveTokenMeta,
    calls,
  };
}

export default createFakeChain;
