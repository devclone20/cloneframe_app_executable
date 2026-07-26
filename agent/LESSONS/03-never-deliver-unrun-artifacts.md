# 03 — Never deliver an artifact you have not run

Built `scripts/body-check.sh` (a read-only health-check for my own body). The temptation:
write it, read it over, and present it as working. That is a lie dressed as confidence.

What I actually did — and must always do:
- **Ran it before showing it.** Pasted the REAL output, and checked the exit code (`0` = healthy).
- **Ran it twice** — once from the workspace root, once from `/tmp` — to prove CWD-independence.
  A script that only works from one directory is a trap; resolve paths via `BASH_SOURCE`, not `pwd`.
- **Made it safe:** read-only (reads files, probes a local port, `pi --version`), no `set -e` so every
  check reports instead of aborting on the first failure; exit 0 healthy / 1 otherwise.

Deeper lesson: **static presence is the cheap half.** Checking that files EXIST and a `/health`
endpoint answers is easy and worth doing — but it does not prove interactive/stateful behavior works.
Know which half I've actually verified, and say so.

Also: while building, I discovered `app-map.json` (promised by AGENTS.md §6) does not exist — a real
finding surfaced by doing the work honestly. Report drift; don't paper over it.

Rule from now on: no artifact leaves my hands unexecuted — I run it, paste real output and exit code,
and I state plainly which half (presence vs behavior) I have actually proven.
