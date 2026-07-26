#!/usr/bin/env bash
# git-memory · Mode A — put a FOLDERS folder under local version control, on request.
# Usage: save-folder.sh <folder> <message-file>
# init (if needed) + add -A + commit -F <message-file>. Local only — never pushes.
# -F only: never -m with backticks or '$' (the shell would execute them).
set -euo pipefail

FOLDER="${1:?usage: save-folder.sh <folder> <message-file>}"
MSGFILE="${2:?usage: save-folder.sh <folder> <message-file>}"

[ -d "$FOLDER" ]  || { echo "git-memory: '$FOLDER' is not a directory." >&2; exit 1; }
[ -f "$MSGFILE" ] || { echo "git-memory: message file '$MSGFILE' not found (use -F, never -m)." >&2; exit 1; }

git -C "$FOLDER" rev-parse --git-dir >/dev/null 2>&1 || git -C "$FOLDER" init
git -C "$FOLDER" add -A

if git -C "$FOLDER" diff --cached --quiet; then
  echo "git-memory: nothing to commit in '$FOLDER'."
  exit 0
fi

git -C "$FOLDER" commit -F "$MSGFILE"   # -F only, never -m "…"
echo "git-memory: committed '$FOLDER' (local only — not pushed)."
