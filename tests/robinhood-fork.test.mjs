// Context test for bridge/robinhood.mjs AFTER consolidating its generic
// address/uint256 codec fork onto the shared platform/evm port (isAddress /
// encodeUint / encodeAddr). The migration MUST be behavior-preserving on the
// wire: a wrong encoding here builds a wrong on-chain launch tx. So this suite
// locks the exact byte payloads (golden vectors captured from the pre-migration
// module) and proves the address guards + offline surface are unchanged.
//
// Fully offline: the pure encode surface hits no network at all, and the one
// networked read (launchReadiness → local _rpc → fetch) is exercised against a
// stubbed global.fetch that records the request and returns canned eth_call
// hex — the real Robinhood RPC is never contacted. Fresh CLONE_FRAME_HUB_ROOT +
// cache-busting ?ctx= import give each test a clean module (its own in-memory
// TTL cache + request-id counter), matching the Wave-3 context-test template.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function freshRobinhood() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-robinhood-'));
  process.env.CLONE_FRAME_HUB_ROOT = root;
  const mod = await import('../bridge/robinhood.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { root, R: mod.Robinhood };
}

// Golden wire vectors captured from the module BEFORE the port swap. Any drift
// in the shared encodeUint/encodeAddr would change these byte-for-byte.
const LAUNCH_INPUT = {
  name: 'Test Agent', ticker: 'test', cores: [0, 1], desc: 'hello',
  img: 'ipfs://Qm/img.png', urls: ['https://x.com/a'], purchaseAmount: '0',
  antiSniper: 1, airdropBips: 100,
};
const GOLDEN_LAUNCH_DATA = '0xa2baa04400000000000000000000000000000000000000000000000000000000000001c00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000002e0000000000000000000000000000000000000000000000000000000000000032000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000440000000000000000000000000000000000000000000000000000000000000000a54657374204167656e740000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000045445535400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000568656c6c6f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000011697066733a2f2f516d2f696d672e706e67000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000f68747470733a2f2f782e636f6d2f61000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001';
const GOLDEN_APPROVE_DATA = '0x095ea7b3000000000000000000000000d4ccbfa37e2f35611b3042e4096ad7a3459bd0070000000000000000000000000000000000000000000000000de0b6b3a7640000';
const FACTORY = '0xd4cCBFA37e2f35611b3042e4096Ad7a3459Bd007';
const VIRTUAL = '0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31';

test('buildLaunchTx — preLaunch payload is byte-identical to the golden wire vector', async () => {
  const { R } = await freshRobinhood();
  const r = R.buildLaunchTx(LAUNCH_INPUT);
  assert.equal(r.ok, true);
  assert.equal(r.launchTx.to, FACTORY);
  assert.equal(r.launchTx.value, '0x0');
  assert.equal(r.launchTx.data, GOLDEN_LAUNCH_DATA);
  assert.equal(r.chainId, 4663);
  assert.equal(r.chainIdHex, '0x1237');
  assert.equal(r.needsApprove, false);
});

test('buildLaunchTx — pre-buy adds a byte-identical approve tx and flips needsApprove', async () => {
  const { R } = await freshRobinhood();
  const r = R.buildLaunchTx({ ...LAUNCH_INPUT, purchaseAmount: '1000000000000000000' });
  assert.equal(r.ok, true);
  assert.equal(r.needsApprove, true);
  assert.equal(r.purchaseWei, '1000000000000000000');
  assert.equal(r.approveTx.to, VIRTUAL);
  assert.equal(r.approveTx.value, '0x0');
  assert.equal(r.approveTx.data, GOLDEN_APPROVE_DATA);
});

test('buildLaunchTx — domain validation contracts are unchanged', async () => {
  const { R } = await freshRobinhood();
  assert.deepEqual(R.buildLaunchTx({ ticker: 'ABC' }), { ok: false, error: 'name required (≤64 chars)' });
  assert.deepEqual(R.buildLaunchTx({ name: 'x', ticker: 'a' }), { ok: false, error: 'ticker must be 2–12 letters/digits' });
  assert.deepEqual(R.buildLaunchTx({ name: 'x', ticker: 'ABC', purchaseAmount: '-1' }), { ok: false, error: 'pre-buy must be ≥ 0' });
  assert.deepEqual(R.buildLaunchTx({ name: 'x', ticker: 'ABC', purchaseAmount: 'nope' }), { ok: false, error: 'bad pre-buy amount' });
});

