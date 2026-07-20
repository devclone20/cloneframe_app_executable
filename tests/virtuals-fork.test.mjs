// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — virtuals — fork-consolidation context test
// Proves virtuals.mjs's ERC-8004 on-chain identity read now rides the shared
// platform/evm codec + eth_call failover WITHOUT changing the on-wire request
// shape or the public return shapes. Fully offline: global.fetch is mocked
// (JSON-RPC eth_call + a Blockscout getLogs REST scan), never the real network.
// Only the OFFLINE-safe surface is exercised; a data: tokenURI keeps the whole
// path in-process (no second remote fetch for metadata).
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { SELECTORS, encodeUint } from '../bridge/platform/evm.mjs';

// Public constants the migrated request shape must reproduce byte-for-byte.
const ERC8004_CONTRACT = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const BASE_RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.llamarpc.com', 'https://1rpc.io/base'];
const OWNER = '0x000102030405060708090a0b0c0d0e0f10111213';
const AGENT_ID = 55101n;

// Fresh throwaway hub root per the migration harness contract (virtuals.mjs is a
// stateless client — no store — but the seam is set regardless so this test can
// never touch the real ~/.clone-frame-hub).
const HUB_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-virtuals-'));
process.env.CLONE_FRAME_HUB_ROOT = HUB_ROOT;

let ctxSeq = 0;
async function freshVirtuals() {
  // ?ctx= busts the module cache so each test gets pristine in-memory TTL caches.
  const mod = await import('../bridge/virtuals.mjs?ctx=' + (++ctxSeq));
  return mod.Virtuals;
}

// ── ABI encoders (mirror the port's own contract-test vectors) ───────────────
function encodeAbiStringReturn(str) {
  const bytes = Buffer.from(str, 'utf8');
  const len = bytes.length;
  const dataHex = len ? bytes.toString('hex').padEnd(Math.ceil(len / 32) * 64, '0') : '';
  return '0x' + encodeUint(32) + encodeUint(len) + dataHex;
}

// A self-contained tokenURI: an on-chain data: URI so resolveTokenMeta parses it
// locally without a second remote fetch — the whole read stays offline.
function dataTokenUri(meta) {
  return 'data:application/json;base64,' + Buffer.from(JSON.stringify(meta)).toString('base64');
}

// ── fetch harness ────────────────────────────────────────────────────────────
// scenario.rpc:  { [rpcUrl]: { result } | { error } | { httpStatus } | { networkError } }
// scenario.logs: canned Blockscout getLogs body (parsed JSON)
// Every JSON-RPC POST body is captured so the migrated request shape can be asserted.
function installFetch(scenario) {
  const original = globalThis.fetch;
  const rpcBodies = [];
  globalThis.fetch = async (url, options = {}) => {
    const isRpc = options.method === 'POST';
    if (isRpc) {
      const body = JSON.parse(options.body);
      rpcBodies.push({ url, body });
      const spec = (scenario.rpc && scenario.rpc[url]) || { networkError: true };
      if (spec.networkError) throw Object.assign(new Error('sim network failure'), { name: 'FetchError' });
      if (spec.httpStatus) return { ok: false, status: spec.httpStatus, json: async () => ({}), text: async () => '' };
      const env = spec.error
        ? { jsonrpc: '2.0', id: 1, error: { message: spec.error } }
        : { jsonrpc: '2.0', id: 1, result: spec.result };
      return { ok: true, status: 200, json: async () => env, text: async () => JSON.stringify(env) };
    }
    // Blockscout getLogs REST scan (out-of-scope local fetchJson client, unchanged).
    if (String(url).includes('blockscout')) {
      const b = scenario.logs || { status: '0', result: [] };
      return { ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) };
    }
    throw new Error('unmocked fetch: ' + url);
  };
  return { rpcBodies, restore() { globalThis.fetch = original; } };
}

function logsBodyFor(agentId, txHash) {
  return {
    status: '1',
    result: [{ topics: ['0xtopic0', '0x' + encodeUint(agentId)], transactionHash: txHash }],
  };
}

// ── A. address validation guard now flows through the port (offline) ─────────

