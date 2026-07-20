#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# CLONE FRAME HUB · sync-mirror.sh  (T-002)
#
# Publishes a STERILIZED copy of the canonical tree
#   ~/Desktop/iFRAME/apps/clone-frame-hub
# into the public mirror clone
#   ~/Desktop/cloneframe_app_executable   (github.com/devclone20/cloneframe_app_executable)
#
# Retires the hand-replay. This script:
#   1. rsyncs the canonical tree into a scratch staging dir, excluding
#      local-only paths (never even touches the mirror's working tree yet).
#   2. runs a secret-scan + sterilization pass over the STAGING copy. Any hit
#      is a HARD FAIL — the script aborts and the mirror is left untouched.
#   3. only on a clean scan, rsyncs staging → the mirror's working tree
#      (still preserving the mirror's own .git/ and .gitignore).
#   4. prints a summary. It NEVER runs git add/commit/push — that is always
#      the owner's action, reviewed, in the mirror repo itself (ARCHITECTURE
#      /EXECUTION.md §6: "push is the owner's action, or explicitly approved").
#
# Usage:
#   scripts/sync-mirror.sh                  # canonical → ~/Desktop/cloneframe_app_executable
#   MIRROR_DIR=/path/to/mirror scripts/sync-mirror.sh
#   PROD_IP=203.0.113.7 scripts/sync-mirror.sh   # override the droplet-IP pattern being hunted
#   DRY_RUN=1 scripts/sync-mirror.sh             # rsync --dry-run everywhere, scan still runs
#
# Exit codes: 0 = synced clean. 1 = secret-scan hard-fail (mirror untouched).
#             2 = usage / environment error (missing tool, bad paths).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# ── paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"                                  # …/clone-frame-hub
MIRROR_DIR="${MIRROR_DIR:-$HOME/Desktop/cloneframe_app_executable}"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cfhub-mirror-stage.XXXXXX")"
DRY_RUN="${DRY_RUN:-}"

