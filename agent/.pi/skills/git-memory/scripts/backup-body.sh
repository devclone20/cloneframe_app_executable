#!/usr/bin/env bash
# git-memory · Mode B — back up the CLONE FRAME body before critical surgery.
# Branch + git bundle to ~/.clone-frame-hub/backups/ + visible mirror in ~/CloneFrame/Backups/.
# Never pushes. Prints the one-line warning for the owner. Safe to run repeatedly.
set -euo pipefail

# The body is wherever THIS checkout is — derived, never a hardcoded home path. A literal
# path is right on exactly one machine and silently wrong on every other: it made this
# script target a directory that does not exist for anyone who cloned the repo.
# $CLONE_FRAME_HOME overrides; otherwise walk up from the script to the repo root.
REPO="${1:-${CLONE_FRAME_HOME:-$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel 2>/dev/null || pwd)}}"
STAMP="$(date +%Y%m%d-%H%M)"        # no spaces, no ':' — valid refname, shell-safe
HIDDEN="$HOME/.clone-frame-hub/backups"
VISIBLE="$HOME/CloneFrame/Backups"
BUNDLE="pi-backup-$STAMP.bundle"

if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  echo "git-memory: '$REPO' is not a git repo — nothing to back up." >&2
  exit 1
fi

mkdir -p "$HIDDEN" "$VISIBLE"
git -C "$REPO" branch "pi-backup/$STAMP"
git -C "$REPO" bundle create "$HIDDEN/$BUNDLE" --all
cp "$HIDDEN/$BUNDLE" "$VISIBLE/$BUNDLE"

echo "Backup at $VISIBLE/$BUNDLE (branch pi-backup/$STAMP) — delete it, or keep it as context / a rollback point."
echo "Restore:  git clone \"$VISIBLE/$BUNDLE\" <dest>"
