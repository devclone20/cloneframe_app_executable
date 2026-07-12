# Tasks / Cron Engine (`tasks.mjs`)

Single-file, zero-dependency cron + task store that runs **inside** the hub
bridge Node process. Node built-ins only. `./llm.mjs` is a static import;
`./email.mjs` and `./approvals.mjs` are **lazy** dynamic-imports inside run
handlers, so a missing/half-built sibling never breaks module load or the tick.

## Wiring into `hub-bridge.mjs`

```js
import { Tasks } from './tasks.mjs';

// At boot, once:
Tasks.init();            // load/seed ~/.clone-frame-hub/tasks.json (idempotent)
Tasks.startScheduler();  // single setInterval (~30s), self-guarding, never throws
```

`setInterval` is `unref()`-ed so it will not keep the process alive on its own.
Call `Tasks.stopScheduler()` on graceful shutdown if desired.

## Storage layout (`~/.clone-frame-hub/`, dir `0700`, files `0600`)

- `tasks.json` — `{ version, pausedAll, tasks: Task[] }` (atomic write).
- `task-sessions/<taskId>.json` — dedicated session log, `[{ts,role,text}]`, capped ~200.
- `task-runs/<taskId>.json` — run history, `Run[]`, capped ~100.

No secrets are ever written to any of these files or logs.

## Task shape

```jsonc
{
  "id": "builtin-email-summary",        // uuid for custom tasks
  "name": "Email (Summary)",
  "category": "email",                  // 'email' | 'custom' | ...
  "cron": "0 */2 * * *",                // 5-field: m h dom mon dow
  "state": "paused",                    // 'running' | 'paused'
  "isBuiltin": true,                     // built-ins: pause/edit, never remove
  "action": "builtin:emailSummary",     // see actions below
  "prompt": null,                        // custom tasks only
  "config": { "folders": ["INBOX"] },   // per-action options
  "sessionId": "builtin-email-summary", // == id; the dedicated session key
  "lastRunAt": null,                     // ISO | null
  "nextRunAt": "2026-07-09T02:00:00.000Z", // ISO | null (null when paused)
  "description": "…"
}
```

`list()` / `get()` return exactly:
`{id,name,category,cron,state,isBuiltin,action,lastRunAt,nextRunAt,sessionId,description}`.

### Actions
- `builtin:emailSummary` — summarise unread INBOX since `lastRunAt` (PT-PT) → session.
- `builtin:emailAutoReply` — draft replies to reply-worthy unread → `Approvals.add` (never sends).
- `builtin:emailTags` — classify unread INBOX into tags, `\Flagged` the urgent ones.
- `custom` — runs `ask([{role:'user',content:task.prompt}])`, appends result to session.

## Run shape (`activity()` items)

```jsonc
{
  "id": "uuid",
  "startedAt": "ISO",
  "finishedAt": "ISO",
  "status": "ok" | "error" | "skipped",
  "summary": "human string",
  "error": "message" | null,
  "sessionId": "taskId"
}
```

Every run is wrapped: throw → `error` run with the message; found no work →
`skipped`. Scheduled runs advance `lastRunAt` + recompute `nextRunAt`.

## Session entry shape (`session()` items)

```jsonc
{ "ts": "ISO", "role": "assistant" | "system" | "user", "text": "…" }
```

## Exported API

`Tasks` object (and matching named exports):

| Function | Args | Returns |
|---|---|---|
| `init()` | — | `void` (idempotent; seeds 3 built-ins once) |
| `startScheduler()` | — | `void` |
| `stopScheduler()` | — | `void` |
| `list()` | — | `TaskView[]` |
| `get(id)` | `id:string` | `TaskView \| null` |
| `add({name,category,cron,prompt,action,config})` | object | `{ok,id}` / `{ok:false,error}` |
| `update(id,patch)` | `id`, `{name?,cron?,config?,description?,category?,prompt?}` | `{ok}` / `{ok:false,error}` |
| `remove(id)` | `id` | `{ok}` (built-in → `{ok:false,error}`) |
| `setState(id,state)` | `id`, `'running'\|'paused'` | `{ok}` |
| `pauseAll(flag)` | `boolean` | `{ok,pausedAll}` |
| `isPausedAll()` | — | `boolean` |
| `runNow(id)` | `id` | `Promise<{ok,run}>` |
| `activity(id,{limit=20})` | `id`, opts | `Run[]` (newest first) |
| `session(id)` | `id` | `SessionEntry[]` |
| `nextRun(cron,from?)` | cron, `Date` | `Date \| null` |
| `isDue(cron,date?)` | cron, `Date` | `boolean` |
| `parseCron(cron)` | cron | parsed sets (throws on invalid) |

## Cron support

5 fields `m h dom mon dow`, each accepting `*`, `*/n`, `a,b`, `a-b`, `a-b/n`
and comma-lists thereof. `dow` 0 = Sunday. When **both** `dom` and `dow` are
restricted, a date matches if **either** matches (classic Vixie-cron OR rule).

## Scheduler semantics

- One `setInterval` (~30s). Respects global `pausedAll`.
- A task fires when `state==='running'` and `Date.now() >= nextRunAt`.
- Per-task in-flight lock: a due task whose previous run is still executing is skipped.
- After each scheduled run, `nextRunAt` is recomputed from the wall clock — no double-fire within a minute.
- The interval body can never throw (per-task and outer try/catch).
