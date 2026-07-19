// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Email Engine
//
// A real IMAP/SMTP client for the HUB's Mail app. Runs locally, talks directly
// to the user's own mail provider (Gmail or any IMAP/SMTP host). No relay, no
// third-party inbox service — the credentials and the connection live only on
// this machine.
//
// Dependencies: imapflow (IMAP), nodemailer (SMTP + MIME composition),
// mailparser (MIME parsing). All three are real network/parsing libraries —
// this is not a mock.
// ─────────────────────────────────────────────────────────────────────────────
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { OAuth } from './oauth.mjs'; // Gmail accounts connected via OAuth (loopback) → XOAUTH2 IMAP/SMTP, no app password

// ── errors ───────────────────────────────────────────────────────────────────
// Thrown (not returned) from read-path functions — list/message/attachment/
// folders — where the caller is expected to try/catch. Write-path functions
// (add/remove/send/flag/move/drafts) always resolve to {ok, error?}.
export class EmailError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'EmailError';
    if (cause) this.cause = cause;
  }
}

// ── persistence ──────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(homedir(), '.clone-frame-hub');
const ACCOUNTS_FILE = path.join(CONFIG_DIR, 'accounts.json');

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort on shared/odd filesystems */ }
}

function loadStore() {
  ensureConfigDir();
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { accounts: Array.isArray(data.accounts) ? data.accounts : [] };
  } catch (e) {
    if (e.code === 'ENOENT') return { accounts: [] };
    throw new EmailError(`failed to read accounts store: ${e.message}`, e);
  }
}

