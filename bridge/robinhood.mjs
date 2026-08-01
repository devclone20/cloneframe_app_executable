// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — robinhood
// Read-only helper for Robinhood Chain (Arbitrum Nitro L2 on Ethereum, chain id
// 4663 / testnet 46630): status probe, balances, token + NFT listings via a
// keyless JSON-RPC endpoint and the public Blockscout indexer.
// Zero deps: node: imports + global fetch + the shared platform/evm codec.
//
// The generic address/uint256 codec primitives (isAddress/encodeUint/encodeAddr)
// come from platform/evm.mjs — one shared, contract-tested implementation
// instead of a private byte-identical fork. The bespoke launch-payload encoder
// below (fixed-size string arrays, uint8[] cores, dynamic bytes → preLaunch)
// stays local: the port has no equivalent for that shape, and a wrong encoding
// here builds a wrong on-chain tx. The keyless _rpc wrapper (concurrency cap +
// monotonic request id, single-endpoint) also stays local — the port's rpcCall
// carries neither.
// ─────────────────────────────────────────────────────────────────────────────

import { isAddress, encodeUint, encodeAddr } from './platform/evm.mjs';

const TIMEOUT_MS = 10_000;

// Hardcoded from docs.robinhood.com/chain — no discovery, these don't change often.
const CHAINS = {
  mainnet: {
    chainId: 4663,
    chainIdHex: '0x1237',
    name: 'Robinhood Chain',
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    type: 'Arbitrum Nitro L2 on Ethereum',
  },
  testnet: {
    chainId: 46630,
    chainIdHex: '0xB626',
    name: 'Robinhood Chain Testnet',
    rpc: 'https://rpc.testnet.chain.robinhood.com',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    type: 'Arbitrum Nitro L2 on Ethereum',
  },
};

// ── cache ────────────────────────────────────────────────────────────────────
// Public RPC + Blockscout are rate-limited — cache aggressively, in memory only.
// A Stock Token's uiMultiplier only moves on a corporate action, so it is worth caching hard.
const TTL = { status: 15_000, balance: 30_000, list: 5 * 60_000, multiplier: 60 * 60_000 };
const _cache = new Map();
function _cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.exp) { _cache.delete(key); return undefined; }
  return hit.val;
}
function _cacheSet(key, val, ttlMs) { _cache.set(key, { val, exp: Date.now() + ttlMs }); }

// ── JSON-RPC concurrency cap ────────────────────────────────────────────────
const MAX_CONCURRENT = 8;
let _inFlight = 0;
const _queue = [];
function _acquire() {
  return new Promise((resolve) => {
    if (_inFlight < MAX_CONCURRENT) { _inFlight++; resolve(); return; }
    _queue.push(resolve);
  });
}
function _release() {
  _inFlight--;
  const next = _queue.shift();
  if (next) { _inFlight++; next(); }
}
let _id = 1;
function _nextId() { return _id++; }

// keyless JSON-RPC POST, one call = one queue slot, 10s timeout, never throws
async function _rpc(method, params = [], testnet = false) {
  const chain = testnet ? CHAINS.testnet : CHAINS.mainnet;
  await _acquire();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(chain.rpc, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: _nextId(), method, params }),
    });
    if (!r.ok) return { ok: false, error: `rpc http ${r.status}` };
    const j = await r.json();
    if (j && j.error) return { ok: false, error: (j.error && j.error.message) || 'rpc error' };
    if (j && j.result !== undefined && j.result !== null) return { ok: true, result: j.result };
    return { ok: false, error: 'rpc: empty result' };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'rpc timeout' : ((e && e.message) || 'rpc failed') };
  } finally {
    clearTimeout(timer);
    _release();
  }
}

// keyless GET JSON (Blockscout API v2), 10s timeout, never throws
async function _fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return { ok: false, status: r.status, error: `http ${r.status}` };
    const data = await r.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : ((e && e.message) || 'fetch failed') };
  } finally {
    clearTimeout(timer);
  }
}

// wei → fixed 6dp ETH string (native currency display; not trimmed)
function _formatEth(wei) {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const base = 1_000000000000000000n; // 1e18
  const whole = v / base;
  const frac = (v % base).toString().padStart(18, '0').slice(0, 6);
  return (neg ? '-' : '') + whole.toString() + '.' + frac;
}

