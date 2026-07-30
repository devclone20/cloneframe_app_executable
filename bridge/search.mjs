// search.mjs — global cross-module search. Stateless, read-only aggregator.
//
// Fans a single query out to every content module the HUB knows about. Each
// module is loaded lazily (only when a query actually runs) and wrapped in
// its own try/catch so a missing file, a broken store, or a thrown error in
// one module can never take down the others — that module's group is simply
// omitted from the result.

const MODULES = ['notes', 'tasks', 'reminders', 'research'];

const LABELS = {
  notes: 'Notes',
  tasks: 'Tasks',
  reminders: 'Reminders',
  research: 'Research',
};

const DEFAULT_LIMIT = 8;

function toText(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// needle must already be lower-cased; fields are matched case-insensitively.
function matchesAny(needle, ...fields) {
  if (!needle) return true;
  return fields.some((f) => toText(f).toLowerCase().includes(needle));
}

function cap(rows, limit) {
  return Array.isArray(rows) ? rows.slice(0, Math.max(0, limit)) : [];
}

// Notes does its own matching (title + body + tags, case-insensitive) behind the
// `search` argument, so the needle is handed to the module rather than re-filtered
// here — one definition of "does this note match", on the daemon side.
async function searchNotes(needle, limit) {
  const { Notes } = await import('./notes.mjs');
  const rows = Notes.list({ search: needle });
  return cap(rows, limit).map((n) => ({
    id: n.id,
    title: n.title,
    snippet: n.snippet || '',
  }));
}

async function searchTasks(needle, limit) {
  const { Tasks } = await import('./tasks.mjs');
  const rows = Tasks.list().filter((t) => matchesAny(needle, t.name, t.category));
  return cap(rows, limit).map((t) => ({
    id: t.id,
    title: t.name,
    snippet: t.category || '',
  }));
}

async function searchReminders(needle, limit) {
  const { Reminders } = await import('./reminders.mjs');
  const rows = Reminders.list().filter((r) => matchesAny(needle, r.note, r.status));
  return cap(rows, limit).map((r) => ({
    id: r.id,
    title: r.note,
    snippet: r.status || '',
  }));
}

async function searchResearch(needle, limit) {
  const { Research } = await import('./research.mjs');
  const rows = Research.list().filter((r) => matchesAny(needle, r.question));
  return cap(rows, limit).map((r) => ({
    id: r.id,
    title: r.question,
    snippet: r.createdAt || '',
  }));
}

const SEARCHERS = {
  notes: searchNotes,
  tasks: searchTasks,
  reminders: searchReminders,
  research: searchResearch,
};

// query(q, {limit}) -> {groups:[{module, label, results:[{id,title,snippet}]}]}
// Case-insensitive across modules. Never throws: a failing/missing module
// simply contributes no group. Empty-result groups are omitted.
export async function query(q, { limit = DEFAULT_LIMIT } = {}) {
  const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
  const cappedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
  if (!needle) return { groups: [] };

  const settled = await Promise.allSettled(
    MODULES.map(async (mod) => {
      try {
        const results = await SEARCHERS[mod](needle, cappedLimit);
        return { module: mod, label: LABELS[mod], results: Array.isArray(results) ? results : [] };
      } catch {
        return { module: mod, label: LABELS[mod], results: [] };
      }
    }),
  );

  const groups = settled
    .filter((s) => s.status === 'fulfilled')
    .map((s) => s.value)
    .filter((g) => g.results.length > 0);

  return { groups };
}

// modules() -> string[] — the fixed set of module keys this aggregator searches.
export function modules() {
  return [...MODULES];
}

export const Search = { query, modules };
export default Search;
