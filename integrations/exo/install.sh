#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# Installs EXO into THIS folder (integrations/exo/): upstream source → src/,
# built runtime → .venv/. Idempotent. exo is Apache-2.0 (see NOTICE.md); we run
# it unmodified via its own CLI. The bridge (bridge/exo.mjs) resolves these paths.
# ─────────────────────────────────────────────────────────────────────────────
set -e
DIR="${0:A:h}"
SRC="$DIR/src"
VENV="$DIR/.venv"
REPO="https://github.com/exo-explore/exo"

# resolve python3 (GUI launches have a minimal PATH)
PY="$(command -v python3 2>/dev/null || true)"
[ -z "$PY" ] && [ -x /opt/homebrew/bin/python3 ] && PY=/opt/homebrew/bin/python3
[ -z "$PY" ] && [ -x /usr/bin/python3 ] && PY=/usr/bin/python3
if [ -z "$PY" ]; then echo "python3 not found — install Python 3 and re-run"; exit 1; fi

# 1) upstream source → src/  (clone, not submodule: clone-frame-hub is not its own repo)
if [ -d "$SRC/.git" ]; then
  echo "src/ present — updating"; git -C "$SRC" pull --ff-only || true
else
  echo "cloning exo → src/"; git clone --depth 1 "$REPO" "$SRC"
fi

# 2) built runtime → .venv/  (editable install of the upstream source)
[ -x "$VENV/bin/python" ] || { echo "creating venv"; "$PY" -m venv "$VENV"; }
echo "installing exo (editable)"; "$VENV/bin/pip" install -e "$SRC"

echo "✓ exo installed in $DIR (src/ + .venv/)"
