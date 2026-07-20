#!/usr/bin/env bash
# CLONE FRAME HUB — dev smoke (the G4 gate in one command).
#
# Proves the bridge parses + boots + dispatches, on a DEV port (:8799 by default)
# so the owner's daily driver on :8765 is never touched. Used by every ticket gate
# and by CI. Exit 0 = green.
#
#   scripts/dev-smoke.sh            # default dev port 8799
#   HUB_BRIDGE_PORT=8123 scripts/dev-smoke.sh
set -uo pipefail

HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${HUB_BRIDGE_PORT:-8799}"
URL="http://127.0.0.1:${PORT}"
FAIL=0
STARTED=""

say(){ printf '%s\n' "$*"; }
ok(){  printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad(){ printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }

if [ "$PORT" = "8765" ]; then
  say "refusing to smoke against :8765 (the owner's live app). Use a dev port."; exit 2
fi

# ── G1 · every bridge module parses ──────────────────────────────────────────
say "── syntax (node --check bridge/*.mjs) ──"
SYN_OK=1
for f in "$HUB_DIR"/bridge/*.mjs; do
  node --check "$f" 2>/dev/null || { bad "syntax: ${f##*/}"; SYN_OK=0; }
done
[ "$SYN_OK" = 1 ] && ok "all bridge/*.mjs parse"

# ── liveness · start a dev bridge on PORT only if not already healthy ─────────
say "── bridge liveness (:${PORT}) ──"
if ! curl -s -m 2 "${URL}/health" >/dev/null 2>&1; then
  ( cd "$HUB_DIR/bridge" && HUB_BRIDGE_PORT="$PORT" node hub-bridge.mjs >"/tmp/cf-smoke-${PORT}.log" 2>&1 & echo $! >"/tmp/cf-smoke-${PORT}.pid" )
  STARTED=1
  for _ in $(seq 1 60); do curl -s -m 2 "${URL}/health" >/dev/null 2>&1 && break; sleep 0.2; done
fi
HEALTH="$(curl -s -m 3 "${URL}/health" 2>/dev/null || true)"
if printf '%s' "$HEALTH" | grep -q '"ok":true'; then ok "/health → ${HEALTH}"; else bad "/health did not answer ok"; fi

# ── bonus · authed module dispatch, if a pairing token exists (non-fatal) ─────
TOK="$HOME/.clone-frame-hub/bridge.token"
if [ -f "$TOK" ]; then
  RESP="$(curl -s -m 4 -X POST "${URL}/mod/models" \
      -H "Authorization: Bearer $(cat "$TOK")" -H "Host: 127.0.0.1:${PORT}" \
      -H "Content-Type: application/json" -d '{"fn":"listProviders","args":[]}' 2>/dev/null || true)"
  if printf '%s' "$RESP" | grep -q '.'; then ok "/mod dispatch alive (models.listProviders answered)"; \
  else say "  · /mod gave no body (token/Sec-Fetch gate) — non-fatal"; fi
fi

# ── clean up only the bridge we started ──────────────────────────────────────
if [ -n "$STARTED" ] && [ -f "/tmp/cf-smoke-${PORT}.pid" ]; then
  kill "$(cat "/tmp/cf-smoke-${PORT}.pid")" 2>/dev/null || true
  rm -f "/tmp/cf-smoke-${PORT}.pid"
fi

say ""
if [ "$FAIL" = 0 ]; then say "SMOKE OK"; exit 0; else say "SMOKE FAILED"; exit 1; fi
