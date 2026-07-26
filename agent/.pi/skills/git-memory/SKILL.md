---
name: git-memory
description: Give the owner's folders and the app's own body version control — clean local git commits on request, and an automatic safety backup before any risky surgery on the CLONE FRAME app. Use when the owner says "save this", "git this", "commit it", "snapshot this", or before you edit the app's UI/design/code. Local only — never pushes without an order.
---

# Git memory — save work, back up the body

Git is memory and it is a seatbelt. Two modes, nothing more. **No git on "everything"** — only on
request, and at the one critical moment. No noise.

## Mode A — on request ("save this", "git this", "snapshot it")

The owner points at a folder in the CLONE FRAME **FOLDERS** (`~/CloneFrame/…`) and wants it under
version control.
```bash
git -C <folder> init                 # if it is not already a repo
git -C <folder> add -A
git -C <folder> commit -F <msgfile>  # clean message — see the safety law below
```
- Clean, meaningful commits. One logical change per commit.
- **Everything stays LOCAL** on the owner's machine. **Never `git push`** — never touch a remote —
  without an explicit order from the owner.

## Mode B — automatic, ONLY before critical surgery on the body

"The body" = the CLONE FRAME app's own checkout — any change to its UI, design, or code.
Before you edit it, back it up yourself. This is the one time you act without being asked.
Resolve the path, never assume it: `$CLONE_FRAME_HOME` if set, else the git root of the
checkout you are working in. It is a different directory on every machine.
```bash
STAMP=$(date +%Y%m%d-%H%M)
BODY="${CLONE_FRAME_HOME:-$(git rev-parse --show-toplevel)}"
git -C "$BODY" branch pi-backup/$STAMP
git -C "$BODY" bundle create \
  ~/.clone-frame-hub/backups/pi-backup-$STAMP.bundle --all
mkdir -p ~/CloneFrame/Backups
cp ~/.clone-frame-hub/backups/pi-backup-$STAMP.bundle ~/CloneFrame/Backups/   # visible mirror
```
- A branch (`pi-backup/<YYYYmmdd-HHMM>`) + a `git bundle` to `~/.clone-frame-hub/backups/`, AND a
  copy mirrored into a **visible** app folder (`~/CloneFrame/Backups/`) so the owner can find it in
  the FOLDERS panel.
- Then **WARN the owner** in one line: "Backup at `~/CloneFrame/Backups/pi-backup-<stamp>.bundle` —
  delete it, or keep it as context / a rollback point." The owner decides its fate later; you don't.
- Restore is one command:
  `git clone ~/CloneFrame/Backups/pi-backup-<stamp>.bundle <dest>` (full working tree from the
  bundle), or from inside the repo `git fetch <bundle> && git checkout pi-backup/<stamp>`.

The date stamp uses no spaces and no `:` — a valid branch/refname and shell-safe.

## ⚠️ Commit-message safety law (never break)

**Never put backticks or `$` inside a double-quoted `git commit -m "…"`.** The shell EXECUTES what
is in backticks / `$(…)` — a message like `` -m "fix `rm -rf ~`" `` runs the command for real.
Instead:
- write the message to a file and use `git commit -F <file>` (preferred for anything non-trivial), or
- use single quotes: `git commit -m 'plain message, no $ or backticks'`.

## scripts/

The two flows are one command away — helpers live beside this file in `scripts/`:
- `scripts/backup-body.sh` — the Mode-B branch + bundle + visible mirror, and it prints the warning
  line for the owner. Run it before any surgery on `clone-frame-hub`.
- `scripts/save-folder.sh <folder> <message-file>` — the Mode-A init / add / commit, `-F` only.

Both refuse to `push` and never use `-m` with backticks or `$`.