// raw integer string + decimals → human-readable string, trailing zeros trimmed
function _formatUnits(raw, decimals) {
  const d = Math.max(0, Number(decimals) || 0);
  let v; try { v = BigInt(raw); } catch { return '0'; }
  const neg = v < 0n;
  if (neg) v = -v;
  if (d === 0) return (neg ? '-' : '') + v.toString();
  const base = 10n ** BigInt(d);
  const whole = v / base;
  const frac = (v % base).toString().padStart(d, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (frac ? `${whole}.${frac}` : whole.toString());
}

// Blockscout token-balances item → normalized shape
function _normalizeToken(it) {
  if (!it) return null;
  const tok = it.token || {};
  const decimals = Number(tok.decimals ?? 18) || 0;
  const raw = it.value ?? it.balance ?? '0';
  return {
    symbol: tok.symbol || '',
    name: tok.name || '',
    decimals,
    balance: _formatUnits(raw, decimals),
    rawUnits: String(raw),                 // integer units — the scaling pass needs full precision
    address: tok.address || tok.address_hash || '',
    type: tok.type || '',
  };
}

// ── Stock Tokens: the balance the explorer reports is NOT what the holder owns ────────────
// Robinhood's tokenised equities carry a `uiMultiplier()` that absorbs corporate actions
// (splits, and the daily accrual of income instruments). The contract's own
// `balanceOfUI(a) = mulDiv(balanceOf(a), uiMultiplier(), 1e18)` is the true display balance —
// Blockscout's token-balances endpoint returns the RAW value, so showing it directly
// under-reports the holder. Measured 2026-07-26: SGOV's top holder owns 3358.152844… but the
// raw value reads 3354.940422… — 3.21 tokens missing, and that gap widens every day it accrues.
//
// The trap is that the multiplier is exactly 1.0 on almost every ticker (12 of 14 sampled), so
// testing on AAPL "proves" this code is unnecessary. It is not; it is only invisible.
const UI_MULTIPLIER_SELECTOR = '0xa60bf13d';       // uiMultiplier()
const ONE = 10n ** 18n;                            // the contract's DENOMINATOR (1 ether)

// Reads uiMultiplier() for one token. Returns null when the token does not implement it —
// which is the normal case for every ordinary ERC-20 and the cheapest way to tell a real
// Stock Token from an impostor sharing its ticker (there are several on this chain).
async function _uiMultiplier(tokenAddr, testnet) {
  const key = 'mult:' + (testnet ? 't' : 'm') + ':' + String(tokenAddr).toLowerCase();
  const hit = _cacheGet(key);
  if (hit !== undefined && hit !== null) return hit.value;
  const r = await _rpc('eth_call', [{ to: tokenAddr, data: UI_MULTIPLIER_SELECTOR }, 'latest'], testnet);
  // A plain ERC-20 reverts here. That is an answer, not a failure — cache it so we ask once.
  let value = null;
  if (r.ok && typeof r.result === 'string' && /^0x[0-9a-fA-F]{2,}$/.test(r.result)) {
    try { const v = BigInt(r.result); if (v > 0n) value = v.toString(); } catch { /* not a uint */ }
  }
  // Only a REAL answer goes in the cache. `_rpc` reports a timeout, an HTTP 502 and a
  // contract revert all as {ok:false}, and caching them alike turned one bad second into an
  // hour of "not a Stock Token" — the multiplier silently unapplied and every holding of that
  // token under-reported, with nothing on screen to say the read had failed.
  const answered = r.ok || /revert|invalid opcode|out of gas|no data|0x$/i.test(String(r.error || ''));
  if (answered) _cacheSet(key, { value }, TTL.multiplier);
  return value;
}

// Scale a normalized token list in place. Fails OPEN: an RPC hiccup leaves the raw balance
// showing rather than blanking a holding the owner really has.
async function _applyStockMultipliers(list, testnet) {
  for (const t of list) {
    if (!t || !t.address || t.type === 'ERC-721' || t.type === 'ERC-1155') continue;
    let mult = null;
    try { mult = await _uiMultiplier(t.address, testnet); } catch { continue; }
    if (!mult || mult === ONE.toString()) continue;   // absent or exactly 1.0 → nothing to correct
    try {
      const scaled = (BigInt(t.rawUnits) * BigInt(mult)) / ONE;
      t.balanceRaw = t.balance;                        // keep what the explorer said, for auditing
      t.balance = _formatUnits(scaled.toString(), t.decimals);
      t.uiMultiplier = _formatUnits(mult, 18);
      t.stockToken = true;
    } catch { /* leave the raw balance in place */ }
  }
  return list;
}

// Blockscout nft item → normalized shape (best-effort field mapping)
function _normalizeNft(it) {
  if (!it) return null;
  const md = it.metadata || {};
  const tok = it.token || {};
  const tokenId = it.id ?? it.token_id ?? '';
  return {
    name: md.name || (tokenId !== '' ? `#${tokenId}` : (tok.name || 'NFT')),
    tokenId,
    contract: tok.address || tok.address_hash || '',
    image: it.image_url || md.image || '',
  };
}

// ── public surface ───────────────────────────────────────────────────────────

function chains() {
  // shallow-safe copy so callers can't mutate the shared constant
  return JSON.parse(JSON.stringify(CHAINS));
}

// probe: eth_chainId + eth_blockNumber + eth_gasPrice, verify chain id matches
async function status({ testnet = false } = {}) {
  const key = 'status:' + (testnet ? 't' : 'm');
  const cached = _cacheGet(key);
  if (cached) return cached;

  const chain = testnet ? CHAINS.testnet : CHAINS.mainnet;
  const start = Date.now();
  const [chainIdR, blockR, gasR] = await Promise.all([
    _rpc('eth_chainId', [], testnet),
    _rpc('eth_blockNumber', [], testnet),
    _rpc('eth_gasPrice', [], testnet),
  ]);
  const latencyMs = Date.now() - start;

  if (!chainIdR.ok) return { ok: false, error: chainIdR.error };
  if (!blockR.ok) return { ok: false, error: blockR.error };

  const chainId = parseInt(chainIdR.result, 16);
  if (chainId !== chain.chainId) return { ok: false, error: 'unexpected chain id' };

  const block = parseInt(blockR.result, 16);
  const gasPriceGwei = gasR.ok ? Number(BigInt(gasR.result)) / 1e9 : null;

  const result = { ok: true, chainId, block, gasPriceGwei, latencyMs };
  _cacheSet(key, result, TTL.status);
  return result;
}

async function balance(address, { testnet = false } = {}) {
  if (!isAddress(address)) return { ok: false, error: 'invalid address' };
  const addr = address.toLowerCase();
  const key = 'balance:' + (testnet ? 't' : 'm') + ':' + addr;
  const cached = _cacheGet(key);
  if (cached) return cached;

  const r = await _rpc('eth_getBalance', [addr, 'latest'], testnet);
  if (!r.ok) return { ok: false, error: r.error };

  const wei = BigInt(r.result);
  const result = { ok: true, wei: wei.toString(), eth: _formatEth(wei) };
  _cacheSet(key, result, TTL.balance);
  return result;
}

// Blockscout API v2 token balances — keyless; 404 on a fresh/unindexed address is normal
async function tokens(address, { testnet = false } = {}) {
  if (!isAddress(address)) return { ok: false, error: 'invalid address' };
  const addr = address.toLowerCase();
  const key = 'tokens:' + (testnet ? 't' : 'm') + ':' + addr;
  const cached = _cacheGet(key);
  if (cached) return cached;

  const chain = testnet ? CHAINS.testnet : CHAINS.mainnet;
  const r = await _fetchJson(`${chain.explorer}/api/v2/addresses/${addr}/token-balances`);
  if (!r.ok) {
    if (r.status === 404) { const empty = { ok: true, tokens: [] }; _cacheSet(key, empty, TTL.list); return empty; }
    return { ok: false, error: r.error };
  }
  const arr = Array.isArray(r.data) ? r.data : [];
  const list = arr.map(_normalizeToken).filter(Boolean);
  await _applyStockMultipliers(list, testnet);      // Stock Tokens: raw ≠ what the holder owns
  const result = { ok: true, tokens: list };
  _cacheSet(key, result, TTL.list);
  return result;
}

// Blockscout API v2 NFT holdings (ERC-721 + ERC-1155) — keyless
async function nfts(address, { testnet = false } = {}) {
  if (!isAddress(address)) return { ok: false, error: 'invalid address' };
  const addr = address.toLowerCase();
  const key = 'nfts:' + (testnet ? 't' : 'm') + ':' + addr;
  const cached = _cacheGet(key);
  if (cached) return cached;

  const chain = testnet ? CHAINS.testnet : CHAINS.mainnet;
  const r = await _fetchJson(`${chain.explorer}/api/v2/addresses/${addr}/nft?type=ERC-721%2CERC-1155`);
  if (!r.ok) {
    if (r.status === 404) { const empty = { ok: true, items: [] }; _cacheSet(key, empty, TTL.list); return empty; }
    return { ok: false, error: r.error };
  }
  const arr = Array.isArray(r.data && r.data.items) ? r.data.items : (Array.isArray(r.data) ? r.data : []);
  const result = { ok: true, items: arr.map(_normalizeNft).filter(Boolean) };
  _cacheSet(key, result, TTL.list);
  return result;
}

async function txcount(address, { testnet = false } = {}) {
  if (!isAddress(address)) return { ok: false, error: 'invalid address' };
  const addr = address.toLowerCase();
  const key = 'txcount:' + (testnet ? 't' : 'm') + ':' + addr;
  const cached = _cacheGet(key);
  if (cached) return cached;

  const r = await _rpc('eth_getTransactionCount', [addr, 'latest'], testnet);
  if (!r.ok) return { ok: false, error: r.error };

  const result = { ok: true, count: parseInt(r.result, 16) };
  _cacheSet(key, result, TTL.status);
  return result;
}

// pure string builder — no network
function explorerUrl(kind, value, { testnet = false } = {}) {
  const chain = testnet ? CHAINS.testnet : CHAINS.mainnet;
  const v = String(value || '');
  switch (kind) {
    case 'address': return `${chain.explorer}/address/${v}`;
    case 'tx': return `${chain.explorer}/tx/${v}`;
    case 'token': return `${chain.explorer}/token/${v}`;
    default: return chain.explorer;
  }
}

// ── Virtuals agent-token launch on Robinhood Chain (BondingV5.preLaunch) ────────
// The factory is permissionless (verified on-chain: eth_call from 0x…dEaD succeeds,
// and two unrelated EOAs launched directly). We only BUILD the unsigned tx here —
// the user signs it in their own wallet, which stays the sole key holder and final
// gate. The ABI encoder below is verified byte-exact against real launches (BDAT,
// VEX) on chain 4663. Contract addresses confirmed on-chain via FRouter.assetToken()
// and the BondingV5 proxy's creation trace.
const LAUNCH = {
  factory: '0xd4cCBFA37e2f35611b3042e4096Ad7a3459Bd007', // BondingV5 proxy — call this
  virtual: '0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31', // $VIRTUAL on Robinhood Chain (18dp)
  preLaunchSel: '0xa2baa044', // preLaunch(string,string,uint8[],string,string,string[4],uint256,uint256,uint8,uint16,bool,uint8,bool,bytes)
  approveSel: '0x095ea7b3',   // approve(address,uint256)
  balanceOfSel: '0x70a08231', // balanceOf(address)
  allowanceSel: '0xdd62ed3e', // allowance(address,address)
  // default matches the real BDAT launch (needAcf=false, no pre-buy) exactly
  defaultExtParams: '0x0000000000000000000000000000000000000000000000000000000000000001',
};
// Generic uint256/address word codec is the shared platform/evm implementation
// (encodeUint === the former local `_word`; encodeAddr === `_addrWord`, both
// byte-identical for the lowercase-0x inputs this module ever passes). The
// composite encoders below (utf8 string, dynamic bytes, uint8[] cores,
// fixed-size string-array blob → preLaunch) have no port equivalent and stay.
const _te = new TextEncoder();
const _hx = (buf) => Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
const _padR = (h) => { const r = h.length % 64; return r ? h + '0'.repeat(64 - r) : h; };
const _encStr = (s) => { const b = _te.encode(String(s)); return encodeUint(b.length) + _padR(_hx(b)); };
const _encBytes = (h) => { const x = String(h || '').replace(/^0x/, ''); return encodeUint(x.length / 2) + _padR(x); };
const _encU8Arr = (a) => encodeUint(a.length) + a.map((v) => encodeUint(v & 0xff)).join('');
function _encStrArr(arr) { // fixed-size array of dynamic strings → its own head+tail blob
  const n = arr.length, parts = arr.map(_encStr);
  let off = n * 32; const heads = [], tails = [];
  for (const p of parts) { heads.push(encodeUint(off)); tails.push(p); off += p.length / 2; }
  return heads.join('') + tails.join('');
}
function _encodePreLaunch(p) {
  const dyn = [_encStr(p.name), _encStr(p.ticker), _encU8Arr(p.cores), _encStr(p.desc),
    _encStr(p.img), _encStrArr(p.urls), null, null, null, null, null, null, null, _encBytes(p.extParams)];
  const stat = { 6: encodeUint(p.purchaseWei), 7: encodeUint(p.startTime), 8: encodeUint(p.launchMode),
    9: encodeUint(p.airdropBips), 10: encodeUint(p.needAcf ? 1 : 0), 11: encodeUint(p.antiSniper), 12: encodeUint(p.isProject60days ? 1 : 0) };
  const N = 14, heads = new Array(N), tails = []; let off = N * 32;
  for (let i = 0; i < N; i++) { if (dyn[i] !== null) { heads[i] = encodeUint(off); tails.push(dyn[i]); off += dyn[i].length / 2; } else heads[i] = stat[i]; }
  return LAUNCH.preLaunchSel + heads.join('') + tails.join('');
}

// Build the unsigned transaction(s) to launch an agent token on Robinhood Chain.
// Returns { launchTx, approveTx?, needsApprove, purchaseWei } — the caller signs in-wallet.
function buildLaunchTx(p = {}) {
  const name = String((p && p.name) || '').trim();
  const ticker = String((p && p.ticker) || '').trim().toUpperCase();
  if (!name || name.length > 64) return { ok: false, error: 'name required (≤64 chars)' };
  if (!/^[A-Z0-9]{2,12}$/.test(ticker)) return { ok: false, error: 'ticker must be 2–12 letters/digits' };
  const cores = (Array.isArray(p.cores) && p.cores.length) ? p.cores.map((n) => Number(n) & 0xff) : [0];
  let urls = Array.isArray(p.urls) ? p.urls.slice(0, 4).map((u) => String(u || '')) : [];
  while (urls.length < 4) urls.push('');
  let purchaseWei; try { purchaseWei = BigInt((p.purchaseAmount ?? '0').toString()); } catch { return { ok: false, error: 'bad pre-buy amount' }; }
  if (purchaseWei < 0n) return { ok: false, error: 'pre-buy must be ≥ 0' };
  const antiSniper = [0, 1, 2].includes(Number(p.antiSniper)) ? Number(p.antiSniper) : 1;
  const airdropBips = Math.max(0, Math.min(500, Number(p.airdropBips) || 0));
  const data = '0x' + _encodePreLaunch({
    name, ticker, cores, desc: String(p.desc || ''), img: String(p.img || ''), urls,
    purchaseWei, startTime: Number(p.startTime) || 0, launchMode: 0, airdropBips,
    needAcf: !!p.needAcf, antiSniper, isProject60days: !!p.isProject60days,
    extParams: p.extParams || LAUNCH.defaultExtParams,
  }).replace(/^0x/, '');
  const out = {
    ok: true, chainId: CHAINS.mainnet.chainId, chainIdHex: CHAINS.mainnet.chainIdHex,
    launchTx: { to: LAUNCH.factory, data: '0x' + data.replace(/^0x/, ''), value: '0x0' },
    needsApprove: purchaseWei > 0n, purchaseWei: purchaseWei.toString(),
    virtual: LAUNCH.virtual, factory: LAUNCH.factory,
  };
  // pre-buy pulls VIRTUAL via transferFrom → must approve the factory first
  if (purchaseWei > 0n) out.approveTx = { to: LAUNCH.virtual, data: '0x' + LAUNCH.approveSel.replace(/^0x/, '') + encodeAddr(LAUNCH.factory) + encodeUint(purchaseWei), value: '0x0' };
  return out;
}

// Read the wallet's $VIRTUAL balance + allowance to the factory on Robinhood Chain,
// so the launch UI can tell the user up front whether they can fund a pre-buy.
async function launchReadiness(address, { virtualAmount = '0' } = {}) {
  if (!isAddress(address)) return { ok: false, error: 'invalid address' };
  const owner = address.toLowerCase();
  const [balR, allowR] = await Promise.all([
    _rpc('eth_call', [{ to: LAUNCH.virtual, data: LAUNCH.balanceOfSel + encodeAddr(owner) }, 'latest']),
    _rpc('eth_call', [{ to: LAUNCH.virtual, data: LAUNCH.allowanceSel + encodeAddr(owner) + encodeAddr(LAUNCH.factory) }, 'latest']),
  ]);
  const bal = balR.ok ? BigInt(balR.result) : 0n;
  const allow = allowR.ok ? BigInt(allowR.result) : 0n;
  let need; try { need = BigInt((virtualAmount || '0').toString()); } catch { need = 0n; }
  return {
    ok: balR.ok, virtual: LAUNCH.virtual, factory: LAUNCH.factory,
    balanceWei: bal.toString(), balance: _formatUnits(bal.toString(), 18),
    allowanceWei: allow.toString(), enough: bal >= need, needsApprove: need > 0n && allow < need,
  };
}

// pure getter for the launch constants (UI shows addresses / chain)
function launchInfo() {
  return { factory: LAUNCH.factory, virtual: LAUNCH.virtual, chainId: CHAINS.mainnet.chainId, chainIdHex: CHAINS.mainnet.chainIdHex, symbol: 'VIRTUAL', decimals: 18 };
}

export const Robinhood = { chains, status, balance, tokens, nfts, txcount, explorerUrl, buildLaunchTx, launchReadiness, launchInfo };
export default Robinhood;
