// Context test for bridge/nft.mjs AFTER consolidating its chain-read fork onto
// the shared platform/evm.mjs port (eth_call / JSON-RPC failover, ABI string +
// address decode, tokenURI metadata + media-scheme resolution). Proves the
// migration is behavior-preserving end-to-end, fully OFFLINE: global.fetch is
// mocked (canned RPC results + metadata bodies), and the module's local JSON
// store is isolated to a throwaway dir by pointing $HOME there BEFORE import
// (nft.mjs resolves its store via homedir(), not the hub-root seam — the store
// was deliberately NOT migrated; see the fork report / cacheMigrated=no).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── offline fetch harness ────────────────────────────────────────────────────
// Routes JSON-RPC POSTs by method+selector, plain GETs by URL. Nothing here
// ever touches the real network; an unrouted call fails like an unreachable host.
function encodeAbiStringReturn(str) {
  const bytes = Buffer.from(str, 'utf8');
  const len = bytes.length;
  const data = len ? bytes.toString('hex').padEnd(Math.ceil(len / 32) * 64, '0') : '';
  return '0x' + (32).toString(16).padStart(64, '0') + len.toString(16).padStart(64, '0') + data;
}
function encodeAddrWord(addr) {
  return '0x' + String(addr).replace(/^0x/, '').toLowerCase().padStart(64, '0');
}
function jsonResp(body) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => text };
}
function textResp(text, ct) {
  return { ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? ct || 'text/plain' : null) }, json: async () => JSON.parse(text), text: async () => text };
}
function notFound() {
  return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
}

// routes: { ethCall: { [selector]: hexResult }, getBalance: hex, get: { [url]: string|object } }
function installFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      if (body.method === 'eth_call') {
        const sel = body.params[0].data.slice(0, 10);
        const res = (routes.ethCall || {})[sel];
        return jsonResp({ jsonrpc: '2.0', id: 1, result: res === undefined ? '0x' : res });
      }
      if (body.method === 'eth_getBalance') {
        return jsonResp({ jsonrpc: '2.0', id: 1, result: routes.getBalance === undefined ? '0x0' : routes.getBalance });
      }
      return jsonResp({ jsonrpc: '2.0', id: 1, error: { message: 'unrouted method' } });
    }
    const hit = (routes.get || {})[u];
    if (hit === undefined) return notFound();
    return typeof hit === 'string' ? textResp(hit) : jsonResp(hit);
  };
  return () => { globalThis.fetch = original; };
}

// Fresh throwaway home + fresh module instance so nft.mjs's module-level
// `let store = load()` binds to our isolated dir (its DIR = homedir()/.clone-frame-hub).
async function freshNft() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfhub-nft-'));
  process.env.HOME = home;
  process.env.CLONE_FRAME_HUB_ROOT = home; // harmless; nft.mjs store is not on the seam
  const mod = await import('../bridge/nft.mjs?ctx=' + Math.random().toString(36).slice(2));
  return { home, NFT: mod.NFT, file: path.join(home, '.clone-frame-hub', 'nft.json') };
}

const CONTRACT = '0x000102030405060708090a0b0c0d0e0f10111213';

// ── A. pure offline surface (no network) ─────────────────────────────────────

test('known() lists the two seeded agent iNFTs', async () => {
  const { NFT } = await freshNft();
  assert.deepEqual(NFT.known(), [{ label: 'iCLONE', tokenId: 55101 }, { label: 'VEGETA', tokenId: 58099 }]);
});

test('placeholder() shape is stable and self-describing', async () => {
  const { NFT } = await freshNft();
  const p = NFT.placeholder(55101);
  assert.equal(p.name, 'iCLONE #55101');
  assert.equal(p.placeholder, true);
  assert.ok(p.image.startsWith('data:image/svg+xml;utf8,'));
  assert.equal(NFT.placeholder(999).name, 'iCLONE #999'); // unknown id → default label
});

