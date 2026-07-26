---
name: supabase-data
description: Treat data as a craft — stand up a local Postgres, run SQL, manage migrations, and connect to the owner's Supabase project. Use when the owner asks to put data in a database, query/join/aggregate structured data, import a CSV/JSON into tables, set up Supabase, or when flat files have clearly outgrown their job. On-demand — suggest it yourself only in extreme cases.
---

# Data as a craft — SQL / Supabase

Most data lives fine in files. Reach for a database when the shape of the work demands it — and,
mostly, when the owner asks.

## When to use it

- **On demand** — the owner asked for a database, SQL, queries, or Supabase. Just do it.
- **Suggest it yourself ONLY in extreme cases** — flat files visibly bursting (data too large or
  too relational for files; a real need for joins / aggregations / indexes / integrity). Then
  SUGGEST, explain exactly why a database beats files here, and **wait for a yes.** Don't spin up
  Postgres to store ten rows.

## 1. Detect the CLI (escalation ladder)
```bash
supabase --version
```
- Present → continue.
- Absent → climb the ladder, never install silently: tell the owner it's missing, hand them the
  ready command, and let them run it — `brew install supabase/tap/supabase` (macOS). **The 14-day
  quarantine (github-research skill / §10) applies**: verify the release age before recommending
  any install; the override is the owner's.

## 2. Local first — Postgres on the machine
```bash
supabase init          # scaffolds ./supabase in the target folder
supabase start         # boots local Postgres + Studio in Docker; prints the DB URL + keys
supabase status        # URLs and keys for the running stack
supabase stop          # tear the local stack down
```
Do the work locally before touching anything remote.

## 3. Schema & migrations — `supabase db`
```bash
supabase migration new <name>     # new timestamped SQL migration in supabase/migrations/
# … write the DDL in supabase/migrations/<ts>_<name>.sql …
supabase db reset                 # rebuild the local DB from migrations + seed
supabase db diff -f <name>        # capture live schema changes as a migration
supabase db push                  # apply migrations to the LINKED remote project
```

## 4. Connect to the owner's remote project (BYOK)
```bash
supabase login                    # opens the owner's browser to authorize
supabase link --project-ref <ref> # link this folder to the owner's project
```
- **BYOK**: the access token is the OWNER's. **Never store it in cleartext** — never write it to a
  file, a commit, a note, or the HTML. Use interactive `supabase login`, or pass it via an
  environment variable at run time (`SUPABASE_ACCESS_TOKEN`) so it lives only in that process.

## 5. Treat data in SQL (the everyday loop)
- **Import**: `\copy <table> from 'data.csv' csv header` in `psql`; for JSON, `COPY` into a staging
  table then unpack. Load CSV / JSON → tables.
- **Query**: joins, aggregations, window functions — the whole reason to leave files behind.
- **Export**: `\copy (select …) to 'out.csv' csv header`, or `supabase db dump` for the schema.

## ⚠️ Security rule — SECURITY INVOKER by default

Any function you create defaults to **`SECURITY INVOKER`** (runs with the CALLER's privileges).
**Never write `SECURITY DEFINER` without a written reason** in the migration comment explaining why
the elevation is necessary. Definer functions run as their owner and are a classic
privilege-escalation footgun.
```sql
create function app.thing(...) returns ...
  language sql
  security invoker            -- default; make it explicit
as $$ ... $$;
```

## Use cases
- Organize data the fleet collected (research runs, scraped datasets) into queryable tables.
- Turn a GitHub-research dataset into something you can join and filter.
- Keep a structured history the owner can actually query, instead of a pile of JSON.
