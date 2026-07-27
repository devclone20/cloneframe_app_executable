// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — Tasks / Cron engine (zero-dep, Node built-ins only)
//
// A small, robust in-process scheduler + task store. Lives beside the hub
// bridge and runs inside the same local Node process. No external deps; the LLM
// helper (./llm.mjs) is a static import, while ./email.mjs and ./approvals.mjs
// are LAZY dynamic-imported inside run handlers so a missing/half-built sibling
// can never break module load or the scheduler tick.
//
// Public surface: `Tasks` object + named exports. See TASKS.md.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ask } from './llm.mjs';
import { openStore } from './platform/json-store.mjs';
import { hubRoot } from './platform/hub-root.mjs';

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = hubRoot();
const SESSIONS_DIR = path.join(ROOT, 'task-sessions');
const RUNS_DIR = path.join(ROOT, 'task-runs');

const TICK_MS = 30_000;
const SESSION_CAP = 200;
const RUNS_CAP = 100;
const STORE_VERSION = 1;

// The tasks.json container is backed by the shared atomic JSON store (dir 0700 /
// file 0600, tmp-write-then-rename, read-per-call). The per-task session and run
// logs stay on the local writeJSONAtomic/readJSON helpers below: they are a set
// of dynamically-named files under task-sessions/ and task-runs/, not a single
// fixed-name container, so they fall outside a single openStore handle's scope.
const tasksStore = openStore({ name: 'tasks', version: STORE_VERSION, shape: { pausedAll: false, tasks: [] }, root: ROOT });

// ── In-memory state ──────────────────────────────────────────────────────────
/** @type {{version:number, pausedAll:boolean, tasks:Task[]}} */
let store = { version: STORE_VERSION, pausedAll: false, tasks: [] };
let loaded = false;
let timer = null;
const inFlight = new Set(); // task ids with a run currently executing

// ─────────────────────────────────────────────────────────────────────────────
// Cron: zero-dep 5-field evaluator ( m h dom mon dow )
// Supports:  *   */n   a,b,c   a-b   and combinations (a-b/n, list of ranges).
// Standard semantics: when BOTH dom and dow are restricted, a date matches if
// EITHER matches (the classic Vixie-cron OR rule).
// ─────────────────────────────────────────────────────────────────────────────
const FIELD_BOUNDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 },  // day of week (0 = Sunday)
];

