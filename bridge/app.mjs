// app.mjs — control plane for the MAIN app UI (the 20 panels + the live screen).
//
// The iT terminal has its own control socket (it.mjs, op=it). This is its sibling for
// the rest of the app: the running index.html parks ONE control WebSocket here
// (GET /stream?op=app — same host/token gates as every stream) and answers each command
// on that socket. It is how an OUTSIDE process (the Pi coding agent, via /mod/app) opens
// a panel, focuses/closes one, and reads the live screen state — the things the browser
// can do but the bridge cannot see. This module only ferries JSON between the two, with a
// timeout. No LLM, no shell, no secrets.
//
// Contract: the caller sends {fn:'cmd', args:[action, params]}; we forward
// {id, action, params} to the app and resolve with whatever the app answers ({ok,...}).
// The app-side handler lives in the App() IIFE (web/panels/harness.js) and switches on
// `action` (ping · open_panel · close_panel · focus_panel · read_screen · list_panels ·
// snapshot). A missing app window returns a clear, actionable error — never a hang.

// Control sockets, newest-first — a STACK, not one slot (a reload/second window would
// otherwise fight over a single slot; see it.mjs for the scar). Commands go to the most
// recently attached socket still open; older ones are silent fallbacks.
const ctls = [];
let seq = 0;
const pending = new Map(); // id → {resolve, timer}
const TIMEOUT_MS = 8000;   // panel opens can animate; a touch longer than it.mjs's 6s

function liveCtl() {
  for (let i = ctls.length - 1; i >= 0; i--) {
    if (ctls[i].readyState === 1) return ctls[i];
    ctls.splice(i, 1);
  }
  return null;
}

function settle(id, result) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer); pending.delete(id);
  p.resolve((result && typeof result === 'object') ? result : { ok: true, out: String(result ?? '') });
}

// A tiny allowlist of actions the app control channel accepts. Anything else is refused
// here (defence in depth: the app-side handler enforces the same list). Read + panel-drive
// only; nothing here writes files, moves value, or runs a shell — those are other modules.
const ACTIONS = new Set(['ping', 'open_panel', 'close_panel', 'focus_panel', 'read_screen', 'list_panels', 'snapshot']);

export const App = {
  available() { return true; },
  ui() { return !!liveCtl(); },

  // Caller (Pi extension via POST /mod/app) → the app UI. `action` is a verb from ACTIONS;
  // `params` is a small plain object. Resolves with the app's JSON answer.
  async cmd(action, params) {
    if (typeof action !== 'string' || !ACTIONS.has(action)) return { ok: false, error: 'unknown app action' };
    let p = {};
    if (params && typeof params === 'object' && !Array.isArray(params)) {
      // shallow-sanitize: only string/number/boolean fields, bounded — the app trusts this
      for (const k of Object.keys(params)) {
        if (!/^[\w-]{1,40}$/.test(k)) continue;
        const v = params[k];
        if (typeof v === 'string') { if (v.length <= 4000) p[k] = v; }
        else if (typeof v === 'number' || typeof v === 'boolean') p[k] = v;
      }
    }
    if (!App.ui()) return { ok: false, error: 'CLONE FRAME is not open — open the app first (the agent drives the app window; it must be running)' };
    const id = 'app' + (++seq);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'the app did not answer (timeout) — is the CLONE FRAME window responsive?' }); }, TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      let sent = false;
      const ws = liveCtl();
      if (ws) { try { ws.send(JSON.stringify({ id, action, params: p })); sent = true; } catch {} }
      if (!sent) { clearTimeout(timer); pending.delete(id); resolve({ ok: false, error: 'app control channel broke — reload the CLONE FRAME window' }); }
    });
  },

  // GET /stream?op=app — called from dispatchStream AFTER the upgrade gates passed.
  // `_` prefix for the same reason as It._attachCtl: handleMod refuses underscore fns, and
  // this one takes a live WebSocket and pushes it into the control stack before it validates
  // anything. Only the upgrade path may call it.
  _attachCtl(ws) {
    const drop = () => { const i = ctls.indexOf(ws); if (i >= 0) ctls.splice(i, 1); };
    drop(); ctls.push(ws);
    if (ctls.length > 8) { const old = ctls.shift(); try { old.close(1000, 'too many app windows'); } catch {} }
    ws.on('close', drop);
    ws.on('error', drop);
    ws.on('message', (d) => {
      let m = null; try { m = JSON.parse(String(d)); } catch {}
      if (m && m.id) settle(String(m.id), m.result);
    });
    try { ws.send(JSON.stringify({ hello: 'app-ctl' })); } catch {}
  },
};

export default App;
