// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — the provider-agnostic MODEL port  (T-018)
//
// ONE place every model call routes through — interactive chat AND background
// helpers (tasks, style, compare, research, cookbook, brain). It dispatches to
// whatever provider the user configured:
//   • Anthropic         → POST <base>/v1/messages        (x-api-key, anthropic-version)
//   • OpenAI-compatible  → POST <base>/chat/completions   (Bearer; DeepSeek, Grox, xAI…)
//   • Local              → the same OpenAI-compatible wire (Ollama / vLLM / MATRIX cluster)
//
// INVARIANT — model-agnostic: NO path is Claude-locked, and there is NO hardcoded
// model id as a silent default. The model resolves from the user's config (the
// models.mjs registry), with a provider-NEUTRAL last-resort fallback (the first
// configured provider, or an env ANTHROPIC_API_KEY only if that is literally all
// there is). BYOK: keys are read from the registry / env and are NEVER logged and
// NEVER placed in an error string returned to a caller.
//
// Deep module: the wire dispatch + SSE parsing live behind ask()/stream(); the
// transport (fetch) and the registry are injected, so it is testable through its
// interface with an in-memory fake (see createFakeModelPort + tests/model-port.test.mjs).
// ─────────────────────────────────────────────────────────────────────────────

// Strip trailing slashes; for the Anthropic wire also strip a trailing /vN so a
// stored "https://api.anthropic.com/v1" doesn't become ".../v1/v1/messages".
function baseFor(rawBase, isAnthropic, fallback) {
  let b = (rawBase || fallback || '').replace(/\/+$/, '');
  if (isAnthropic) b = b.replace(/\/v\d+$/, '');
  return b;
}

// An error message that a caller may see must never carry the key. We only ever
// surface the provider label + HTTP status + a trimmed, key-free body.
function wireError(label, status, bodyText) {
  return new Error(`${label} ${status}${bodyText ? ' ' + String(bodyText).slice(0, 300) : ''}`);
}

// Parse one Anthropic SSE line → delta text (or '' / throws marker via onErr).
function anthropicDelta(ev) {
  if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') return ev.delta.text;
  return '';
}
// Parse one OpenAI-compatible SSE line → delta text.
function openaiDelta(ev) { return ev.choices?.[0]?.delta?.content || ''; }

async function readSse(body, onLine) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (p === '[DONE]') continue;
      let ev; try { ev = JSON.parse(p); } catch { continue; }
      onLine(ev);
    }
  }
}

/**
 * Build a model port over an injected registry + fetch.
 * @param {object} deps
 *   registry  — the models.mjs registry surface: _raw(id), getDefaults(), listProviders(), _isAnthropic(provider,baseUrl)
 *   fetchImpl — defaults to global fetch
 *   envAnthropicKey — () => string|null : the env ANTHROPIC_API_KEY fallback (BYOK, off disk)
 *   envProvider — () => {provider,baseUrl,apiKey,model}|null : a GENERIC env-configured
 *     provider (any OpenAI-compatible/local, or Anthropic-shaped), so the app works with
 *     ANY provider via env without a Settings entry. Preferred over the bare Anthropic key.
 */
