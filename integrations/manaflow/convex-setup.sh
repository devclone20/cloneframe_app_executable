#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# convex-setup.sh — bootstrap Manaflow's Convex data layer with NO DOCKER.
#
# cmux/Manaflow normally ships Convex inside its Docker image. This reproduces
# that setup Docker-free using the Convex CLI's ANONYMOUS LOCAL deployment:
#   • configures a local, no-login Convex deployment (packages/convex/.env.local),
#     which the CLI runs on 127.0.0.1:3210 (matches NEXT_PUBLIC_CONVEX_URL),
#   • pushes the deployment's required env vars (Convex functions read env from the
#     deployment's OWN store, NOT the OS shell) from src/.env,
#   • deploys the functions (schema + indexes) so the app has a working backend.
#
# Convex "use node" actions require a SUPPORTED Node.js (18/20/22/24). We locate a
# keg-only Homebrew LTS node and put it first on PATH (the system node may be too new).
#
# Idempotent: safe to re-run. Values persist in the deployment's sqlite store.
# ─────────────────────────────────────────────────────────────────────────────
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/src"
CONVEX_DIR="$SRC/packages/convex"
ROOT_ENV="$SRC/.env"

[ -d "$CONVEX_DIR" ] || { echo "convex-setup: $CONVEX_DIR missing (run install first)"; exit 1; }
[ -f "$ROOT_ENV" ]   || { echo "convex-setup: $ROOT_ENV missing"; exit 1; }

# ── PATH: supported node first, then bun ─────────────────────────────────────
for d in /opt/homebrew/opt/node@22/bin /opt/homebrew/opt/node@24/bin \
         /opt/homebrew/opt/node@20/bin /opt/homebrew/opt/node@18/bin \
         /usr/local/opt/node@22/bin /usr/local/opt/node@24/bin; do
  [ -x "$d/node" ] && { export PATH="$d:$PATH"; break; }
done
for d in "$HOME/.bun/bin" /opt/homebrew/bin /usr/local/bin; do
  [ -d "$d" ] && export PATH="$d:$PATH"
done
command -v bunx >/dev/null 2>&1 || { echo "convex-setup: bunx not found — install bun"; exit 1; }
NODE_V="$(node -v 2>/dev/null || echo none)"
case "$NODE_V" in
  v18.*|v20.*|v22.*|v24.*) : ;;
  *) echo "convex-setup: node $NODE_V is unsupported by Convex — installing node@22";
     command -v brew >/dev/null 2>&1 && brew install node@22 >/dev/null 2>&1 && export PATH="/opt/homebrew/opt/node@22/bin:$PATH" || {
       echo "  ⚠ could not install a supported node — convex 'use node' actions will fail"; }; ;;
esac
echo "convex-setup: using node $(node -v 2>/dev/null)"

cd "$CONVEX_DIR"

# ── 1) configure a local anonymous deployment (no login, no Docker) ──────────
if [ ! -f .env.local ] || ! grep -q "CONVEX_DEPLOYMENT" .env.local 2>/dev/null; then
  echo "convex-setup: configuring anonymous local deployment…"
  CONVEX_DEPLOYMENT= CONVEX_AGENT_MODE=anonymous \
    bunx convex dev --configure new --dev-deployment local --project cmux_local --once >/tmp/cf-convex-configure.log 2>&1 || true
fi
grep -q "CONVEX_DEPLOYMENT" .env.local 2>/dev/null || { echo "convex-setup: FAILED to configure local deployment"; tail -5 /tmp/cf-convex-configure.log 2>/dev/null; exit 1; }
echo "convex-setup: deployment = $(grep CONVEX_DEPLOYMENT .env.local | head -1)"

# ── 2) start the backend (persistent) so we can set env vars ─────────────────
LOG=/tmp/cf-convex-setup-dev.log; : > "$LOG"
( set -a; . "$ROOT_ENV" 2>/dev/null; set +a; unset CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY
  CONVEX_AGENT_MODE=anonymous bunx convex dev >"$LOG" 2>&1 ) &
DEV_PID=$!
for i in $(seq 1 40); do curl -sf -m 2 http://127.0.0.1:3210/version >/dev/null 2>&1 && break; sleep 1; done
curl -sf -m 2 http://127.0.0.1:3210/version >/dev/null 2>&1 || { echo "convex-setup: backend did not come up on :3210"; kill "$DEV_PID" 2>/dev/null; tail -8 "$LOG"; exit 1; }
echo "convex-setup: backend up on 127.0.0.1:3210"

# ── 3) push required env into the DEPLOYMENT's env store (from src/.env) ──────
# Convex functions read env from the deployment, not the shell. These are every var a
# convex module reads at import time (Stack/Hexclave client, Modal, JWT, webhook…).
KEYS="STACK_WEBHOOK_SECRET STACK_SECRET_SERVER_KEY STACK_SUPER_SECRET_ADMIN_KEY STACK_DATA_VAULT_SECRET \
NEXT_PUBLIC_STACK_PROJECT_ID NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY BASE_APP_URL CMUX_TASK_RUN_JWT_SECRET \
MODAL_TOKEN_ID MODAL_TOKEN_SECRET MORPH_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY \
CMUX_GITHUB_APP_ID CMUX_GITHUB_APP_PRIVATE_KEY"
set_count=0
for k in $KEYS; do
  v="$(node -e 'const fs=require("fs");const r=fs.readFileSync(process.argv[1],"utf8");const m={};for(const l of r.split(/\r?\n/)){const x=l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);if(x){let val=x[2].replace(/\s+#.*$/,"").trim();m[x[1]]=val;}}process.stdout.write(m[process.argv[2]]||"");' "$ROOT_ENV" "$k")"
  [ -z "$v" ] && continue
  if bunx convex env set "$k" "$v" >/dev/null 2>&1; then set_count=$((set_count+1)); fi
done
echo "convex-setup: pushed $set_count deployment env vars"

# ── 4) deploy functions (schema + indexes) and confirm ───────────────────────
( set -a; . "$ROOT_ENV" 2>/dev/null; set +a; unset CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY
  CONVEX_AGENT_MODE=anonymous bunx convex dev --once >>"$LOG" 2>&1 ) || true
if grep -q "Convex functions ready" "$LOG"; then echo "convex-setup: ✓ Convex functions deployed (no Docker)"; RC=0; else echo "convex-setup: ⚠ functions not confirmed — see $LOG"; RC=1; fi

# ── 5) stop our backend; dev.sh owns Convex at runtime ───────────────────────
kill "$DEV_PID" 2>/dev/null; wait "$DEV_PID" 2>/dev/null
exit $RC
