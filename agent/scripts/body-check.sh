#!/usr/bin/env bash
#
# body-check.sh — a read-only health-check for CLONE FRAME's body (the pi agent).
#
# Checks, one ✓/✗ per line:
#   1. HUB Bridge answering on 127.0.0.1:8765/health
#   2. pi installed + its version
#   3. the 3 core extensions present (clone-frame.ts, goal.ts, fleet.ts)
#   4. the 5 skills present
#   5. the count of panels in the APP-MAP (AGENTS.md §3 AUTO PANELS table)
#   6. ~/CloneFrame/Attachments exists
#
# SAFE: read-only. Reads files, probes a local port with curl, runs `pi --version`.
# It creates/deletes/modifies nothing. Exits 0 when every check passes, 1 otherwise.

set -u  # no `set -e`: we want to run every check and report, not abort on first ✗

# Resolve the agent workspace root = parent of this script's dir, regardless of CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BRIDGE="${CFHUB_BRIDGE:-http://127.0.0.1:8765}"
FAIL=0

ok()   { printf '  \xe2\x9c\x93 %s\n' "$1"; }               # ✓
bad()  { printf '  \xe2\x9c\x97 %s\n' "$1"; FAIL=1; }        # ✗

echo "CLONE FRAME · body-check"
echo "workspace: ${ROOT}"
echo "---------------------------------------------"

# 1. HUB Bridge /health --------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  HEALTH="$(curl -fs -m 4 "${BRIDGE}/health" 2>/dev/null)"
  if [ -n "${HEALTH}" ] && printf '%s' "${HEALTH}" | grep -q '"ok":true'; then
    BV="$(printf '%s' "${HEALTH}" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
    ok "HUB Bridge answering on ${BRIDGE}/health (bridge v${BV:-?})"
  else
    bad "HUB Bridge not answering on ${BRIDGE}/health"
  fi
else
  bad "HUB Bridge check skipped — curl not found"
fi

# 2. pi installed + version ----------------------------------------------------
if command -v pi >/dev/null 2>&1; then
  PIV="$(pi --version 2>/dev/null | head -1 | tr -d '[:space:]')"
  ok "pi installed (version ${PIV:-unknown})"
else
  bad "pi not found on PATH"
fi

# 3. core extensions -----------------------------------------------------------
EXT_DIR="${ROOT}/.pi/extensions"
for ext in clone-frame.ts goal.ts fleet.ts; do
  if [ -f "${EXT_DIR}/${ext}" ]; then
    ok "extension present: ${ext}"
  else
    bad "extension MISSING: ${ext}"
  fi
done

# 4. skills (expect 5) ---------------------------------------------------------
SKILL_DIR="${ROOT}/.pi/skills"
EXPECTED_SKILLS="clone-frame-orchestration git-memory github-research guardrails supabase-data"
for sk in ${EXPECTED_SKILLS}; do
  if [ -f "${SKILL_DIR}/${sk}/SKILL.md" ]; then
    ok "skill present: ${sk}"
  else
    bad "skill MISSING: ${sk}"
  fi
done

# 5. panel count in the APP-MAP (AGENTS.md §3 AUTO PANELS table) ----------------
AGENTS_MD="${ROOT}/AGENTS.md"
EXPECTED_PANELS=27
if [ -f "${AGENTS_MD}" ]; then
  PANELS="$(awk '/BEGIN AUTO PANELS/{f=1;next} /END AUTO PANELS/{f=0} f' "${AGENTS_MD}" \
            | grep -E '^\|' | grep -vE '^\| *key *\|' | grep -vE '^\|[ -]+\|' | wc -l | tr -d ' ')"
  if [ "${PANELS}" = "${EXPECTED_PANELS}" ]; then
    ok "APP-MAP panel count = ${PANELS} (expected ${EXPECTED_PANELS})"
  else
    bad "APP-MAP panel count = ${PANELS:-0} (expected ${EXPECTED_PANELS})"
  fi
else
  bad "AGENTS.md not found — cannot count panels"
fi

# 6. ~/CloneFrame/Attachments --------------------------------------------------
ATT="${HOME}/CloneFrame/Attachments"
if [ -d "${ATT}" ]; then
  ok "attachments dir exists: ${ATT}"
else
  bad "attachments dir MISSING: ${ATT}"
fi

echo "---------------------------------------------"
if [ "${FAIL}" -eq 0 ]; then
  echo "RESULT: healthy ✓"
else
  echo "RESULT: unhealthy ✗"
fi
exit "${FAIL}"