test('isAddress guard (from the port) rejects malformed addresses on every read, no network', async () => {
  const { R } = await freshRobinhood();
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...a) => { seen.push(a); throw new Error('network must not be hit'); };
  try {
    for (const bad of ['', 'not-an-addr', '0x123', '0X000102030405060708090a0b0c0d0e0f10111213']) {
      assert.deepEqual(await R.balance(bad), { ok: false, error: 'invalid address' });
      assert.deepEqual(await R.tokens(bad), { ok: false, error: 'invalid address' });
      assert.deepEqual(await R.nfts(bad), { ok: false, error: 'invalid address' });
      assert.deepEqual(await R.txcount(bad), { ok: false, error: 'invalid address' });
      assert.deepEqual(await R.launchReadiness(bad), { ok: false, error: 'invalid address' });
    }
  } finally { globalThis.fetch = original; }
  assert.equal(seen.length, 0, 'guarded reads must short-circuit before fetch');
});

test('launchReadiness — eth_call request data uses the shared encodeAddr, byte-exact', async () => {
  const { R } = await freshRobinhood();
  const owner = '0xABCDEF0123456789abcdef0123456789ABCDEF01';
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    // balanceOf → 2e18, allowance → 1e18
    const result = body.params[0].data.startsWith('0x70a08231')
      ? '0x0000000000000000000000000000000000000000000000001bc16d674ec80000'
      : '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000';
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
  };
  let out;
  try {
    out = await R.launchReadiness(owner, { virtualAmount: '1500000000000000000' });
  } finally { globalThis.fetch = original; }

  const lowerAddrWord = '000000000000000000000000abcdef0123456789abcdef0123456789abcdef01';
  const factoryWord = '000000000000000000000000d4ccbfa37e2f35611b3042e4096ad7a3459bd007';
  const balData = bodies.find((b) => b.params[0].data.startsWith('0x70a08231')).params[0].data;
  const allowData = bodies.find((b) => b.params[0].data.startsWith('0xdd62ed3e')).params[0].data;
  assert.equal(balData, '0x70a08231' + lowerAddrWord);
  assert.equal(allowData, '0xdd62ed3e' + lowerAddrWord + factoryWord);

  assert.equal(out.ok, true);
  assert.equal(out.balanceWei, '2000000000000000000');
  assert.equal(out.balance, '2');
  assert.equal(out.allowanceWei, '1000000000000000000');
  assert.equal(out.enough, true);            // 2e18 >= 1.5e18
  assert.equal(out.needsApprove, true);      // allowance 1e18 < need 1.5e18
  assert.equal(out.virtual, VIRTUAL);
  assert.equal(out.factory, FACTORY);
});

test('pure getters (chains / launchInfo / explorerUrl) are unchanged', async () => {
  const { R } = await freshRobinhood();
  const c = R.chains();
  assert.equal(c.mainnet.chainId, 4663);
  assert.equal(c.testnet.chainId, 46630);
  // returns a fresh copy — mutating it must not corrupt the shared constant
  c.mainnet.chainId = 999;
  assert.equal(R.chains().mainnet.chainId, 4663);

  assert.deepEqual(R.launchInfo(), {
    factory: FACTORY, virtual: VIRTUAL, chainId: 4663, chainIdHex: '0x1237',
    symbol: 'VIRTUAL', decimals: 18,
  });

  assert.equal(R.explorerUrl('address', '0xabc'), 'https://robinhoodchain.blockscout.com/address/0xabc');
  assert.equal(R.explorerUrl('tx', '0xhash', { testnet: true }), 'https://explorer.testnet.chain.robinhood.com/tx/0xhash');
});

// ─────────────────────────────────────────────────────────────────────────────
// Stock Tokens — the explorer's balance is NOT what the holder owns.
//
// Robinhood's tokenised equities scale their display balance by uiMultiplier():
// balanceOfUI(a) = mulDiv(balanceOf(a), uiMultiplier(), 1e18). Blockscout's
// token-balances serves the RAW value, so reporting it under-reports the holder.
// Measured on live mainnet 2026-07-26: SGOV's top holder reads 3354.940422680995371336
// raw against a true 3358.152844868801231394 — the vectors below are those numbers.
//
// The reason this needs a test at all: the multiplier is exactly 1.0 on nearly every
// ticker (12 of 14 sampled live), so a happy-path test on AAPL would pass whether the
// correction ran or not. Each case below is chosen to FAIL if the code is removed.
const UI_MULT_SEL = '0xa60bf13d';                        // uiMultiplier()
const SGOV = '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5';
const PLAIN = '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34';   // Ethena USDe — an ordinary ERC-20
const HOLDER = '0x9c856e12a12689f18109aa2B6728ffb41a65D664';
const SGOV_RAW = '3354940422680995371336';
const SGOV_TRUE = '3358.152844868801231394';             // == on-chain balanceOfUI()
const SGOV_MULT = 1000957519890990718n;

