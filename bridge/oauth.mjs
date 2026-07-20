// Gmail OAuth2 (loopback / installed-app flow) for the CLONE FRAME hub bridge.
//
// Why this exists: Google is retiring App Passwords for many accounts and
// treats "less secure" auth as deprecated. This module lets a user sign in
// with real Google OAuth (RFC 8252 loopback redirect — no fixed redirect URI,
// no client-side secret exposure beyond the user's own machine) and then send
// mail over SMTP with XOAUTH2.
//
// BYOK: the user brings their own Google OAuth *Desktop app* Client ID +
// Secret. Creds and tokens live in ~/.clone-frame-hub/oauth.json (dir 0700,
// file 0600). Secrets and tokens are NEVER logged and NEVER surfaced by
// status()/accounts().
//
// Dependencies: node built-ins (http, crypto, fs, os, global fetch) for the
// OAuth dance; nodemailer (already vendored in bridge/node_modules) for the
// XOAUTH2 SMTP transport only.
//
// Write-path (config/removeAccount/beginAuth/accessToken/sendMail) resolves to
// {ok, ...} and never throws. Read-path (status/accounts/pollAuth) returns
// directly. A corrupt store degrades to empty rather than throwing.

import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

// ── constants ────────────────────────────────────────────────────────────────
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

// https://mail.google.com/ is the full-access scope required for SMTP/IMAP
// XOAUTH2; openid + email give us the signed-in address via userinfo.
const SCOPES = ['https://mail.google.com/', 'openid', 'email'];

const AUTH_TIMEOUT_MS = 180_000;
const TOKEN_SKEW_MS = 60_000; // refresh a minute before real expiry

// ── persistence ──────────────────────────────────────────────────────────────
// Backed by the shared atomic JSON store: ~/.clone-frame-hub/oauth.json,
// dir 0700 / file 0600, tmp-write-then-rename, read-per-call, never logs. This
// file holds the BYOK clientSecret and per-account refresh/access tokens — the
// load/save projections below keep it to exactly {clientId, clientSecret,
// accounts} so no stray key is ever read or written (same as before the port).
const store = openStore({ name: 'oauth', version: 1, shape: { accounts: [] }, root: hubRoot() });

/** @returns {{clientId?:string, clientSecret?:string, accounts:Array<object>}} */
function loadStore() {
  const data = store.read(); // never throws; ENOENT/corrupt → {version, accounts:[]}
  return {
    clientId: typeof data.clientId === 'string' ? data.clientId : undefined,
    clientSecret: typeof data.clientSecret === 'string' ? data.clientSecret : undefined,
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
  };
}

function saveStore(s) {
  // Project to exactly the three known fields — never let a stray in-memory key
  // (or a hand-edited one) get persisted alongside the secrets.
  store.write({
    clientId: s.clientId,
    clientSecret: s.clientSecret,
    accounts: Array.isArray(s.accounts) ? s.accounts : [],
  });
}

// A non-reversible fingerprint of the client used to mint an account's tokens,
// so we can detect if the BYOK client changed under a stored refresh_token.
function clientFingerprint(clientId) {
  return createHash('sha256').update(String(clientId)).digest('hex').slice(0, 12);
}

// ── in-flight auth state ─────────────────────────────────────────────────────
// Only one loopback sign-in runs at a time. beginAuth() replaces any prior one.
let pending = null; // { state, server, timer, done, email?, error? }

function clearPending() {
  if (!pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  if (pending.server) { try { pending.server.close(); } catch { /* already closed */ } }
}

// ── OAuth HTTP helpers ───────────────────────────────────────────────────────
async function postToken(params) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new Error(`token endpoint: ${detail}`);
  }
  return data;
}

async function fetchUserEmail(accessToken) {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.email) throw new Error('userinfo: no email in response');
  return String(data.email).toLowerCase();
}

