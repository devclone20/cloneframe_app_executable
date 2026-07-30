// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — domains/chat/chat  (T-031)
//
// The streaming chat relays, extracted from hub-bridge.mjs so the router keeps
// only transport + security + dispatch. Two endpoints:
//
//   • handleChat        — the "brain": streams from the user's DEFAULT model via the
//                         provider-agnostic model port. ANY provider works — a Settings
//                         registry provider, a generic env provider (DeepSeek /
//                         OpenAI-compat / local via DEEPSEEK_API_KEY or CFHUB_LLM_*),
//                         or a bare env ANTHROPIC_API_KEY. No path is Claude-locked.
//   • handleProviderChat — streams from a STORED provider the user configured.
//                         Anthropic (/v1/messages, x-api-key) vs OpenAI-compatible
//                         (/chat/completions, Bearer). The wire details come from
//                         models._streamConfig(id) — a single purpose-built
//                         server-only accessor — NOT the old _raw/_isAnthropic
//                         reach-through. Includes the MATRIX cluster's
//                         launch-instance-on-404-then-retry path.
//
// Control framing is unchanged: streamed text plus \x00ERR\x00<msg> error frames
// (the renderer's marks() parser splits on \x00). `streamHead` is injected by the
// router (the shared streaming-response head). Zero npm deps — global fetch only.
// Keys are read from disk, never logged, and never leave this machine.
// ─────────────────────────────────────────────────────────────────────────────
const CHAT_TIMEOUT = 120_000;
// Concrete model for a bare env ANTHROPIC_API_KEY (that API rejects "auto"). Every
// OTHER provider brings its own model. Overridable via HUB_BRIDGE_MODEL.
const BRAIN_MODEL = process.env.HUB_BRIDGE_MODEL || 'claude-opus-4-8';
const DEFAULT_SYSTEM = 'You are the model the owner connected to CLONE FRAME. Answer helpfully, directly and honestly. You have real access to this machine\'s terminal through the HUB Bridge.';
const j = (o) => JSON.stringify(o);

// Lazy models loader (mirrors the router's getMod('models'): a broken models
// module degrades /provider-chat to a 503 instead of crashing the daemon). ESM
// caches by specifier, so this is the SAME instance the router/port already hold.
let _Models = null;
async function models() {
  if (_Models) return _Models;
  const m = await import('../../models.mjs');
  _Models = m.Models || m.default || m;
  return _Models;
}

// Lazy model port (the provider-agnostic dispatch: registry provider OR a generic
// env provider OR env ANTHROPIC_API_KEY). Reads config fresh each call.
let _port = null;
async function port() {
  if (_port) return _port;
  _port = await (await import('../../model/port.mjs')).modelPort();
  return _port;
}

// The DEFAULT model /chat speaks, resolved through the port. Reflected by /pair + the
// boot banner. Async (the port lazily loads the registry). Never exposes the key.
export async function brain() {
  try {
    const t = (await port()).resolveTarget({ capability: 'chat' });
    if (!t) return { ready: false, provider: null, model: null };
    const model = (t.anthropic && (!t.model || t.model === 'auto')) ? BRAIN_MODEL : t.model;
    return { ready: true, provider: t.provider || 'model', model };
  } catch { return { ready: false, provider: null, model: null }; }
}

