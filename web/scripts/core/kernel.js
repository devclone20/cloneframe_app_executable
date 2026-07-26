// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — web/core kernel   (L4 · T-040 / T-041 / T-046)
//
// The single source for the frontend's cross-panel primitives. Written as an ES module
// so node can unit-test it directly, and inlined into the single-file document by
// tools/build.mjs, which replaces
//     <script data-cfbuild-src="scripts/core/kernel.js"></script>
// with an esbuild IIFE bundle of this file. The IIFE traps top-level bindings, so the
// browser-exposure block at the bottom assigns each primitive onto window — the classic
// inline app script (which runs AFTER this one) then uses them as bare globals, exactly
// as it used the old in-file const helpers. Zero runtime deps (esbuild is build-time only).
// ─────────────────────────────────────────────────────────────────────────────

// ── HTML escaping (T-041) ────────────────────────────────────────────────────
// TWO escapers with sharp, documented contracts, replacing 13 inconsistent local copies
// (esc/esc2/esc3/escA/escAttr, whose char-sets silently differed per scope):
//   escHtml — TEXT-node context. Escapes & < > .
//   escAttr — ATTRIBUTE context, and safe in ANY context. Escapes & < > " ' , so a value
//             can never break out of a single- OR double-quoted attribute (this also closes
//             the single-quote gap the old escAttr documented). & is matched first so a
//             pre-escaped entity is never double-escaped into &amp;lt; .
// Both coerce null/undefined to '' (the union of the old helpers' behaviours).
export const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const escAttr = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Auto-scroll that respects the reader. stickBottom only snaps to the bottom when the
// user is ALREADY near it — so scrolling up during a streaming reply is never yanked
// back down (owner: "scroll barely works" — it was forced on every token). forceBottom
// always jumps (use on open / session switch / the user's own just-sent message).
export const stickBottom = (el, threshold = 90) => {
  if (el && el.scrollHeight - el.scrollTop - el.clientHeight < threshold) el.scrollTop = el.scrollHeight;
};
export const forceBottom = (el) => { if (el) el.scrollTop = el.scrollHeight; };

// friendlyErr(raw) → the human sentence inside a provider/API failure. Raw API bodies
// (JSON with error.message etc.) must never reach a chat bubble as-is — extract the
// message; fall back to the original string when it isn't JSON.
export const friendlyErr = (raw) => {
  const s = String(raw == null ? '' : raw).trim();
  const dig = (j) => j && (j.error && (j.error.message || j.error.type) || j.message || j.detail);
  try { const m = dig(JSON.parse(s)); if (m) return String(m); } catch { /* not pure JSON */ }
  const i = s.indexOf('{');
  let out = s;
  if (i >= 0) { try { const m = dig(JSON.parse(s.slice(i))); if (m) out = String(m); } catch { /* no embedded JSON */ } }
  // Provider vocabulary the owner never chose ("instance", model ids) → what to DO about it.
  if (/no (instance|endpoints?|provider).*found|model.*not found|unknown model/i.test(out))
    return out + ' — pick a working model in the ⌄ selector at the bottom of this panel.';
  return out;
};

// ── time (T-046) ─────────────────────────────────────────────────────────────
// relTime(ts) → compact "3m ago" relative label. Accepts a ms epoch, an ISO/date string,
// or a Date. Returns '' for missing/invalid/future input (the safe common core of the three
// private rel()/ago() copies it replaces). Scale: s · m · h · d · w · y (superset of the
// copies, which variously capped at d or w). Callers that previously fell back to an absolute
// timestamp for invalid/future input do `relTime(ts) || fmtTS(ts)` at the call site.
export const relTime = (ts) => {
  if (ts == null || ts === '') return '';
  const t = ts instanceof Date ? ts.getTime() : (typeof ts === 'number' ? ts : new Date(ts).getTime());
  const s = (Date.now() - t) / 1000;
  if (!isFinite(s) || s < 0) return '';
  if (s < 60) return (s | 0) + 's ago';
  if (s < 3600) return (s / 60 | 0) + 'm ago';
  if (s < 86400) return (s / 3600 | 0) + 'h ago';
  if (s < 604800) return (s / 86400 | 0) + 'd ago';
  if (s < 31536000) return (s / 604800 | 0) + 'w ago';
  return (s / 31536000 | 0) + 'y ago';
};

