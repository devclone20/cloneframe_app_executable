// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB Bridge — Prompt Cookbook
//
// A local library of reusable prompt recipes ("skills"): name, category,
// description, a prompt template with {{variables}}, and tags. Ships ~8 curated
// built-in recipes (email reply, summarize, translate PT, code review,
// brainstorm, rewrite formal, extract action items, meeting notes). Built-ins
// are defined in code and are not editable or removable — improvements to them
// ship with the module, never drift on disk. Only user-created recipes are
// persisted (~/.clone-frame-hub/cookbook.json, dir 0700 / file 0600, atomic).
//
// `run(id, vars)` fills a recipe's {{variables}} and calls Claude via
// ./llm.mjs (BYOK, non-streaming). Everything degrades gracefully: a corrupt or
// missing store is treated as empty, and write/run paths never throw for
// expected failures — they return {ok:false, error}.
//
// Public surface: `Cookbook` object + named exports. See COOKBOOK.md.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ask } from './llm.mjs';

const CONFIG_DIR = path.join(homedir(), '.clone-frame-hub');
const STORE_FILE = path.join(CONFIG_DIR, 'cookbook.json');
const STORE_VERSION = 1;
const DEFAULT_MAX_TOKENS = 1024;
const MAX_TEMPLATE_LEN = 20_000;

// {{ variable }} — letters, digits, underscore, dot, hyphen. Whitespace-tolerant.
const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — atomic writes, dir 0700 / file 0600. Corrupt store → empty.
// Only USER recipes live on disk; built-ins are code-defined (see BUILTINS).
// ─────────────────────────────────────────────────────────────────────────────
function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort on odd filesystems */ }
}

function loadStore() {
  ensureConfigDir();
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return { recipes: Array.isArray(data.recipes) ? data.recipes.filter(isSaneRecord) : [] };
  } catch {
    // Missing or corrupt store must never crash the app — start empty.
    return { recipes: [] };
  }
}

function saveStore(store) {
  ensureConfigDir();
  const tmp = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, recipes: store.recipes }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, STORE_FILE);
  try { fs.chmodSync(STORE_FILE, 0o600); } catch { /* best effort */ }
}