// ── the "brain": stream from the user's DEFAULT model — ANY provider, BYOK ───
// Provider-agnostic: routes through the model port, so DeepSeek / any OpenAI-compat /
// local / Anthropic all work with no code change. \x00ERR\x00 framing preserved (the
// port throws a key-free "<label> <status> <body>" that we frame; abort → "timeout").
export async function handleChat(req, res, body, { streamHead }) {
  // 'chat' is the Settings → AI Defaults row that governs this route (the default brain
  // behind CODE and LAB). An explicit body.model still wins — that is the model picker.
  const pick = { model: body.model, capability: 'chat' };
  let p, t;
  try { p = await port(); t = p.resolveTarget(pick); } catch { t = null; }
  if (!t) {
    res.writeHead(501, { 'Content-Type': 'text/plain' });
    res.end('no model configured — add a provider in Settings → Add Models, or set an API key (e.g. DEEPSEEK_API_KEY) in ~/.env.local');
    return;
  }
  streamHead(res);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = body.system || DEFAULT_SYSTEM;
  // Anthropic rejects "auto"; a bare env key resolves to "auto" → substitute the brain
  // default there. Every other provider brings (or defaults) its own model.
  const model = body.model || ((t.anthropic && (!t.model || t.model === 'auto')) ? BRAIN_MODEL : t.model);
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), CHAT_TIMEOUT);
  req.on('close', () => ctl.abort());
  try {
    // `pick` must ride along: stream() resolves the target again internally, and without
    // the capability it would resolve a DIFFERENT provider than the one checked above.
    await p.stream(messages, { ...pick, system, model, maxTokens: Number(body.max_tokens) || 2048, signal: ctl.signal, onText: (d) => res.write(d) });
    res.end();
  } catch (e) {
    res.end('\x00ERR\x00' + (e.name === 'AbortError' ? 'timeout' : e.message));
  } finally { clearTimeout(to); }
}

// MATRIX cluster: a model that is on disk but has no running instance answers the
// OpenAI endpoint with 404 "no instance found". Spin one up on demand (Pipeline / MlxRing,
// single node) so any downloaded local model is directly chattable from CODE/LAB — without
// a manual LAUNCH. Never auto-DOWNLOADS: refuses a model that is not already on disk.
// Returns true once an instance exists or is coming up (the caller then polls the chat call).
async function matrixEnsureInstance(v1Base, model, signal) {
  const eng = String(v1Base || '').replace(/\/v\d+$/, ''); // http://127.0.0.1:52415
  const getJson = async (p) => { try { const r = await fetch(eng + p, { signal }); return r.ok ? await r.json() : null; } catch { return null; } };
  const state = await getJson('/state');
  const runners = (state && state.runners) || {};
  // exo's instance union is TAGGED: MlxRingInstance today, MlxJacclInstance on an RDMA
  // cluster, more later. Reading one hardcoded key made a Jaccl instance invisible (a
  // duplicate placed on every message) and a FAILED ring instance count as "coming up"
  // (never replaced, so the model could never load again).
  const forModel = [];
  for (const iid in (state && state.instances) || {}) {
    const inner = state.instances[iid][Object.keys(state.instances[iid])[0]] || {};
    const sa = inner.shardAssignments || {};
    if (sa.modelId !== model) continue;
    const rids = Object.keys(sa.runnerToShard || {});
    const failed = rids.some((r) => /Failed/i.test(runners[r] ? Object.keys(runners[r])[0] || '' : ''));
    forModel.push({ iid, failed });
  }
  const usable = forModel.filter((i) => !i.failed);
  if (!usable.length) {
    const dl = await getJson('/models?status=downloaded');
    const ids = dl ? (dl.data || dl || []).map((m) => m && m.id) : [];
    if (!ids.includes(model)) return false; // not on disk — do not trigger a (huge) download
    // A dead instance keeps the model's slot; clear it or the replacement never places.
    for (const dead of forModel) {
      try { await fetch(eng + '/instance/' + encodeURIComponent(dead.iid), { method: 'DELETE', signal }); } catch { /* best effort */ }
    }
    try {
      const r = await fetch(eng + '/place_instance', {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model_id: model, sharding: 'Pipeline', instance_meta: 'MlxRing', min_nodes: 1 }),
      });
      if (!r.ok) return false;
    } catch { return false; }
  }
  return true;
}

