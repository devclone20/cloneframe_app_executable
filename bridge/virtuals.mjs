// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — virtuals
// Keyless discovery over the public Virtuals Protocol API + a keyless Base
// Blockscout log scan for ERC-8004 registrations. No auth, no secrets — every
// endpoint here is a public read. No npm deps: global fetch + the shared
// platform/evm read stack (address/uint codec, ABI-string decode, eth_call
// failover) that nft.mjs and robinhood.mjs also consume.
// ─────────────────────────────────────────────────────────────────────────────

import { isAddress, encodeUint, decodeAbiString, ethCall, SELECTORS } from './platform/evm.mjs';

const API = 'https://api.virtuals.io/api';
// The ACP (Agent Commerce Protocol) side — a DIFFERENT service from the token catalog
// above, and the one where an owner's real working agents live. Public reads, no key:
//   /agents/wallet/<address>  → the agent that wallet belongs to
//   /agents/<uuid>/jobs       → its ACP job history (who it traded with, and whether)
const ACP_API = 'https://api.acp.virtuals.io';
const BLOCKSCOUT = 'https://base.blockscout.com/api';
// ERC-8004 identity registry on Base — AgentRegistered(uint256 agentId, address owner) topic0
const ERC8004_CONTRACT = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const ERC8004_TOPIC0 = '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a';
// Keyless Base JSON-RPC — used to read each ERC-8004 identity's tokenURI on-chain so
// agent NAMES survive even when api.virtuals.io (the Strapi catalog) is unreachable.
const BASE_RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.llamarpc.com', 'https://1rpc.io/base'];
// Browser-ish headers reduce Cloudflare bot-blocking on api.virtuals.io from server IPs.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const WALLET_TTL = 5 * 60 * 1000;
const AGENT_TTL = 5 * 60 * 1000;
const ERC_TTL = 10 * 60 * 1000;
const STATS_TTL = 30 * 60 * 1000;

// ── in-memory caches (per-process, TTL-bound — no disk, nothing to leak) ──────
const walletCache = new Map();
const agentCache = new Map();
const ercCache = new Map();
const statsCache = new Map();

