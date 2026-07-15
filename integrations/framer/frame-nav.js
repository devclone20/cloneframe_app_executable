// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — direct-iframe navigation shim  (MV3 content script, MAIN world)
//
// The HUB's in-app browser renders remote sites in a DIRECT cross-origin <iframe>
// sandboxed `allow-scripts allow-same-origin allow-forms` (NO allow-popups). Because
// it is cross-origin, the HUB parent cannot see the page's window.open / link clicks,
// so target="_blank" and window.open() links are dead. This script — the DIRECT-mode
// twin of bridge/proxy.mjs's injected CONTROLLER — runs INSIDE each framed page and
// re-routes those "new browsing context" navigations to the HUB via postMessage, using
// the exact contract the parent already speaks: {__cfhub:1,type:'navigate',url,newTab,gesture}.
//
// It runs in the MAIN world on purpose: a content script's ISOLATED world cannot
// override the *page's* window.open or observe the page's own dispatch — only a
// main-world script (like the server-injected proxy CONTROLLER) can. The activation
// guard below is read at document_start, before any page script runs, and keys off
// location.ancestorOrigins (browser-populated, not page-writable), so the shim only
// ever wakes up inside a frame whose TOP document is the local HUB.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  "use strict";

  // ── Activation guard ───────────────────────────────────────────────────────
  // Every condition must hold, or we stay completely dormant (do NOT touch the
  // user's normal browsing in this Chrome profile).
  try {
    // 1) Sub-frames only — never the top-level page.
    if (window.top === window.self) return;

    // 2) A real, non-opaque origin. Opaque ("null") means either the HUB's PROXY
    //    iframe (sandbox has no allow-same-origin → the proxy CONTROLLER already
    //    handles nav there) or a HUB-internal sandboxed frame (animations, etc.).
    //    Direct-mode tabs always carry allow-same-origin → a real http(s) origin.
    var myOrigin = null;
    try { myOrigin = self.origin; } catch (e) {}
    if (!myOrigin || myOrigin === "null") return;

    // 3) The TOP ancestor must be the local HUB. ancestorOrigins[last] === top
    //    document's origin; it is populated by the browser and cannot be forged by
    //    page script, and (being read in the isolated document_start window) is
    //    trustworthy. If it is missing we fail safe (stay off).
    var ao = null;
    try { ao = location.ancestorOrigins; } catch (e) {}
    if (!ao || !ao.length) return;
    var topOrigin = ao[ao.length - 1];
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(topOrigin)) return;

    // 4) Skip HUB-internal SAME-ORIGIN frames (would only spam the parent, which
    //    ignores non-tab sources anyway). Real browser tabs are cross-origin to
    //    the HUB; only the HUB's own embeds share its origin.
    if (myOrigin === topOrigin) return;
  } catch (e) { return; }

  // Idempotency: never install twice in one document.
  try { if (window.__cfFrameNav) return; window.__cfFrameNav = 1; } catch (e) { return; }

  // Depth-1 = this page IS a HUB browser tab's top document (its parent is the HUB).
  // Only depth-1 may post {__cfhub} to the HUB, because the parent identifies the tab
  // by `e.source === tab.fr.contentWindow`, which only equals the DIRECT child frame.
  var isTop1 = (window.parent === window.top);

  function abs(h) { try { return new URL(h, location.href).href; } catch (e) { return null; } }
  function ok(u) { return !!u && /^https?:/i.test(u); }

  // Emit a navigate intent toward the HUB. Depth-1 posts straight to the HUB
  // (window.top) so e.source matches the tab's iframe. Deeper (nested) frames relay
  // to their PARENT frame, whose own copy of this shim re-emits upward until the
  // depth-1 frame delivers it to the HUB — preserving the e.source invariant with
  // zero parent-side changes.
  function emit(url, newTab, gesture) {
    if (!ok(url)) return;
    var msg = isTop1
      ? { __cfhub: 1, type: "navigate", url: url, newTab: !!newTab, gesture: !!gesture }
      : { __cfnav: 1, url: url, newTab: !!newTab, gesture: !!gesture };
    try { (isTop1 ? window.top : window.parent).postMessage(msg, "*"); } catch (e) {}
  }

  // ── window.open → route to HUB (programmatic ⇒ same-tab per the parent's rule) ──
  try {
    var STUB = {
      closed: false, focus: function () {}, blur: function () {}, close: function () {},
      postMessage: function () {}, moveTo: function () {}, resizeTo: function () {},
      location: { href: "", replace: function () {}, assign: function () {} }, document: null
    };
    window.open = function (u) { emit(abs(u || ""), true, false); return STUB; };
  } catch (e) {}

  // ── Anchor interception (left-click + middle-click) ─────────────────────────
  function anchorNav(e, forceNew) {
    if (e.defaultPrevented) return;
    var a = e.target && e.target.closest ? e.target.closest("a[href],area[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#" ||
        /^(javascript|mailto|tel|sms|data|blob|about):/i.test(href)) return;

    var target = (a.getAttribute("target") || "").toLowerCase();
    var isGesture = forceNew || e.metaKey || e.ctrlKey;   // ⌘/Ctrl-click or middle-click
    var opensNewContext = target === "_blank";
    var leavesFrame = target === "_top" || target === "_parent";

    // CRITICAL — leave same-frame client routing alone. A plain left-click on a
    // default-target link is EITHER an SPA route (framework preventDefaults + does
    // history.pushState — must keep working for Next.js / virtuals.io) OR a genuine
    // same-frame full navigation (the sandbox allows a frame to navigate ITSELF, so
    // it just loads in place — not dead). We only take over navigations that would
    // open a NEW browsing context or navigate OUT of this frame, which is exactly
    // what dies under the no-popups sandbox.
    if (!isGesture && !opensNewContext && !leavesFrame) return;

    var u = abs(href);
    if (!ok(u)) return;
    e.preventDefault();
    // New tab ONLY on a real user gesture; a bare target="_blank"/_top goes same-tab
    // (newTab flag true but gesture false → parent opens it in place → no tab storm).
    emit(u, isGesture || opensNewContext || leavesFrame, isGesture);
  }
  document.addEventListener("click", function (e) { if (e.button === 0) anchorNav(e, false); }, true);
  document.addEventListener("auxclick", function (e) { if (e.button === 1) anchorNav(e, true); }, true);

  // ── form target=_blank/_top/_parent → route to HUB (same-frame submits run native) ──
  document.addEventListener("submit", function (e) {
    var f = e.target; if (!f || f.tagName !== "FORM") return;
    var target = (f.getAttribute("target") || "").toLowerCase();
    if (target !== "_blank" && target !== "_top" && target !== "_parent") return;
    var method = (f.getAttribute("method") || "get").toLowerCase();
    var action = abs(f.getAttribute("action") || location.href);
    if (!ok(action)) return;
    var newTab = target === "_blank";
    if (method === "get") {
      var qs = ""; try { qs = new URLSearchParams(new FormData(f)).toString(); } catch (_) { return; }
      var base = action.split("#")[0];
      e.preventDefault();
      emit(base + (base.indexOf("?") >= 0 ? "&" : "?") + qs, newTab, newTab);
      return;
    }
    // POST can't be replayed through the parent's GET /proxy pipe, but we must still
    // stop the frame self-navigating to a blank action; take the user to the action URL.
    e.preventDefault();
    emit(action.split("#")[0], newTab, newTab);
  }, true);

  // ── Relay from nested child frames (deep frames → up the tree → HUB) ─────────
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.__cfnav !== 1) return;
    // Accept ONLY from our own direct child frames (WindowProxy identity compare is
    // valid cross-origin) — never from window.parent/top or an unrelated window.
    var src = e.source, own = false;
    try {
      var frs = document.querySelectorAll("iframe,frame");
      for (var i = 0; i < frs.length; i++) {
        try { if (frs[i].contentWindow === src) { own = true; break; } } catch (_) {}
      }
    } catch (_) {}
    if (!own) return;
    var u = (typeof d.url === "string") ? d.url : "";
    if (!ok(u)) return;
    emit(u, !!d.newTab, !!d.gesture);
  }, false);

  // ── Address-bar truthfulness (depth-1 only) ─────────────────────────────────
  // Report the tab's REAL current URL + title. In direct mode the frame shows the
  // genuine same-origin page, so location.href is authoritative (a page can only
  // replaceState within its OWN origin — no cross-origin address spoof). This lets
  // native same-frame navigations keep the HUB address bar honest WITHOUT the parent
  // re-driving the frame. We deliberately do NOT hook history.pushState (that would
  // risk SPA routing); pushState-only route changes simply aren't surfaced.
  if (isTop1) {
    var report = function () {
      try {
        window.top.postMessage(
          { __cfhub: 1, type: "loaded", url: location.href, title: (document.title || "").slice(0, 300) },
          "*"
        );
      } catch (e) {}
    };
    if (document.readyState !== "loading") report();
    else document.addEventListener("DOMContentLoaded", report);
    window.addEventListener("load", report);
    window.addEventListener("popstate", report);
    window.addEventListener("hashchange", report);
  }
})();
