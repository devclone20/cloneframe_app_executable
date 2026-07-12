// ─────────────────────────────────────────────────────────────────────────────
// CLONE FRAME · HUB — Deep Research
//
// Sidebar "Deep Research". Given a question, run a multi-step research pass and
// synthesize a CITED markdown report. There is no web-search key on this box, so
// two modes are supported:
//
//   • 'sources' — the caller supplies an array of {title,url,text}. The engine
//     decomposes the question, extracts evidence from the sources, then writes a
//     report that cites every non-trivial claim by source number [1][2]. The
//     Sources list is appended DETERMINISTICALLY (never model-authored), so URLs
//     are exact and never hallucinated.
//
//   • 'reason' — no sources. The engine produces a structured deep analysis that
//     ends with an explicit "What I could verify vs. what needs a source"
//     section, so the reader always knows what to confirm against a primary
//     source before relying on it.
//
// Runs inside the hub bridge Node process. Zero npm deps — Node built-ins only.
// `ask()` from ./llm.mjs is a static import (same tier as this module); it is
// only ever CALLED inside run(), never at module load. Past reports persist to
// ~/.clone-frame-hub/research.json (dir 0700 / file 0600, atomic writes).
//
// Public surface: `Research` object + named exports. See RESEARCH.md.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ask } from './llm.mjs';

// ── paths ──────────────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(homedir(), '.clone-frame-hub');
const STORE_FILE = path.join(CONFIG_DIR, 'research.json');

// ── limits (bound cost + payload; Claude tolerates far more, we don't need it) ──
const STORE_VERSION = 1;
const MAX_REPORTS = 100;          // ring buffer; oldest dropped first
const MAX_SOURCES = 20;
const MAX_SOURCE_CHARS = 8_000;   // per-source body cap
const TOTAL_SOURCE_BUDGET = 80_000; // cumulative body cap across all sources
const MAX_QUESTION_CHARS = 4_000;
const MAX_SUBQUESTIONS = 8;

const TOK_PLAN = 600;
const TOK_ANALYZE = 1_600;
const TOK_SYNTH = 3_000;

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — atomic write, dir 0700 / file 0600. A corrupt/missing store
// degrades to empty; nothing here ever throws out of load/save call sites.
// ─────────────────────────────────────────────────────────────────────────────
function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort on odd/shared fs */ }
}

function emptyStore() {
  return { version: STORE_VERSION, reports: [] };
}

function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const reports = Array.isArray(data?.reports)
      ? data.reports.filter((r) => r && typeof r === 'object' && typeof r.id === 'string')
      : [];
    return { version: STORE_VERSION, reports };
  } catch {
    // ENOENT or corrupt JSON — start clean, never crash the sidebar.
    return emptyStore();
  }
}

function saveStore(store) {
  ensureConfigDir();
  const tmp = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, STORE_FILE);
  try { fs.chmodSync(STORE_FILE, 0o600); } catch { /* best effort */ }
}

// ── input sanitisation ─────────────────────────────────────────────────────────
// Strip control chars (keep tab 0x09 / newline 0x0A / carriage-return 0x0D) and
// collapse to a single line where one is expected. LLM text and user-supplied
// source bodies are untrusted; output is markdown, never raw HTML.
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function oneLine(v, cap) {
  const s = String(v ?? '').replace(CTRL, ' ').replace(/\s+/g, ' ').trim();
  return cap && s.length > cap ? s.slice(0, cap).trim() : s;
}

function clampText(v, cap) {
  let s = String(v ?? '').replace(CTRL, '').replace(/\r\n?/g, '\n').trim();
  if (s.length > cap) s = `${s.slice(0, cap).trim()} …[truncated]`;
  return s;
}

/** @returns {{title,url,text}[]} cleaned, capped by count + total budget. */
function cleanSources(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  let budget = TOTAL_SOURCE_BUDGET;
  for (const s of input) {
    if (out.length >= MAX_SOURCES) break;
    if (!s || typeof s !== 'object') continue;
    const title = oneLine(s.title, 200);
    const url = oneLine(s.url, 500);
    let text = clampText(s.text, MAX_SOURCE_CHARS);
    if (!text && !title) continue; // nothing citable
    if (text.length > budget) text = text.slice(0, Math.max(budget, 0)).trim();
    budget -= text.length;
    out.push({ title: title || 'Untitled', url, text });
  }
  return out;
}

// ── markdown / url safety ───────────────────────────────────────────────────────
function mdLinkText(title) {
  return String(title || '').replace(/[[\]]/g, '').trim() || 'Untitled';
}

// Only linkify safe schemes — blocks javascript:/data: link injection if the
// host app renders this markdown to HTML.
function safeUrl(u) {
  return /^(https?:|mailto:|ftp:)/i.test(String(u || '')) ? String(u) : '';
}

