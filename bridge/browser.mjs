// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — browser
// In-app browser backend: search + reader view (via web.mjs), history, bookmarks,
// quick-links. So the user never leaves CLONE FRAME to search/read the web.
// ─────────────────────────────────────────────────────────────────────────────
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

// Backed by the shared atomic JSON store: ~/.clone-frame-hub/browser.json,
// dir 0700 / file 0600, tmp-write-then-rename, read-per-call (no cached
// singleton, so a second bridge process or a hand-edited file is never stale).
// Every mutation below reads fresh, mutates, then saves in the same call.
const store = openStore({ name: 'browser', version: 1, shape: { history: [], bookmarks: [] }, root: hubRoot() });
const load = () => store.read();
// The old hand-rolled save() swallowed disk errors (catch {}) so a mutation
// always reported ok; the port throws, so keep that swallow at the call site.
const save = (o) => { try { store.write(o); } catch { /* best effort, matches pre-port behavior */ } };
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
        // Record the visit BEST-EFFORT: a history-store read/write failure must
        // never discard a page that was fetched successfully (the store now
        // re-throws a genuine EACCES rather than the old swallow-to-empty).
        try {
          const s = load();
          s.history.unshift({ id: rid(), url: r.url || url, title: r.title || url, ts: Date.now() });
          if (s.history.length > 200) s.history.length = 200; save(s);
        } catch { /* best-effort history; the fetched page still returns below */ }
      }
      return r || { ok: false, error: 'falhou' };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  history({ limit = 30 } = {}) { return load().history.slice(0, limit); },
  clearHistory() { const s = load(); s.history = []; save(s); return { ok: true }; },
  bookmarks() { return load().bookmarks.slice(); },
  addBookmark({ url, title } = {}) {
    if (!url) return { ok: false, error: 'no url' };
    const s = load();
    if (s.bookmarks.some(b => b.url === url)) return { ok: true, dup: true };
    const id = rid(); s.bookmarks.unshift({ id, url, title: title || url, ts: Date.now() }); save(s); return { ok: true, id };
  },
  removeBookmark(id) { const s = load(); s.bookmarks = s.bookmarks.filter(b => b.id !== id); save(s); return { ok: true }; },
  quickLinks() { return QUICK.slice(); },
  // fire-and-forget history write from the in-app browser (the proxy path sets the
  // iframe src directly, so History would otherwise stay empty)
  visit({ url, title } = {}) {
    if (!url || !/^https?:\/\//i.test(url)) return { ok: false };
    const s = load();
    const h = s.history;
    if (h[0] && h[0].url === url) { if (title) h[0].title = title; save(s); return { ok: true }; }
    h.unshift({ id: rid(), url, title: title || url, ts: Date.now() });
    if (h.length > 200) h.length = 200; save(s);
    return { ok: true };
  },
};
export default Browser;
