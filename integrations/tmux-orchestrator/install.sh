#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# Installs Tmux-Orchestrator into THIS folder (integrations/tmux-orchestrator/):
# upstream source → src/. MIT (see NOTICE.md). Needs `tmux` (brew install tmux).
# The bridge (bridge/tmuxorch.mjs — Fase 2) resolves these paths.
# ─────────────────────────────────────────────────────────────────────────────
set -e
DIR="${0:A:h}"
SRC="$DIR/src"
REPO="https://github.com/Jedward23/Tmux-Orchestrator"

if [ -d "$SRC/.git" ]; then
  echo "src/ present — updating"; git -C "$SRC" pull --ff-only || true
else
  echo "cloning Tmux-Orchestrator → src/"; git clone --depth 1 "$REPO" "$SRC"
fi

command -v tmux >/dev/null 2>&1 || echo "note: 'tmux' not found — install with: brew install tmux"
echo "✓ tmux-orchestrator installed in $DIR (src/)"