function saveStore(store) {
  ensureConfigDir();
  const tmp = `${ACCOUNTS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, ACCOUNTS_FILE);
  try { fs.chmodSync(ACCOUNTS_FILE, 0o600); } catch { /* best effort */ }
}

// ── OAuth-backed Gmail accounts ──────────────────────────────────────────────
// A Gmail account connected through oauth.mjs (loopback OAuth — the ONLY way Google
// permits sign-in for a desktop app) surfaces here as a first-class read+send account
// authenticated with XOAUTH2, so the inbox works with NO app password. Its id is
// `oauth:<email>`; it is virtual (never written to accounts.json) and always reflects
// the live set of OAuth sign-ins.
function oauthAccountShape(email) {
  return {
    id: `oauth:${email}`, email, user: email, display: email,
    provider: 'gmail', authType: 'xoauth2',
    imapHost: 'imap.gmail.com', imapPort: 993, imapSecure: true,
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true,
    isDefault: false,
  };
}
function oauthAccountEmails() {
  try { return (OAuth.accounts() || []).map((a) => a.email).filter(Boolean); }
  catch { return []; }
}

function getAccountRaw(id) {
  if (typeof id === 'string' && id.startsWith('oauth:')) {
    const email = id.slice(6);
    return oauthAccountEmails().includes(email) ? oauthAccountShape(email) : null;
  }
  const store = loadStore();
  return store.accounts.find((a) => a.id === id) || null;
}

// Resolve the auth object for a connection: XOAUTH2 (fresh, auto-refreshed access
// token) for OAuth accounts, otherwise the stored password. Throws EmailError if an
// OAuth token can't be obtained (expired grant → user must sign in again).
async function resolveAuth(acct) {
  if (acct.authType === 'xoauth2') {
    const r = await OAuth.accessToken(acct.email);
    if (!r || !r.ok || !r.token) {
      throw new EmailError(`Gmail OAuth token unavailable for ${acct.email}: ${(r && r.error) || 'sign in again'}`);
    }
    return { user: acct.user || acct.email, accessToken: r.token };
  }
  return { user: acct.user || acct.email, pass: acct.pass };
}
// nodemailer spells XOAUTH2 auth as { type:'OAuth2', user, accessToken }; ImapFlow takes
// { user, accessToken } directly. This adapts a resolveAuth() result for SMTP.
function smtpAuthShape(auth) {
  return auth.accessToken ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken } : auth;
}

function publicSummary(acct) {
  return { id: acct.id, email: acct.email, display: acct.display || acct.email, isDefault: !!acct.isDefault };
}

function sanitizeAccount(acct) {
  if (!acct) return null;
  const { pass, ...rest } = acct; // eslint-disable-line no-unused-vars
  return rest;
}

// ── account config helpers ──────────────────────────────────────────────────
const REQUIRED_FIELDS = ['email', 'imapHost', 'imapPort', 'user', 'pass', 'smtpHost', 'smtpPort'];

function applyProviderDefaults(cfg) {
  const out = { ...cfg };
  if (out.provider === 'gmail') {
    out.imapHost = out.imapHost || 'imap.gmail.com';
    out.imapPort = out.imapPort ?? 993;
    out.imapSecure = out.imapSecure ?? true;
    out.smtpHost = out.smtpHost || 'smtp.gmail.com';
    out.smtpPort = out.smtpPort ?? 465;
    out.smtpSecure = out.smtpSecure ?? true;
    out.user = out.user || out.email;
  }
  return out;
}

function validateAccountShape(cfg) {
  const missing = REQUIRED_FIELDS.filter((k) => cfg[k] === undefined || cfg[k] === null || cfg[k] === '');
  if (missing.length) return `missing fields: ${missing.join(', ')}`;
  if (typeof cfg.email !== 'string' || !cfg.email.includes('@')) return 'invalid email';
  if (!Number.isFinite(Number(cfg.imapPort)) || !Number.isFinite(Number(cfg.smtpPort))) return 'invalid port';
  return null;
}

function isGmailAccount(acct) {
  return acct.provider === 'gmail' || /gmail\.com$/i.test(acct.imapHost || '');
}

// ── connection pool (one ImapFlow client per account, reconnected lazily) ──
const pool = new Map(); // accountId -> ImapFlow
const chains = new Map(); // accountId -> Promise (serializes ops per account)

// IMAP is a single stateful connection (one selected mailbox at a time), so all
// operations against the same account are queued through this chain. This is
// the correctness boundary — not a performance optimization.
function withAccountLock(accountId, task) {
  const prev = chains.get(accountId) || Promise.resolve();
  const result = prev.then(task, task);
  chains.set(accountId, result.then(() => {}, () => {}));
  return result;
}

function buildImapOptions(acct, auth) {
  return {
    host: acct.imapHost,
    port: Number(acct.imapPort),
    secure: acct.imapSecure !== false,
    auth, // { user, pass } or { user, accessToken } — ImapFlow uses XOAUTH2 when accessToken is set
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  };
}

async function getClient(accountId) {
  const existing = pool.get(accountId);
  if (existing && existing.usable) return existing;
  if (existing) {
    pool.delete(accountId);
    try { existing.close(); } catch { /* already gone */ }
  }
  const acct = getAccountRaw(accountId);
  if (!acct) throw new EmailError(`unknown account: ${accountId}`);
  const client = new ImapFlow(buildImapOptions(acct, await resolveAuth(acct)));
  client.on('error', () => { if (pool.get(accountId) === client) pool.delete(accountId); });
  client.on('close', () => { if (pool.get(accountId) === client) pool.delete(accountId); });
  try {
    await client.connect();
  } catch (e) {
    // XOAUTH2 rejected: almost always the consent didn't grant the Gmail (IMAP/SMTP)
    // scope `https://mail.google.com/` — Google issues a token with only email/openid
    // when that restricted scope isn't on the OAuth consent screen. Give an actionable
    // message instead of the raw "Invalid credentials".
    if (acct.authType === 'xoauth2' && (e.authenticationFailed || e.serverResponseCode === 'AUTHENTICATIONFAILED')) {
      throw new EmailError(
        `Gmail rejected the OAuth token for ${acct.email}: the sign-in didn't include Gmail (IMAP/SMTP) access. `
        + `In Google Cloud Console → OAuth consent screen add the scope "https://mail.google.com/" and add ${acct.email} as a Test user, `
        + `then reconnect and approve the Gmail permission (click through the "unverified app" notice).`,
        e,
      );
    }
    throw e;
  }
  pool.set(accountId, client);
  return client;
}