say(){ printf '%s\n' "$*"; }
ok(){  printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad(){ printf '  \033[31m✗\033[0m %s\n' "$*"; }
step(){ printf '\n── %s ──\n' "$*"; }

cleanup(){ rm -rf "$STAGE_DIR"; }
trap cleanup EXIT

# ── sanity ────────────────────────────────────────────────────────────────────
[ "$CANON_DIR" = "$MIRROR_DIR" ] && { say "canonical == mirror dir — refusing (check MIRROR_DIR)"; exit 2; }
command -v rsync >/dev/null 2>&1 || { say "rsync not found"; exit 2; }
if [ ! -d "$MIRROR_DIR/.git" ]; then
  say "MIRROR_DIR ($MIRROR_DIR) is not a git working tree — refusing to sync into it."
  say "Clone devclone20/cloneframe_app_executable there first, or set MIRROR_DIR=…"
  exit 2
fi

say "canonical : $CANON_DIR"
say "mirror    : $MIRROR_DIR"
say "staging   : $STAGE_DIR"
[ -n "$DRY_RUN" ] && say "mode      : DRY RUN (no writes to mirror)"

# ── 1. rsync canonical → staging, excluding local-only paths ─────────────────
# Mirrors this repo's own .gitignore intent (node_modules, .git, backups, logs,
# build output, editor/OS noise) PLUS the two mirror-specific exclusions the
# ticket calls out: ARCHITECTURE/ (in-progress planning notes — internal only)
# and integrations/runtime (downloaded Chrome-for-Testing runtime, never
# redistributed per its own ToS note in the canonical .gitignore).
step "1/4 · rsync canonical → staging"
RSYNC_EXCLUDES=(
  --exclude='.git/'
  --exclude='.git'
  --exclude='node_modules/'
  --exclude='**/node_modules/'
  --exclude='*.bak*'
  --exclude='ARCHITECTURE/'          # internal restructuring plan — not public
  --exclude='INTEGRATION_PLAN/'      # internal integration design notes — not public
  # Secret-handling test fixtures: these three files exist ONLY to prove the
  # redactor / OAuth store handle secrets, so they necessarily CONTAIN intentional
  # fake ones (sk-ant-…, AKIA…, xoxb-…, PRIVATE KEY headers, SECRET-… placeholders).
  # Keep them out of the mirror so the public face ships no key-shaped test vectors —
  # the secret-scan below stays STRICT (no allowlist holes), and the tests still run
  # in the canonical dev tree. A NEW such fixture will (correctly) fail the scan and
  # force a conscious add here rather than slipping through. (T-034 sync milestone.)
  --exclude='tests/redact-port.test.mjs'
  --exclude='tests/admin-fork.test.mjs'
  --exclude='tests/oauth-context.test.mjs'
  --exclude='build/'
  # NOTE: the public mirror's own .gitignore ignores dist/, so the built dist/index.html
  # is staged but not committed publicly today — harmless at Step 0 (the root index.html
  # fallback is byte-identical). FOLLOW-UP: un-ignore dist/ in the mirror before the peel
  # retires root index.html, so the public repo keeps shipping the built artifact.
  # NOTE: dist/index.html (the built, shippable single-file app) is intentionally
  # INCLUDED — it is the artifact a fresh public clone runs without build tools (T-005).
  --exclude='login-island/dist/'
  --exclude='integrations/runtime/'
  --exclude='integrations/*/src/'
  --exclude='integrations/*/.venv/'
  --exclude='integrations/*/venv/'
  --exclude='integrations/*/node_modules/'
  --exclude='integrations/**/_metadata/'
  --exclude='integrations/manaflow/convex-local-backend'
  --exclude='integrations/manaflow/*.sqlite3'
  --exclude='integrations/manaflow/convex_local_storage/'
  --exclude='integrations/manaflow/.convex*'
  --exclude='integrations/manaflow/.manaflow*'
  --exclude='*.log'
  --exclude='logs/'
  --exclude='*.pid'
  --exclude='.clone-frame-hub/'
  --exclude='.DS_Store'
  --exclude='**/.DS_Store'
  --exclude='.idea/'
  --exclude='.vscode/'
  --exclude='*.swp'
  --exclude='.env'
  --exclude='.env.*'
  --exclude='**/.env'
  --exclude='**/.env.*'
  --exclude='*.pem'
  --exclude='*.key'
  --exclude='*_rsa'
  --exclude='*_ed25519'
  --exclude='*.p12'
  --exclude='*.keystore'
  --exclude='*.pfx'
  --exclude='secrets.*'
  --exclude='*.secret'
  --exclude='.prod-ip'
  --exclude='scripts/.prod-ip'
)
rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$CANON_DIR/" "$STAGE_DIR/" || { bad "rsync to staging failed"; exit 2; }
ok "staged $(find "$STAGE_DIR" -type f | wc -l | tr -d ' ') files"

# ── 2. secret-scan + sterilization pass over STAGING (never the mirror) ──────
# Any hit here HARD-FAILS: exit non-zero, mirror is left completely untouched.
step "2/4 · secret-scan + sterilization (staging only)"
SCAN_FAIL=0

# 2a. production droplet IP — must NEVER appear in the public mirror.
#     The exact IP/range is kept OUT of this public script. It is read from
#     scripts/.prod-ip (gitignored, owner-local, one regex per first line), or from
#     $PROD_IP (exact address) / $PROD_IP_PATTERN (custom regex). With none set the
#     hunt is skipped with a loud warning rather than leaking a pattern here.
PROD_IP_PATTERN="${PROD_IP_PATTERN:-}"
if [ -n "${PROD_IP:-}" ]; then
  PROD_IP_PATTERN="$(printf '%s' "$PROD_IP" | sed 's/\./\\./g')"
elif [ -z "$PROD_IP_PATTERN" ] && [ -f "$SCRIPT_DIR/.prod-ip" ]; then
  PROD_IP_PATTERN="$(head -1 "$SCRIPT_DIR/.prod-ip" | tr -d '[:space:]')"
fi
if [ -n "$PROD_IP_PATTERN" ]; then
  HITS="$(grep -rInE "$PROD_IP_PATTERN" "$STAGE_DIR" 2>/dev/null | grep -v '/\.git/' || true)"
  if [ -n "$HITS" ]; then
    bad "production IP pattern found in staged tree:"
    printf '%s\n' "$HITS" | sed 's/^/      /'
    SCAN_FAIL=1
  else
    ok "no production droplet IP found"
  fi
else
  say "  · production-IP hunt skipped (set PROD_IP or scripts/.prod-ip to enable)"
fi

# 2b. API key shapes — sk-ant- (Anthropic), sk- (generic OpenAI-style), AKIA
#     (AWS access key id), ghp_ (GitHub PAT), xox (Slack tokens: xoxb/xoxp/xoxa/xoxs).
KEY_PATTERN='sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}'
HITS="$(grep -rInE "$KEY_PATTERN" "$STAGE_DIR" 2>/dev/null | grep -v '/\.git/' || true)"
if [ -n "$HITS" ]; then
  bad "API-key-shaped string found in staged tree:"
  printf '%s\n' "$HITS" | sed 's/^/      /'
  SCAN_FAIL=1
else
  ok "no API-key-shaped strings found"
fi

# 2c. private key headers (PEM/OpenSSH/PuTTY).
KEYHDR_PATTERN='-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----'
HITS="$(grep -rInE "$KEYHDR_PATTERN" "$STAGE_DIR" 2>/dev/null | grep -v '/\.git/' || true)"
if [ -n "$HITS" ]; then
  bad "private key header found in staged tree:"
  printf '%s\n' "$HITS" | sed 's/^/      /'
  SCAN_FAIL=1
else
  ok "no private key headers found"
fi

# 2d. gitleaks, if installed — belt-and-braces on top of the patterns above.
#     Non-fatal to run (report-only failures from gitleaks itself don't abort),
#     but a LEAKS FOUND verdict from gitleaks DOES hard-fail the sync.
if command -v gitleaks >/dev/null 2>&1; then
  GITLEAKS_OUT="$(mktemp)"
  # Use the repo's .gitleaks.toml (copied into staging) so vendored/built bundles are allowlisted.
  GITLEAKS_CFG=(); [ -f "$STAGE_DIR/.gitleaks.toml" ] && GITLEAKS_CFG=(--config "$STAGE_DIR/.gitleaks.toml")
  if gitleaks detect --no-git -s "$STAGE_DIR" "${GITLEAKS_CFG[@]}" --report-format json --report-path "$GITLEAKS_OUT" -v >/dev/null 2>&1; then
    ok "gitleaks: clean"
  else
    if [ -s "$GITLEAKS_OUT" ] && [ "$(cat "$GITLEAKS_OUT")" != "[]" ]; then
      bad "gitleaks found potential secrets — see $GITLEAKS_OUT"
      SCAN_FAIL=1
    else
      say "  · gitleaks exited non-zero without a findings report — treating as non-fatal (tool/config issue, not a proven leak)"
    fi
  fi
  rm -f "$GITLEAKS_OUT"
else
  say "  · gitleaks not installed — skipping (pattern scan above still ran)"
fi

if [ "$SCAN_FAIL" != 0 ]; then
  say ""
  bad "SECRET-SCAN FAILED — aborting. The mirror at $MIRROR_DIR was NOT touched."
  say "Fix the flagged content in the canonical tree (or its exclusion list) and re-run."
  exit 1
fi
ok "sterilization pass clean"

# ── 3. staging → mirror working tree (mirror's own .git/ untouched) ─────────
step "3/4 · staging → mirror working tree"
# The mirror owns its own PUBLIC FACE — README, LICENSE, docs/, its curated .gitignore —
# which do not exist in the canonical dev tree. Excluding them here both skips copying them
# AND protects them from --delete, so a sync updates the app without ever wiping the public
# repo's own presentation. (rsync: an excluded path is never deleted by --delete.)
MIRROR_RSYNC_FLAGS=(-a --delete
  --exclude='.git/'
  --exclude='README.md' --exclude='LICENSE' --exclude='LICENSE.*'
  --exclude='docs/' --exclude='.gitignore' --exclude='.github/')
if [ -n "$DRY_RUN" ]; then
  MIRROR_RSYNC_FLAGS+=(--dry-run -i)
  say "(dry run — showing what WOULD change in the mirror)"
fi
rsync "${MIRROR_RSYNC_FLAGS[@]}" "$STAGE_DIR/" "$MIRROR_DIR/" || { bad "rsync to mirror failed"; exit 2; }
ok "mirror tree updated"

# ── 4. summary — never auto-commit, never auto-push ──────────────────────────
step "4/4 · summary"
if [ -z "$DRY_RUN" ]; then
  say "git status in mirror:"
  ( cd "$MIRROR_DIR" && git status --short | sed 's/^/  /' )
  say ""
fi
say "Sync complete. Nothing was committed or pushed."
say "Review the diff, then from $MIRROR_DIR:"
say "    git add -A && git commit -m '…' && git push"
exit 0