const CLOSE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>CLONE FRAME</title><style>
:root{color-scheme:dark}html,body{height:100%}body{margin:0;display:grid;place-items:center;
background:#0b0b0f;color:#e7e7ea;font:500 15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro",system-ui,sans-serif}
.card{text-align:center;padding:40px 48px;border:1px solid #1e1e26;border-radius:16px;background:#111117}
.dot{width:10px;height:10px;border-radius:50%;background:#34d399;display:inline-block;margin-right:8px;
box-shadow:0 0 12px #34d399}h1{font-size:17px;margin:0 0 6px;font-weight:600}
p{margin:0;color:#9a9aa5;font-size:13px}</style></head>
<body><div class="card"><h1><span class="dot"></span>Signed in</h1>
<p>You can close this window.</p></div></body></html>`;

function respondHtml(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Persist BYOK Google OAuth Desktop-app credentials.
 * @param {{clientId?:string, clientSecret?:string}} creds
 * @returns {{ok:boolean, error?:string}}
 */
function config({ clientId, clientSecret } = {}) {
  if (!clientId || typeof clientId !== 'string') return { ok: false, error: 'clientId is required' };
  if (!clientSecret || typeof clientSecret !== 'string') return { ok: false, error: 'clientSecret is required' };
  try {
    const store = loadStore();
    store.clientId = clientId.trim();
    store.clientSecret = clientSecret.trim();
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * @returns {{configured:boolean, accounts:string[]}} — never leaks secrets/tokens.
 */
function status() {
  const store = loadStore();
  return {
    configured: !!store.clientId,
    accounts: store.accounts.map((a) => a.email),
  };
}

/**
 * @returns {{email:string}[]}
 */
function accounts() {
  return loadStore().accounts.map((a) => ({ email: a.email }));
}

/**
 * @param {string} email
 * @returns {{ok:boolean}}
 */
function removeAccount(email) {
  try {
    const store = loadStore();
    const key = String(email || '').toLowerCase();
    store.accounts = store.accounts.filter((a) => a.email !== key);
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Start the loopback OAuth flow. Returns immediately with an authUrl for the
 * UI to open in the system browser; the temporary loopback server completes
 * the exchange out-of-band. Poll pollAuth() for the result.
 * @returns {Promise<{ok:boolean, authUrl?:string, error?:string}>}
 */
function beginAuth() {
  return new Promise((resolve) => {
    let store;
    try {
      store = loadStore();
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    if (!store.clientId || !store.clientSecret) {
      resolve({ ok: false, error: 'not configured — call config({clientId, clientSecret}) first' });
      return;
    }

    clearPending(); // supersede any prior in-flight sign-in

    const state = randomBytes(24).toString('base64url');
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') { respondHtml(res, 404, 'not found'); return; }
      // Ignore stray requests (favicon, refresh) that carry no auth params.
      if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
        res.writeHead(204); res.end(); return;
      }
      if (url.searchParams.get('state') !== state) {
        respondHtml(res, 400, 'state mismatch');
        return;
      }
      const err = url.searchParams.get('error');
      if (err) {
        pending.error = `authorization denied: ${err}`;
        pending.done = true;
        respondHtml(res, 400, 'Authorization denied. You can close this window.');
        clearPending();
        return;
      }

      try {
        const port = server.address().port;
        const redirectUri = `http://127.0.0.1:${port}/`;
        const tok = await postToken({
          code: url.searchParams.get('code'),
          client_id: store.clientId,
          client_secret: store.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        });
        const email = await fetchUserEmail(tok.access_token);

        const fresh = loadStore();
        const account = {
          email,
          refresh_token: tok.refresh_token,
          access_token: tok.access_token,
          expiry: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
          clientRef: clientFingerprint(store.clientId),
        };
        const idx = fresh.accounts.findIndex((a) => a.email === email);
        // Google only returns a refresh_token on the first consent; if we
        // re-auth and get none, keep the one we already hold.
        if (idx >= 0) {
          account.refresh_token = tok.refresh_token || fresh.accounts[idx].refresh_token;
          fresh.accounts[idx] = account;
        } else {
          fresh.accounts.push(account);
        }
        saveStore(fresh);

        pending.email = email;
        pending.done = true;
        respondHtml(res, 200, CLOSE_PAGE);
      } catch (e) {
        pending.error = e.message;
        pending.done = true;
        respondHtml(res, 500, 'Failed to complete authentication. You can close this window.');
      } finally {
        clearPending();
      }
    });

    server.on('error', (e) => {
      if (pending) { pending.error = e.message; pending.done = true; }
      clearPending();
      resolve({ ok: false, error: e.message });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/`;
      const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
        client_id: store.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state,
      }).toString()}`;

      const timer = setTimeout(() => {
        if (pending && !pending.done) {
          pending.error = 'sign-in timed out';
          pending.done = true;
        }
        clearPending();
      }, AUTH_TIMEOUT_MS);
      timer.unref?.();

      pending = { state, server, timer, done: false };
      resolve({ ok: true, authUrl });
    });
  });
}