async function evictClient(accountId) {
  const client = pool.get(accountId);
  if (!client) return;
  pool.delete(accountId);
  try { await client.logout(); } catch { try { client.close(); } catch { /* noop */ } }
}

async function closeAll() {
  await Promise.all([...pool.keys()].map((id) => evictClient(id)));
}

// ── probes (used by testAccount / addAccount) ───────────────────────────────
async function probeImap(cfg) {
  const client = new ImapFlow({
    host: cfg.imapHost,
    port: Number(cfg.imapPort),
    secure: cfg.imapSecure !== false,
    auth: await resolveAuth(cfg),
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
  try {
    await client.connect();
    try { await client.logout(); } catch { try { client.close(); } catch { /* noop */ } }
    return { ok: true };
  } catch (e) {
    try { client.close(); } catch { /* noop */ }
    return { ok: false, error: e.message || String(e) };
  }
}

async function probeSmtp(cfg) {
  const transport = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: Number(cfg.smtpPort),
    secure: cfg.smtpSecure !== false,
    requireTLS: cfg.smtpSecure === false, // enforce STARTTLS upgrade, never fall back to plaintext
    auth: smtpAuthShape(await resolveAuth(cfg)),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
  try {
    await transport.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    transport.close();
  }
}

// ── mailbox / message helpers ───────────────────────────────────────────────
function addressOf(a) {
  return { name: (a && a.name) || '', address: (a && a.address) || '' };
}
function firstAddress(list) {
  return Array.isArray(list) && list.length ? addressOf(list[0]) : { name: '', address: '' };
}
function addrList(addrObj) {
  if (!addrObj) return [];
  const objs = Array.isArray(addrObj) ? addrObj : [addrObj];
  return objs.flatMap((o) => (o?.value || []).map((v) => ({ name: v.name || '', address: v.address || '' })));
}

function hasAttachments(node) {
  if (!node) return false;
  if ((node.disposition || '').toLowerCase() === 'attachment') return true;
  if (Array.isArray(node.childNodes)) return node.childNodes.some(hasAttachments);
  return false;
}

// Walks BODYSTRUCTURE to find the best inline preview part (plain text
// preferred, HTML as fallback) so list() can show a snippet without
// downloading the whole message for every row in a mailbox listing.
function findTextPart(node, path = '') {
  if (!node) return null;
  const type = String(node.type || '').toLowerCase();
  if (type !== 'multipart') {
    const part = path || '1';
    const subtype = String(node.subtype || '').toLowerCase();
    if (type === 'text' && subtype === 'plain') return { part, kind: 'plain' };
    if (type === 'text' && subtype === 'html') return { part, kind: 'html' };
    return null;
  }
  let htmlFallback = null;
  const children = node.childNodes || [];
  for (let i = 0; i < children.length; i++) {
    const childPath = path ? `${path}.${i + 1}` : `${i + 1}`;
    const found = findTextPart(children[i], childPath);
    if (found?.kind === 'plain') return found;
    if (found?.kind === 'html' && !htmlFallback) htmlFallback = found;
  }
  return htmlFallback;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function computeSnippet(client, uid, bodyStructure) {
  const tp = findTextPart(bodyStructure);
  if (!tp) return '';
  try {
    const { content } = await client.download(uid, tp.part, { uid: true, maxBytes: 4096 });
    if (!content) return '';
    let text = (await streamToBuffer(content)).toString('utf8');
    if (tp.kind === 'html') text = stripHtml(text);
    return text.replace(/\s+/g, ' ').trim().slice(0, 180);
  } catch {
    return ''; // snippet is best-effort — never fail a listing because of it
  }
}

function toSummary(msg, snippet) {
  const flags = msg.flags || new Set();
  return {
    uid: msg.uid,
    from: firstAddress(msg.envelope?.from),
    to: (msg.envelope?.to || []).map(addressOf),
    subject: msg.envelope?.subject || '(no subject)',
    date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
    snippet,
    unread: !flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: hasAttachments(msg.bodyStructure),
  };
}

async function buildSummaries(client, uidsPage) {
  const byUid = new Map();
  for await (const msg of client.fetch(uidsPage, { uid: true, flags: true, envelope: true, bodyStructure: true }, { uid: true })) {
    byUid.set(msg.uid, msg);
  }
  const out = [];
  for (const uid of uidsPage) {
    const msg = byUid.get(uid);
    if (!msg) continue;
    const snippet = await computeSnippet(client, uid, msg.bodyStructure);
    out.push(toSummary(msg, snippet));
  }
  return out;
}

async function listMessagesCore(client, { limit, offset, search }) {
  const q = search && search.trim() ? search.trim() : '';
  const query = q ? { or: [{ subject: q }, { from: q }, { body: q }] } : { all: true };
  const uids = (await client.search(query, { uid: true })) || [];
  if (!uids.length) return [];
  uids.sort((a, b) => b - a); // newest UID first
  const page = uids.slice(offset, offset + limit);
  if (!page.length) return [];
  return buildSummaries(client, page);
}

async function listFoldersRaw(client) {
  return client.list({ statusQuery: { messages: true, unseen: true } });
}

// Gmail (and most modern servers) send RFC 6154 SPECIAL-USE flags directly;
// this is only a fallback for servers/folder names that don't.
function guessSpecialUse(f) {
  if (f.specialUse) return f.specialUse;
  const p = f.path.toLowerCase();
  if (p === 'inbox') return '\\Inbox';
  if (p.includes('sent')) return '\\Sent';
  if (p.includes('trash') || p.includes('bin')) return '\\Trash';
  if (p.includes('spam') || p.includes('junk')) return '\\Junk';
  if (p.includes('draft')) return '\\Drafts';
  if (p.includes('all mail')) return '\\All';
  if (p.includes('important')) return '\\Important';
  if (p.includes('starred')) return '\\Flagged';
  return null;
}

async function resolveSpecialFolder(client, want) {
  const list = await listFoldersRaw(client);
  const bySpecial = list.find((f) => f.specialUse === want);
  if (bySpecial) return bySpecial.path;
  const pattern = { '\\Sent': /sent/i, '\\Drafts': /draft/i, '\\Trash': /trash|bin/i, '\\Junk': /spam|junk/i }[want];
  const byName = pattern ? list.find((f) => pattern.test(f.path)) : null;
  return byName ? byName.path : null;
}

// ── MIME composition (nodemailer's MailComposer — same engine used to build
// the message we send, so the SMTP copy and the Sent/Drafts copy are byte-
// identical, not two independent renders) ───────────────────────────────────
function buildMailOptions(acct, msg) {
  const opts = {
    from: acct.display ? { name: acct.display, address: acct.email } : acct.email,
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    subject: msg.subject || '',
    text: msg.text,
    html: msg.html,
  };
  if (msg.inReplyTo) opts.inReplyTo = msg.inReplyTo;
  if (msg.references) opts.references = msg.references;
  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    opts.attachments = msg.attachments.map((a) => ({
      filename: a.filename,
      content: a.contentBase64 ? Buffer.from(a.contentBase64, 'base64') : a.content,
      contentType: a.mimeType || a.contentType,
    }));
  }
  return opts;
}

function composeRaw(mailOptions) {
  return new Promise((resolve, reject) => {
    new MailComposer(mailOptions).compile().build((err, message) => {
      if (err) reject(err); else resolve(message);
    });
  });
}

function extractMessageId(rawBuffer) {
  const m = rawBuffer.toString('utf8').match(/^Message-ID:\s*(<[^>]+>)/im);
  return m ? m[1] : null;
}

function splitRecipients(...fields) {
  return fields
    .filter(Boolean)
    .flatMap((r) => (Array.isArray(r) ? r : String(r).split(',')))
    .map((r) => r.trim())
    .filter(Boolean);
}

async function appendRawToFolder(accountId, folder, raw, flags) {
  return withAccountLock(accountId, async () => {
    const client = await getClient(accountId);
    await client.append(folder, raw, flags);
  });
}

async function appendRawToSent(accountId, raw) {
  return withAccountLock(accountId, async () => {
    const client = await getClient(accountId);
    const folder = await resolveSpecialFolder(client, '\\Sent');
    if (!folder) return;
    await client.append(folder, raw, ['\\Seen']);
  });
}

// ── public API ───────────────────────────────────────────────────────────────

/** @returns {Promise<{id:string,email:string,display:string,isDefault:boolean}[]>} */
export async function listAccounts() {
  const own = loadStore().accounts;
  const oauthEmails = oauthAccountEmails();
  const oauthSet = new Set(oauthEmails);
  // OAuth (secure token, no password) SUPERSEDES a stored password account for the same
  // address — one row per email, and it uses XOAUTH2. The password record stays in the
  // store (untouched), so removing the OAuth connection restores it.
  const oauthRows = oauthEmails.map((email) => publicSummary(oauthAccountShape(email)));
  const ownRows = own.filter((a) => !oauthSet.has(a.email)).map(publicSummary);
  return [...oauthRows, ...ownRows];
}

/** @returns {Promise<object|null>} full config minus password, or null */
export async function getAccount(id) {
  return sanitizeAccount(getAccountRaw(id));
}

/** @returns {Promise<{ok:boolean, imap:boolean, smtp:boolean, error?:string}>} */
export async function testAccount(cfgIn) {
  const cfg = applyProviderDefaults(cfgIn || {});
  const shapeError = validateAccountShape(cfg);
  if (shapeError) return { ok: false, imap: false, smtp: false, error: shapeError };
  const [imapRes, smtpRes] = await Promise.all([probeImap(cfg), probeSmtp(cfg)]);
  const ok = imapRes.ok && smtpRes.ok;
  const error = ok ? undefined : [imapRes.error, smtpRes.error].filter(Boolean).join(' | ');
  return { ok, imap: imapRes.ok, smtp: smtpRes.ok, ...(error ? { error } : {}) };
}

/** @returns {Promise<{ok:boolean, id?:string, error?:string}>} */
export async function addAccount(cfgIn) {
  const cfg = applyProviderDefaults(cfgIn || {});
  const shapeError = validateAccountShape(cfg);
  if (shapeError) return { ok: false, error: shapeError };
  const test = await testAccount(cfg);
  if (!test.ok) return { ok: false, error: test.error || 'connection failed' };

  const store = loadStore();
  const id = randomUUID();
  const isFirst = store.accounts.length === 0;
  const record = {
    id,
    email: cfg.email,
    display: cfg.display || cfg.email,
    provider: cfg.provider || 'custom',
    imapHost: cfg.imapHost,
    imapPort: Number(cfg.imapPort),
    imapSecure: cfg.imapSecure !== false,
    user: cfg.user || cfg.email,
    pass: cfg.pass,
    smtpHost: cfg.smtpHost,
    smtpPort: Number(cfg.smtpPort),
    smtpSecure: cfg.smtpSecure !== false,
    isDefault: cfg.isDefault === true || isFirst,
  };
  if (record.isDefault) store.accounts.forEach((a) => { a.isDefault = false; });
  store.accounts.push(record);
  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true, id };
}

/** @returns {Promise<{ok:boolean, error?:string}>} */
export async function removeAccount(id) {
  const store = loadStore();
  const idx = store.accounts.findIndex((a) => a.id === id);
  if (idx === -1) return { ok: false, error: 'not found' };
  const wasDefault = store.accounts[idx].isDefault;
  store.accounts.splice(idx, 1);
  if (wasDefault && store.accounts.length) store.accounts[0].isDefault = true;
  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  await evictClient(id);
  chains.delete(id);
  return { ok: true };
}

/** @returns {Promise<{ok:boolean, error?:string}>} */
export async function setDefault(id) {
  const store = loadStore();
  const acct = store.accounts.find((a) => a.id === id);
  if (!acct) return { ok: false, error: 'not found' };
  store.accounts.forEach((a) => { a.isDefault = a.id === id; });
  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true };
}