test('address guards reject malformed input before any fetch', async () => {
  const V = await freshVirtuals();
  const patched = installFetch({});
  try {
    for (const bad of ['', 'nope', '0x123', OWNER.toUpperCase().replace('0X', '0x') + 'zz']) {
      assert.deepEqual(await V.byWallet(bad), { ok: false, error: 'bad address' });
      assert.deepEqual(await V.erc8004ByOwner(bad), { ok: false, error: 'bad address' });
      assert.deepEqual(await V.detect(bad), { ok: false, error: 'bad address' });
    }
    assert.equal(patched.rpcBodies.length, 0, 'no RPC issued for a bad address');
  } finally {
    patched.restore();
  }
});

// ── B. request shape is byte-identical to the pre-consolidation fork ─────────

test('readIdentity issues the exact eth_call the fork issued (to + tokenURI selector + padded id)', async () => {
  const V = await freshVirtuals();
  const meta = { name: 'iCLONE #55101', description: 'x'.repeat(300), image: 'ipfs://QmX/img.png' };
  const patched = installFetch({
    logs: logsBodyFor(AGENT_ID, '0xtx55101'),
    rpc: { [BASE_RPCS[0]]: { result: encodeAbiStringReturn(dataTokenUri(meta)) } },
  });
  try {
    const out = await V.erc8004Enriched(OWNER);
    assert.equal(out.ok, true);
    assert.equal(out.total, 1);
    assert.equal(out.remaining, 0);
    assert.deepEqual(out.enriched, [{
      agentId: '55101',
      name: 'iCLONE #55101',
      description: 'x'.repeat(240), // truncate(_, 240) preserved
      image: 'https://ipfs.io/ipfs/QmX/img.png',
      txHash: '0xtx55101',
    }]);

    const call = patched.rpcBodies.find((b) => b.body.method === 'eth_call');
    assert.ok(call, 'an eth_call was made');
    assert.equal(call.url, BASE_RPCS[0], 'first RPC in the pinned BASE_RPCS list');
    assert.equal(call.body.jsonrpc, '2.0');
    assert.equal(call.body.id, 1);
    assert.deepEqual(call.body.params, [
      { to: ERC8004_CONTRACT, data: SELECTORS.tokenURI + encodeUint(AGENT_ID) },
      'latest',
    ]);
  } finally {
    patched.restore();
  }
});

// ── C. RPC failover preserved via the port (dead node → next node) ───────────

test('a dead first RPC fails over to the next and the name still resolves', async () => {
  const V = await freshVirtuals();
  const meta = { name: 'iCLONE #55101', description: 'agent iNFT', image: null };
  const patched = installFetch({
    logs: logsBodyFor(AGENT_ID, '0xtxfo'),
    rpc: {
      [BASE_RPCS[0]]: { networkError: true },
      [BASE_RPCS[1]]: { httpStatus: 500 },
      [BASE_RPCS[2]]: { result: encodeAbiStringReturn(dataTokenUri(meta)) },
    },
  });
  try {
    const out = await V.erc8004Enriched(OWNER);
    assert.equal(out.ok, true);
    assert.deepEqual(out.enriched[0], {
      agentId: '55101', name: 'iCLONE #55101', description: 'agent iNFT', image: null, txHash: '0xtxfo',
    });
  } finally {
    patched.restore();
  }
});

// ── D. all RPCs dead → best-effort null fields, never a throw ─────────────────

test('every RPC failing yields a bare identity (null name), never an exception', async () => {
  const V = await freshVirtuals();
  const patched = installFetch({
    logs: logsBodyFor(AGENT_ID, '0xtxdead'),
    rpc: Object.fromEntries(BASE_RPCS.map((u) => [u, { networkError: true }])),
  });
  try {
    const out = await V.erc8004Enriched(OWNER);
    assert.equal(out.ok, true);
    assert.deepEqual(out.enriched[0], {
      agentId: '55101', name: null, description: null, image: null, txHash: '0xtxdead',
    });
  } finally {
    patched.restore();
  }
});

test.after(() => { try { fs.rmSync(HUB_ROOT, { recursive: true, force: true }); } catch {} });
