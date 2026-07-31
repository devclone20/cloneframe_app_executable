// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — permissions
// The gate the bridge consults before privileged agent actions. All DEFAULT OFF.
// Nothing here stores a password; rootMode only means "sudo is permitted".
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { hubRoot } from './platform/hub-root.mjs';

// Resolved through the shared hub-root seam like every other store. This module was
// missed when the ~19 hardcoded `path.join(homedir(), '.clone-frame-hub')` copies were
// migrated, and the omission had teeth: with no seam, a test that exercised the
// permission gate wrote to the DEVELOPER'S REAL permissions.json — silently flipping a
// live security setting on the machine running the suite. Production behavior is
// unchanged (hubRoot() is `~/.clone-frame-hub` when the env is unset); what changes is
// that the gate can now be tested without touching the owner's own configuration.
const DIR = hubRoot();
const FILE = path.join(DIR, 'permissions.json');
// machineControl = the master switch: when ON, the agent may do anything on this machine
// (shell, root/sudo, files, web, open apps/folders, automations). Email stays separate —
// sending mail on the owner's behalf is outbound to other people and keeps its own toggle.
// ssh = reach the user's own remote servers/VMs. Its OWN gate, default OFF, NOT unlocked by the
// master switch — remote blast radius ≠ local, so "control this machine" must not imply "SSH into
// my whole fleet" (mirrors how email stays separate).
// matrix = start/stop the local MATRIX cluster engine daemon. Its OWN gate like ssh —
// spawning/killing a resident engine is a deliberate owner choice, not implied by the master.
const DEFAULTS = { machineControl: false, fullAccess: false, rootMode: false, autoEmail: false, autoAutomations: false, fileWrite: false, webAccess: false, ssh: false, matrix: false };

function load() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { return { ...DEFAULTS }; }
}
function save(o) {
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    return true;
  } catch { return false; }
}

let perms = load();

export const Permissions = {
  get() { return { ...perms }; },
  set(patch) {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'bad patch' };
    for (const k of Object.keys(DEFAULTS)) if (k in patch) perms[k] = !!patch[k];
    save(perms);
    return { ok: true, perms: { ...perms } };
  },
  // action → which flag governs it. The master switch unlocks everything except email.
  can(action) {
    if (perms.machineControl && action !== 'email' && action !== 'ssh' && action !== 'matrix') return true;
    const map = { shell: 'fullAccess', root: 'rootMode', email: 'autoEmail', automation: 'autoAutomations', fileWrite: 'fileWrite', web: 'webAccess', open: 'fullAccess', ssh: 'ssh', matrix: 'matrix' };
    const flag = map[action];
    if (!flag) return false;
    return !!perms[flag];
  },
  reset() { perms = { ...DEFAULTS }; save(perms); return { ok: true }; },

  // ── the calls an AGENT may not make on a toggle it does not have ────────────────────
  //
  // SETTINGS is honest about the general rule and says so on screen: these switches "shape
  // what your agent reaches for in normal operation — they are not a sandbox", and only ssh,
  // MATRIX and Root mode are enforced in the daemon. That is a sound position and it stands.
  //
  // Email was the one place where the app said something STRONGER and unqualified:
  //
  //   "An agent can only send from your account when Send email without asking is on in
  //    Machine. With it off, everything it writes waits for you in APPROVAL."
  //
  // and the agent's own curriculum told it "with autoEmail off, email.send refuses". Neither
  // was true: Permissions.can('email') had no call site anywhere in the bridge. The only check
  // lived in the browser's tool loop, which pi does not go through — it calls POST /mod/email
  // itself. So a well-behaved agent, believing it would be refused, sent instead of queueing.
  //
  // The general argument for not enforcing here ("whoever holds the pairing token already has
  // a shell") is about an ATTACKER. It does not cover the owner's own agent, which is exactly
  // who this toggle exists to constrain — and mail is irreversible and reaches other people.
  // So these three, and only these three, are enforced for calls the agent marks as its own.
  // The owner's interface never sends the agent header and is never constrained by this.
  //
  //   email.send          the direct path
  //   scheduled.schedule  the same send, on a timer — a gate the clock walks around is no gate
  //   approvals.approve   the agent must not approve the draft it wrote for the owner to read
  //
  // Returns the permission key this (module, fn) needs from an agent caller, or null.
  agentGateFor(mod, fn) {
    const key = String(mod || '') + '.' + String(fn || '');
    return AGENT_GATED[key] || null;
  },
};

const AGENT_GATED = {
  // Mail leaves the machine and cannot be recalled.
  'email.send': 'email',
  'scheduled.schedule': 'email',   // the same send, on a timer
  'approvals.approve': 'email',    // the agent must not approve the draft it wrote
  // Writing to the owner's disk. bridge/files.mjs's own header says "the permission gate
  // (permissions.mjs) decides whether the agent may call write", and the pi extension repeats
  // it to the model — "write respects the owner's file permission". Neither was true: the only
  // check lived in the browser's tool loop, which pi does not go through. Reads stay open, so
  // the agent can still see the project it is working on.
  'files.write': 'fileWrite',
  'files.writeB64': 'fileWrite',
  'files.mkdir': 'fileWrite',
  'files.remove': 'fileWrite',
  'files.move': 'fileWrite',
  'files.copy': 'fileWrite',
};

export default Permissions;
