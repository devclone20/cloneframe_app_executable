// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — permissions
// The gate the bridge consults before privileged agent actions. All DEFAULT OFF.
// Nothing here stores a password; rootMode only means "sudo is permitted".
// ─────────────────────────────────────────────────────────────────────────────
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(homedir(), '.clone-frame-hub');
const FILE = path.join(DIR, 'permissions.json');
// machineControl = the master switch: when ON, the agent may do anything on this machine
// (shell, root/sudo, files, web, open apps/folders, automations). Email stays separate —
// sending mail on the owner's behalf is outbound to other people and keeps its own toggle.
const DEFAULTS = { machineControl: false, fullAccess: false, rootMode: false, autoEmail: false, autoAutomations: false, fileWrite: false, webAccess: false };

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
    if (perms.machineControl && action !== 'email') return true;
    const map = { shell: 'fullAccess', root: 'rootMode', email: 'autoEmail', automation: 'autoAutomations', fileWrite: 'fileWrite', web: 'webAccess', open: 'fullAccess' };
    const flag = map[action];
    if (!flag) return false;
    return !!perms[flag];
  },
  reset() { perms = { ...DEFAULTS }; save(perms); return { ok: true }; },
};
export default Permissions;
