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

  // ── the control plane: an agent may not change the rules that constrain it ──────────
  //
  // A switch the agent can flip is not a switch. The first version of the gate above was
  // WORTHLESS and a live sweep proved it in three calls:
  //
  //   AGENT email.send                        → 403 refused, the switch is off
  //   AGENT permissions.set {autoEmail:true}  → 200 OK
  //   AGENT email.send                        → 200, straight through
  //
  // `permissions` is an ordinary routed module, so the agent could simply turn its own gate
  // on. Gating `permissions.set` behind a permission would be circular; this is a different
  // category and it is refused outright, like `rpcallow.set` already was.
  //
  // Expressed as a PRINCIPLE rather than another hand-written list, because a hand-written
  // list is exactly what missed `scheduled.reschedule` one commit earlier and would miss the
  // next one: everything that edits the constraints, the tool inventory, or the pairing
  // identity is out of the agent's reach, and a new function in one of these modules is
  // out of reach by default rather than by remembering.
  agentForbidden(mod, fn) {
    const m = String(mod || ''), f = String(fn || '');
    const rule = CONTROL_PLANE[m];
    if (!rule) return null;
    return rule.reads.includes(f) ? null : rule.why;
  },

  // What to tell the agent INSTEAD. A refusal that names no alternative is how a draft gets
  // dropped — but the alternative is not the same for every gate, and the first version of this
  // said "queue it with approvals.add" to a file-write refusal, which is advice about email.
  // Caught by the live sweep, not by the suite: the tests asserted the refusal, not its sense.
  agentGateAdvice(need) {
    return need === 'email'
      ? 'queue it with approvals.add and the owner will send it'
      : need === 'fileWrite'
        ? 'show the owner the change instead — they can turn on "Write files" in Machine'
        : 'ask the owner to enable it in Machine';
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
  // Moving a queued mail puts the same message on the wire as scheduling one. Missed by the
  // first pass because the table was written from the three functions that were on the mind
  // at the time rather than from what the module exports.
  'scheduled.reschedule': 'email',
};

// module → { reads that stay open, why everything else is refused }.
// DENY-BY-DEFAULT inside each module: adding a function to one of these does not accidentally
// hand it to the agent. Reads stay open so the agent can still SEE what it is allowed to do —
// that is what the original rpcallow exemption existed for, and it is the only part worth keeping.
const CONTROL_PLANE = {
  permissions: { reads: ['get'], why: 'the permission switches are the owner\'s — they are changed in SETTINGS → Machine, not by the agent they constrain' },
  rpcallow:    { reads: ['get', 'check'], why: 'the app_rpc policy is the owner\'s — it is changed in SETTINGS, not by the agent it constrains' },
  admin:       { reads: ['tools', 'users', 'system', 'logs'], why: 'the agent\'s own tool inventory is the owner\'s to edit, in SETTINGS → Agent tools' },
  session:     { reads: ['get', 'keys'], why: 'the pairing identity is the owner\'s — minting, rotating or revoking a key is never the agent\'s call' },
};

export default Permissions;
