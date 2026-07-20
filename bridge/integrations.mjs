// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Integrations Registry
//
// "All external service connections in one place." Aggregates the user's
// connectors — email accounts (reflected read-only from email.mjs), MCP tool
// servers, API services, and CalDAV/CardDAV endpoints — with a status and a
// live test() per integration.
//
// Dependencies: Node built-ins only. Live handshakes use the global `fetch`
// (undici, built into Node). email.mjs is lazy dynamic-imported inside list()/
// get() so a load-order issue in that module never breaks importing this one,
// and so this module never pulls in imapflow/nodemailer just to render a list.
//
// Security: secrets (password, apiKey, token, pass, and authHeader.value) live
// only in the on-disk store (0600, in a 0700 dir). Every value handed back to
// a caller — list(), get(), add(), update() — is a sanitized Integration with
// a `meta` summary instead of raw config. The only place the full config with
// secrets is read back into memory is the module-private getConfigRecord(),
// used exclusively by test() to perform the live handshake.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';
import { davFetch } from './platform/dav.mjs';

// ── persistence ──────────────────────────────────────────────────────────────
// Backed by the shared atomic JSON store: ~/.clone-frame-hub/integrations.json,
// dir 0700 / file 0600, tmp-write-then-rename, read-per-call. Each integration
// record's config holds live secrets (password/apiKey/token/pass/secret and
// authHeader.value); those are stripped on the way out to every caller by
// toIntegration()/buildMeta()/hasAuthConfigured() below (unchanged). The
// load/save projections keep the on-disk container to exactly {integrations:[]}.
const store = openStore({ name: 'integrations', version: 1, shape: { integrations: [] }, root: hubRoot() });

const TYPES = new Set(['mcp', 'api', 'caldav', 'carddav', 'contacts_import']);
const STATUSES = new Set(['connected', 'pending', 'error', 'configured', 'disabled']);
const HANDSHAKE_TIMEOUT_MS = 8_000;

function loadStore() {
  const data = store.read(); // never throws; ENOENT/corrupt → {version, integrations:[]}
  return { integrations: Array.isArray(data.integrations) ? data.integrations : [] };
}

function saveStore(s) {
  // Project to exactly the known container — a corrupt store already degrades to
  // {integrations:[]} on read, and no stray top-level key is ever persisted.
  store.write({ integrations: Array.isArray(s.integrations) ? s.integrations : [] });
}

// Internal only — never exported, never part of the `Integrations` object.
// Returns the raw on-disk record (secrets included). Used solely by test().
function getConfigRecord(id) {
  return loadStore().integrations.find((r) => r.id === id) || null;
}

// ── sanitization / meta ──────────────────────────────────────────────────────
const SECRET_KEYS = new Set(['password', 'apiKey', 'token', 'pass', 'secret']);

function hostOf(urlStr) {
  if (!urlStr) return null;
  try { return new URL(urlStr).host; } catch { return null; }
}

function hasAuthConfigured(config) {
  if (!config) return false;
  if (config.username) return true;
  for (const k of SECRET_KEYS) if (config[k]) return true;
  if (config.authHeader && config.authHeader.value) return true;
  return false;
}

// Builds the non-secret summary shown to callers in place of raw config.
function buildMeta(type, config = {}) {
  switch (type) {
    case 'mcp': {
      const isStdio = config.transport === 'stdio';
      return {
        transport: config.transport || null,
        url: isStdio ? null : (config.url || null),
        command: isStdio ? (config.command || null) : null,
        host: isStdio ? null : hostOf(config.url),
        hasAuth: hasAuthConfigured(config),
      };
    }
    case 'api':
      return {
        baseUrl: config.baseUrl || null,
        host: hostOf(config.baseUrl),
        method: (config.method || 'GET').toUpperCase(),
        hasAuth: hasAuthConfigured(config),
      };
    case 'caldav':
    case 'carddav':
      return {
        url: config.url || null,
        host: hostOf(config.url),
        username: config.username || null,
        hasAuth: hasAuthConfigured(config),
      };
    case 'contacts_import':
      return {
        source: config.source || 'file',
        path: config.path || null,
        hasAuth: false,
      };
    default:
      return {};
  }
}

function toIntegration(record) {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    status: record.status,
    isDefault: !!record.isDefault,
    readOnly: false,
    meta: buildMeta(record.type, record.config),
    lastError: record.lastError || null,
    lastCheckedAt: record.lastCheckedAt || null,
    createdAt: record.createdAt,
  };
}

// ── config shape validation (per type) ──────────────────────────────────────
function validateConfigShape(type, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'config is required';
  switch (type) {
    case 'mcp': {
      if (!['http', 'ws', 'stdio'].includes(config.transport)) {
        return "mcp requires config.transport: 'http' | 'ws' | 'stdio'";
      }
      if (config.transport !== 'stdio' && !config.url) return 'mcp http/ws transport requires config.url';
      if (config.transport === 'stdio' && !config.command) return 'mcp stdio transport requires config.command';
      return null;
    }
    case 'api':
      if (!config.baseUrl) return 'api requires config.baseUrl';
      if (!isValidUrl(config.baseUrl)) return 'api config.baseUrl must be a valid URL';
      return null;
    case 'caldav':
    case 'carddav':
      if (!config.url) return `${type} requires config.url`;
      if (!isValidUrl(config.url)) return `${type} config.url must be a valid URL`;
      return null;
    case 'contacts_import':
      if (config.source !== undefined && typeof config.source !== 'string') {
        return 'contacts_import config.source must be a string';
      }
      return null;
    default:
      return `unknown type: ${type}`;
  }
}