// Serve one Blockscout token-balances list + canned eth_call answers.
// `multByToken` maps token address → bigint multiplier, or 'revert' for a plain ERC-20.
function stubChain(multByToken, { rpcFails = false } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (!opts || opts.method !== 'POST') {
      return { ok: true, status: 200, json: async () => ([
        { value: SGOV_RAW, token: { symbol: 'SGOV', name: 'iShares 0-3 Month Treasury • Robinhood Token', decimals: '18', address: SGOV, type: 'ERC-20' } },
        { value: '1000000000000000000', token: { symbol: 'USDE', name: 'Ethena USDe', decimals: '18', address: PLAIN, type: 'ERC-20' } },
      ]) };
    }
    const body = JSON.parse(opts.body);
    const to = body.params[0].to;
    calls.push({ to, data: body.params[0].data });
    if (rpcFails) return { ok: false, status: 503 };
    const m = multByToken[to];
    if (m === 'revert') return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { message: 'execution reverted' } }) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0x' + m.toString(16).padStart(64, '0') }) };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('tokens — a Stock Token balance is corrected by uiMultiplier, and the raw value is kept', async () => {
  const { R } = await freshRobinhood();
  const s = stubChain({ [SGOV]: SGOV_MULT, [PLAIN]: 'revert' });
  let r;
  try { r = await R.tokens(HOLDER); } finally { s.restore(); }
  assert.equal(r.ok, true);
  const sgov = r.tokens.find((t) => t.symbol === 'SGOV');
  assert.equal(sgov.balance, SGOV_TRUE, 'must match the contract\'s own balanceOfUI()');
  assert.equal(sgov.balanceRaw, '3354.940422680995371336', 'the explorer value stays available for auditing');
  assert.equal(sgov.stockToken, true);
  assert.equal(sgov.uiMultiplier, '1.000957519890990718');
  assert.notEqual(sgov.balance, sgov.balanceRaw, 'correction must actually change the number');
});

// The three cases below all assert that a balance was NOT changed — which is equally true
// when the correction never ran at all, so asserting only the absence would leave them
// passing against a deleted _applyStockMultipliers: tests that cannot fail (AGENTS.md §16.4d).
// Each therefore also asserts the probe HAPPENED, which is what separates "looked, and
// correctly left it alone" from "never looked".
test('tokens — an ordinary ERC-20 reverts on uiMultiplier and is left completely untouched', async () => {
  const { R } = await freshRobinhood();
  const s = stubChain({ [SGOV]: SGOV_MULT, [PLAIN]: 'revert' });
  let r;
  try { r = await R.tokens(HOLDER); } finally { s.restore(); }
  assert.ok(s.calls.some((c) => c.to === PLAIN && c.data === UI_MULT_SEL), 'the plain token must actually be probed');
  const plain = r.tokens.find((t) => t.symbol === 'USDE');
  assert.equal(plain.balance, '1', 'a plain ERC-20 keeps its balance');
  assert.equal(plain.stockToken, undefined, 'and is never tagged as a Stock Token');
  assert.equal(plain.balanceRaw, undefined);
  assert.equal(plain.uiMultiplier, undefined);
});

test('tokens — a multiplier of exactly 1.0 leaves the token untouched (no cosmetic mutation)', async () => {
  const { R } = await freshRobinhood();
  const s = stubChain({ [SGOV]: 10n ** 18n, [PLAIN]: 'revert' });
  let r;
  try { r = await R.tokens(HOLDER); } finally { s.restore(); }
  assert.ok(s.calls.some((c) => c.to === SGOV && c.data === UI_MULT_SEL), 'the multiplier must be read before concluding it is 1.0');
  const sgov = r.tokens.find((t) => t.symbol === 'SGOV');
  assert.equal(sgov.balance, '3354.940422680995371336');
  assert.equal(sgov.stockToken, undefined, '1.0 is not a correction — do not tag it');
});

test('tokens — the multiplier is cached per token, not re-read for every holder', async () => {
  const { R } = await freshRobinhood();
  const s = stubChain({ [SGOV]: SGOV_MULT, [PLAIN]: 'revert' });
  try {
    await R.tokens(HOLDER);
    const first = s.calls.filter((c) => c.to === SGOV && c.data === UI_MULT_SEL).length;
    assert.equal(first, 1, 'one uiMultiplier read on the first pass');
    await R.tokens('0x1111111111111111111111111111111111111111');   // different holder, same token
    const total = s.calls.filter((c) => c.to === SGOV && c.data === UI_MULT_SEL).length;
    assert.equal(total, 1, 'the second holder must reuse the cached multiplier');
  } finally { s.restore(); }
});

test('tokens — an RPC outage fails OPEN: the holding still shows, uncorrected', async () => {
  const { R } = await freshRobinhood();
  const s = stubChain({}, { rpcFails: true });
  let r;
  try { r = await R.tokens(HOLDER); } finally { s.restore(); }
  assert.ok(s.calls.length > 0, 'the correction must have been attempted, not skipped');
  assert.equal(r.ok, true, 'a multiplier outage must never fail the whole listing');
  const sgov = r.tokens.find((t) => t.symbol === 'SGOV');
  assert.equal(sgov.balance, '3354.940422680995371336', 'raw balance survives rather than blanking a real holding');
  assert.equal(sgov.stockToken, undefined);
});
