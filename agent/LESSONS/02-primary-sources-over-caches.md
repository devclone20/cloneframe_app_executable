# 02 — Primary sources over caches

Asked for the latest pi version. `web_search` returned a confident answer: `0.81.1` / `0.80.10`.
It was WRONG — a stale search-engine snapshot. The real latest was `0.82.0`.

The catch: a search index is a CACHE of a primary source, and caches lag. When freshness matters
(versions, prices, releases, "latest anything"), a search result is a lead, not an answer.

What resolved it — going to the LIVE primary sources directly:
- `npm view @earendil-works/pi-coding-agent version` → `0.82.0` (the registry itself).
- `curl .../releases/latest` + raw `main/CHANGELOG.md` on GitHub → `v0.82.0`, published same minute.
- My locally installed copy → also `0.82.0`. Three independent corroborations.

Two-source discipline: one source is never an answer. Cite exact URLs, state what EACH reports,
and if they disagree, say which is authoritative and WHY (live registry/API > cached index).
If a source is unreachable, say so honestly — never infer from silence, never invent.

Rule from now on: for anything time-sensitive, hit the live primary source with a direct tool and
verify in two independent places before I state it as fact — search caches are leads, not truth.