function numberedSources(sources) {
  return sources
    .map((s, i) => `[${i + 1}] ${s.title}${s.url ? ` (${s.url})` : ''}\n${s.text}`)
    .join('\n\n---\n\n');
}

function sourcesSection(sources) {
  const lines = sources.map((s, i) => {
    const n = i + 1;
    const label = mdLinkText(s.title);
    const u = safeUrl(s.url);
    if (u) return `${n}. [${label}](<${u}>)`;
    if (s.url) return `${n}. ${label} — \`${oneLine(s.url, 500)}\``; // unsafe scheme → plain, not a link
    return `${n}. ${label}`;
  });
  return `## Sources\n\n${lines.join('\n')}`;
}

// ── model response helpers ──────────────────────────────────────────────────────
function parseJsonArray(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('[');
  if (start === -1) return [];
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']') {
      depth--;
      if (depth === 0) {
        try {
          const arr = JSON.parse(s.slice(start, i + 1));
          return Array.isArray(arr) ? arr : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

function stripOuterFence(md) {
  const t = String(md || '').trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return m ? m[1].trim() : t;
}

// Demote model-authored H1 headings to H2 (outside code fences) so the assembled
// report has exactly one H1 — the question title we prepend.
function demoteH1(md) {
  const lines = String(md || '').split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && /^ {0,3}# (?!#)/.test(lines[i])) lines[i] = lines[i].replace(/^( {0,3})# /, '$1## ');
  }
  return lines.join('\n');
}

function planBlock(plan) {
  return plan.length
    ? `Sub-questions to address:\n${plan.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : '';
}

// Guarantees the reason-mode contract even if the model omits the section.
function ensureVerifySection(md) {
  const t = String(md || '').trim();
  if (/what i could verify/i.test(t)) return t;
  return `${t}\n\n## What I could verify vs. what needs a source\n\n- **Well-established:** the analysis above draws on general, stable knowledge.\n- **Needs a source:** any specific figures, dates, quotations, named entities, or recent developments should be confirmed against a primary source before you rely on them — this pass ran without web access.`;
}

// ── prompts ─────────────────────────────────────────────────────────────────────
const PLAN_SYSTEM =
  "You are a meticulous research lead. Decompose the user's question into 3–6 focused, non-overlapping sub-questions a rigorous investigation must answer. Respond with ONLY a JSON array of strings — no prose, no code fences.";

const ANALYZE_SYSTEM =
  'You are a rigorous research analyst. You are given a question, sub-questions, and a set of NUMBERED sources. Extract only the concrete evidence the sources contain, attributing every point to its source number in brackets, e.g. [2]. Use ONLY the provided sources — no outside knowledge. If the sources do not answer a sub-question, say so explicitly. Output concise markdown notes grouped by sub-question.';

const SYNTH_SOURCES_SYSTEM =
  'You are a world-class research writer. Using ONLY the evidence notes and numbered sources provided, write a clear, well-structured markdown report answering the question. Requirements: (1) open with a one-paragraph executive summary; (2) cite every non-trivial claim with bracketed source numbers like [1] or [2][3]; (3) never invent facts, figures, or sources; (4) where the sources are insufficient, conflicting, or silent, say so under a "## Gaps & caveats" section. Do NOT append a Sources list — one is added automatically. Do NOT add a top-level H1 title — start directly with the executive summary. Do not wrap the whole answer in code fences.';

const REASON_SYSTEM =
  'You are a world-class analyst operating WITHOUT web access and WITHOUT any provided sources. Produce a structured, decision-grade markdown report that answers the question through rigorous reasoning over well-established knowledge. Structure: a one-paragraph executive summary, then the analysis under clear headings. You MUST end with a section titled exactly "## What I could verify vs. what needs a source" containing two bulleted lists: (1) claims that rest on stable, well-established knowledge, and (2) specific claims, figures, dates, or recent facts that must be confirmed against a primary source before being relied upon. Never fabricate citations, statistics, quotations, or URLs. Be explicit about uncertainty and assumptions. Do NOT add a top-level H1 title — start directly with the executive summary. Do not wrap the answer in code fences.';

// ── multi-step research pass ────────────────────────────────────────────────────
// Step 1 (planning) is best-effort: a parse/transient failure yields an empty
// plan and the pass continues. The final synthesis call is the gate — if the
// brain is unavailable (no key) it throws here and run() reports {ok:false}.
async function planStep(question, model) {
  try {
    const raw = await ask([{ role: 'user', content: `Question:\n${question}` }], {
      system: PLAN_SYSTEM,
      model,
      maxTokens: TOK_PLAN,
    });
    return parseJsonArray(raw)
      .filter((x) => typeof x === 'string')
      .map((x) => oneLine(x, 300))
      .filter(Boolean)
      .slice(0, MAX_SUBQUESTIONS);
  } catch {
    return [];
  }
}

async function analyzeStep(question, plan, sources, model) {
  try {
    const content = [
      `Question:\n${question}`,
      planBlock(plan),
      `Sources:\n${numberedSources(sources)}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return await ask([{ role: 'user', content }], { system: ANALYZE_SYSTEM, model, maxTokens: TOK_ANALYZE });
  } catch {
    return '';
  }
}

async function synthesizeFromSources(question, plan, findings, sources, model) {
  const content = [
    `Question:\n${question}`,
    planBlock(plan),
    findings ? `Evidence notes (from a prior analysis pass):\n${findings}` : '',
    `Numbered sources (for citation reference):\n${numberedSources(sources)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const md = await ask([{ role: 'user', content }], { system: SYNTH_SOURCES_SYSTEM, model, maxTokens: TOK_SYNTH });
  return stripOuterFence(md);
}

async function reasonAnalysis(question, plan, model) {
  const content = [`Question:\n${question}`, planBlock(plan)].filter(Boolean).join('\n\n');
  const md = await ask([{ role: 'user', content }], { system: REASON_SYSTEM, model, maxTokens: TOK_SYNTH });
  return ensureVerifySection(stripOuterFence(md));
}

function assembleMarkdown({ question, mode, sources, body, createdAt }) {
  const meta =
    mode === 'sources'
      ? `> Deep Research · sources mode · ${sources.length} source(s) · ${createdAt}`
      : `> Deep Research · reason mode · no external sources · ${createdAt}`;
  let md = `# ${oneLine(question, 200)}\n\n${meta}\n\n${demoteH1(String(body || '').trim())}\n`;
  if (mode === 'sources' && sources.length) md += `\n${sourcesSection(sources)}\n`;
  return md;
}

function persistReport(record) {
  try {
    const store = loadStore();
    store.reports.push(record);
    if (store.reports.length > MAX_REPORTS) store.reports = store.reports.slice(-MAX_REPORTS);
    saveStore(store);
    return true;
  } catch {
    // Best effort: the caller still receives the generated markdown even if the
    // store is unwritable; the report simply won't appear in list()/get().
    return false;
  }
}

// ── views (never leak raw source bodies or any secret-shaped field) ─────────────
function listView(r) {
  return { id: r.id, question: r.question, createdAt: r.createdAt };
}

function getView(r) {
  return {
    id: r.id,
    question: r.question,
    markdown: r.markdown,
    createdAt: r.createdAt,
    mode: r.mode,
    model: r.model ?? null,
    sourceCount: Number.isInteger(r.sourceCount) ? r.sourceCount : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a multi-step deep-research pass and synthesize a cited markdown report.
 * @param {{question:string, sources?:{title:string,url:string,text:string}[], mode?:'sources'|'reason', model?:string}} input
 * @returns {Promise<{ok:boolean, reportId?:string, markdown?:string, error?:string}>}
 */
export async function run(input = {}) {
  try {
    const arg = input && typeof input === 'object' ? input : {};
    const question = oneLine(arg.question, MAX_QUESTION_CHARS);
    if (!question) return { ok: false, error: 'question is required' };

    const sources = cleanSources(arg.sources);
    const mode =
      arg.mode === 'sources' || arg.mode === 'reason'
        ? arg.mode
        : sources.length
          ? 'sources'
          : 'reason';
    if (mode === 'sources' && !sources.length) {
      return { ok: false, error: 'sources mode requires at least one source with title/url/text' };
    }

    const model = typeof arg.model === 'string' && arg.model.trim() ? arg.model.trim() : undefined;
    const createdAt = new Date().toISOString();

    const plan = await planStep(question, model);

    let body;
    if (mode === 'sources') {
      const findings = await analyzeStep(question, plan, sources, model);
      body = await synthesizeFromSources(question, plan, findings, sources, model);
    } else {
      body = await reasonAnalysis(question, plan, model);
    }

    const markdown = assembleMarkdown({ question, mode, sources, body, createdAt });
    const reportId = randomUUID();
    persistReport({
      id: reportId,
      question,
      mode,
      model: model ?? null,
      sourceCount: sources.length,
      markdown,
      createdAt,
    });

    return { ok: true, reportId, markdown };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/** @returns {{id:string,question:string,createdAt:string}[]} newest first */
export function list() {
  const { reports } = loadStore();
  return [...reports]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(listView);
}

/** @returns {{id,question,markdown,createdAt,mode,model,sourceCount}|null} */
export function get(id) {
  if (!id || typeof id !== 'string') return null;
  const { reports } = loadStore();
  const r = reports.find((x) => x.id === id);
  return r ? getView(r) : null;
}

/** @returns {{ok:boolean, error?:string}} */
export function remove(id) {
  try {
    if (!id || typeof id !== 'string') return { ok: false, error: 'id is required' };
    const store = loadStore();
    const before = store.reports.length;
    store.reports = store.reports.filter((r) => r.id !== id);
    if (store.reports.length === before) return { ok: false, error: 'not found' };
    saveStore(store);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

export const Research = { run, list, get, remove };
export default Research;