function isSaneRecord(r) {
  return r && typeof r === 'object' && typeof r.id === 'string' && typeof r.template === 'string';
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in recipes (curated). Stable ids, isBuiltin:true. Not editable/removable.
// ─────────────────────────────────────────────────────────────────────────────
const BUILTINS = [
  {
    id: 'builtin-email-reply',
    name: 'Email Reply',
    category: 'email',
    description: 'Draft a concise, professional reply to an email in a chosen tone.',
    tags: ['email', 'reply', 'writing'],
    system: 'You are a sharp executive assistant. Write email replies that are clear, courteous and concise. Return only the reply body — no subject line, no placeholder signature.',
    template: 'Write a reply to the email below.\n\nDesired tone: {{tone}}\nKey points to convey: {{points}}\n\n--- Original email ---\n{{email}}',
  },
  {
    id: 'builtin-summarize',
    name: 'Summarize',
    category: 'productivity',
    description: 'Summarize any text into a tight executive summary plus key bullets.',
    tags: ['summary', 'reading'],
    system: 'You are an expert analyst. Produce faithful, information-dense summaries. Never invent facts that are not in the source.',
    template: 'Summarize the following text. Start with a 2-sentence executive summary, then up to 5 key bullet points.\n\n--- Text ---\n{{text}}',
  },
  {
    id: 'builtin-translate-pt',
    name: 'Translate → PT (Portugal)',
    category: 'translation',
    description: 'Translate text into natural European Portuguese, preserving tone.',
    tags: ['translation', 'portuguese'],
    system: 'You are a professional translator. Translate into natural, fluent European Portuguese (Portugal), preserving the tone, register and formatting of the original. Return only the translation.',
    template: 'Translate the following text into European Portuguese (Portugal):\n\n{{text}}',
  },
  {
    id: 'builtin-code-review',
    name: 'Code Review',
    category: 'code',
    description: 'Review a code diff or snippet for bugs, security and clarity.',
    tags: ['code', 'review', 'engineering'],
    system: 'You are a world-class senior engineer doing a rigorous code review. Prioritise correctness and security first, then architecture, performance, and readability. Be specific: cite the exact line or symbol and give the concrete fix. If it is solid, say so.',
    template: 'Review the following {{language}} code. Flag issues by severity (critical/high/medium/low) with the fix for each.\n\n```{{language}}\n{{code}}\n```',
  },
  {
    id: 'builtin-brainstorm',
    name: 'Brainstorm',
    category: 'ideation',
    description: 'Generate a diverse set of ideas around a topic and goal.',
    tags: ['ideas', 'brainstorm'],
    system: 'You are a creative strategist. Generate ideas that are diverse, non-obvious and genuinely useful — no filler. Favour range over volume.',
    template: 'Brainstorm {{count}} distinct ideas for: {{topic}}\n\nGoal / constraints: {{goal}}\n\nFor each idea give a one-line pitch and why it could work.',
  },
  {
    id: 'builtin-rewrite-formal',
    name: 'Rewrite Formal',
    category: 'writing',
    description: 'Rewrite text in a more formal, polished register without changing meaning.',
    tags: ['writing', 'rewrite', 'tone'],
    system: 'You are a meticulous editor. Rewrite text in a more formal, professional register while preserving the exact meaning and all facts. Do not add new content. Return only the rewritten text.',
    template: 'Rewrite the following text in a more formal, polished tone:\n\n{{text}}',
  },
  {
    id: 'builtin-action-items',
    name: 'Extract Action Items',
    category: 'productivity',
    description: 'Pull a clean, owner-tagged action-item list out of any text.',
    tags: ['tasks', 'productivity', 'extraction'],
    system: 'You extract actionable items from text. Output a Markdown checklist. Each item: the concrete action, the owner in [brackets] if identifiable, and a due date if stated. Include only real, actionable items — no vague filler.',
    template: 'Extract all action items from the text below as a Markdown checklist.\n\n--- Text ---\n{{text}}',
  },
  {
    id: 'builtin-meeting-notes',
    name: 'Meeting Notes',
    category: 'productivity',
    description: 'Turn a raw transcript into structured meeting notes.',
    tags: ['meeting', 'notes', 'summary'],
    system: 'You turn raw meeting transcripts into structured notes. Use these sections: Summary, Decisions, Action Items (owner + due where stated), Open Questions. Be faithful to the transcript and never invent outcomes.',
    template: 'Produce structured meeting notes from this transcript.\n\nMeeting: {{title}}\n\n--- Transcript ---\n{{transcript}}',
  },
].map((r) => Object.freeze({ ...r, isBuiltin: true, createdAt: null, updatedAt: null }));

const BUILTIN_IDS = new Set(BUILTINS.map((r) => r.id));

// ─────────────────────────────────────────────────────────────────────────────
// Templates & views
// ─────────────────────────────────────────────────────────────────────────────
function extractVariables(template) {
  const seen = new Set();
  const out = [];
  for (const m of String(template).matchAll(VAR_RE)) {
    const name = m[1];
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

function coerceValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(coerceValue).join('\n');
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Single-pass fill: values are substituted verbatim and never re-scanned, so a
// value that itself contains "{{x}}" can never trigger nested substitution.
function fillTemplate(template, vars) {
  const supplied = vars && typeof vars === 'object' && !Array.isArray(vars) ? vars : {};
  const missing = [];
  const output = String(template).replace(VAR_RE, (_full, name) => {
    if (!Object.prototype.hasOwnProperty.call(supplied, name) || supplied[name] === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }
    return coerceValue(supplied[name]);
  });
  return { output, missing };
}

function publicView(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    description: r.description || '',
    template: r.template,
    variables: extractVariables(r.template),
    tags: Array.isArray(r.tags) ? r.tags : [],
    system: r.system || '',
    isBuiltin: !!r.isBuiltin,
    createdAt: r.createdAt || null,
    updatedAt: r.updatedAt || null,
  };
}

// Built-ins first (curated order), then user recipes newest-first. A user
// record that somehow shares a built-in id is shadowed by the built-in.
function allRecipes() {
  const user = loadStore().recipes
    .filter((r) => !BUILTIN_IDS.has(r.id))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return [...BUILTINS, ...user];
}

function normTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
}

function cleanStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — routed by the bridge as Cookbook.<fn>(...args)
// ─────────────────────────────────────────────────────────────────────────────
export function list({ category = '' } = {}) {
  const cat = cleanStr(category).toLowerCase();
  return allRecipes()
    .filter((r) => !cat || String(r.category).toLowerCase() === cat)
    .map(publicView);
}

export function get(id) {
  const r = allRecipes().find((x) => x.id === id);
  return r ? publicView(r) : null;
}

export function categories() {
  return [...new Set(allRecipes().map((r) => r.category).filter(Boolean))].sort();
}

export function add({ name, category, description, template, tags, system } = {}) {
  const nm = cleanStr(name);
  const tpl = typeof template === 'string' ? template : '';
  if (!nm) return { ok: false, error: 'name is required' };
  if (!tpl.trim()) return { ok: false, error: 'template is required' };
  if (tpl.length > MAX_TEMPLATE_LEN) return { ok: false, error: `template too long (max ${MAX_TEMPLATE_LEN} chars)` };
  try {
    const store = loadStore();
    const now = new Date().toISOString();
    const id = randomUUID();
    store.recipes.push({
      id,
      name: nm,
      category: cleanStr(category) || 'custom',
      description: cleanStr(description),
      template: tpl,
      tags: normTags(tags),
      system: cleanStr(system),
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
    });
    saveStore(store);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

const EDITABLE = new Set(['name', 'category', 'description', 'template', 'tags', 'system']);

export function update(id, patch = {}) {
  if (BUILTIN_IDS.has(id)) return { ok: false, error: 'built-in recipes cannot be edited' };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'patch must be an object' };
  try {
    const store = loadStore();
    const r = store.recipes.find((x) => x.id === id);
    if (!r) return { ok: false, error: 'not found' };

    if (patch.name !== undefined) {
      const nm = cleanStr(patch.name);
      if (!nm) return { ok: false, error: 'name cannot be empty' };
      r.name = nm;
    }
    if (patch.template !== undefined) {
      const tpl = typeof patch.template === 'string' ? patch.template : '';
      if (!tpl.trim()) return { ok: false, error: 'template cannot be empty' };
      if (tpl.length > MAX_TEMPLATE_LEN) return { ok: false, error: `template too long (max ${MAX_TEMPLATE_LEN} chars)` };
      r.template = tpl;
    }
    if (patch.category !== undefined) r.category = cleanStr(patch.category) || 'custom';
    if (patch.description !== undefined) r.description = cleanStr(patch.description);
    if (patch.system !== undefined) r.system = cleanStr(patch.system);
    if (patch.tags !== undefined) r.tags = normTags(patch.tags);

    // Ignore any keys outside EDITABLE — unknown fields are never persisted.
    for (const k of Object.keys(patch)) if (!EDITABLE.has(k)) delete patch[k];

    r.updatedAt = new Date().toISOString();
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function remove(id) {
  if (BUILTIN_IDS.has(id)) return { ok: false, error: 'built-in recipes cannot be removed' };
  try {
    const store = loadStore();
    const before = store.recipes.length;
    store.recipes = store.recipes.filter((x) => x.id !== id);
    if (store.recipes.length === before) return { ok: false, error: 'not found' };
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function run(id, vars) {
  try {
    const r = allRecipes().find((x) => x.id === id);
    if (!r) return { ok: false, error: 'not found' };

    const { output: prompt, missing } = fillTemplate(r.template, vars);
    if (missing.length) return { ok: false, error: `missing variables: ${missing.join(', ')}` };

    const output = await ask(
      [{ role: 'user', content: prompt }],
      {
        system: r.system || undefined,
        model: r.model || undefined,
        maxTokens: Number.isInteger(r.maxTokens) ? r.maxTokens : DEFAULT_MAX_TOKENS,
      },
    );
    return { ok: true, output };
  } catch (e) {
    // No API key, network failure, upstream error — surface, never throw.
    return { ok: false, error: e?.message || String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
export const Cookbook = {
  list,
  get,
  add,
  update,
  remove,
  run,
  categories,
};

export default Cookbook;
