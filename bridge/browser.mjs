// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — browser
// In-app browser backend: search + reader view (via web.mjs), history, bookmarks,
// quick-links. So the user never leaves CLONE FRAME to search/read the web.
// ─────────────────────────────────────────────────────────────────────────────
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(homedir(), '.clone-frame-hub');
const FILE = path.join(DIR, 'browser.json');
function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { history: [], bookmarks: [] }; } }
function save(o) { try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); const t = FILE + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(o), { mode: 0o600 }); fs.renameSync(t, FILE); } catch {} }
let store = load();
const rid = () => Math.random().toString(36).slice(2, 10);

const QUICK = [
  { label: 'Google', url: 'https://www.google.com/search?q=', search: true },
  { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=', search: true },
  { label: 'GitHub', url: 'https://github.com' },
  { label: 'YouTube', url: 'https://youtube.com' },
  { label: 'X', url: 'https://x.com' },
  { label: 'Wikipedia', url: 'https://wikipedia.org' },
  { label: 'Gmail', url: 'https://mail.google.com' },
  { label: 'OKX', url: 'https://www.okx.com' },
  { label: 'Base', url: 'https://basescan.org' },
  { label: 'Virtuals', url: 'https://virtuals.io' },
];

async function web() { try { const m = await import('./web.mjs'); return m.Web || m.default; } catch { return null; } }

export const Browser = {
  async search(q, { limit = 8 } = {}) {
    const W = await web(); if (!W) return { ok: false, error: 'web module unavailable', results: [] };
    try { const r = await W.search(String(q || ''), { limit }); return r && r.ok ? r : { ok: false, error: (r && r.error) || 'no results', results: [] }; }
    catch (e) { return { ok: false, error: e.message, results: [] }; }
  },
  async open(url) {
    const W = await web(); if (!W) return { ok: false, error: 'web module unavailable' };
    try {
      const r = await W.fetchUrl(String(url || ''));
      if (r && r.ok) {
        store.history.unshift({ id: rid(), url: r.url || url, title: r.title || url, ts: Date.now() });
        if (store.history.length > 200) store.history.length = 200; save(store);
      }
      return r || { ok: false, error: 'falhou' };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  history({ limit = 30 } = {}) { return store.history.slice(0, limit); },
  clearHistory() { store.history = []; save(store); return { ok: true }; },
  bookmarks() { return store.bookmarks.slice(); },
  addBookmark({ url, title } = {}) {
    if (!url) return { ok: false, error: 'no url' };
    if (store.bookmarks.some(b => b.url === url)) return { ok: true, dup: true };
    const id = rid(); store.bookmarks.unshift({ id, url, title: title || url, ts: Date.now() }); save(store); return { ok: true, id };
  },
  removeBookmark(id) { store.bookmarks = store.bookmarks.filter(b => b.id !== id); save(store); return { ok: true }; },
  quickLinks() { return QUICK.slice(); },
  // fire-and-forget history write from the in-app browser (the proxy path sets the
  // iframe src directly, so History would otherwise stay empty)
  visit({ url, title } = {}) {
    if (!url || !/^https?:\/\//i.test(url)) return { ok: false };
    const h = store.history;
    if (h[0] && h[0].url === url) { if (title) h[0].title = title; save(store); return { ok: true }; }
    h.unshift({ id: rid(), url, title: title || url, ts: Date.now() });
    if (h.length > 200) h.length = 200; save(store);
    return { ok: true };
  },
};
export default Browser;
