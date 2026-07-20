// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — platform/hub-root
//
// The single source of truth for the app's data directory. Replaces the ~19
// verbatim `path.join(homedir(), '.clone-frame-hub')` copies scattered across
// the domain modules (admin, calendar, notes, oauth, scheduled, …). Every store
// resolves its directory through here so there is exactly one place that decides
// where the HUB keeps its state.
//
// Production behavior is UNCHANGED: with `CLONE_FRAME_HUB_ROOT` unset, hubRoot()
// returns `~/.clone-frame-hub`, byte-for-byte the same path every module used
// before. The env override exists for one reason — to point the whole data tree
// at a throwaway directory in tests, so a context test can exercise a real store
// on real fs without touching the developer's live `~/.clone-frame-hub`. It sits
// in the same trust tier as the env vars the bridge already honors
// (HUB_BRIDGE_PORT, HUB_BRIDGE_MODEL, HOME): a process that can set the bridge's
// environment can already do far more than redirect its data root.
//
// Zero deps. Node built-ins only.
// ─────────────────────────────────────────────────────────────────────────────
import path from 'node:path';
import { homedir } from 'node:os';

// Resolved lazily on every call (not frozen at import) so a test can set
// CLONE_FRAME_HUB_ROOT, then dynamic-import a domain module, and have that
// module's module-level `openStore({ root: hubRoot() })` see the override.
export function hubRoot() {
  const override = process.env.CLONE_FRAME_HUB_ROOT;
  return override && override.trim() ? override : path.join(homedir(), '.clone-frame-hub');
}

// Convenience: a path INSIDE the hub root (e.g. hubPath('gallery') for a blob
// subdirectory, or hubPath('config', 'acp') for a nested config space). With no
// segments it is exactly hubRoot().
export function hubPath(...segments) {
  return segments.length ? path.join(hubRoot(), ...segments) : hubRoot();
}

export const HubRoot = { hubRoot, hubPath };
export default HubRoot;
