#!/usr/bin/env bash
# CLONE FRAME HUB — build gate (G3). Rebuilds the single-file app, proves determinism, and
# runs the build assertions (identity, single-html, self-contained, injection anchor).
#   scripts/build-check.sh
set -uo pipefail
HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$HUB_DIR"

ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad(){ printf '  \033[31m✗\033[0m %s\n' "$*"; }

node tools/build.mjs >/dev/null || { bad "build failed"; exit 1; }
H1="$(shasum -a 256 dist/index.html | awk '{print $1}')"
node tools/build.mjs >/dev/null
H2="$(shasum -a 256 dist/index.html | awk '{print $1}')"
if [ "$H1" = "$H2" ]; then ok "A5 deterministic (${H1:0:12}…)"; else bad "A5 non-deterministic build"; exit 1; fi

# Step-0 extra: dist must equal the hand-authored monolith byte-for-byte.
if cmp -s index.html dist/index.html; then ok "dist/index.html === index.html (cmp-clean)"; else
  printf '  \033[33m·\033[0m dist diverged from root index.html (expected once web/ is peeled)\n'; fi

node --test tools/build.test.mjs || { bad "build assertions failed"; exit 1; }
echo "BUILD-CHECK OK"