/**
 * Non-blocking status of the in-flight sign-in started by beginAuth().
 * @returns {{done:boolean, email?:string, error?:string}}
 */
function pollAuth() {
  if (!pending) return { done: false };
  if (!pending.done) return { done: false };
  return {
    done: true,
    ...(pending.email ? { email: pending.email } : {}),
    ...(pending.error ? { error: pending.error } : {}),
  };
}

/**
 * Return a valid access token for the account, refreshing if expired.
 * @param {string} email
 * @returns {Promise<{ok:boolean, token?:string, error?:string}>}
 */
async function accessToken(email) {
  try {
    const store = loadStore();
    if (!store.clientId || !store.clientSecret) return { ok: false, error: 'not configured' };
    const key = String(email || '').toLowerCase();
    const acct = store.accounts.find((a) => a.email === key);
    if (!acct) return { ok: false, error: `unknown account: ${email}` };

    if (acct.access_token && acct.expiry && acct.expiry - TOKEN_SKEW_MS > Date.now()) {
      return { ok: true, token: acct.access_token };
    }
    if (!acct.refresh_token) return { ok: false, error: 'no refresh_token — sign in again' };

    const tok = await postToken({
      client_id: store.clientId,
      client_secret: store.clientSecret,
      refresh_token: acct.refresh_token,
      grant_type: 'refresh_token',
    });

    const fresh = loadStore();
    const idx = fresh.accounts.findIndex((a) => a.email === key);
    if (idx < 0) return { ok: false, error: `unknown account: ${email}` };
    fresh.accounts[idx].access_token = tok.access_token;
    fresh.accounts[idx].expiry = Date.now() + (Number(tok.expires_in) || 3600) * 1000;
    if (tok.refresh_token) fresh.accounts[idx].refresh_token = tok.refresh_token;
    saveStore(fresh);

    return { ok: true, token: tok.access_token };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Send mail via Gmail SMTP with XOAUTH2. Never throws.
 * @param {string} email — a signed-in gmail address (the authenticated sender)
 * @param {{to:string|string[], cc?:string|string[], bcc?:string|string[],
 *          subject?:string, text?:string, html?:string, inReplyTo?:string}} msg
 * @returns {Promise<{ok:boolean, messageId?:string, error?:string}>}
 */
async function sendMail(email, msg = {}) {
  try {
    const store = loadStore();
    if (!store.clientId || !store.clientSecret) return { ok: false, error: 'not configured' };
    const key = String(email || '').toLowerCase();
    const acct = store.accounts.find((a) => a.email === key);
    if (!acct) return { ok: false, error: `unknown account: ${email}` };
    if (!msg.to) return { ok: false, error: 'to is required' };

    const at = await accessToken(key);
    if (!at.ok) return { ok: false, error: at.error };

    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        type: 'OAuth2',
        user: key,
        clientId: store.clientId,
        clientSecret: store.clientSecret,
        refreshToken: acct.refresh_token,
        accessToken: at.token,
      },
    });

    const headers = msg.inReplyTo
      ? { 'In-Reply-To': msg.inReplyTo, References: msg.inReplyTo }
      : undefined;

    const info = await transport.sendMail({
      from: key,
      to: msg.to,
      ...(msg.cc ? { cc: msg.cc } : {}),
      ...(msg.bcc ? { bcc: msg.bcc } : {}),
      subject: msg.subject || '',
      ...(msg.text ? { text: msg.text } : {}),
      ...(msg.html ? { html: msg.html } : {}),
      ...(headers ? { headers } : {}),
    });

    return { ok: true, messageId: info.messageId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export const OAuth = {
  config,
  status,
  accounts,
  removeAccount,
  beginAuth,
  pollAuth,
  accessToken,
  sendMail,
};

export default OAuth;