// ── network (T-046) ──────────────────────────────────────────────────────────
// fetchWithTimeout(url, opts, ms) → fetch that aborts after `ms`, while still honouring a
// caller-supplied opts.signal (either aborting cancels). ms falsy → a plain fetch (no timer).
// Single source for the hand-rolled `new AbortController()+setTimeout(abort)` fetch copies.
export const fetchWithTimeout = (url, opts = {}, ms = 0) => {
  if (!ms) return fetch(url, opts);
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  const outer = opts.signal;
  const onAbort = () => ctl.abort();
  if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener('abort', onAbort, { once: true }); }
  return fetch(url, { ...opts, signal: ctl.signal })
    .finally(() => { clearTimeout(to); if (outer) outer.removeEventListener('abort', onAbort); });
};

// ── persistence (T-046) ──────────────────────────────────────────────────────
// persisted(key, def) → a tiny typed localStorage cell: { get, set, clear }. JSON-encoded,
// fully try/catch-guarded (private-mode / quota / disabled storage all degrade to the default),
// replacing the per-panel `let st; try{st=JSON.parse(getItem(k))}…; const save=()=>setItem(k,…)`
// silos. get() returns `def` when the key is absent or unparseable; never throws.
export const persisted = (key, def) => ({
  get() { try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch (_) { return def; } },
  set(v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) {} },
  clear() { try { localStorage.removeItem(key); } catch (_) {} },
});

