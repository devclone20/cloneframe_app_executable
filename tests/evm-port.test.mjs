// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — platform/evm — contract tests
// The SAME assertions run twice: once against the real port (evm.mjs, with
// global.fetch mocked so the suite is fully offline/deterministic) and once
// against the in-memory fake (fakeChain.mjs). Any behavioral drift between
// them — the whole point of shipping a fake alongside a real network-backed
// module — fails here.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import * as RealEvm from '../bridge/platform/evm.mjs';
import { createFakeChain } from '../bridge/platform/fakeChain.mjs';

// ── network-scenario harness ────────────────────────────────────────────────
// A "scenario" is { [rpcUrl]: spec } where spec is one of:
//   { result: hex }     — RPC answers with this eth_call/JSON-RPC result
//   { error: 'msg' }     — RPC answers 200 with a JSON-RPC {error} envelope
//   { httpStatus: 500 }  — RPC answers with a non-2xx HTTP status
//   { networkError: true } — fetch() throws (simulated DNS/timeout failure)
// Both harnesses interpret it identically: only `result` yields a usable
// answer; everything else must be skipped and failover to the next URL.

function fetchMockFor(scenario) {
  return async (url) => {
    const spec = scenario[url];
    if (!spec) throw new Error(`unmocked fetch: ${url}`);
    if (spec.networkError) throw Object.assign(new Error('simulated network failure'), { name: 'FetchError' });
    if (spec.httpStatus) return { ok: false, status: spec.httpStatus, json: async () => ({}), text: async () => '' };
    const body = spec.error ? { jsonrpc: '2.0', id: 1, error: { message: spec.error } } : { jsonrpc: '2.0', id: 1, result: spec.result };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

function readsFromScenario(method, params, scenario) {
  const reads = {};
  for (const [url, spec] of Object.entries(scenario)) {
    if (spec.networkError || spec.httpStatus) continue; // omitted key == "unreachable" to the fake
    reads[`${url}::${method}::${JSON.stringify(params)}`] = spec.error ? { error: spec.error } : { result: spec.result };
  }
  return reads;
}

async function withMockFetch(scenario, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchMockFor(scenario);
  try { return await fn(); } finally { globalThis.fetch = original; }
}

// Plain-HTTP mock for resolveTokenMeta's remote GET (a tokenURI metadata
// fetch, not a JSON-RPC call) — body is the raw metadata JSON, no envelope.
function metaFetchMockFor(scenario) {
  return async (url) => {
    const spec = scenario[url];
    if (!spec) throw new Error(`unmocked fetch: ${url}`);
    if (spec.networkError) throw Object.assign(new Error('simulated network failure'), { name: 'FetchError' });
    if (spec.httpStatus) return { ok: false, status: spec.httpStatus, json: async () => ({}), text: async () => '' };
    const text = JSON.stringify(spec.result);
    return { ok: true, status: 200, json: async () => spec.result, text: async () => text };
  };
}

async function withMockMetaFetch(scenario, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = metaFetchMockFor(scenario);
  try { return await fn(); } finally { globalThis.fetch = original; }
}

// ── targets under test ───────────────────────────────────────────────────────
// Each target exposes the SAME public shape (isAddress/encodeUint/…/ethCall/
// rpcCall/resolveTokenMeta) plus a `run(scenario, fn)` that arranges the
// network for that impl (mocked global.fetch for real; canned reads for fake)
// before invoking `fn`.

const targets = [
  {
    label: 'real (evm.mjs, mocked fetch)',
    impl: RealEvm,
    async run(method, params, scenario, fn) {
      return withMockFetch(scenario, () => fn(RealEvm));
    },
    async runMeta(metaUrl, spec, fn) {
      return withMockMetaFetch({ [metaUrl]: spec }, () => fn(RealEvm));
    },
  },
  {
    label: 'fake (fakeChain.mjs)',
    impl: null, // built per-scenario below since fakeChain reads are seeded at construction
    async run(method, params, scenario, fn) {
      const fake = createFakeChain({ reads: readsFromScenario(method, params, scenario) });
      return fn(fake);
    },
    async runMeta(metaUrl, spec, fn) {
      const fake = createFakeChain({ metas: { [metaUrl]: spec.result === undefined ? null : spec.result } });
      return fn(fake);
    },
  },
];

// ── A. pure codec vectors — identical assertions against every target's impl ─

for (const t of targets) {
  test(`[${t.label}] isAddress — format vectors`, () => {
    const impl = t.impl || createFakeChain();
    assert.equal(impl.isAddress('0x000102030405060708090a0b0c0d0e0f10111213'), true);
    assert.equal(impl.isAddress('0X000102030405060708090A0B0C0D0E0F10111213'), false); // capital 0X prefix not matched
    assert.equal(impl.isAddress('000102030405060708090a0b0c0d0e0f10111213'), false); // missing 0x
    assert.equal(impl.isAddress('0x0001020304050607080'), false); // too short
    assert.equal(impl.isAddress(''), false);
    assert.equal(impl.isAddress(null), false);
    assert.equal(impl.isAddress(undefined), false);
  });

  test(`[${t.label}] encodeUint / encodeAddr / decodeAddr — known vectors`, () => {
    const impl = t.impl || createFakeChain();
    assert.equal(impl.encodeUint(0), '0'.repeat(64));
    assert.equal(impl.encodeUint(1), '0'.repeat(63) + '1');
    assert.equal(impl.encodeUint(255), '0'.repeat(62) + 'ff');
    assert.equal(impl.encodeUint(55101).length, 64);
    assert.equal(BigInt('0x' + impl.encodeUint(55101)), 55101n);

    const addr = '0xabcdef0123456789abcdef0123456789abcdef01';
    const word = impl.encodeAddr(addr);
    assert.equal(word.length, 64);
    assert.equal(word, '0'.repeat(24) + 'abcdef0123456789abcdef0123456789abcdef01');
    // mixed-case input lower-cases
    assert.equal(impl.encodeAddr(addr.toUpperCase().replace('0X', '0x')), word);
    // round trip through decodeAddr
    assert.equal(impl.decodeAddr('0x' + word), addr);
    assert.equal(impl.decodeAddr(''), '');
    assert.equal(impl.decodeAddr(null), '');
  });

  test(`[${t.label}] decodeAbiString — ABI string-return vectors`, () => {
    const impl = t.impl || createFakeChain();
    const encodeAbiStringReturn = (str) => {
      const bytes = Buffer.from(str, 'utf8');
      const len = bytes.length;
      const dataHex = len ? bytes.toString('hex').padEnd(Math.ceil(len / 32) * 64, '0') : '';
      return '0x' + impl.encodeUint(32) + impl.encodeUint(len) + dataHex;
    };
    assert.equal(impl.decodeAbiString(encodeAbiStringReturn('hello')), 'hello');
    assert.equal(impl.decodeAbiString(encodeAbiStringReturn('ipfs://bafy…/metadata.json')), 'ipfs://bafy…/metadata.json');
    assert.equal(impl.decodeAbiString(encodeAbiStringReturn('')), ''); // len=0 short-circuits
    assert.equal(impl.decodeAbiString('0x'), ''); // empty eth_call result (e.g. non-contract address)
    assert.equal(impl.decodeAbiString(''), '');
    assert.equal(impl.decodeAbiString(null), '');
    assert.equal(impl.decodeAbiString('0xnotarealhexpayload'), ''); // malformed → '', never throws
  });

  test(`[${t.label}] resolveMediaUrl / mediaKind — scheme + extension vectors`, () => {
    const impl = t.impl || createFakeChain();
    assert.equal(impl.resolveMediaUrl('ipfs://QmABC/1.png'), 'https://ipfs.io/ipfs/QmABC/1.png');
    assert.equal(impl.resolveMediaUrl('ipfs://ipfs/QmABC/1.png'), 'https://ipfs.io/ipfs/QmABC/1.png'); // double ipfs/ prefix collapsed
    assert.equal(impl.resolveMediaUrl('ar://txid123'), 'https://arweave.net/txid123');
    assert.equal(impl.resolveMediaUrl('irys://txid123'), 'https://gateway.irys.xyz/txid123');
    assert.equal(impl.resolveMediaUrl('https://example.com/a.png'), 'https://example.com/a.png');
    assert.equal(impl.resolveMediaUrl('data:image/svg+xml;utf8,<svg/>'), 'data:image/svg+xml;utf8,<svg/>');
    assert.equal(impl.resolveMediaUrl(''), '');
    assert.equal(impl.resolveMediaUrl(null), '');

    assert.equal(impl.mediaKind('https://x/a.glb'), 'glb');
    assert.equal(impl.mediaKind('https://x/a.gltf?v=2'), 'glb'); // query stripped before sniffing
    assert.equal(impl.mediaKind('https://x/a.mp4#t=1'), 'video');
    assert.equal(impl.mediaKind('https://x/a.png'), 'image');
    assert.equal(impl.mediaKind('https://x/a.svg'), 'image');
    assert.equal(impl.mediaKind('https://x/page'), 'html');
    assert.equal(impl.mediaKind(''), '');
  });
}

// ── B. resolveTokenMeta — data: URIs (pure, no network) ─────────────────────

for (const t of targets) {
  test(`[${t.label}] resolveTokenMeta — data: URI forms`, async () => {
    const impl = t.impl || createFakeChain();
    const obj = { name: 'iCLONE #55101', description: 'agent iNFT', attributes: [{ trait_type: 'chain', value: 'Base 8453' }] };

    const b64 = 'data:application/json;base64,' + Buffer.from(JSON.stringify(obj)).toString('base64');
    assert.deepEqual(await impl.resolveTokenMeta(b64), obj);

    const enc = 'data:application/json,' + encodeURIComponent(JSON.stringify(obj));
    assert.deepEqual(await impl.resolveTokenMeta(enc), obj);

    assert.equal(await impl.resolveTokenMeta('data:application/json;base64,not-valid-base64-json'), null);
    assert.equal(await impl.resolveTokenMeta(''), null);
    assert.equal(await impl.resolveTokenMeta(null), null);
  });
}

// ── C. resolveTokenMeta — remote fetch + {id} substitution ──────────────────

for (const t of targets) {
  test(`[${t.label}] resolveTokenMeta — remote http(s) fetch + ERC-1155 {id}`, async () => {
    const url = 'https://meta.example.test/1155/{id}.json';
    const resolvedUrl = 'https://meta.example.test/1155/' + (5n).toString(16).padStart(64, '0') + '.json';
    const meta = { name: 'Item #5', image: 'ipfs://Qm123/img.png' };

    const got = await t.runMeta(resolvedUrl, { result: meta }, (impl) => impl.resolveTokenMeta(url, { tokenId: 5 }));
    assert.deepEqual(got, meta);
  });

  test(`[${t.label}] resolveTokenMeta — non-http(s) after scheme resolution → null`, async () => {
    const impl = t.impl || createFakeChain();
    assert.equal(await impl.resolveTokenMeta('not-a-real-scheme-or-path'), null);
  });
}

// ── D. rpcCall — RPC failover ────────────────────────────────────────────────

for (const t of targets) {
  test(`[${t.label}] rpcCall — skips a dead RPC and succeeds on the next`, async () => {
    const method = 'eth_call';
    const params = [{ to: '0xdead000000000000000000000000000000dead', data: '0xc87b56dd' }, 'latest'];
    const scenario = {
      'https://rpc-a.test': { networkError: true },
      'https://rpc-b.test': { httpStatus: 500 },
      'https://rpc-c.test': { result: '0xdeadbeef' },
    };
    const rpcs = Object.keys(scenario);
    const r = await t.run(method, params, scenario, (impl) => impl.rpcCall(method, params, { rpcs }));
    assert.equal(r.ok, true);
    assert.equal(r.result, '0xdeadbeef');
    assert.equal(r.rpc, 'https://rpc-c.test');
  });

  test(`[${t.label}] rpcCall — a JSON-RPC {error} envelope also triggers failover`, async () => {
    const method = 'eth_getBalance';
    const params = ['0x0000000000000000000000000000000000dead', 'latest'];
    const scenario = {
      'https://rpc-a.test': { error: 'execution reverted' },
      'https://rpc-b.test': { result: '0x1' },
    };
    const rpcs = Object.keys(scenario);
    const r = await t.run(method, params, scenario, (impl) => impl.rpcCall(method, params, { rpcs }));
    assert.equal(r.ok, true);
    assert.equal(r.result, '0x1');
    assert.equal(r.rpc, 'https://rpc-b.test');
  });

  test(`[${t.label}] rpcCall — every RPC failing is reported explicitly, never thrown`, async () => {
    const method = 'eth_call';
    const params = [{ to: '0x0', data: '0x0' }, 'latest'];
    const scenario = {
      'https://rpc-a.test': { networkError: true },
      'https://rpc-b.test': { httpStatus: 503 },
      'https://rpc-c.test': { error: 'boom' },
    };
    const rpcs = Object.keys(scenario);
    const r = await t.run(method, params, scenario, (impl) => impl.rpcCall(method, params, { rpcs }));
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
    assert.ok(r.error.length > 0);
  });
}

// ── E. ethCall — the tokenURI/ownerOf/balanceOf convenience wrapper ─────────

for (const t of targets) {
  test(`[${t.label}] ethCall — returns the hex result on failover success`, async () => {
    const to = '0x1234500000000000000000000000000000005678';
    const data = RealEvm.SELECTORS.tokenURI + RealEvm.encodeUint(55101);
    const method = 'eth_call';
    const params = [{ to, data }, 'latest'];
    const scenario = {
      'https://rpc-a.test': { networkError: true },
      'https://rpc-b.test': { result: '0xcafebabe' },
    };
    const rpcs = Object.keys(scenario);
    const out = await t.run(method, params, scenario, (impl) => impl.ethCall(to, data, { rpcs }));
    assert.equal(out, '0xcafebabe');
  });

  test(`[${t.label}] ethCall — an empty ('0x') response is treated as no data, not an error`, async () => {
    const to = '0x1234500000000000000000000000000000005678';
    const data = RealEvm.SELECTORS.ownerOf + RealEvm.encodeUint(1);
    const method = 'eth_call';
    const params = [{ to, data }, 'latest'];
    const scenario = { 'https://rpc-a.test': { result: '0x' } };
    const rpcs = Object.keys(scenario);
    const out = await t.run(method, params, scenario, (impl) => impl.ethCall(to, data, { rpcs }));
    assert.equal(out, null);
  });

  // Wave-3 regression (adversarial review, HIGH): a bare '0x' from the FIRST RPC
  // is a bad-node/rate-limit signal, not a real answer — it must fail over to a
  // healthy RPC, not short-circuit to null (which vanished a user's held NFTs).
  test(`[${t.label}] ethCall — a '0x' from one RPC fails over to real data on the next`, async () => {
    const to = '0x1234500000000000000000000000000000005678';
    const data = RealEvm.SELECTORS.balanceOf + RealEvm.encodeAddr('0xabc0000000000000000000000000000000dead');
    const method = 'eth_call';
    const params = [{ to, data }, 'latest'];
    const scenario = {
      'https://rpc-a.test': { result: '0x' },        // rate-limited/lagging node
      'https://rpc-b.test': { result: '0x000000000000000000000000000000000000000000000000000000000000000c' },
    };
    const rpcs = Object.keys(scenario);
    const out = await t.run(method, params, scenario, (impl) => impl.ethCall(to, data, { rpcs }));
    assert.equal(out, '0x000000000000000000000000000000000000000000000000000000000000000c', 'must recover from the healthy RPC, not return null');
  });

  test(`[${t.label}] ethCall — legacy bare-string rpcUrl arg is prepended to the failover list`, async () => {
    const to = '0x1234500000000000000000000000000000005678';
    const data = RealEvm.SELECTORS.balanceOf + RealEvm.encodeAddr('0xabc0000000000000000000000000000000dead');
    const method = 'eth_call';
    const params = [{ to, data }, 'latest'];
    const scenario = { 'https://preferred-rpc.test': { result: '0x01' } };
    const out = await t.run(method, params, scenario, (impl) => impl.ethCall(to, data, 'https://preferred-rpc.test'));
    assert.equal(out, '0x01');
  });
}
