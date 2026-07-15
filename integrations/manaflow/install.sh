#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# Installs Manaflow (=cmux) into THIS folder (integrations/manaflow/) — NO DOCKER.
# MIT (see NOTICE.md). The bridge (bridge/manaflow.mjs) runs it via scripts/dev.sh
# with SKIP_DOCKER_BUILD=true and embeds its :5173 UI in the INTEGRATIONS tab.
#
# NO-DOCKER data layer: instead of cmux's Docker Convex, we use the Convex CLI's
# ANONYMOUS LOCAL deployment (no login) — it runs its own backend on 127.0.0.1:3210.
# convex-setup.sh configures it, pushes the deployment env, and deploys the functions.
#
# This script does everything that does NOT need a cloud account:
#   • clones Manaflow + bun install
#   • ensures a Convex-supported Node.js (18/20/22/24) — convex "use node" actions need it
#   • generates local secrets + seeds src/.env (local Convex :3210 + feature stubs)
# THE ONE THING YOU MUST DO: create a free Hexclave/Stack Auth project (app.stack-auth.com)
# and paste its 3 keys into src/.env — Manaflow has no anonymous mode. Then press Launch;
# the launcher runs convex-setup.sh once to deploy the backend.
# ─────────────────────────────────────────────────────────────────────────────
set -e
DIR="${0:A:h}"
SRC="$DIR/src"
ENVF="$SRC/.env"
REPO="https://github.com/manaflow-ai/manaflow"

# 1) source
if [ -d "$SRC/.git" ]; then echo "src/ present — updating"; git -C "$SRC" pull --ff-only || true
else echo "cloning Manaflow → src/"; git clone --depth 1 "$REPO" "$SRC"; fi

# 1b) patch dev.sh — upstream OpenAPI readiness marker never matches the generator's real
#     output, so its 120s watchdog tears down a HEALTHY stack. Fix the marker (idempotent).
DEVSH="$SRC/scripts/dev.sh"
if [ -f "$DEVSH" ] && grep -q 'OPENAPI_READY_MARKER="watch-openapi complete"' "$DEVSH"; then
  /usr/bin/sed -i '' 's/OPENAPI_READY_MARKER="watch-openapi complete"/OPENAPI_READY_MARKER="initial client generation complete"/' "$DEVSH" \
    && echo "  ✓ patched dev.sh OpenAPI readiness marker"
fi

# 2) deps (Bun)
if command -v bun >/dev/null 2>&1; then echo "bun install…"; ( cd "$SRC" && bun install ) || echo "  ⚠ bun install incomplete";
else echo "note: 'bun' not found — install it: curl -fsSL https://bun.sh/install | bash"; fi

# 3) Convex-supported Node.js (18/20/22/24) — the system node may be too new (e.g. v26).
_node_ok=0
for d in /opt/homebrew/opt/node@22/bin /opt/homebrew/opt/node@24/bin /usr/local/opt/node@22/bin; do
  [ -x "$d/node" ] && { _node_ok=1; break; }
done
case "$(node -v 2>/dev/null)" in v18.*|v20.*|v22.*|v24.*) _node_ok=1;; esac
if [ "$_node_ok" != "1" ]; then
  if command -v brew >/dev/null 2>&1; then echo "installing node@22 (Convex needs a supported Node)…"; brew install node@22 >/dev/null 2>&1 && echo "  ✓ node@22" || echo "  ⚠ node@22 install failed — install a Node 18/20/22/24 manually";
  else echo "  ⚠ no Homebrew — install Node.js 18/20/22/24 so Convex 'use node' actions can deploy"; fi
fi

# 4) seed src/.env — local anonymous Convex (:3210) + generated secrets + feature stubs.
#    Optional third-party features (Modal sandboxes, GitHub App, Morph fast-apply, LLM key)
#    are STUBBED so every boot-time env gate passes; each degrades only its own feature until
#    you drop in a real value. Stack Auth keys are the one thing you must add yourself.
[ -f "$ENVF" ] || { [ -f "$SRC/.env.example" ] && cp "$SRC/.env.example" "$ENVF" || touch "$ENVF"; }
if ! grep -q "seeded by CLONE FRAME" "$ENVF" 2>/dev/null; then
  gen(){ /usr/bin/openssl rand -hex 32 2>/dev/null || echo "cf$(date +%s)$RANDOM$RANDOM"; }
  {
    echo ""
    echo "# --- seeded by CLONE FRAME (no-Docker local setup) ---"
    echo "CONVEX_URL=http://127.0.0.1:3210          # anonymous local Convex (convex-setup.sh)"
    echo "NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210"
    echo "CONVEX_INSTANCE_NAME=cmux-dev"
    echo "STACK_DATA_VAULT_SECRET=$(gen)"
    echo "CMUX_TASK_RUN_JWT_SECRET=$(gen)"
    echo "STACK_WEBHOOK_SECRET=$(gen)"
    echo "BASE_APP_URL=http://localhost:5173"
    echo "NEXT_PUBLIC_WWW_ORIGIN=http://localhost:9779"
    echo "# feature stubs — replace with real values to enable each feature:"
    echo "MODAL_TOKEN_ID=PLACEHOLDER_modal_sandbox_disabled"
    echo "MODAL_TOKEN_SECRET=PLACEHOLDER_modal_sandbox_disabled"
    echo "MORPH_API_KEY=PLACEHOLDER_morph_fast_apply_disabled"
    echo "CMUX_GITHUB_APP_ID=000000"
    echo "CMUX_GITHUB_APP_PRIVATE_KEY=PLACEHOLDER_github_app_disabled"
    echo "STACK_SUPER_SECRET_ADMIN_KEY=PLACEHOLDER_admin_key_not_used_at_runtime"
    echo "ANTHROPIC_API_KEY=PLACEHOLDER_add_real_key_or_use_in_app_settings"
    echo "# TODO (only cloud step): create a free project at https://app.stack-auth.com, then set"
    echo "# NEXT_PUBLIC_STACK_PROJECT_ID / NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY / STACK_SECRET_SERVER_KEY above"
  } >> "$ENVF"
  echo "  ✓ seeded src/.env (local Convex :3210 + generated secrets + feature stubs)"
fi

echo "\n✓ manaflow installed in $DIR — WITHOUT Docker."
echo "  Last step: put your free Hexclave/Stack Auth keys in $ENVF, then press Launch in the app."
echo "  (Launch runs convex-setup.sh once to deploy the Convex backend locally — no Docker.)"
