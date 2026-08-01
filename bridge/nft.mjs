// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — nft
// Reads the owner's agent iNFT from Base (chain 8453) via public JSON-RPC so the
// LAB can show the NFT image + description and let the user work with it.
// The chain-read stack (eth_call/JSON-RPC failover, ABI string/address codec,
// tokenURI/media resolution) is the shared platform/evm.mjs port; only the
// neural-soul origin allowlist (a privileged-input security seam) and the
// Blockscout indexer + placeholder domain shaping stay local.
// ─────────────────────────────────────────────────────────────────────────────
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  DEFAULT_RPCS, SELECTORS,
  isAddress, encodeUint, encodeAddr, decodeAddr, decodeAbiString,
  resolveMediaUrl, mediaKind, ethCall, rpcCall, resolveTokenMeta,
} from './platform/evm.mjs';

const DIR = path.join(homedir(), '.clone-frame-hub');
const FILE = path.join(DIR, 'nft.json');
function load() { try { const s = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!Array.isArray(s.collections)) s.collections = []; return s; } catch { return { contract: '', rpcUrl: '', indexerUrl: '', collections: [], cache: {} }; } }
function save(o) { try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); const t = FILE + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(o), { mode: 0o600 }); fs.renameSync(t, FILE); } catch {} }
let store = load();