function cacheGet(map, key, fresh) {
  if (fresh) return null;
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { map.delete(key); return null; }
  return hit.value;
}
function cacheSet(map, key, value, ttlMs) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// Single retry on network/abort error only — a well-formed non-2xx response
// (e.g. the API's 400 when a filter is malformed) is not retried, just
// reported back as {ok:false} so callers can fail soft.
async function fetchJson(url, { timeoutMs = 10000 } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA } });
      } finally {
        clearTimeout(t);
      }
      if (!res.ok) {
        let body = null;
        try { body = await res.json(); } catch {}
        return { ok: false, error: `http ${res.status}`, status: res.status, data: body };
      }
      const json = await res.json();
      return { ok: true, data: json };
    } catch (e) {
      if (attempt === 0) continue; // one retry on network error / timeout
      return { ok: false, error: e && e.message ? e.message : 'network error' };
    }
  }
  return { ok: false, error: 'unreachable' };
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) : str;
}
// virtuals.io image URLs observed as either absolute CDN links or bare paths —
// normalize to absolute so the UI never has to guess the origin.
function abs(u) {
  const s = String(u || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return 'https://api.virtuals.io' + (s.startsWith('/') ? s : '/' + s);
}

// data[] items from /api/virtuals are flat (no .attributes nesting) — map
// straight through to our normalized shape.
function normalizeAgent(item) {
  if (!item || typeof item !== 'object') return null;
  const img = item.image && typeof item.image === 'object' ? item.image.url : item.image;
  return {
    id: item.id ?? null,
    virtualId: item.virtualId ?? null,
    name: item.name ?? null,
    symbol: item.symbol ?? null,
    status: item.status ?? null,
    chain: item.chain ?? null,
    tokenAddress: item.tokenAddress ?? null,
    image: abs(img),
    description: truncate(item.description, 240),
    acpAgentId: item.acpAgentId ?? null,
    createdAt: item.createdAt ?? null,
    holderCount: item.holderCount ?? null,
    mcapInVirtual: item.mcapInVirtual ?? null,
  };
}

// ── ERC-8004 on-chain identity read (keyless Base RPC) ───────────────────────
// Resilient path: when the Strapi catalog (api.virtuals.io) is unreachable, agent
// names still resolve from each identity's tokenURI on Base. Read-only eth_call —
// the address/uint codec, ABI-string decode and RPC failover come from the shared
// platform/evm read stack (SELECTORS.tokenURI + encodeUint + decodeAbiString +
// ethCall), pinned to BASE_RPCS with the original 6s per-RPC budget so the on-wire
// request is byte-identical to the pre-consolidation fork.
//
// resolveTokenMeta stays local on purpose: its remote branch goes through this
// module's own fetchJson (single-retry, no size cap — the Virtuals-catalog HTTP
// client, which is out of scope for the evm port). The evm port's resolveTokenMeta
// has different fetch semantics (no retry, 1.5MB cap), so importing it would change
// observable behavior on the best-effort enrichment path.
// tokenURI may be an on-chain data: URI (base64 or url-encoded JSON) or an off-chain
// https/ipfs/ar pointer. Return parsed metadata JSON, or null.
async function resolveTokenMeta(uri) {
  const s = String(uri || '').trim();
  if (!s) return null;
  if (s.startsWith('data:')) {
    try {
      const comma = s.indexOf(',');
      const head = s.slice(5, comma), payload = s.slice(comma + 1);
      const raw = /;base64/i.test(head) ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
      return JSON.parse(raw);
    } catch { return null; }
  }
  let u = s;
  if (u.startsWith('ipfs://')) u = 'https://ipfs.io/ipfs/' + u.slice(7).replace(/^ipfs\//, '');
  else if (u.startsWith('ar://')) u = 'https://arweave.net/' + u.slice(5);
  else if (u.startsWith('irys://')) u = 'https://gateway.irys.xyz/' + u.slice(7);
  if (!/^https?:\/\//i.test(u)) return null;
  const r = await fetchJson(u, { timeoutMs: 8000 });
  return r.ok ? r.data : null;
}
// One ERC-8004 identity → {agentId, name, description, image} from its on-chain tokenURI.
async function readIdentity(agentId) {
  const hex = await ethCall(ERC8004_CONTRACT, SELECTORS.tokenURI + encodeUint(agentId), { rpcs: BASE_RPCS, timeoutMs: 6000 });
  const out = { agentId: String(agentId), name: null, description: null, image: null };
  if (!hex) return out;
  const meta = await resolveTokenMeta(decodeAbiString(hex));
  if (meta && typeof meta === 'object') {
    out.name = meta.name || null;
    out.description = truncate(meta.description || '', 240) || null;
    const img = meta.image || null;
    out.image = img ? abs(img.startsWith('ipfs://') ? 'https://ipfs.io/ipfs/' + img.slice(7) : img) : null;
  }
  return out;
}

// Is this agent actually trading? An agent with completed ACP jobs is a working business,
// not a listing — the owner should see that at a glance instead of having to go look.
async function acpJobs(acpId) {
  const r = await fetchJson(`${ACP_API}/agents/${encodeURIComponent(acpId)}/jobs`, { timeoutMs: 8000 }).catch(() => ({ ok: false }));
  const rows = (r.ok && r.data && Array.isArray(r.data.data)) ? r.data.data : null;
  if (!rows) return null;
  const done = rows.filter((j) => String(j.jobStatus || '').toUpperCase() === 'COMPLETED').length;
  const open = rows.filter((j) => ['OPEN', 'NEGOTIATION', 'TRANSACTION'].includes(String(j.jobStatus || '').toUpperCase())).length;
  return { total: rows.length, completed: done, open };
}

export const Virtuals = {
  // Agents created by a wallet — GET /api/virtuals?filters[walletAddress][$eq]=<addr>
  async byWallet(address, { limit = 24, fresh = false } = {}) {
    const addr = String(address || '');
    if (!isAddress(addr)) return { ok: false, error: 'bad address' };
    const key = addr.toLowerCase() + ':' + limit;
    const hit = cacheGet(walletCache, key, fresh);
    if (hit) return hit;

    const url = `${API}/virtuals?filters[walletAddress][$eq]=${addr}&pagination[pageSize]=${limit}`;
    const r = await fetchJson(url);
    if (!r.ok) return { ok: false, error: r.error };

    const rows = Array.isArray(r.data && r.data.data) ? r.data.data : [];
    const total = (r.data && r.data.meta && r.data.meta.pagination && r.data.meta.pagination.total) ?? rows.length;
    const agents = rows.map(normalizeAgent).filter(Boolean);
    const result = { ok: true, total, agents };
    cacheSet(walletCache, key, result, WALLET_TTL);
    return result;
  },

  // Single agent — GET /api/virtuals/<id>
  async agent(id) {
    const idStr = String(id ?? '').trim();
    if (!idStr) return { ok: false, error: 'bad id' };
    const hit = cacheGet(agentCache, idStr, false);
    if (hit) return hit;

    const url = `${API}/virtuals/${encodeURIComponent(idStr)}`;
    const r = await fetchJson(url);
    if (!r.ok) return { ok: false, error: r.error };

    const item = (r.data && r.data.data) || r.data;
    const base = normalizeAgent(item);
    if (!base) return { ok: false, error: 'not found' };
    const agentOut = {
      ...base,
      lpAddress: item.lpAddress ?? null,
      genesis: item.genesis ?? null,
      launchInfo: item.launchInfo ?? null,
    };
    const result = { ok: true, agent: agentOut };
    cacheSet(agentCache, idStr, result, AGENT_TTL);
    return result;
  },

  // Chain totals — GET /api/virtuals?filters[chain][$eq]=<chain>&pagination[pageSize]=1
  async chainStats({ fresh = false } = {}) {
    const hit = cacheGet(statsCache, 'chains', fresh);
    if (hit) return hit;

    const chains = ['BASE', 'SOLANA', 'ROBINHOOD'];
    const rows = await Promise.all(chains.map(async (chain) => {
      const url = `${API}/virtuals?filters[chain][$eq]=${chain}&pagination[pageSize]=1`;
      const r = await fetchJson(url);
      const total = r.ok ? ((r.data && r.data.meta && r.data.meta.pagination && r.data.meta.pagination.total) ?? 0) : null;
      return [chain, total];
    }));
    const counts = Object.fromEntries(rows);
    const ok = rows.every(([, v]) => v !== null);
    const result = { ok, counts };
    cacheSet(statsCache, 'chains', result, STATS_TTL);
    return result;
  },

  // ERC-8004 registrations owned by a wallet — keyless Blockscout classic log scan.
  // topic1 = agentId (indexed), topic2 = owner address (indexed, left-padded).
  async erc8004ByOwner(address, { fresh = false } = {}) {
    const addr = String(address || '');
    if (!isAddress(addr)) return { ok: false, error: 'bad address' };
    const key = addr.toLowerCase();
    const hit = cacheGet(ercCache, key, fresh);
    if (hit) return hit;

    const ownerTopic = '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();
    const url = `${BLOCKSCOUT}?module=logs&action=getLogs&fromBlock=0&toBlock=latest`
      + `&address=${ERC8004_CONTRACT}&topic0=${ERC8004_TOPIC0}&topic0_2_opr=and&topic2=${ownerTopic}`;
    // Full-history getLogs scans the whole chain (observed ~16s) — a short timeout
    // would abort a valid response, so this heavy read gets a generous budget.
    const r = await fetchJson(url, { timeoutMs: 28000 });
    if (!r.ok) return { ok: false, error: r.error };

    const j = r.data;
    const rows = (j && j.status === '1' && Array.isArray(j.result)) ? j.result : [];
    const registrations = [];
    for (const row of rows) {
      try {
        const agentIdHex = row.topics && row.topics[1];
        if (!agentIdHex) continue;
        registrations.push({ agentId: BigInt(agentIdHex).toString(), txHash: row.transactionHash || null });
      } catch {}
    }
    const result = { ok: true, registrations };
    cacheSet(ercCache, key, result, ERC_TTL);
    return result;
  },

  // ERC-8004 identities owned by a wallet, ENRICHED with on-chain names via each
  // identity's tokenURI on Base (keyless). SLOW (full-history log scan ~20s + reads)
  // and best-effort — many identities carry no metadata URI. Exposed as an explicit,
  // lazily-triggered "on-chain identities" scan, NOT part of the fast detect() path.
  async erc8004Enriched(address, { fresh = false, limit = 10 } = {}) {
    const base = await this.erc8004ByOwner(address, { fresh });
    if (!base.ok) return { ok: false, error: base.error };
    const regs = base.registrations;
    const key = String(address).toLowerCase() + ':enr:' + limit;
    const hit = cacheGet(ercCache, key, fresh);
    if (hit) return hit;
    // enrich newest-first, bounded; the rest stay as bare ids
    const head = regs.slice(0, limit);
    const enriched = await Promise.all(head.map((r) => readIdentity(r.agentId).then(
      (id) => ({ ...id, txHash: r.txHash }),
      () => ({ agentId: r.agentId, name: null, description: null, image: null, txHash: r.txHash }),
    )));
    const result = { ok: true, total: regs.length, enriched, remaining: Math.max(0, regs.length - head.length) };
    cacheSet(ercCache, key, result, ERC_TTL);
    return result;
  },

  // ── the identity graph ──────────────────────────────────────────────────────
  // A person's agents are almost never held by the wallet they log in with. On
  // Virtuals each agent gets its OWN wallet, and that is what owns the agent's
  // ERC-8004 identity NFT and what the catalog stores in `walletAddress`. Proven on
  // the owner's own account, 2026-07-25:
  //     login  0xb480…a739 → ERC-8004 registrations: []      ← what we used to scan
  //     agent  0x44Cc…6664 → agentId 55101 (iCLONE)          ← where it actually lives
  // so scanning only the login wallet found nothing and reported "no agents", which
  // was false. /api/profile/<wallet> is the public endpoint that maps a login wallet to
  // every wallet linked to that person — including each agent's. Scan them all.
  //
  // (Do NOT be tempted by filters[creator][…]: the catalog silently IGNORES relation
  // filters it cannot resolve and answers with the ENTIRE 70k-agent catalog, which a
  // naive caller would happily show as "your agents".)
  async profile(address) {
    const addr = String(address || '');
    if (!isAddress(addr)) return { ok: false, error: 'bad address' };
    const key = 'prof:' + addr.toLowerCase();
    const hit = cacheGet(walletCache, key, false);
    if (hit) return hit;
    const r = await fetchJson(`${API}/profile/${addr}`);
    if (!r.ok) return { ok: false, error: r.error, wallets: [addr] };
    const d = (r.data && r.data.data) || {};
    const wallets = [addr];
    for (const s of (Array.isArray(d.userSocials) ? d.userSocials : [])) {
      const w = String(s && s.walletAddress || '');
      if (isAddress(w) && !wallets.some((x) => x.toLowerCase() === w.toLowerCase())) wallets.push(w);
    }
    const result = { ok: true, id: d.id ?? null, displayName: d.displayName || null, wallets };
    cacheSet(walletCache, key, result, WALLET_TTL);
    return result;
  },

  // Every agent this PERSON holds, across every wallet their profile links — the
  // catalog's tokenised agents and the on-chain ERC-8004 identities together. Each
  // result says which wallet it came from, because "yours" should be inspectable.
  async holdings(address, opts = {}) {
    const { fresh = false } = opts;
    const addr = String(address || '');
    if (!isAddress(addr)) return { ok: false, error: 'bad address' };
    // The caller may already hold the identity graph (MY AGENTS resolves it once and hands
    // the same set to every economy) — don't pay for the profile lookup twice.
    let wallets = (Array.isArray(opts.wallets) ? opts.wallets.filter(isAddress) : []);
    if (!wallets.length) {
      const prof = await this.profile(addr);
      wallets = (prof.wallets && prof.wallets.length) ? prof.wallets : [addr];
    }
    // Read every wallet CONCURRENTLY — this walk used to be serial across up to 12
    // wallets with three round trips each, and the panel sat on a spinner for the sum
    // of all of them. The wallets are independent reads; only the merge below needs
    // order, and it gets it by iterating the results in wallet order.
    const per = await Promise.all(wallets.slice(0, 12).map(async (w) => {
      const [cat, acp, erc] = await Promise.all([
        this.byWallet(w, { fresh }).catch(() => ({ ok: false })),
        // ACP — the commerce side of Virtuals, and the ONLY place an agent that was
        // created but never activated can be seen at all: it has no token in the catalog
        // and no ERC-8004 identity on chain, yet it exists and belongs to this person.
        // Both endpoints are public reads (measured 2026-07-25).
        fetchJson(`${ACP_API}/agents/wallet/${w}`, { timeoutMs: 8000 }).catch(() => ({ ok: false })),
        // read ONCE per wallet: activation below and the identity list share this answer
        this.erc8004ByOwner(w, { fresh }).catch(() => ({ ok: false })),
      ]);
      const a = acp.ok && acp.data && acp.data.data;
      const jobs = a && a.id ? await acpJobs(a.id) : null;
      return { w, cat, acp: a, jobs, regs: erc.registrations || [] };
    }));
    const agents = [];
    const seen = new Set();
    let catalogOk = true;
    for (const { w, cat, acp: a, jobs, regs } of per) {
      if (!cat.ok) catalogOk = false;
      for (const a2 of (cat.agents || [])) {
        const k = 'v:' + (a2.virtualId || a2.id || a2.name);
        if (seen.has(k)) continue; seen.add(k);
        agents.push({ ...a2, source: 'Virtuals', wallet: w });
      }
      if (a && a.id && !seen.has('a:' + a.id)) {
        seen.add('a:' + a.id);
        const reg = regs[0] || null;
        if (reg) seen.add('e:' + reg.agentId);
        agents.push({
          acpId: a.id, name: a.name || 'agent', image: a.imageUrl || null, role: a.role || null,
          rating: a.rating ?? null, source: 'ACP', wallet: w,
          activated: !!reg, agentId: reg ? reg.agentId : null, jobs,
        });
      }
      for (const r of regs) {
        const k = 'e:' + r.agentId;
        if (seen.has(k)) continue; seen.add(k);
        let name = null;
        try { const id = await readIdentity(r.agentId); name = id && id.name; } catch { /* bare id is still true */ }
        agents.push({ agentId: r.agentId, name: name || ('agent #' + r.agentId), source: 'ERC-8004', wallet: w, activated: true, txHash: r.txHash });
      }
    }
    return { ok: true, wallets, linked: wallets.length - 1, catalogOk, agents, total: agents.length };
  },

  // Primary wallet discovery — fast and authoritative via the Virtuals catalog.
  // `catalogOk:false` tells the UI the catalog was unreachable (network / Cloudflare)
  // so it can show an honest retry state instead of a misleading "nothing found".
  async detect(address, opts = {}) {
    const addr = String(address || '');
    if (!isAddress(addr)) return { ok: false, error: 'bad address' };
    const w = await this.byWallet(addr, opts);
    return {
      ok: w.ok,
      catalogOk: w.ok,
      agents: w.ok ? w.agents : [],
      total: w.ok ? w.total : 0,
      error: w.ok ? null : (w.error || 'catalog unreachable'),
    };
  },
};
export default Virtuals;
