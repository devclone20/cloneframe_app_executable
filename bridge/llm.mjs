// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — shared Claude helper (non-streaming)
// A tiny BYOK primitive for background modules (tasks, style). The key is read
// from the local environment / ~/.env.local and NEVER leaves this machine.
// ─────────────────────────────────────────────────────────────────────────────
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

export function loadKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  for (const f of [path.join(homedir(), '.env.local'), path.join(homedir(), '.env')]) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+)\s*$/m);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    } catch {}
  }
  return null;
}

export const DEFAULT_MODEL = process.env.HUB_BRIDGE_MODEL || 'claude-sonnet-5';

// ask(messages, {system, model, maxTokens, signal}) -> string
// messages: [{role:'user'|'assistant', content:string}]
// Throws on missing key or API error. Returns the assistant's text.
export async function ask(messages, opts = {}) {
  const key = loadKey();
  if (!key) throw new Error('no ANTHROPIC_API_KEY on this machine');
  const body = {
    model: opts.model || DEFAULT_MODEL,
    max_tokens: opts.maxTokens || 1024,
    messages: Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages) }],
  };
  if (opts.system) body.system = opts.system;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: opts.signal,
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('anthropic ' + r.status + (t ? ' ' + t.slice(0, 300) : ''));
  }
  const o = await r.json();
  return (o.content || []).filter(b => b.type === 'text').map(b => b.text).join('') || '';
}

export function hasBrain() { return !!loadKey(); }

export default { ask, loadKey, hasBrain, DEFAULT_MODEL };