// ── provider chat: stream from the user's OWN model (API or local), any provider
//    Anthropic → /v1/messages ; everyone else (OpenAI/DeepSeek/Groq/Ollama/…) → /chat/completions
export async function handleProviderChat(req, res, body, { streamHead }) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = body.system || '';
  const maxTok = Number(body.max_tokens) || 2048;
  let Models; try { Models = await models(); } catch (e) { res.writeHead(503); res.end('models module off'); return; }
  const cfg = Models._streamConfig && Models._streamConfig(String(body.providerId || ''));
  if (!cfg) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('provider not found'); return; }
  const model = body.model || cfg.models[0] || 'auto';
  const key = cfg.apiKey || '';
  const anthropic = cfg.anthropic;
  streamHead(res);
  const ctl = new AbortController(); let to = setTimeout(() => ctl.abort(), CHAT_TIMEOUT); req.on('close', () => ctl.abort());
  try {
    if (anthropic) {
      // tolerate a stored base that already ends in /v1 (e.g. https://api.anthropic.com/v1)
      let base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v\d+$/, '');
      const r = await fetch(base + '/v1/messages', {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: j({ model, max_tokens: maxTok, system, messages, stream: true }),
      });
      if (!r.ok || !r.body) { const t = await r.text().catch(() => ''); res.end('\x00ERR\x00' + r.status + ' ' + t.slice(0, 300)); clearTimeout(to); return; }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
        let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue; const p = line.slice(5).trim(); if (p === '[DONE]') continue;
          try { const ev = JSON.parse(p); if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') res.write(ev.delta.text); else if (ev.type === 'error') res.write('\x00ERR\x00' + (ev.error?.message || 'stream error')); } catch {} } }
      res.end();
    } else {
      // OpenAI-compatible (also Ollama/llama.cpp/vLLM local, and the MATRIX cluster)
      let base = (cfg.baseUrl || '').replace(/\/+$/, '');
      const url = /\/v\d+$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions';
      const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
      const headers = { 'content-type': 'application/json' };
      if (cfg.kind === 'api' && key) headers.Authorization = 'Bearer ' + key;
      const send = () => fetch(url, { method: 'POST', signal: ctl.signal, headers, body: j({ model, messages: msgs, stream: true, max_tokens: maxTok }) });
      let r;
      try { r = await send(); }
      catch (e) {
        // A MATRIX model stays in the pickers while its weights are on disk, so a
        // stopped engine is an expected state — not a reason to show the owner undici's
        // "fetch failed". Name what is wrong and what to press.
        if (cfg.provider !== 'matrix' || (e && e.name === 'AbortError')) throw e;
        let hint = '';
        try {
          const { Matrix } = await import('../../matrix.mjs');
          const s = await Matrix.status();
          hint = s.engineFound ? '' : ' (no engine binary at ' + s.enginePath + ')';
        } catch { /* the message below is still the useful part */ }
        res.end('\x00ERR\x00MATRIX did not answer on ' + base.replace(/\/v\d+$/, '') + ' — open MATRIX and press START ENGINE' + hint);
        clearTimeout(to); return;
      }
      // MATRIX cluster: on-disk model with no instance → 404. Launch it once, wait, retry.
      if (!r.ok && r.status === 404 && cfg.provider === 'matrix') {
        const t = await r.text().catch(() => '');
        if (/no instance/i.test(t) && await matrixEnsureInstance(base, model, ctl.signal)) {
          for (let i = 0; i < 40 && !ctl.signal.aborted; i++) {
            await new Promise((s) => setTimeout(s, 1500));
            try { await r.body?.cancel(); } catch { /* an unread body pins a socket for the whole retry loop */ }
            r = await send();
            if (r.ok || r.status !== 404) break;
          }
          if (r.ok) { clearTimeout(to); to = setTimeout(() => ctl.abort(), CHAT_TIMEOUT); } // fresh window for generation
        }
        // Frame the FINAL response, not the first 404: pairing the newest status with
        // the oldest body hid every real reason a launch failed.
        if (!r.ok) {
          const t2 = await r.text().catch(() => '');
          res.end('\x00ERR\x00' + r.status + ' ' + (t2 || t || '').slice(0, 300)); clearTimeout(to); return;
        }
      }
      if (!r.ok || !r.body) { const t = await r.text().catch(() => ''); res.end('\x00ERR\x00' + r.status + ' ' + t.slice(0, 300)); clearTimeout(to); return; }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
        let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue; const p = line.slice(5).trim(); if (p === '[DONE]') continue;
          try { const ev = JSON.parse(p); const d = ev.choices?.[0]?.delta?.content; if (d) res.write(d); } catch {} } }
      res.end();
    }
  } catch (e) { res.end('\x00ERR\x00' + (e.name === 'AbortError' ? 'timeout' : e.message)); }
  finally { clearTimeout(to); }
}

export const Chat = { handleChat, handleProviderChat, brain };
export default Chat;
