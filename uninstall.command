#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# CLONE FRAME HUB — uninstaller.
#
# Stops the daemon and removes the app. Your DATA is a separate decision, asked
# for separately, because "remove the program" and "throw away my work" are not
# the same request and a tool that treats them as one is a tool that eats things.
#
# Double-click, or from Terminal:  zsh uninstall.command
# ─────────────────────────────────────────────────────────────────────────────
set -u
APP="$HOME/Applications/CLONE FRAME HUB.app"
CONF="$HOME/.clone-frame-hub"
DATA="$HOME/CloneFrame"
PORT="${HUB_BRIDGE_PORT:-8765}"

say(){ printf '%s\n' "$*"; }
ok(){  printf '  \033[32m✓\033[0m %s\n' "$*"; }

say ""
say "  CLONE FRAME HUB — uninstaller"
say "  ─────────────────────────────"
say ""

# ── 1 · stop the daemon ──────────────────────────────────────────────────────
# Only ever the process LISTENING on our port on loopback — never a pid matched by
# name, which on a developer's machine is somebody else's editor.
PIDS="$(/usr/sbin/lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
  for pid in ${=PIDS}; do kill "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in ${=PIDS}; do kill -9 "$pid" 2>/dev/null || true; done
  ok "stopped the daemon on 127.0.0.1:${PORT}"
else
  ok "the daemon was not running"
fi

# ── 2 · the app ──────────────────────────────────────────────────────────────
if [ -d "$APP" ]; then rm -rf "$APP"; ok "removed $APP"; else ok "no app in ~/Applications"; fi

# ── 3 · the data — asked for, never assumed ──────────────────────────────────
say ""
say "  Two things are left, and they are yours:"
say "    $DATA"
say "      the folders every frame reads and writes — Models, Agents, Data,"
say "      Harnesses, Servers, Downloads, Logs"
say "    $CONF"
say "      settings, the pairing token, your agent workspace and its curriculum"
say ""
say "  Keeping them means a future install picks up exactly where you left off."
say ""
printf '  Delete them too? Type DELETE to confirm, anything else to keep: '
read -r ANSWER
if [ "$ANSWER" = "DELETE" ]; then
  rm -rf "$CONF"; ok "removed $CONF"
  rm -rf "$DATA"; ok "removed $DATA"
  say ""
  say "  Gone. Note that this removed only what CLONE FRAME created. Anything the"
  say "  app helped you make elsewhere on disk — repositories, files an agent"
  say "  wrote, models you downloaded outside ~/CloneFrame — is untouched."
else
  ok "kept your data"
fi
say ""
say "  Done."
say ""
