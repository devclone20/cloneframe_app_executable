// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — Electron preload (isolated bridge to the native shell)
//
// Exposes a tiny, explicit API to the app renderer under window.cfhubNative. The
// in-app browser (wireWebBrowser) detects this object; when present it drives real
// native WebContentsViews instead of <iframe>s, so full web apps + Google sign-in
// work. When absent (plain chrome --app / preview), the browser falls back to the
// iframe+proxy path unchanged — the app runs in both shells.
//
// contextIsolation is ON: the renderer never sees Node or ipcRenderer directly, only
// these narrow, validated methods.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const stateSubs = new Set();
const openSubs = new Set();
const toastSubs = new Set();
const authSubs = new Set();
const menuSubs = new Set();
ipcRenderer.on('cfhub:web:state', (_e, s) => stateSubs.forEach((fn) => { try { fn(s); } catch (_) {} }));
ipcRenderer.on('cfhub:web:openurl', (_e, o) => openSubs.forEach((fn) => { try { fn(o); } catch (_) {} }));
ipcRenderer.on('cfhub:web:toast', (_e, o) => toastSubs.forEach((fn) => { try { fn(o); } catch (_) {} }));
ipcRenderer.on('cfhub:web:authwall', (_e, o) => authSubs.forEach((fn) => { try { fn(o); } catch (_) {} }));
ipcRenderer.on('cfhub:menu', (_e, action) => menuSubs.forEach((fn) => { try { fn(String(action || '')); } catch (_) {} }));

contextBridge.exposeInMainWorld('cfhubNative', {
  platform: process.platform,
  // Native browser view control — one view per in-app browser tab, addressed by `id`.
  web: {
    create: (id) => ipcRenderer.invoke('cfhub:web:create', { id }),
    setBounds: (id, bounds, visible) => ipcRenderer.invoke('cfhub:web:setBounds', { id, bounds, visible }),
    navigate: (id, url) => ipcRenderer.invoke('cfhub:web:navigate', { id, url }),
    back: (id) => ipcRenderer.invoke('cfhub:web:act', { id, action: 'back' }),
    forward: (id) => ipcRenderer.invoke('cfhub:web:act', { id, action: 'forward' }),
    reload: (id) => ipcRenderer.invoke('cfhub:web:act', { id, action: 'reload' }),
    stop: (id) => ipcRenderer.invoke('cfhub:web:act', { id, action: 'stop' }),
    destroy: (id) => ipcRenderer.invoke('cfhub:web:destroy', { id }),
    onState: (fn) => { stateSubs.add(fn); return () => stateSubs.delete(fn); },
    onOpenUrl: (fn) => { openSubs.add(fn); return () => openSubs.delete(fn); },
    onToast: (fn) => { toastSubs.add(fn); return () => toastSubs.delete(fn); },
    onAuthWall: (fn) => { authSubs.add(fn); return () => authSubs.delete(fn); },
  },
  // native menu → renderer: the iT keyboard actions Chromium reserves come through here
  onMenu: (fn) => { menuSubs.add(fn); return () => menuSubs.delete(fn); },
  // system browser — Google sign-in only (the one flow Google blocks in every embedded browser)
  openExternal: (url) => ipcRenderer.invoke('cfhub:open-external', { url }),
});