/** @returns {Promise<{path:string,name:string,specialUse:string|null,unread:number,total:number}[]>} */
export async function folders(accountId) {
  return withAccountLock(accountId, async () => {
    const client = await getClient(accountId);
    const list = await listFoldersRaw(client);
    return list.map((f) => ({
      path: f.path,
      name: f.name,
      specialUse: guessSpecialUse(f),
      unread: f.status?.unseen ?? 0,
      total: f.status?.messages ?? 0,
    }));
  });
}

/**
 * @returns {Promise<Array<{uid:number, from:{name,address}, to:{name,address}[],
 *   subject:string, date:string|null, snippet:string, unread:boolean,
 *   flagged:boolean, answered:boolean, hasAttachments:boolean}>>}
 */
export async function list(accountId, folder, opts = {}) {
  if (!folder) throw new EmailError('folder is required');
  const { limit = 50, offset = 0, search = '' } = opts;
  return withAccountLock(accountId, async () => {
    const client = await getClient(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      return await listMessagesCore(client, { limit, offset, search });
    } finally {
      lock.release();
    }
  });
}

/**
 * @returns {Promise<{uid:number, headers:{from,to,cc,subject,date}, text:string,
 *   html:string|null, attachments:Array<{partId,filename,mimeType,size}>}>}
 */
