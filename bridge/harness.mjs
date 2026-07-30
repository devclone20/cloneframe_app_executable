// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — harness registry
// The Harness tab is a LIST of harnesses (crews of agents). Selecting one shows
// its roles/gates; the user can mark one "active for terminal". Seeds HARNESS ENGINE.
// ─────────────────────────────────────────────────────────────────────────────
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

const rid = () => 'h_' + Math.random().toString(36).slice(2, 9);

const ENGINE = {
  id: 'harness-engine', name: 'HARNESS ENGINE', kind: 'spine', isBuiltin: true,
  description: 'The CLONE FRAME spine: orchestrates a crew of agents with 4 non-collapsible gates. Nothing irreversible happens without the OWNER.',
  roles: [
    { name: 'ORCHESTRATOR', desc: 'head · delegates · moderates the crew', gate: false, collapsible: false },
    { name: 'SAFETY / HACKER', desc: 'security veto · fail-closed', gate: true, collapsible: false },
    { name: 'EVALUATOR', desc: 'quality gate', gate: true, collapsible: false },
    { name: 'TREASURY', desc: 'funds gate · spending caps', gate: true, collapsible: false },
    { name: 'OWNER', desc: 'human approval — you', gate: true, collapsible: false },
    { name: 'RESEARCH', desc: 'specialist agent (research)', gate: false, collapsible: true },
    { name: 'DELIVERY', desc: 'specialist agent (execution)', gate: false, collapsible: true },
  ],
  gates: ['EVALUATOR', 'SAFETY', 'TREASURY', 'OWNER'],
  activeForTerminal: true,
  createdAt: Date.now(),
};

// ── persistence ───────────────────────────────────────────────────────────────
// Backed by the shared atomic JSON store: ~/.clone-frame-hub/harness.json, dir
// 0700 / file 0600, tmp-write-then-rename, read-per-call (fixes the old
// `let store = load()` stale-read singleton). The store guarantees only the
// top-level {harnesses:[]} container; the builtin-ENGINE refresh below stays this
// module's job. Every mutation reads fresh, mutates, and saves in the same call.
const store = openStore({ name: 'harness', version: 1, shape: { harnesses: [] }, root: hubRoot() });

function load() {
  const s = store.read();
  if (!Array.isArray(s.harnesses)) s.harnesses = [];
  // the builtin is code-owned: refresh it from ENGINE on every load (keeps user's activeForTerminal)
  const i = s.harnesses.findIndex(h => h.id === 'harness-engine');
  if (i === -1) s.harnesses.unshift(JSON.parse(JSON.stringify(ENGINE)));
  else s.harnesses[i] = { ...JSON.parse(JSON.stringify(ENGINE)), activeForTerminal: s.harnesses[i].activeForTerminal !== false, createdAt: s.harnesses[i].createdAt || ENGINE.createdAt };
  return s;
}
// The port's write() throws on disk failure; the original save() swallowed to
// nothing and every caller returns {ok:true} regardless — preserve that here.
function save(o) { try { store.write(o); } catch {} }

save(load());

export const Harness = {
  list() { return load().harnesses.slice(); },
  get(id) { return load().harnesses.find(h => h.id === id) || null; },
  add({ name, description, kind, roles, gates } = {}) {
    if (!name) return { ok: false, error: 'name required' };
    const s = load();
    const id = rid();
    const r = Array.isArray(roles) ? roles : [];
    const g = Array.isArray(gates) && gates.length ? gates : r.filter(x => x && x.gate).map(x => x.name);
    s.harnesses.push({ id, name, description: description || '', kind: kind || 'custom', isBuiltin: false, roles: r, gates: g.length ? g : ['SAFETY', 'OWNER'], activeForTerminal: false, createdAt: Date.now() });
    save(s); return { ok: true, id };
  },
  update(id, patch) {
    const s = load();
    const h = s.harnesses.find(x => x.id === id); if (!h) return { ok: false, error: 'not found' };
    if (h.isBuiltin && (patch.name || patch.roles || patch.gates)) return { ok: false, error: 'built-in: duplicate it to edit its crew' };
    const p = { ...patch };
    // keep the gate list derived from the crew unless the caller set it explicitly
    if (Array.isArray(p.roles) && !Array.isArray(p.gates)) p.gates = p.roles.filter(x => x && x.gate).map(x => x.name);
    // The SAME floor add() applies. Without it, editing a crew down to zero gate roles wiped
    // `gates` as well, so the floor only ever protected creation and the edit path walked
    // straight past it. The UI calls these "non-collapsible" and the agent's system prompt
    // says "nothing irreversible passes without" them — that has to be true on every path
    // that can write a crew, including the agent's own update_harness.
    if (Array.isArray(p.gates) && !p.gates.length) p.gates = ['SAFETY', 'OWNER'];
    Object.assign(h, p); save(s); return { ok: true };
  },
  // clone any harness (incl. the built-in ENGINE) into an editable custom crew
  duplicate(id, name) {
    const s = load();
    const src = s.harnesses.find(x => x.id === id); if (!src) return { ok: false, error: 'not found' };
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = rid(); copy.isBuiltin = false; copy.activeForTerminal = false;
    copy.name = name || (src.name + ' (copy)'); copy.kind = src.kind === 'spine' ? 'custom' : (src.kind || 'custom');
    copy.createdAt = Date.now();
    s.harnesses.push(copy); save(s); return { ok: true, id: copy.id };
  },
  // Answers for what it actually did: removing an id that is not here used to report
  // {ok:true} and write the store back unchanged — a caller (or a person) was told a
  // deletion happened that never did. Every other module in the bridge says "not found".
  remove(id) {
    const s = load();
    const h = s.harnesses.find(x => x.id === id);
    if (!h) return { ok: false, error: 'remove: harness not found' };
    if (h.isBuiltin) return { ok: false, error: 'built-in cannot be removed' };
    s.harnesses = s.harnesses.filter(x => x.id !== id);
    save(s);
    return { ok: true };
  },
  setActiveForTerminal(id, on) {
    const s = load();
    s.harnesses.forEach(h => { h.activeForTerminal = false; });
    if (on !== false) { const h = s.harnesses.find(x => x.id === id); if (h) h.activeForTerminal = true; }
    save(s); return { ok: true };
  },
  activeForTerminal() { return load().harnesses.find(h => h.activeForTerminal) || null; },
};
export default Harness;
