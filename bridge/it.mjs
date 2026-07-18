// it.mjs — control plane for iT, the CLONE FRAME terminal multiplexer.
// The `it` CLI (it-cli.mjs) POSTs /mod/it {fn:'cmd', args:[argv, ctx]}; the iT window
// parks ONE control WebSocket here (GET /stream?op=it — same host/token gates as every
// stream) and answers each command on that socket. This module only ferries JSON
// between the two, with timeouts. No LLM, no shell, no secrets.

// Control sockets, one per open iT window. A STACK, not a single slot: kicking the old
// window made its 3s reconnect fight the new one forever (ctl ping-pong, seen live with
// the Electron shell + a browser tab both open). Nobody gets kicked; commands go to the
// most recently attached socket that is still open, older ones are silent fallbacks.
const ctls = [];
let seq = 0;
const pending = new Map(); // id → {resolve, timer}
const TIMEOUT_MS = 6000;
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

export const It = {
  available() { return true; },
  ui() { return !!liveCtl(); },

  // CLI → UI. argv is the raw command vector; ctx carries the caller's env ids.
  async cmd(argv, ctx) {
    if (!Array.isArray(argv) || !argv.length) return { ok: false, error: 'empty command' };
    if (argv.length > 64) return { ok: false, error: 'too many arguments' };
    for (const a of argv) if (typeof a !== 'string' || a.length > 4000) return { ok: false, error: 'bad argument' };
    if (!It.ui()) return { ok: false, error: 'iT is not open — open the iT terminal in CLONE FRAME first' };
    const c = {};
    if (ctx && typeof ctx === 'object') {
      if (typeof ctx.workspace === 'string' && /^[\w-]{1,64}$/.test(ctx.workspace)) c.workspace = ctx.workspace;
      if (typeof ctx.surface === 'string' && /^[\w-]{1,64}$/.test(ctx.surface)) c.surface = ctx.surface;
    }
    const id = 'it' + (++seq);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'iT did not answer (timeout) — is the iT window responsive?' }); }, TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      let sent = false;
      const ws = liveCtl();
      if (ws) { try { ws.send(JSON.stringify({ id, argv, ctx: c })); sent = true; } catch {} }
      if (!sent) { clearTimeout(timer); pending.delete(id); resolve({ ok: false, error: 'iT control channel broke — reopen the iT terminal' }); }
    });
  },

  // GET /stream?op=it — called from dispatchStream AFTER the upgrade gates passed.
  attachCtl(ws) {
    const drop = () => { const i = ctls.indexOf(ws); if (i >= 0) ctls.splice(i, 1); };
    drop(); ctls.push(ws);
    if (ctls.length > 8) { const old = ctls.shift(); try { old.close(1000, 'too many iT windows'); } catch {} }
    ws.on('close', drop);
    ws.on('error', drop);
    ws.on('message', (d) => {
      let m = null; try { m = JSON.parse(String(d)); } catch {}
      if (m && m.id) settle(String(m.id), m.result);
    });
    try { ws.send(JSON.stringify({ hello: 'it-ctl' })); } catch {}
  },
};