export async function message(accountId, folder, uid) {
  if (!folder) throw new EmailError('folder is required');
  return withAccountLock(accountId, async () => {
    const client = await getClient(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      const { content } = await client.download(uid, undefined, { uid: true });
      if (!content) throw new EmailError(`message not found: uid ${uid} in ${folder}`);
      const raw = await streamToBuffer(content);
      const parsed = await simpleParser(raw, { skipHtmlToText: true });
      try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch { /* best-effort read receipt */ }

      const attachments = (parsed.attachments || []).map((a) => ({
        partId: a.partId,
        filename: a.filename || `attachment-${a.partId}`,
        mimeType: a.contentType,
        size: a.size ?? (a.content?.length || 0),
      }));

      return {
        uid,
        headers: {
          from: addrList(parsed.from),
          to: addrList(parsed.to),
          cc: addrList(parsed.cc),
          subject: parsed.subject || '',
          date: parsed.date ? parsed.date.toISOString() : null,
        },
        text: parsed.text || '',
        html: parsed.html || null,
        attachments,
      };
    } finally {
      lock.release();
    }
  });
}

/** @returns {Promise<{filename:string, mimeType:string, contentBase64:string}>} */
export async function attachment(accountId, folder, uid, partId) {
  if (!folder) throw new EmailError('folder is required');
  if (!partId) throw new EmailError('partId is required');
  return withAccountLock(accountId, async () => {
    const client = await getClient(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      const { meta, content } = await client.download(uid, partId, { uid: true });
      if (!content) throw new EmailError(`attachment part not found: uid ${uid} part ${partId}`);
      const buf = await streamToBuffer(content);
      return {
        filename: meta.filename || `attachment-${partId}`,
        mimeType: meta.contentType || 'application/octet-stream',
        contentBase64: buf.toString('base64'),
      };
    } finally {
      lock.release();
    }
  });
}