// ── panel-scoped event bus (T-040) ───────────────────────────────────────────
// makePanelBus(Bus) → panelBus(panelEl) whose .on(evt, fn) subscribes to the global Bus but
// (a) only invokes fn while panelEl is still in the document, and (b) is auto-unsubscribed the
// moment panelEl leaves the DOM — via one shared MutationObserver. This removes the ~27 manual
// `if(document.body.contains(p))` guards AND the handler leak they papered over (Bus had no off,
// so closed panels' handlers accumulated forever). Bus must expose on(evt,fn) and off(evt,fn).
// Dependency-injected (Bus, and document/MutationObserver from the global) so node can test it.
export const makePanelBus = (Bus) => {
  const tracked = new Map(); // panelEl -> [[evt, wrapped], …]
  let observer = null;
  const sweep = () => {
    for (const [p, subs] of tracked) {
      if (!document.body.contains(p)) {
        for (const [evt, w] of subs) Bus.off(evt, w);
        tracked.delete(p);
      }
    }
  };
  const ensureObserver = () => {
    if (observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    observer = new MutationObserver(sweep);
    observer.observe(document.body, { childList: true, subtree: true });
  };
  return (p) => {
    ensureObserver();
    return {
      on(evt, fn) {
        const w = (d) => { if (document.body.contains(p)) fn(d); };
        Bus.on(evt, w);
        const arr = tracked.get(p) || []; arr.push([evt, w]); tracked.set(p, arr);
        return this;
      },
    };
  };
};

// ── URL-scheme guards (T-071) ────────────────────────────────────────────────
// HTML-escaping stops an attribute breakout but does NOT stop a dangerous URL SCHEME: a
// javascript:/vbscript: or data:text/html value set as a frame src can run script (an iframe
// with sandbox="allow-scripts" executes a data:text/html document). These are strict ALLOWLISTS
// for attacker-supplied media URLs (NFT animation/image metadata) — return the URL only if its
// scheme is safe for the sink, else '' so the caller falls back to the still image / placeholder.
// Tab/CR/LF are stripped first because browsers ignore them inside a scheme (java\tscript: →
// javascript:), so they can't smuggle a scheme past the test; leading control/space is trimmed.
const cleanUrl = (u) => { let s = String(u == null ? '' : u).replace(/[\t\n\r]/g, '').trim();
  if (/^ipfs:\/\//i.test(s)) s = 'https://ipfs.io/ipfs/' + s.slice(7); return s; };
// Scheme check via the browser's OWN parser (adversarial-review recommendation): new URL()
// reproduces the exact whitespace/control-char stripping, case-folding and backslash handling a
// browser applies, then we read the RESOLVED protocol — so no regex edge case can smuggle a
// scheme past it. Relative / protocol-relative (//evil) inputs throw (no base) → rejected.
const isHttp = (s) => { try { const p = new URL(s); return p.protocol === 'http:' || p.protocol === 'https:'; } catch (_) { return false; } };
// safeMediaUrl — for a FRAME/EMBED src (iframe, model-viewer, video): http(s) only (ipfs
// rewritten). NO data: — a data: media URL has no file extension, so the renderer would route
// it to the sandboxed iframe where data:text/html executes. Returns the CLEANED ORIGINAL (not
// URL().href) so a signed/presigned query string is never re-encoded.
export const safeMediaUrl = (u) => { const s = cleanUrl(u); return isHttp(s) ? s : ''; };
// safeImageUrl — for an <img>/poster src (cannot execute script): additionally allows data:image/
// so genuine on-chain data-image NFTs keep rendering; still rejects data:text/html, javascript:, etc.
export const safeImageUrl = (u) => { const s = cleanUrl(u); return (isHttp(s) || /^data:image\//i.test(s)) ? s : ''; };

// ── drag gesture (T-045) ─────────────────────────────────────────────────────
// dragGesture(el, {threshold, onStart, onMove, onDrop, ghost, ghostOffset}) → teardown().
// One pointer-based "ghost-follow" drag, replacing the copied mousedown→create-ghost→
// follow-cursor→hit-test-drop implementations. Nothing happens until the pointer moves past
// `threshold` px (so a plain click never starts a drag). If `ghost` is given (an element or a
// factory), it is appended to <body>, positioned at the cursor + ghostOffset each move, and
// removed on drop — and it is removed BEFORE the drop hit-test so it can never intercept
// document.elementFromPoint. onDrop receives {x, y, target} (the element under the drop point).
// A pointerup that never crossed `threshold` is a click, not a drag: `onDrop` is skipped and
// `onTap` is called instead (so callers get FIT-tap→fit / tile-tap→open without a second click
// listener). Pointer events cover mouse and touch; listeners live on window so a drag that
// leaves `el` still tracks. onStart/onMove/onDrop/onTap are all optional.
export const dragGesture = (el, opts = {}) => {
  const { threshold = 4, onStart, onMove, onDrop, onTap, ghost, ghostOffset = [10, 10],
          preventDefault = false, stopPropagation = false } = opts;
  const down = (e) => {
    if (e.button != null && e.button !== 0) return;       // primary button / touch only
    if (preventDefault) e.preventDefault();
    if (stopPropagation) e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    let started = false, gEl = null;
    const move = (ev) => {
      const x = ev.clientX, y = ev.clientY;
      if (!started) {
        if (Math.hypot(x - sx, y - sy) < threshold) return;   // distance gate — a click never drags
        started = true;
        if (ghost) { gEl = typeof ghost === 'function' ? ghost() : ghost; if (gEl && !gEl.isConnected) document.body.appendChild(gEl); }
        if (onStart) onStart(ev, { x, y, startX: sx, startY: sy });
      }
      if (gEl) { gEl.style.left = (x + ghostOffset[0]) + 'px'; gEl.style.top = (y + ghostOffset[1]) + 'px'; }
      if (onMove) onMove(ev, { x, y, dx: x - sx, dy: y - sy, startX: sx, startY: sy });
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (gEl) gEl.remove();                                // remove ghost BEFORE the hit-test
      if (started) {
        if (onDrop) {
          const x = ev.clientX, y = ev.clientY;
          const target = (typeof document !== 'undefined' && document.elementFromPoint) ? document.elementFromPoint(x, y) : null;
          onDrop(ev, { x, y, target });
        }
      } else if (onTap) {
        onTap(ev);                                          // pointerup without crossing threshold = a tap/click
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  el.addEventListener('pointerdown', down);
  return () => el.removeEventListener('pointerdown', down);
};

// ── browser exposure ─────────────────────────────────────────────────────────
// In the built single-file document this module is an IIFE; publish the primitives as bare
// globals for the classic inline app script. (No-op under node import — exports are used there.)
if (typeof window !== 'undefined') {
  Object.assign(window, { escHtml, escAttr, stickBottom, forceBottom, friendlyErr, relTime, fetchWithTimeout, persisted, makePanelBus, dragGesture, safeMediaUrl, safeImageUrl });
}