// Blockscout Base — open, keyless indexer that lists every NFT an address holds (with metadata + animation_url).
const INDEXER_BASE = 'https://base.blockscout.com/api/v2';
// ipfs:// → public gateway so <img> can render it. Kept local only because the
// soul seam below (soulUrl) needs it; all NFT media goes through the port's
// resolveMediaUrl, which resolves ipfs:// identically.
function gw(u) { u = String(u || ''); return u.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + u.slice(7).replace(/^ipfs\//, '') : u; }
const KNOWN = [{ label: 'iCLONE', tokenId: 55101 }, { label: 'VEGETA', tokenId: 58099 }];

// ── what makes a token an iNFT ───────────────────────────────────────────────
// A wallet holds all kinds of tokens: airdrops, PFPs, spam, half-finished test
// contracts. Only some of them are agents, and the app must be able to tell the
// difference in ONE place — the wallet drawer, the LAB and MY AGENTS all read the
// `isAgent` tag this puts on every scanned token.
//
// Identity is address-based, never name-based. A collection NAME is attacker-
// controlled: anyone can deploy a contract, call it "iCLONE" and airdrop it into a
// wallet. So the trusted set is contracts — the ERC-8004 AgentIdentity registry, the
// configured CLONE FRAME collection, and collections the owner added by hand. A
// collection that merely calls itself an agent is a weak signal, accepted only when
// the token also carries an identity of its own (art or traits or a description);
// an empty token has no soul to work with, whatever its collection is called.
const AGENT_REGISTRY = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432'; // ERC-8004 AgentIdentity, Base
function isAgentNft(a) {
  if (!a) return false;
  const c = String(a.contract || '').toLowerCase();
  if (c && c === AGENT_REGISTRY) return true;
  if (c && c === String(store.contract || '').toLowerCase()) return true;
  if (c && (store.collections || []).includes(c)) return true;
  // Self-declaration: check BOTH fields for BOTH signals. The first version of this only
  // read `inft` out of the collection and `AGENT` out of the symbol, and promptly hid the
  // owner's real ATLAS iNFTs — collection "ATLAS", symbol "INFT" — because the one word
  // that mattered was in the field it wasn't looking at. A contract declares itself in
  // whichever of the two it likes; read them the same way.
  const fields = [String(a.symbol || ''), String(a.collection || '')].map((s) => s.toLowerCase());
  const selfDeclared = fields.some((f) => /(^|[^a-z])(inft|agent|agentidentity)([^a-z]|$)/.test(f));
  // `name` is not evidence: fromIndexer synthesises one from the collection when the
  // token has no metadata at all, so it is never empty and never proves anything.
  const hasIdentity = !!(a.image || a.animation || (a.attributes && a.attributes.length) || String(a.description || '').trim());
  return selfDeclared && hasIdentity;
}

// ── neural soul ──────────────────────────────────────────────────────────────
// The soul becomes a SYSTEM PROMPT — privileged input. Only these origins may
// ever serve soul text; an arbitrary NFT's tokenURI is attacker-controlled.
// Split by what the origin actually PROVES. api.acp.virtuals.io is a service that answers for
// its own records; the four below are open content-addressed gateways — anyone can pin any
// bytes and get a URL on them, so "the host is ipfs.io" says nothing about who wrote the text.
// A host-only allowlist that includes them constrains nobody: an attacker's tokenURI points at
// their own CID and the gateway serves it, straight into a system prompt.
const SOUL_ORIGINS = ['api.acp.virtuals.io'];
// Reachable only for a pointer the OWNER configured (configSoul / KNOWN_SOULS) — never for one
// read out of a token's own metadata, which is the attacker-controlled path this guard exists for.
const SOUL_GATEWAYS = ['gateway.irys.xyz', 'arweave.net', 'ipfs.io', 'cloudflare-ipfs.com'];
// raw.githubusercontent.com allowed only under the owner's org
const SOUL_GH_PREFIX = 'https://raw.githubusercontent.com/devclone20/';
// today the monorepo is the only real soul source (on-chain pointers come later);
// overridable per token via configSoul() so new mints need no code change
const KNOWN_SOULS = {
  '55101': 'https://raw.githubusercontent.com/devclone20/iclone/main/agent/iclone/neural_soul.md',
  '58099': 'https://raw.githubusercontent.com/devclone20/vegeta/main/agent/vegeta/neural_soul.md',
};
const SOUL_TTL = 24 * 3600 * 1000, SOUL_NEG_TTL = 10 * 60 * 1000, SOUL_MAX = 512 * 1024, SOUL_MIN = 1024;

/**
 * @param {string} u  normalized https URL
 * @param {boolean} ownerConfigured  true only for a pointer the owner set (configSoul /
 *   KNOWN_SOULS). A pointer read out of token metadata is never owner-configured.
 */
function soulOriginOk(u, ownerConfigured = false) {
  try {
    if (u.startsWith(SOUL_GH_PREFIX)) return true; // authenticated by PATH, to the owner's org
    const h = new URL(u).hostname;
    if (SOUL_ORIGINS.includes(h)) return true;
    return ownerConfigured && SOUL_GATEWAYS.includes(h);
  } catch { return false; }
}
// normalize pointer schemes to fetchable https, preserving the allowlist
function soulUrl(v) {
  const s = String(v || '').trim();
  if (/^irys:\/\//.test(s)) return 'https://gateway.irys.xyz/' + s.slice(7);
  if (/^ar:\/\//.test(s)) return 'https://arweave.net/' + s.slice(5);
  if (/^ipfs:\/\//.test(s)) return gw(s);
  if (/^https:\/\//.test(s)) return s;
  if (/^[A-Za-z0-9_-]{43}$/.test(s)) return 'https://gateway.irys.xyz/' + s; // bare Irys/Arweave txid
  return '';
}
async function soulFetch(url) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'text/plain, text/markdown, */*' } });
    clearTimeout(t);
    if (!r.ok) return null;
    const ct = String(r.headers.get('content-type') || '');
    if (/^(image|video|audio)\//.test(ct)) return null;
    const text = await r.text();
    if (text.length > SOUL_MAX || text.length < SOUL_MIN) return null;
    return text;
  } catch { return null; }
}
function soulValidate(text) {
  const first = String(text || '').split('\n').find(l => l.trim());
  return !!first && (first.trim().startsWith('# ') || /neural\s*soul/i.test(text));
}
function soulShape(text, source, uri, cached) {
  const name = (String(text).match(/^#\s+(.+)$/m) || [])[1] || null;
  const version = (String(text).match(/Version:?\s*v?(\d+\.\d+\.\d+)/i) || [])[1] || null;
  return { text, source, uri, sha256: createHash('sha256').update(text).digest('hex'), version, name, fetchedAt: Date.now(), cached: !!cached };
}

function parseTokenURI(uri) {
  if (!uri) return null;
  try {
    if (uri.startsWith('data:application/json;base64,')) return JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
    if (uri.startsWith('data:application/json,')) return JSON.parse(decodeURIComponent(uri.split(',').slice(1).join(',')));
    return { __external: uri }; // http(s) or ipfs — the UI can fetch/display
  } catch { return { __external: uri }; }
}

function svgPlaceholder(tokenId, label) {
  const hue = (Number(tokenId) * 47) % 360;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><defs><radialGradient id='g' cx='50%' cy='40%'><stop offset='0%' stop-color='hsl(${hue},70%,55%)'/><stop offset='100%' stop-color='#0a0a0f'/></radialGradient></defs><rect width='400' height='400' fill='url(#g)'/><rect x='150' y='150' width='100' height='100' fill='none' stroke='#e5484d' stroke-width='3'/><text x='200' y='300' fill='#fff' font-family='monospace' font-size='22' text-anchor='middle'>${label} #${tokenId}</text><text x='200' y='330' fill='#aaa' font-family='monospace' font-size='11' text-anchor='middle'>CLONE FRAME · Base 8453</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
function placeholder(tokenId) {
  const k = KNOWN.find(x => String(x.tokenId) === String(tokenId));
  const label = k ? k.label : 'iCLONE';
  return {
    name: `${label} #${tokenId}`, tokenId, contract: store.contract || '',
    description: `CLONE FRAME agent iNFT. Mutable soul (neural_soul → monorepo → Irys, on-chain pointer), ERC-6551 wallet, registered on ERC-8004. Connect your wallet to read this NFT's real on-chain data.`,
    image: svgPlaceholder(tokenId, label),
    attributes: [{ trait_type: 'chain', value: 'Base 8453' }, { trait_type: 'standard', value: 'ERC-721A · 2981 · 6551' }, { trait_type: 'status', value: 'placeholder — connect wallet' }],
    owner: '', placeholder: true,
  };
}

// Map one Blockscout NFT item → our agent shape. animation_url powers the animated (3D/2D) art.
function fromIndexer(it) {
  const md = it.metadata || {};
  const tok = it.token || {};
  const anim = it.animation_url || md.animation_url || (['video', 'html', 'gif'].includes(String(it.media_type || '').toLowerCase()) ? it.media_url : '') || '';
  const animUrl = resolveMediaUrl(anim);
  return {
    contract: tok.address_hash || tok.address || '', tokenId: it.id,
    name: md.name || ((tok.name || 'NFT') + ' #' + it.id),
    collection: tok.name || '', symbol: tok.symbol || '',
    description: md.description || '',
    image: resolveMediaUrl(it.image_url || it.media_url || md.image || ''),
    animation: animUrl,
    mediaType: it.media_type || mediaKind(animUrl),
    attributes: Array.isArray(md.attributes) ? md.attributes : [],
    owner: (it.owner && (it.owner.hash || it.owner)) || '',
  };
}

export const NFT = {
  config({ contract, rpcUrl, indexerUrl } = {}) { if (contract !== undefined) store.contract = contract; if (rpcUrl !== undefined) store.rpcUrl = rpcUrl; if (indexerUrl !== undefined) store.indexerUrl = indexerUrl; save(store); return { ok: true }; },
  known() { return KNOWN.slice(); },
  collections() { return (store.collections || []).slice(); },
  addCollection(contract) { const c = String(contract || '').trim().toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(c)) return { ok: false, error: 'invalid contract address' }; if (!store.collections.includes(c)) store.collections.push(c); save(store); return { ok: true, collections: store.collections.slice() }; },
  removeCollection(contract) { const c = String(contract || '').trim().toLowerCase(); store.collections = (store.collections || []).filter(x => x !== c); save(store); return { ok: true, collections: store.collections.slice() }; },
  placeholder,
  isAgentNft, // the one definition — panels read the `isAgent` tag scanWallet puts on each token
  // Detect EVERY iNFT the connected wallet holds. Primary: open Blockscout indexer (keyless, all collections).
  // Fallback: enumerate configured collections over raw RPC (balanceOf + tokenOfOwnerByIndex).
  // `fresh` makes the wallet's Rescan button mean something: it bypasses the 10-minute
  // metadata cache, so a token minted or revealed a minute ago is re-read from its
  // tokenURI instead of coming back exactly as stale as it did the first time.
  async scanWallet(address, { limit = 60, fresh = false } = {}) {
    if (!isAddress(address)) return { ok: false, error: 'bad address' };
    const base = store.indexerUrl || INDEXER_BASE;
    // 1) indexer
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(`${base}/addresses/${address}/nft?type=ERC-721,ERC-1155,ERC-404`, { signal: ctl.signal, headers: { accept: 'application/json' } });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        const items = Array.isArray(j.items) ? j.items : [];
        const agents = items.slice(0, limit).map(fromIndexer).filter(a => a.contract);
        // fresh mints the indexer hasn't crawled yet come back media-less — resolve
        // their art straight from the chain (tokenURI → metadata JSON)
        const bare = agents.filter(a => !a.image && !a.animation).slice(0, 12);
        await Promise.all(bare.map(async (a) => {
          try {
            const rr = await this.read({ contract: a.contract, tokenId: a.tokenId, fresh });
            if (rr && rr.ok && rr.nft) {
              a.image = rr.nft.image; a.animation = a.animation || rr.nft.animation;
              a.mediaType = a.mediaType || rr.nft.mediaType;
              if (!a.attributes.length) a.attributes = rr.nft.attributes;
              if (!a.description) a.description = rr.nft.description;
            }
          } catch {}
        }));
        // Tag AFTER the on-chain resolution pass: a fresh mint the indexer hasn't crawled
        // deserves to be judged on the metadata its tokenURI actually returns, not on the
        // blank the indexer happened to have.
        agents.forEach((a) => { a.isAgent = isAgentNft(a); });
        return { ok: true, source: 'indexer', agents, inftCount: agents.filter(a => a.isAgent).length };
      }
    } catch {}
    // 2) fallback: enumerate configured collections
    const cols = store.collections || [];
    if (!cols.length) return { ok: true, source: 'none', agents: [], inftCount: 0, needsConfig: true };
    const agents = [];
    for (const c of cols) {
      try {
        const balHex = await ethCall(c, SELECTORS.balanceOf + encodeAddr(address), store.rpcUrl);
        const bal = balHex ? parseInt(balHex, 16) : 0;
        for (let i = 0; i < Math.min(bal, 12); i++) {
          const tidHex = await ethCall(c, SELECTORS.tokenOfOwnerByIndex + encodeAddr(address) + encodeUint(i), store.rpcUrl);
          if (!tidHex) continue;
          const tokenId = parseInt(tidHex, 16);
          const rr = await this.read({ contract: c, tokenId, fresh });
          if (rr.ok) agents.push({ ...rr.nft, collection: '', animation: '' });
        }
      } catch {}
    }
    agents.forEach((a) => { a.isAgent = isAgentNft(a); });
    return { ok: true, source: 'rpc', agents, inftCount: agents.filter(a => a.isAgent).length };
  },
  async read(opts = {}) {
    // `opts || {}`: JSON has no `undefined`, so an omitted options bag arrives over RPC as
    // null — and a `= {}` default only ever fires for undefined. Without this the destructure
    // throws a V8 internal ("Cannot destructure property …") instead of answering the call.
    const { contract, tokenId, rpcUrl, fresh = false } = opts || {};
    const c = contract || store.contract;
    if (!c) return { ok: false, error: 'need contract', nft: placeholder(tokenId || 55101) };
    const ck = c + ':' + tokenId;
    const hit = store.cache[ck];
    if (!fresh && hit && hit.fetchedAt && Date.now() - hit.fetchedAt < 10 * 60 * 1000) return { ok: true, nft: hit, cached: true };
    try {
      const uriHex = await ethCall(c, SELECTORS.tokenURI + encodeUint(tokenId), rpcUrl || store.rpcUrl);
      const uri = decodeAbiString(uriHex);
      let meta = parseTokenURI(uri) || {};
      if (meta.__external) meta = { ...(await resolveTokenMeta(meta.__external, { tokenId: tokenId ?? 0, timeoutMs: 10000 }) || {}), __external: meta.__external };
      let owner = '';
      try { owner = decodeAddr(await ethCall(c, SELECTORS.ownerOf + encodeUint(tokenId), rpcUrl || store.rpcUrl)); } catch {}
      const image = resolveMediaUrl(meta.image || meta.image_url || '');
      const animation = resolveMediaUrl(meta.animation_url || meta.animation || '');
      const nft = {
        name: meta.name || `#${tokenId}`, description: meta.description || '',
        // A token with no art gets NO art. This used to fall through to a generated
        // CLONE FRAME card, which painted our brand onto strangers' empty contracts and
        // then read back as "this token has identity". The panels all degrade to a
        // neutral tile on an empty image; an invented picture is a lie they can't see.
        image: image || (meta.image_data ? 'data:image/svg+xml;utf8,' + encodeURIComponent(String(meta.image_data)) : ''),
        animation, mediaType: mediaKind(animation),
        attributes: Array.isArray(meta.attributes) ? meta.attributes : [], owner, tokenId, contract: c, external: meta.__external || null,
        fetchedAt: Date.now(),
      };
      store.cache[ck] = nft; save(store);
      return { ok: true, nft };
    } catch (e) { return { ok: false, error: e.message, nft: placeholder(tokenId) }; }
  },
  async balance(address) {
    if (!isAddress(address)) return { ok: false, error: 'bad address' };
    const rpcs = store.rpcUrl ? [store.rpcUrl, ...DEFAULT_RPCS] : DEFAULT_RPCS;
    const r = await rpcCall('eth_getBalance', [address, 'latest'], { rpcs });
    if (!r.ok) return { ok: false, error: 'rpc unreachable' };
    const wei = BigInt(r.result);
    return { ok: true, wei: wei.toString(), eth: Number(wei) / 1e18 };
  },
  // owner-set soul URL override for a tokenId (e.g. fresh mints, Irys re-publishes)
  configSoul({ tokenId, url } = {}) {
    if (tokenId == null) return { ok: false, error: 'need tokenId' };
    if (!store.souls) store.souls = {};
    const u = String(url || '').trim();
    if (!u) { delete store.souls[String(tokenId)]; save(store); return { ok: true, removed: true }; }
    // The owner setting this IS the trust decision, so the content-addressed gateways are on
    // the table here — and only here.
    if (!soulOriginOk(soulUrl(u), true)) return { ok: false, error: 'origin not allowlisted for souls' };
    store.souls[String(tokenId)] = u; save(store); return { ok: true };
  },

  // Pull the token's neural soul: on-chain metadata fields → allowlisted pointer →
  // known monorepo. Never throws; soul:null + reason when nothing real exists.
  async soul({ contract, tokenId } = {}) {
    if (tokenId == null || tokenId === '') return { ok: false, error: 'bad tokenId' };
    const key = 'soul:' + String(contract || '').toLowerCase() + ':' + tokenId;
    if (!store.soulCache) store.soulCache = {};
    const hit = store.soulCache[key];
    const now = Date.now();
    if (hit && hit.text && now - hit.fetchedAt < SOUL_TTL) return { ok: true, soul: { ...hit, cached: true } };
    if (hit && !hit.text && now - hit.fetchedAt < SOUL_NEG_TTL) return { ok: true, soul: null, reason: hit.negativeReason || 'no-soul-field' };

    let reason = 'no-metadata';
    const finish = (soul, neg) => {
      store.soulCache[key] = soul || { text: '', fetchedAt: now, negativeReason: neg };
      save(store);
      return soul ? { ok: true, soul } : { ok: true, soul: null, reason: neg };
    };
    const tryUri = async (v, source, ownerConfigured = false) => {
      const u = soulUrl(v);
      if (!u) return null;
      if (!soulOriginOk(u, ownerConfigured)) { reason = 'untrusted-origin'; return null; }
      const text = await soulFetch(u);
      if (text == null) { reason = 'fetch-failed'; return null; }
      if (!soulValidate(text)) { reason = 'invalid-content'; return null; }
      return soulShape(text, source, u, false);
    };

    // 1) token metadata fields (on-chain first)
    if (contract || store.contract) {
      try {
        const r = await this.read({ contract, tokenId });
        const meta = r && r.ok ? r.nft : null;
        if (meta) {
          reason = 'no-soul-field';
          const attrs = Array.isArray(meta.attributes) ? meta.attributes : [];
          const trait = attrs.find(a => /^(soul|neural_soul|soul_uri)$/i.test(String(a.trait_type || '')));
          const cands = [meta.soul, meta.neural_soul, meta.soul_uri, meta.soulUri, trait && trait.value].filter(Boolean);
          for (const c of cands) {
            const s = String(c);
            if (s.startsWith('# ') || (s.length > 512 && !/^\w+:\/\//.test(s))) {
              if (soulValidate(s) && s.length >= SOUL_MIN && s.length <= SOUL_MAX) return finish(soulShape(s, 'onchain-field', 'tokenURI', false));
              continue;
            }
            const got = await tryUri(s, 'onchain-pointer');
            if (got) return finish(got);
          }
        }
      } catch {}
    }
    // 2) owner override, then known monorepo souls
    const mapped = (store.souls && store.souls[String(tokenId)]) || KNOWN_SOULS[String(tokenId)];
    if (mapped) {
      // ownerConfigured: this pointer came from configSoul() or the shipped KNOWN_SOULS map,
      // not from the token — so a content-addressed gateway is a choice the owner made.
      const got = await tryUri(mapped, 'monorepo', true);
      if (got) return finish(got);
    }
    // 3) serve stale positive over nothing when the network failed
    if (hit && hit.text) return { ok: true, soul: { ...hit, cached: true, stale: true } };
    return finish(null, reason);
  },

  async forWallet(address, { contract } = {}) {
    const c = contract || store.contract;
    if (!c) return { ok: false, error: 'need contract' };
    try {
      const balHex = await ethCall(c, SELECTORS.balanceOf + encodeAddr(address), store.rpcUrl);
      const bal = balHex ? parseInt(balHex, 16) : 0;
      if (!bal) return { ok: true, nfts: [] };
      const nfts = [];
      for (let i = 0; i < Math.min(bal, 12); i++) {
        const tidHex = await ethCall(c, SELECTORS.tokenOfOwnerByIndex + encodeAddr(address) + encodeUint(i), store.rpcUrl);
        if (!tidHex) continue;
        const tokenId = parseInt(tidHex, 16);
        const r = await this.read({ contract: c, tokenId });
        if (r.ok) nfts.push(r.nft);
      }
      return { ok: true, nfts };
    } catch (e) { return { ok: false, error: e.message }; }
  },
};
export default NFT;