function isValidUrl(value) {
  try { new URL(value); return true; } catch { return false; }
}

// ── live handshakes ──────────────────────────────────────────────────────────
function buildAuthHeaders(config) {
  const headers = {};
  if (config.authHeader && config.authHeader.name && config.authHeader.value) {
    headers[config.authHeader.name] = config.authHeader.value;
  } else if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function describeFetchError(e) {
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timed out';
  const cause = e.cause;
  if (cause?.code) return `${cause.code}: ${cause.message || e.message}`;
  return e.message || String(e);
}

// Any HTTP response — including 401/403/404/405 — means the endpoint is
// reachable and answering. Only a network-level failure (DNS, refused,
// timeout) counts as unreachable.
async function testApi(config) {
  const method = config.method && config.method.toUpperCase() === 'HEAD' ? 'HEAD' : 'GET';
  try {
    await fetch(config.baseUrl, {
      method,
      headers: buildAuthHeaders(config),
      redirect: 'follow',
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    });
    return { ok: true, status: 'connected' };
  } catch (e) {
    return { ok: false, status: 'error', error: describeFetchError(e) };
  }
}

function toHttpEquivalent(wsUrl) {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    return u.toString();
  } catch {
    return null;
  }
}

function commandExists(command) {
  if (!command || typeof command !== 'string') return false;
  if (command.includes('/')) {
    try { return fs.statSync(command).isFile(); } catch { return false; }
  }
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return pathDirs.some((dir) => {
    try { return fs.statSync(path.join(dir, command)).isFile(); } catch { return false; }
  });
}

async function testMcp(config) {
  if (config.transport === 'stdio') {
    // Can't spawn a child process from a status check — only confirm the
    // binary is resolvable on PATH (or as an absolute/relative path).
    return commandExists(config.command)
      ? { ok: true, status: 'configured' }
      : { ok: false, status: 'error', error: `command not found: ${config.command}` };
  }

  const url = config.transport === 'ws' ? toHttpEquivalent(config.url) : config.url;
  if (!url) return { ok: false, status: 'error', error: 'invalid or missing url' };

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...buildAuthHeaders(config) },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'clone-frame-hub', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS),
    });
    return { ok: true, status: 'connected' };
  } catch (e) {
    return { ok: false, status: 'error', error: describeFetchError(e) };
  }
}

async function testDav(config) {
  // Transport via the shared davFetch (platform/dav.mjs): same PROPFIND, Depth:0,
  // redirect-follow, 8s-timeout request the local fork hand-rolled. The Basic-auth
  // header is still built inline rather than via the port's authHeader() — the port
  // coerces a nullish pass to '' (`creds.pass || ''`), which would change the wire
  // value for a non-string caldav password; this keeps the request byte-identical.
  const headers = { 'content-type': 'application/xml; charset=utf-8' };
  if (config.username && config.password !== undefined) {
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
  }
  try {
    await davFetch({
      url: config.url,
      method: 'PROPFIND',
      depth: 0,
      headers,
      body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
      timeout: HANDSHAKE_TIMEOUT_MS,
    });
    return { ok: true, status: 'connected' };
  } catch (e) {
    return { ok: false, status: 'error', error: describeFetchError(e) };
  }
}

function testContactsImport(config) {
  if (!config.path) return { ok: true, status: 'configured' };
  const exists = fs.existsSync(config.path);
  return exists
    ? { ok: true, status: 'configured' }
    : { ok: false, status: 'error', error: `path not found: ${config.path}` };
}

async function runHandshake(record) {
  switch (record.type) {
    case 'api': return testApi(record.config);
    case 'mcp': return testMcp(record.config);
    case 'caldav': case 'carddav': return testDav(record.config);
    case 'contacts_import': return testContactsImport(record.config);
    default: return { ok: false, status: 'error', error: `unknown type: ${record.type}` };
  }
}

// ── email reflection (read-only) ────────────────────────────────────────────
async function listEmailIntegrations() {
  let Email;
  try {
    ({ Email } = await import('./email.mjs'));
  } catch {
    return []; // email.mjs unavailable — reflect nothing rather than crash the registry
  }
  let accounts;
  try {
    accounts = await Email.listAccounts();
  } catch {
    return [];
  }
  return (accounts || []).map((acct) => ({
    id: `email:${acct.id}`,
    type: 'email',
    name: acct.email,
    status: 'connected',
    isDefault: !!acct.isDefault,
    readOnly: true,
    meta: { email: acct.email, display: acct.display || acct.email },
    lastError: null,
    lastCheckedAt: null,
    createdAt: null,
  }));
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * @returns {Promise<object[]>} custom integrations (newest first) followed by
 *   the email-account group reflected read-only from email.mjs.
 */
export async function list() {
  const store = loadStore();
  const customs = [...store.integrations]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toIntegration);
  const emails = await listEmailIntegrations();
  return [...customs, ...emails];
}

