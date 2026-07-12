// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — harness registry
// The Harness tab is a LIST of harnesses (crews of agents). Selecting one shows
// its roles/gates; the user can mark one "active for terminal". Seeds HARNESS ENGINE.
// ─────────────────────────────────────────────────────────────────────────────
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(homedir(), '.clone-frame-hub');
const FILE = path.join(DIR, 'harness.json');
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

function load() {
  let s; try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { s = { harnesses: [] }; }
  if (!Array.isArray(s.harnesses)) s.harnesses = [];
  // the builtin is code-owned: refresh it from ENGINE on every load (keeps user's activeForTerminal)
  const i = s.harnesses.findIndex(h => h.id === 'harness-engine');
  if (i === -1) s.harnesses.unshift(JSON.parse(JSON.stringify(ENGINE)));
  else s.harnesses[i] = { ...JSON.parse(JSON.stringify(ENGINE)), activeForTerminal: s.harnesses[i].activeForTerminal !== false, createdAt: s.harnesses[i].createdAt || ENGINE.createdAt };
  return s;
}
function save(o) { try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); const t = FILE + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(o), { mode: 0o600 }); fs.renameSync(t, FILE); } catch {} }
let store = load(); save(store);

export const Harness = {
  list() { return store.harnesses.slice(); },
  get(id) { return store.harnesses.find(h => h.id === id) || null; },
  add({ name, description, kind, roles, gates } = {}) {
    if (!name) return { ok: false, error: 'name required' };
    const id = rid();
    const r = Array.isArray(roles) ? roles : [];
    const g = Array.isArray(gates) && gates.length ? gates : r.filter(x => x && x.gate).map(x => x.name);
    store.harnesses.push({ id, name, description: description || '', kind: kind || 'custom', isBuiltin: false, roles: r, gates: g.length ? g : ['SAFETY', 'OWNER'], activeForTerminal: false, createdAt: Date.now() });
    save(store); return { ok: true, id };
  },
  update(id, patch) {
    const h = store.harnesses.find(x => x.id === id); if (!h) return { ok: false, error: 'not found' };
    if (h.isBuiltin && (patch.name || patch.roles || patch.gates)) return { ok: false, error: 'built-in: duplicate it to edit its crew' };
    const p = { ...patch };
    // keep the gate list derived from the crew unless the caller set it explicitly
    if (Array.isArray(p.roles) && !Array.isArray(p.gates)) p.gates = p.roles.filter(x => x && x.gate).map(x => x.name);
    Object.assign(h, p); save(store); return { ok: true };
  },
  // clone any harness (incl. the built-in ENGINE) into an editable custom crew
  duplicate(id, name) {
    const src = store.harnesses.find(x => x.id === id); if (!src) return { ok: false, error: 'not found' };
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = rid(); copy.isBuiltin = false; copy.activeForTerminal = false;
    copy.name = name || (src.name + ' (copy)'); copy.kind = src.kind === 'spine' ? 'custom' : (src.kind || 'custom');
    copy.createdAt = Date.now();
    store.harnesses.push(copy); save(store); return { ok: true, id: copy.id };
  },
  remove(id) { const h = store.harnesses.find(x => x.id === id); if (h && h.isBuiltin) return { ok: false, error: 'built-in cannot be removed' }; store.harnesses = store.harnesses.filter(x => x.id !== id); save(store); return { ok: true }; },
  setActiveForTerminal(id, on) {
    store.harnesses.forEach(h => { h.activeForTerminal = false; });
    if (on !== false) { const h = store.harnesses.find(x => x.id === id); if (h) h.activeForTerminal = true; }
    save(store); return { ok: true };
  },
  activeForTerminal() { return store.harnesses.find(h => h.activeForTerminal) || null; },
};
export default Harness;
