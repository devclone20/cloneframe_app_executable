// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — domains/mail/mail  (T-033)
//
// The /mod adapter for the email engine. email.mjs stays EXACTLY as it is: its
// throwing contract is relied on by the INTERNAL callers that dynamic-import it
// directly (scheduled / tasks / style / approvals / integrations). This adapter
// is the only thing registered on the generic /mod router (as `email`) — it
// replaces the hand-rolled /email/* shadow switch that used to live in
// hub-bridge.mjs, so email now flows through the same one token-gated RPC every
// other module uses.
//
// Read-path error contract (T-033): an operational READ failure — IMAP dropped,
// unknown account, missing folder — is a NORMAL outcome, not a server bug, so it
// comes back as {ok:false,error} at HTTP 200 instead of leaking as a 500. The
// renderer's Mail client re-throws {ok:false} for these reads, so every existing
// per-call try/catch is unchanged. Write/action methods (send / flag / move /
// account CRUD) pass through email.mjs UNTOUCHED — byte-identical to the old
// switch (a hard failure there still surfaces as before).
// ─────────────────────────────────────────────────────────────────────────────
import EmailImpl from '../../email.mjs';

// Read-path methods that degrade to {ok:false,error} instead of throwing.
const READ = new Set(['listAccounts', 'getAccount', 'folders', 'list', 'message', 'attachment', 'listDrafts', 'idleSince']);

// Lifecycle helpers that the old /email/* switch never exposed as a route — keep
// them OFF the RPC surface (internal callers reach them via email.mjs directly).
const OMIT = new Set(['closeAll']);

// email.mjs functions are standalone module functions (they close over module
// state, never use `this`), so calling them positionally is safe.
function soft(fn) {
  return async (...args) => {
    try { return await fn(...args); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  };
}

// Build the /mod surface: wrap reads, pass everything else through unchanged.
const Email = {};
for (const [name, member] of Object.entries(EmailImpl)) {
  if (OMIT.has(name)) continue;
  Email[name] = (typeof member === 'function' && READ.has(name)) ? soft(member) : member;
}

export { Email };
export default Email;