/** @returns {Promise<object|null>} */
export async function get(id) {
  if (!id) return null;
  if (id.startsWith('email:')) {
    const emails = await listEmailIntegrations();
    return emails.find((e) => e.id === id) || null;
  }
  const record = getConfigRecord(id);
  return record ? toIntegration(record) : null;
}

/** @returns {Promise<{ok:boolean, id?:string, error?:string}>} */
export async function add({ type, name, config } = {}) {
  if (!TYPES.has(type)) return { ok: false, error: `type must be one of: ${[...TYPES].join(', ')}` };
  if (!name || typeof name !== 'string' || !name.trim()) return { ok: false, error: 'name is required' };
  const shapeError = validateConfigShape(type, config);
  if (shapeError) return { ok: false, error: shapeError };

  const store = loadStore();
  const isFirstOfType = !store.integrations.some((r) => r.type === type);
  const record = {
    id: randomUUID(),
    type,
    name: name.trim(),
    config: { ...config },
    status: 'pending',
    isDefault: isFirstOfType,
    lastError: null,
    lastCheckedAt: null,
    createdAt: Date.now(),
  };
  store.integrations.push(record);
  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true, id: record.id };
}

/** @returns {Promise<{ok:boolean, error?:string}>} */
export async function update(id, patch = {}) {
  if (!id) return { ok: false, error: 'id is required' };
  if (id.startsWith('email:')) return { ok: false, error: 'email integrations are read-only here — manage via email.mjs' };
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'patch is required' };

  const store = loadStore();
  const record = store.integrations.find((r) => r.id === id);
  if (!record) return { ok: false, error: 'not found' };

  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) return { ok: false, error: 'name must be a non-empty string' };
    record.name = patch.name.trim();
  }
  if (patch.config !== undefined) {
    if (typeof patch.config !== 'object' || patch.config === null || Array.isArray(patch.config)) {
      return { ok: false, error: 'config must be an object' };
    }
    const merged = { ...record.config, ...patch.config };
    const shapeError = validateConfigShape(record.type, merged);
    if (shapeError) return { ok: false, error: shapeError };
    record.config = merged;
    record.status = 'pending'; // config changed — the last test result is stale
    record.lastError = null;
  }
  if (patch.status !== undefined) {
    if (!STATUSES.has(patch.status)) return { ok: false, error: `status must be one of: ${[...STATUSES].join(', ')}` };
    record.status = patch.status;
  }

  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true };
}

/** @returns {Promise<{ok:boolean, error?:string}>} */
export async function remove(id) {
  if (!id) return { ok: false, error: 'id is required' };
  if (id.startsWith('email:')) return { ok: false, error: 'email accounts are managed by email.mjs (read-only here)' };

  const store = loadStore();
  const idx = store.integrations.findIndex((r) => r.id === id);
  if (idx === -1) return { ok: false, error: 'not found' };
  const removed = store.integrations[idx];
  store.integrations.splice(idx, 1);
  if (removed.isDefault) {
    const next = store.integrations.find((r) => r.type === removed.type);
    if (next) next.isDefault = true;
  }
  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true };
}

/**
 * Performs the live handshake for `id` and persists the resulting status.
 * Never throws.
 * @returns {Promise<{ok:boolean, status:string, error?:string}>}
 */
export async function test(id) {
  if (!id) return { ok: false, status: 'error', error: 'id is required' };
  if (id.startsWith('email:')) {
    return { ok: false, status: 'error', error: 'email integrations are tested via email.mjs (read-only here)' };
  }

  const store = loadStore();
  const record = store.integrations.find((r) => r.id === id);
  if (!record) return { ok: false, status: 'error', error: 'not found' };

  let result;
  try {
    result = await runHandshake(record);
  } catch (e) {
    result = { ok: false, status: 'error', error: e.message || String(e) };
  }

  record.status = result.status;
  record.lastError = result.ok ? null : (result.error || 'unknown error');
  record.lastCheckedAt = Date.now();
  try { saveStore(store); } catch { /* the test result is still returned even if persisting it fails */ }

  return { ok: result.ok, status: result.status, ...(result.error ? { error: result.error } : {}) };
}

/** @returns {Promise<{ok:boolean, error?:string}>} default is scoped within `type` */
export async function setDefault(id) {
  if (!id) return { ok: false, error: 'id is required' };
  if (id.startsWith('email:')) return { ok: false, error: 'email default is managed via email.mjs (read-only here)' };

  const store = loadStore();
  const record = store.integrations.find((r) => r.id === id);
  if (!record) return { ok: false, error: 'not found' };
  store.integrations.forEach((r) => { if (r.type === record.type) r.isDefault = (r.id === id); });
  try {
    saveStore(store);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  return { ok: true };
}

export const Integrations = { list, get, add, update, remove, test, setDefault };
export default Integrations;