/** @returns {Promise<{ok:boolean, messageId?:string, error?:string}>} */
export async function send(accountId, msg = {}) {
  const acct = getAccountRaw(accountId);
  if (!acct) return { ok: false, error: 'unknown account' };

  let raw;
  try {
    raw = await composeRaw(buildMailOptions(acct, msg));
  } catch (e) {
    return { ok: false, error: `compose failed: ${e.message}` };
  }

  const recipients = splitRecipients(msg.to, msg.cc, msg.bcc);
  if (!recipients.length) return { ok: false, error: 'no recipients' };

  const transport = nodemailer.createTransport({
    host: acct.smtpHost,
    port: Number(acct.smtpPort),
    secure: acct.smtpSecure !== false,
    requireTLS: acct.smtpSecure === false,
    auth: smtpAuthShape(await resolveAuth(acct)),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  try {
    const info = await transport.sendMail({ envelope: { from: acct.email, to: recipients }, raw });
    const messageId = info.messageId || extractMessageId(raw);
    if (!isGmailAccount(acct)) {
      // Gmail auto-appends sent mail server-side; everyone else needs an explicit copy.
      appendRawToSent(accountId, raw).catch(() => {});
    }
    return { ok: true, messageId };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  } finally {
    transport.close();
  }
}

/** @returns {Promise<{ok:boolean, error?:string}>} */
export async function flag(accountId, folder, uid, opts = {}) {
  if (!folder) return { ok: false, error: 'folder is required' };
  return withAccountLock(accountId, async () => {
    const client = await getClient(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      const add = [];
      const remove = [];
      const map = { seen: '\\Seen', flagged: '\\Flagged', answered: '\\Answered', deleted: '\\Deleted' };
      for (const [key, imapFlag] of Object.entries(map)) {
        if (opts[key] === true) add.push(imapFlag);
        else if (opts[key] === false) remove.push(imapFlag);
      }
      if (add.length) await client.messageFlagsAdd(uid, add, { uid: true });
      if (remove.length) await client.messageFlagsRemove(uid, remove, { uid: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    } finally {
      lock.release();
    }
  });
}

/** @returns {Promise<{ok:boolean, error?:string}>} */
export async function move(accountId, folder, uid, targetFolder) {
  if (!folder || !targetFolder) return { ok: false, error: 'folder and targetFolder are required' };
  return withAccountLock(accountId, async () => {
    const client = await getClient(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageMove(uid, targetFolder, { uid: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    } finally {
      lock.release();
    }
  });
}

/** @returns {Promise<{ok:boolean, uid?:number, folder?:string, error?:string}>} */
export async function saveDraft(accountId, draft = {}) {
  const acct = getAccountRaw(accountId);
  if (!acct) return { ok: false, error: 'unknown account' };
  let raw;
  try {
    raw = await composeRaw(buildMailOptions(acct, draft));
  } catch (e) {
    return { ok: false, error: `compose failed: ${e.message}` };
  }
  return withAccountLock(accountId, async () => {
    const client = await getClient(accountId);
    const folder = (await resolveSpecialFolder(client, '\\Drafts')) || 'Drafts';
    try {
      const res = await client.append(folder, raw, ['\\Draft']);
      return { ok: true, uid: res?.uid ?? null, folder };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

/** @returns {Promise<Array>} same shape as list() */
export async function listDrafts(accountId, opts = {}) {
  const { limit = 100, offset = 0, search = '' } = opts;
  return withAccountLock(accountId, async () => {
    const client = await getClient(accountId);
    const folder = (await resolveSpecialFolder(client, '\\Drafts')) || 'Drafts';
    const lock = await client.getMailboxLock(folder);
    try {
      return await listMessagesCore(client, { limit, offset, search });
    } finally {
      lock.release();
    }
  });
}

/** @returns {Promise<{ok:boolean, error?:string}>} */
export async function deleteDraft(accountId, uid) {
  return withAccountLock(accountId, async () => {
    const client = await getClient(accountId);
    const folder = (await resolveSpecialFolder(client, '\\Drafts')) || 'Drafts';
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageDelete(uid, { uid: true }); // targeted UID EXPUNGE — permanent, no trash hop
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    } finally {
      lock.release();
    }
  });
}

/**
 * Polls for messages newer than `sinceUid` in `folder`. Not push (no IDLE) —
 * intended to be called on an interval by the caller. O(mailbox size) per
 * call via SEARCH ALL; fine for personal-scale polling, not for huge mailboxes.
 * @returns {Promise<Array>} same shape as list(), newest first
 */
export async function idleSince(accountId, folder, sinceUid) {
  if (!folder) throw new EmailError('folder is required');
  const threshold = Number(sinceUid) || 0;
  return withAccountLock(accountId, async () => {
    const client = await getClient(accountId);
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = (await client.search({ all: true }, { uid: true })) || [];
      const fresh = uids.filter((u) => u > threshold).sort((a, b) => b - a);
      if (!fresh.length) return [];
      return buildSummaries(client, fresh);
    } finally {
      lock.release();
    }
  });
}

/** Closes all pooled IMAP connections. Call on server shutdown. */
export { closeAll };

export const Email = {
  listAccounts,
  getAccount,
  testAccount,
  addAccount,
  removeAccount,
  setDefault,
  folders,
  list,
  message,
  attachment,
  send,
  flag,
  move,
  saveDraft,
  listDrafts,
  deleteDraft,
  idleSince,
  closeAll,
};

export default Email;
