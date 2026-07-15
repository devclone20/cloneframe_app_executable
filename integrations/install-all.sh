#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# CLONE FRAME — install every bundled integration into its own folder.
# Run once after download (or as a release-build step) so CLONE FRAME ships
# self-contained: EXO LAB and every integration installed in integrations/<name>/.
# Idempotent — safe to re-run; each integration's install.sh no-ops if present.
# ─────────────────────────────────────────────────────────────────────────────
set -e
DIR="${0:A:h}"
ORDER=(runtime exo tmux-orchestrator manaflow)   # framer needs no install (extension files ship as-is)

echo "CLONE FRAME · installing integrations into their folders"
for INT in $ORDER; do
  SH="$DIR/$INT/install.sh"
  if [ -x "$SH" ] || [ -f "$SH" ]; then
    echo "\n── $INT ──────────────────────────────────────────────"
    zsh "$SH" || echo "  ⚠ $INT install did not complete (you can re-run integrations/$INT/install.sh)"
  else
    echo "\n── $INT ── (no install.sh — nothing to do)"
  fi
done
echo "\n✓ done. Each integration lives in integrations/<name>/."