function parseField(raw, bound) {
  const set = new Set();
  for (const part of String(raw).split(',')) {
    const token = part.trim();
    if (!token) throw new Error(`empty cron field segment in "${raw}"`);
    let step = 1;
    let range = token;
    const slash = token.indexOf('/');
    if (slash !== -1) {
      range = token.slice(0, slash);
      step = Number(token.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${token}"`);
    }
    let lo;
    let hi;
    if (range === '*') {
      lo = bound.min;
      hi = bound.max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = Number(range);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < bound.min || hi > bound.max || lo > hi) {
      throw new Error(`cron value out of range "${token}" (allowed ${bound.min}-${bound.max})`);
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

/** @returns {{minute:Set,hour:Set,dom:Set,month:Set,dow:Set,domStar:boolean,dowStar:boolean}} */
export function parseCron(cron) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have 5 fields, got ${fields.length}: "${cron}"`);
  const [minute, hour, dom, month, dow] = fields.map((f, i) => parseField(f, FIELD_BOUNDS[i]));
  return {
    minute, hour, dom, month, dow,
    domStar: fields[2].trim() === '*',
    dowStar: fields[4].trim() === '*',
  };
}

export function isDue(cron, date = new Date()) {
  const c = parseCron(cron);
  if (!c.minute.has(date.getMinutes())) return false;
  if (!c.hour.has(date.getHours())) return false;
  if (!c.month.has(date.getMonth() + 1)) return false;
  const domOk = c.dom.has(date.getDate());
  const dowOk = c.dow.has(date.getDay());
  // OR rule when both restricted; AND (i.e. the * one is always true) otherwise.
  if (!c.domStar && !c.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

/** Next minute-aligned Date strictly after `from` that satisfies `cron`, or null. */
export function nextRun(cron, from = new Date()) {
  const c = parseCron(cron);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after `from`
  const CAP = 366 * 24 * 60 + 1; // ~1 year of minutes
  for (let i = 0; i < CAP; i++) {
    if (
      c.minute.has(d.getMinutes()) &&
      c.hour.has(d.getHours()) &&
      c.month.has(d.getMonth() + 1) &&
      matchesDay(c, d)
    ) {
      return new Date(d.getTime());
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

function matchesDay(c, date) {
  const domOk = c.dom.has(date.getDate());
  const dowOk = c.dow.has(date.getDay());
  if (!c.domStar && !c.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

function nextRunISO(cron, from = new Date()) {
  try {
    const n = nextRun(cron, from);
    return n ? n.toISOString() : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — atomic writes, dir 0700 / file 0600. Never logs secrets.
// ─────────────────────────────────────────────────────────────────────────────
function ensureDirs() {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(RUNS_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(ROOT, 0o700); } catch {}
}

function writeJSONAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function persistStore() {
  tasksStore.write(store);
}

// ── Session log (dedicated per-task session) ─────────────────────────────────
function sessionFile(taskId) {
  return path.join(SESSIONS_DIR, `${safeId(taskId)}.json`);
}
function runsFile(taskId) {
  return path.join(RUNS_DIR, `${safeId(taskId)}.json`);
}
function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function logSession(taskId, role, text) {
  const file = sessionFile(taskId);
  const arr = readJSON(file, []);
  arr.push({ ts: new Date().toISOString(), role, text: String(text) });
  if (arr.length > SESSION_CAP) arr.splice(0, arr.length - SESSION_CAP);
  writeJSONAtomic(file, arr);
}

function recordRun(taskId, run) {
  const file = runsFile(taskId);
  const arr = readJSON(file, []);
  arr.push(run);
  if (arr.length > RUNS_CAP) arr.splice(0, arr.length - RUNS_CAP);
  writeJSONAtomic(file, arr);
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in task seeds (state:'paused' — nothing runs unattended until enabled).
// ─────────────────────────────────────────────────────────────────────────────
function builtinSeeds() {
  return [
    {
      id: 'builtin-email-summary',
      name: 'Email (Summary)',
      category: 'email',
      cron: '0 */2 * * *',
      action: 'builtin:emailSummary',
      isBuiltin: true,
      state: 'paused',
      config: { folders: ['INBOX'] },
      description: 'Summarizes unread INBOX emails since the last run and writes the summary to the dedicated session.',
    },
    {
      id: 'builtin-email-auto-reply',
      name: 'Email AI Auto Reply',
      category: 'email',
      cron: '0 */2 * * *',
      action: 'builtin:emailAutoReply',
      isBuiltin: true,
      state: 'paused',
      config: { maxPerRun: 3 },
      description: 'Drafts replies to emails that deserve one and puts them in the approval queue (human-in-the-loop). Never sends directly.',
    },
    {
      id: 'builtin-email-tags',
      name: 'Email Tags',
      category: 'email',
      cron: '0 * * * *',
      action: 'builtin:emailTags',
      isBuiltin: true,
      state: 'paused',
      config: {},
      description: 'Classifies unread INBOX emails into tags (invoice, urgent, newsletter, personal, work…) and flags the urgent ones with \\Flagged.',
    },
  ].map((t) => ({
    ...t,
    prompt: null,
    sessionId: t.id,
    lastRunAt: null,
    nextRunAt: nextRunISO(t.cron),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// init / lifecycle
// ─────────────────────────────────────────────────────────────────────────────
export function init() {
  if (loaded) return;
  ensureDirs();
  const onDisk = tasksStore.read();
  if (onDisk && Array.isArray(onDisk.tasks)) {
    store = { version: STORE_VERSION, pausedAll: !!onDisk.pausedAll, tasks: onDisk.tasks };
    // Ensure the 3 built-ins always exist (self-heal without duplicating).
    const seeds = builtinSeeds();
    for (const seed of seeds) {
      if (!store.tasks.some((t) => t.id === seed.id)) store.tasks.push(seed);
    }
  } else {
    store = { version: STORE_VERSION, pausedAll: false, tasks: builtinSeeds() };
  }
  // Recompute nextRunAt defensively for running tasks with none set.
  for (const t of store.tasks) {
    if (t.state === 'running' && !t.nextRunAt) t.nextRunAt = nextRunISO(t.cron);
  }
  persistStore();
  loaded = true;
}

export function startScheduler() {
  if (!loaded) init();
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// The interval body must NEVER throw. Everything below is wrapped.
function tick() {
  try {
    if (!loaded || store.pausedAll) return;
    const now = Date.now();
    for (const task of store.tasks) {
      try {
        if (task.state !== 'running') continue;
        if (inFlight.has(task.id)) continue; // per-task concurrency lock
        if (!task.nextRunAt) continue;
        if (now < new Date(task.nextRunAt).getTime()) continue;
        void executeScheduled(task);
      } catch {
        // isolate per-task faults; keep ticking
      }
    }
  } catch {
    // absolute backstop — the interval survives no matter what
  }
}

async function executeScheduled(task) {
  await runTask(task, /* scheduled */ true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core run — wraps every handler; records ok | error | skipped.
// ─────────────────────────────────────────────────────────────────────────────
async function runTask(task, scheduled) {
  if (inFlight.has(task.id)) return { status: 'skipped', summary: 'already running' };
  inFlight.add(task.id);
  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await dispatch(task);
    if (!result || typeof result !== 'object') result = { status: 'ok', summary: '' };
  } catch (e) {
    result = { status: 'error', error: e?.message || String(e) };
  } finally {
    inFlight.delete(task.id);
  }

  const finishedAt = new Date().toISOString();
  const run = {
    id: crypto.randomUUID(),
    startedAt,
    finishedAt,
    status: result.status || 'ok',
    summary: result.summary || '',
    error: result.error || null,
    sessionId: task.sessionId,
  };
  try { recordRun(task.id, run); } catch {}

  // Advance schedule + lastRunAt (persist through the live store object).
  const live = store.tasks.find((t) => t.id === task.id);
  if (live) {
    live.lastRunAt = finishedAt;
    if (scheduled || live.state === 'running') live.nextRunAt = nextRunISO(live.cron, new Date());
    try { persistStore(); } catch {}
  }
  return { ok: true, run };
}

async function dispatch(task) {
  switch (task.action) {
    case 'builtin:emailSummary': return runEmailSummary(task);
    case 'builtin:emailAutoReply': return runEmailAutoReply(task);
    case 'builtin:emailTags': return runEmailTags(task);
    case 'custom': return runCustom(task);
    default: return { status: 'skipped', summary: `unknown action ${task.action}` };
  }
}

// ── Lazy sibling loaders (never throw at module load) ────────────────────────
async function loadEmail() {
  const mod = await import('./email.mjs');
  return mod.Email || mod.default || mod;
}
async function loadApprovals() {
  const mod = await import('./approvals.mjs');
  return mod.Approvals || mod.default || mod;
}

async function resolveAccountId(Email, cfg) {
  if (cfg?.accountId) return cfg.accountId;
  const accounts = await Email.listAccounts();
  const def = accounts.find((a) => a.isDefault) || accounts[0];
  return def ? def.id : null;
}

function newerThan(msg, sinceISO) {
  if (!sinceISO) return true;
  if (!msg.date) return true;
  const t = Date.parse(msg.date);
  return Number.isNaN(t) ? true : t >= Date.parse(sinceISO);
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in 1 — Email Summary
// ─────────────────────────────────────────────────────────────────────────────
async function runEmailSummary(task) {
  const Email = await loadEmail();
  const accountId = await resolveAccountId(Email, task.config);
  if (!accountId) return { status: 'skipped', summary: 'no email account configured' };

  const folders = task.config?.folders?.length ? task.config.folders : ['INBOX'];
  const since = task.lastRunAt;
  const collected = [];
  for (const folder of folders) {
    const msgs = await Email.list(accountId, folder, { limit: 50 });
    for (const m of msgs) {
      if (m.unread && newerThan(m, since)) {
        collected.push({ folder, from: m.from?.address || m.from?.name || '?', subject: m.subject || '(sem assunto)', snippet: m.snippet || '' });
      }
    }
  }
  if (!collected.length) return { status: 'skipped', summary: 'no new emails to read' };

  const lines = collected.map((m, i) => `${i + 1}. De: ${m.from} | Assunto: ${m.subject}\n   ${m.snippet}`).join('\n');
  const summary = await ask(
    [{ role: 'user', content: `Unread emails received:\n\n${lines}` }],
    {
      system: 'You are an assistant that summarizes email. Write a clear, concise executive summary in English, grouping by topic when it makes sense, and highlight what needs attention. Do not invent content.',
      capability: 'email_summary', // Settings → AI Defaults; unset falls through to 'chat'
      maxTokens: 900,
    },
  );
  logSession(task.id, 'assistant', summary);
  return { status: 'ok', summary: `Summary of ${collected.length} email(s) written to the session.` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in 2 — Email AI Auto Reply (drafts → Approvals; NEVER sends)
// ─────────────────────────────────────────────────────────────────────────────
const NON_REPLY_FROM = /(no-?reply|do-?not-?reply|noreply|newsletter|notifications?@|mailer-daemon|postmaster|bounce|automated|auto-?confirm|@e?mail\.|@news\.|@marketing\.)/i;
const NON_REPLY_SUBJECT = /(unsubscribe|newsletter|digest|receipt|no-reply|verify your|confirm your (email|subscription)|password reset)/i;

function replyWorthy(msg) {
  const from = msg.from?.address || '';
  const subject = msg.subject || '';
  if (NON_REPLY_FROM.test(from)) return false;
  if (NON_REPLY_SUBJECT.test(subject)) return false;
  return true;
}

async function runEmailAutoReply(task) {
  const Email = await loadEmail();
  const accountId = await resolveAccountId(Email, task.config);
  if (!accountId) return { status: 'skipped', summary: 'no email account configured' };

  let Approvals;
  try {
    Approvals = await loadApprovals();
  } catch {
    return { status: 'skipped', summary: 'approvals module not available yet' };
  }

  const folder = 'INBOX';
  const maxPerRun = Number.isInteger(task.config?.maxPerRun) ? task.config.maxPerRun : 3;
  const since = task.lastRunAt;
  const list = await Email.list(accountId, folder, { limit: 50 });
  const candidates = list.filter((m) => m.unread && newerThan(m, since) && replyWorthy(m)).slice(0, maxPerRun);
  if (!candidates.length) return { status: 'skipped', summary: 'no emails that deserve a reply' };

  let queued = 0;
  for (const c of candidates) {
    let full;
    try {
      full = await Email.message(accountId, folder, c.uid);
    } catch {
      continue;
    }
    const body = await ask(
      [{ role: 'user', content: `Email recebido de ${c.from?.address || c.from?.name || '?'} com assunto "${c.subject || ''}":\n\n${(full.text || full.headers?.subject || '').slice(0, 6000)}` }],
      {
        system: 'You are the user\'s personal assistant. Draft a polite, professional and concise reply in English, in the voice of someone replying on their own behalf. Return ONLY the reply body, with no subject line and no placeholder signature.',
        capability: 'email_reply',
        maxTokens: 800,
      },
    );
    const to = c.from?.address || full.headers?.from || '';
    if (!to) continue;
    const subject = /^re:/i.test(c.subject || '') ? c.subject : `Re: ${c.subject || ''}`.trim();
    const res = await Approvals.add({
      type: 'ai_reply',
      accountId,
      to,
      subject,
      body,
      sourceUid: c.uid,
      folder,
      generatedBy: task.name,
    });
    if (res && res.ok) queued++;
  }

  logSession(task.id, 'assistant', `${queued} reply draft(s) placed in the approval queue.`);
  if (!queued) return { status: 'skipped', summary: 'nenhum rascunho enfileirado' };
  return { status: 'ok', summary: `${queued} draft(s) queued for approval.` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in 3 — Email Tags (classify → apply \Flagged on urgent)
// ─────────────────────────────────────────────────────────────────────────────
const VALID_TAGS = new Set(['invoice', 'urgent', 'newsletter', 'personal', 'work', 'social', 'notification', 'other']);

async function runEmailTags(task) {
  const Email = await loadEmail();
  const accountId = await resolveAccountId(Email, task.config);
  if (!accountId) return { status: 'skipped', summary: 'no email account configured' };

  const folder = 'INBOX';
  const since = task.lastRunAt;
  const msgs = (await Email.list(accountId, folder, { limit: 50 })).filter((m) => m.unread && newerThan(m, since));
  if (!msgs.length) return { status: 'skipped', summary: 'sem emails novos para classificar' };

  const payload = msgs.map((m) => ({ uid: m.uid, from: m.from?.address || m.from?.name || '?', subject: m.subject || '', snippet: (m.snippet || '').slice(0, 200) }));
  const raw = await ask(
    [{ role: 'user', content: `Classify each email into a single tag from: invoice, urgent, newsletter, personal, work, social, notification, other.\nReturn ONLY JSON in the format {"<uid>":"<tag>"}.\n\nEmails:\n${JSON.stringify(payload)}` }],
    {
      system: 'You are an email classifier. Respond exclusively with valid JSON — no extra text, no markdown.',
      capability: 'email_tags',
      maxTokens: 600,
    },
  );

  const tagMap = parseTagMap(raw, msgs);
  let flagged = 0;
  for (const [uid, tag] of Object.entries(tagMap)) {
    if (tag === 'urgent') {
      try {
        await Email.flag(accountId, folder, Number(uid), { flagged: true });
        flagged++;
      } catch {}
    }
  }
  logSession(task.id, 'assistant', `Classification: ${JSON.stringify(tagMap)} — ${flagged} flagged as urgent (\\Flagged).`);
  return { status: 'ok', summary: `${Object.keys(tagMap).length} email(s) classificado(s), ${flagged} urgente(s).` };
}

function parseTagMap(raw, msgs) {
  const known = new Set(msgs.map((m) => String(m.uid)));
  let obj = {};
  try {
    const match = String(raw).match(/\{[\s\S]*\}/);
    obj = match ? JSON.parse(match[0]) : {};
  } catch {
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(String(k))) continue;
    const tag = String(v).toLowerCase().trim();
    out[k] = VALID_TAGS.has(tag) ? tag : 'other';
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom task
// ─────────────────────────────────────────────────────────────────────────────
async function runCustom(task) {
  const prompt = task.prompt && String(task.prompt).trim();
  if (!prompt) return { status: 'skipped', summary: 'empty prompt' };
  const out = await ask([{ role: 'user', content: prompt }], { maxTokens: 1200 });
  logSession(task.id, 'assistant', out);
  return { status: 'ok', summary: 'reply written to the session.' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — CRUD / control / views
// ─────────────────────────────────────────────────────────────────────────────
function publicView(t) {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    cron: t.cron,
    state: t.state,
    isBuiltin: !!t.isBuiltin,
    action: t.action,
    lastRunAt: t.lastRunAt || null,
    nextRunAt: t.nextRunAt || null,
    sessionId: t.sessionId,
    description: t.description || '',
  };
}

export function list() {
  if (!loaded) init();
  return store.tasks.map(publicView);
}

export function get(id) {
  if (!loaded) init();
  const t = store.tasks.find((x) => x.id === id);
  return t ? publicView(t) : null;
}

export function add({ name, category, cron, prompt, action, config } = {}) {
  if (!loaded) init();
  if (!name || !String(name).trim()) return { ok: false, error: 'name is required' };
  if (!cron) return { ok: false, error: 'cron is required' };
  try {
    parseCron(cron);
  } catch (e) {
    return { ok: false, error: `invalid cron: ${e.message}` };
  }
  const act = action || 'custom';
  if (act === 'custom' && (!prompt || !String(prompt).trim())) {
    return { ok: false, error: 'custom tasks require a prompt' };
  }
  const id = crypto.randomUUID();
  const task = {
    id,
    name: String(name).trim(),
    category: category || 'custom',
    cron,
    action: act,
    prompt: prompt || null,
    config: config && typeof config === 'object' ? config : {},
    isBuiltin: false,
    state: 'paused',
    sessionId: id,
    lastRunAt: null,
    nextRunAt: nextRunISO(cron),
    description: '',
  };
  store.tasks.push(task);
  persistStore();
  return { ok: true, id };
}

const EDITABLE = new Set(['name', 'cron', 'config', 'description', 'category', 'prompt']);

export function update(id, patch = {}) {
  if (!loaded) init();
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: 'not found' };
  if (patch.cron !== undefined) {
    try {
      parseCron(patch.cron);
    } catch (e) {
      return { ok: false, error: `invalid cron: ${e.message}` };
    }
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.has(k)) continue;
    if (t.isBuiltin && (k === 'prompt' || k === 'category')) continue; // built-ins keep their action/category
    t[k] = v;
  }
  if (patch.cron !== undefined) t.nextRunAt = nextRunISO(t.cron);
  persistStore();
  return { ok: true };
}

export function remove(id) {
  if (!loaded) init();
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: 'not found' };
  if (t.isBuiltin) return { ok: false, error: 'built-in tasks cannot be removed (pause it instead)' };
  store.tasks = store.tasks.filter((x) => x.id !== id);
  persistStore();
  try { fs.rmSync(sessionFile(id), { force: true }); } catch {}
  try { fs.rmSync(runsFile(id), { force: true }); } catch {}
  return { ok: true };
}

export function setState(id, state) {
  if (!loaded) init();
  if (state !== 'running' && state !== 'paused') return { ok: false, error: 'state must be running|paused' };
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: 'not found' };
  t.state = state;
  t.nextRunAt = state === 'running' ? nextRunISO(t.cron) : null;
  persistStore();
  return { ok: true };
}

export function pauseAll(flag) {
  if (!loaded) init();
  store.pausedAll = !!flag;
  persistStore();
  return { ok: true, pausedAll: store.pausedAll };
}

export function isPausedAll() {
  if (!loaded) init();
  return store.pausedAll;
}

export async function runNow(id) {
  if (!loaded) init();
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: 'not found' };
  return runTask(t, /* scheduled */ false);
}

export function activity(id, { limit = 20 } = {}) {
  if (!loaded) init();
  const arr = readJSON(runsFile(id), []);
  return arr.slice(-Math.max(1, limit)).reverse();
}

export function session(id) {
  if (!loaded) init();
  return readJSON(sessionFile(id), []);
}

// ─────────────────────────────────────────────────────────────────────────────
export const Tasks = {
  init,
  startScheduler,
  stopScheduler,
  list,
  get,
  add,
  update,
  remove,
  setState,
  pauseAll,
  isPausedAll,
  runNow,
  activity,
  session,
  // cron helpers (exposed for callers/tests)
  nextRun,
  isDue,
  parseCron,
};

export default Tasks;