export function createModelPort({ registry, fetchImpl = fetch, envAnthropicKey = () => null, envProvider = () => null } = {}) {
  const isAnthropic = (provider, baseUrl) =>
    (registry && registry._isAnthropic)
      ? !!registry._isAnthropic(provider, baseUrl)
      : (provider === 'anthropic' || /(^|\.)anthropic\.com/i.test(String(baseUrl || '')));

  // Resolve WHICH provider+model to use. Never invents a Claude default.
  // @returns {null | {providerId, provider, baseUrl, apiKey, kind, model, anthropic}}
  function resolveTarget({ providerId, model, capability } = {}) {
    let rec = null;
    if (providerId && registry?._raw) rec = registry._raw(String(providerId));
    if (!rec && capability && registry?.getDefaults) {
      const def = registry.getDefaults()[capability];
      if (def?.providerId && registry._raw) { rec = registry._raw(def.providerId); if (!model) model = def.model; }
    }
    if (!rec && registry?.listProviders) {
      const first = registry.listProviders().find((p) => p.enabled !== false && p.id) || registry.listProviders()[0];
      if (first && registry._raw) rec = registry._raw(first.id);
    }
    if (rec) {
      const anthropic = isAnthropic(rec.provider, rec.baseUrl);
      return {
        providerId: rec.id, provider: rec.provider, kind: rec.kind || 'api',
        baseUrl: rec.baseUrl || (anthropic ? 'https://api.anthropic.com' : ''),
        apiKey: rec.apiKey || '',
        model: model || (rec.models && rec.models[0]) || 'auto',
        anthropic,
      };
    }
    // Provider-NEUTRAL env fallback (only when no registry provider is configured):
    // a GENERIC env provider (DeepSeek / any OpenAI-compat / local) first, then a bare
    // env ANTHROPIC_API_KEY. This is what makes the app work with any provider via env.
    const ep = envProvider();
    if (ep && ep.apiKey) {
      const anthropic = isAnthropic(ep.provider, ep.baseUrl);
      return { providerId: null, provider: ep.provider || 'custom', kind: 'api',
        baseUrl: ep.baseUrl || (anthropic ? 'https://api.anthropic.com' : ''),
        apiKey: ep.apiKey, model: model || ep.model || 'auto', anthropic };
    }
    const envKey = envAnthropicKey();
    if (envKey) {
      return { providerId: null, provider: 'anthropic', kind: 'api',
        baseUrl: 'https://api.anthropic.com', apiKey: envKey, model: model || 'auto', anthropic: true };
    }
    return null;
  }

  function ready(opts) { return !!resolveTarget(opts); }

  function buildRequest(t, { system = '', messages, maxTokens = 1024, stream = false }) {
    if (t.anthropic) {
      const base = baseFor(t.baseUrl, true, 'https://api.anthropic.com');
      const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
      if (t.apiKey) headers['x-api-key'] = t.apiKey;
      const body = { model: t.model, max_tokens: maxTokens, messages };
      if (system) body.system = system;
      if (stream) body.stream = true;
      return { url: base + '/v1/messages', headers, body, label: 'anthropic' };
    }
    const base = baseFor(t.baseUrl, false, '');
    const url = /\/v\d+$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions';
    const headers = { 'content-type': 'application/json' };
    if (t.kind === 'api' && t.apiKey) headers.Authorization = 'Bearer ' + t.apiKey;
    const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const body = { model: t.model, messages: msgs, max_tokens: maxTokens };
    if (stream) body.stream = true;
    return { url, headers, body, label: t.provider || 'openai' };
  }

  // Non-streaming. Returns the assistant's text. Throws (key-free) on error.
  async function ask(messages, opts = {}) {
    const msgs = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages) }];
    const t = resolveTarget(opts);
    if (!t) throw new Error('no model configured — add a provider in Settings → Add Models');
    if (t.kind === 'api' && !t.apiKey) throw new Error(`no API key for provider "${t.provider}"`);
    const { url, headers, body, label } = buildRequest(t, { system: opts.system, messages: msgs, maxTokens: opts.maxTokens || 1024, stream: false });
    const r = await fetchImpl(url, { method: 'POST', signal: opts.signal, headers, body: JSON.stringify(body) });
    if (!r.ok) throw wireError(label, r.status, await r.text().catch(() => ''));
    const o = await r.json();
    if (t.anthropic) return (o.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') || '';
    return o.choices?.[0]?.message?.content || '';
  }

  // Streaming. Calls onText(delta) as chunks arrive; resolves with the full text on done.
  async function stream(messages, opts = {}) {
    const msgs = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages) }];
    const onText = typeof opts.onText === 'function' ? opts.onText : () => {};
    const t = resolveTarget(opts);
    if (!t) throw new Error('no model configured — add a provider in Settings → Add Models');
    if (t.kind === 'api' && !t.apiKey) throw new Error(`no API key for provider "${t.provider}"`);
    const { url, headers, body, label } = buildRequest(t, { system: opts.system, messages: msgs, maxTokens: opts.maxTokens || 2048, stream: true });
    const r = await fetchImpl(url, { method: 'POST', signal: opts.signal, headers, body: JSON.stringify(body) });
    if (!r.ok || !r.body) throw wireError(label, r.status, await r.text().catch(() => ''));
    let full = '';
    const pick = t.anthropic ? anthropicDelta : openaiDelta;
    await readSse(r.body, (ev) => {
      if (t.anthropic && ev.type === 'error') throw new Error(ev.error?.message || 'stream error');
      const d = pick(ev);
      if (d) { full += d; onText(d); }
    });
    return full;
  }

  return { ask, stream, ready, resolveTarget };
}

// A fully in-memory fake — no network, no registry. Domain tests use this to run offline.
// It echoes the last user message (optionally transformed by `reply`) through the same
// ask()/stream() interface, so a caller cannot tell it apart from the real port.
export function createFakeModelPort({ reply } = {}) {
  const render = (messages) => {
    const msgs = Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages) }];
    const last = [...msgs].reverse().find((m) => m.role === 'user');
    const text = last ? String(last.content) : '';
    return reply ? reply(text, msgs) : `echo: ${text}`;
  };
  return {
    ready: () => true,
    resolveTarget: () => ({ providerId: 'fake', provider: 'fake', kind: 'local', model: 'fake', anthropic: false }),
    async ask(messages) { return render(messages); },
    async stream(messages, opts = {}) {
      const out = render(messages);
      const onText = typeof opts.onText === 'function' ? opts.onText : () => {};
      for (const ch of out.match(/.{1,8}/gs) || []) onText(ch);
      return out;
    },
  };
}

// The default port, wired to the real registry + env key (lazy so importing this
// module has zero side effects and never forces the registry to load).
let _default = null;
export async function modelPort() {
  if (_default) return _default;
  const [{ Models }, { loadKey, loadEnvProvider }] = await Promise.all([import('../models.mjs'), import('../llm.mjs')]);
  _default = createModelPort({ registry: Models, envAnthropicKey: loadKey, envProvider: loadEnvProvider });
  return _default;
}

export default { createModelPort, createFakeModelPort, modelPort };