test('collections CRUD persists to nft.json at 0600', async () => {
  const { NFT, file } = await freshNft();
  assert.deepEqual(NFT.collections(), []);
  assert.equal(NFT.addCollection('0xABCDEF0123456789abcdef0123456789ABCDEF01').ok, true);
  assert.deepEqual(NFT.collections(), ['0xabcdef0123456789abcdef0123456789abcdef01']); // lower-cased
  assert.equal(NFT.addCollection('not-an-address').ok, false); // rejected, unchanged
  assert.equal(NFT.collections().length, 1);
  NFT.removeCollection('0xabcdef0123456789abcdef0123456789abcdef01');
  assert.deepEqual(NFT.collections(), []);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('config() persists contract/rpcUrl/indexerUrl', async () => {
  const { NFT, file } = await freshNft();
  NFT.config({ contract: CONTRACT, rpcUrl: 'https://my.rpc', indexerUrl: 'https://my.indexer' });
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.contract, CONTRACT);
  assert.equal(onDisk.rpcUrl, 'https://my.rpc');
  assert.equal(onDisk.indexerUrl, 'https://my.indexer');
});

test('bad-address guards (isAddress port) reject before any network call', async () => {
  const { NFT } = await freshNft();
  const restore = installFetch({}); // any fetch here would throw "unrouted"
  try {
    assert.deepEqual(await NFT.balance('nope'), { ok: false, error: 'bad address' });
    assert.deepEqual(await NFT.scanWallet('nope'), { ok: false, error: 'bad address' });
  } finally { restore(); }
});

// ── B. soul security seam stays local + guards intact ────────────────────────

test('soul()/configSoul() input + origin allowlist guards (soul seam untouched)', async () => {
  const { NFT } = await freshNft();
  assert.deepEqual(await NFT.soul({ tokenId: '' }), { ok: false, error: 'bad tokenId' });
  assert.deepEqual(NFT.configSoul({}), { ok: false, error: 'need tokenId' });
  // non-allowlisted origin must be rejected — the privileged-input seam
  assert.deepEqual(
    NFT.configSoul({ tokenId: 55101, url: 'https://evil.example.com/soul.md' }),
    { ok: false, error: 'origin not allowlisted for souls' },
  );
  assert.equal(NFT.configSoul({ tokenId: 55101, url: 'https://gateway.irys.xyz/abc' }).ok, true);
});

// ── C. read() through the port: on-chain data: tokenURI (no metadata fetch) ──

test('read() decodes an on-chain data: tokenURI via ethCall+decodeAbiString+resolveMediaUrl', async () => {
  const { NFT, file } = await freshNft();
  const owner = '0xdeadbeef00000000000000000000000000001234';
  const meta = { name: 'iCLONE #55101', description: 'agent iNFT', image: 'ipfs://QmImg/art.png', animation_url: 'ar://anim1', attributes: [{ trait_type: 'chain', value: 'Base 8453' }] };
  const tokenUri = 'data:application/json;base64,' + Buffer.from(JSON.stringify(meta)).toString('base64');
  const restore = installFetch({
    ethCall: {
      '0xc87b56dd': encodeAbiStringReturn(tokenUri), // tokenURI(uint256)
      '0x6352211e': encodeAddrWord(owner),           // ownerOf(uint256)
    },
  });
  try {
    const r = await NFT.read({ contract: CONTRACT, tokenId: 55101 });
    assert.equal(r.ok, true);
    assert.equal(r.nft.name, 'iCLONE #55101');
    assert.equal(r.nft.description, 'agent iNFT');
    assert.equal(r.nft.image, 'https://ipfs.io/ipfs/QmImg/art.png');   // ipfs:// resolved
    assert.equal(r.nft.animation, 'https://arweave.net/anim1');        // ar:// resolved
    assert.equal(r.nft.mediaType, 'html');                             // no extension → html
    assert.equal(r.nft.owner, owner);                                  // decodeAddr(port)
    assert.deepEqual(r.nft.attributes, [{ trait_type: 'chain', value: 'Base 8453' }]);
    // persisted to the local cache store (not migrated) + hit on a 2nd read
    assert.ok(fs.existsSync(file));
    const cached = await NFT.read({ contract: CONTRACT, tokenId: 55101 });
    assert.equal(cached.cached, true);
    assert.equal(cached.nft.owner, owner);
  } finally { restore(); }
});

// ── D. read() through the port: off-chain http tokenURI → resolveTokenMeta ──

test('read() fetches an off-chain http tokenURI via resolveTokenMeta', async () => {
  const { NFT } = await freshNft();
  const metaUrl = 'https://meta.example.test/55101.json';
  const meta = { name: 'Item', description: 'off-chain', image: 'ipfs://QmX/i.png', animation_url: 'https://cdn.example.test/a.mp4' };
  const restore = installFetch({
    ethCall: { '0xc87b56dd': encodeAbiStringReturn(metaUrl), '0x6352211e': '0x' },
    get: { [metaUrl]: meta },
  });
  try {
    const r = await NFT.read({ contract: CONTRACT, tokenId: 55101 });
    assert.equal(r.ok, true);
    assert.equal(r.nft.external, metaUrl);          // __external marker preserved
    assert.equal(r.nft.image, 'https://ipfs.io/ipfs/QmX/i.png');
    assert.equal(r.nft.animation, 'https://cdn.example.test/a.mp4');
    assert.equal(r.nft.mediaType, 'video');         // .mp4 → video (port mediaKind)
    assert.equal(r.nft.owner, '');                  // ownerOf returned 0x → empty
  } finally { restore(); }
});

// ── E. read() failover: dead first RPC, live second (port ethCall/rpcCall) ──

test('read() fails soft to a placeholder when every RPC is unreachable', async () => {
  const { NFT } = await freshNft();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error('down'), { name: 'FetchError' }); };
  try {
    const r = await NFT.read({ contract: CONTRACT, tokenId: 55101 });
    // ethCall returns null for tokenURI → decodeAbiString('') = '' → parseTokenURI(null)=null
    // → meta {} → image falls back to the svg placeholder; never throws.
    assert.equal(r.ok, true);
    assert.equal(r.nft.tokenId, 55101);
    assert.ok(r.nft.image.startsWith('data:image/svg+xml;utf8,'));
  } finally { globalThis.fetch = original; }
});

// ── F. balance() through the port's rpcCall failover ─────────────────────────

test('balance() reads eth_getBalance via rpcCall and formats wei/eth', async () => {
  const { NFT } = await freshNft();
  const restore = installFetch({ getBalance: '0x0de0b6b3a7640000' }); // 1e18 wei = 1 ETH
  try {
    const r = await NFT.balance('0x000102030405060708090a0b0c0d0e0f10111213');
    assert.equal(r.ok, true);
    assert.equal(r.wei, '1000000000000000000');
    assert.equal(r.eth, 1);
  } finally { restore(); }
});

test('balance() reports rpc unreachable when every endpoint fails', async () => {
  const { NFT } = await freshNft();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error('down'), { name: 'FetchError' }); };
  try {
    assert.deepEqual(await NFT.balance('0x000102030405060708090a0b0c0d0e0f10111213'), { ok: false, error: 'rpc unreachable' });
  } finally { globalThis.fetch = original; }
});
