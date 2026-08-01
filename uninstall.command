#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# CLONE FRAME HUB — uninstaller.
#
# Stops the program — all of it — and removes the app. Your DATA is a separate
# decision, asked for separately, because "remove the program" and "throw away my
# work" are not the same request and a tool that treats them as one is a tool that
# eats things.
#
# "All of it" is doing real work in that sentence. The daemon is not the only
# process CLONE FRAME starts:
#   • iT Keeper session daemons are spawned DETACHED on purpose, so a terminal
#     survives a reload. Nothing ever took them down again — not quitting, not
#     stopping the bridge, and not this script, whose guard matched only
#     `hub-bridge.mjs`. Each holds a live shell (DEBUG4 · CF4-B-005).
#   • The app window is a Chromium instance running against a profile we created
#     inside ~/.clone-frame-hub. Deleting that directory under a running browser
#     is not something to do quietly (DEBUG4 · CF4-A-009).
#
# Double-click, or from Terminal:  zsh uninstall.command
# ─────────────────────────────────────────────────────────────────────────────
set -u
CONF="$HOME/.clone-frame-hub"
DATA="$HOME/CloneFrame"
PORT="${HUB_BRIDGE_PORT:-8765}"
SELF="${0:A}"

say(){ printf '%s\n' "$*"; }
ok(){  printf '  \033[32m✓\033[0m %s\n' "$*"; }

# ── who is ours, and how to stop it ──────────────────────────────────────────
# One shared definition, also used by bridge/launch.sh and the smoke gate, so the
# "is this pid actually the HUB Bridge" rule cannot drift between copies again.
# This script is installed in TWO places — beside bridge/ in the download, and on
# its own at ~/Applications — so look in both, and carry a minimal fallback rather
# than fail if neither is reachable.
HP=""
for cand in \
  "${0:A:h}/bridge/hub-procs.sh" \
  "$HOME/Applications/CLONE FRAME HUB.app/Contents/Resources/hub/bridge/hub-procs.sh" \
  "/Applications/CLONE FRAME HUB.app/Contents/Resources/hub/bridge/hub-procs.sh" ; do
  [ -r "$cand" ] && { HP="$cand"; break; }
done
if [ -n "$HP" ]; then
  . "$HP"
else
  hub_own_pids(){ for p in $(/usr/sbin/lsof -ti "tcp:${1:-8765}" -sTCP:LISTEN 2>/dev/null); do
    case "$(/bin/ps -o command= -p "$p" 2>/dev/null)" in *hub-bridge.mjs*) printf '%s\n' "$p";; esac; done }
  hub_foreign_pids(){ for p in $(/usr/sbin/lsof -ti "tcp:${1:-8765}" -sTCP:LISTEN 2>/dev/null); do
    case "$(/bin/ps -o command= -p "$p" 2>/dev/null)" in *hub-bridge.mjs*) ;; *) printf '%s\n' "$p";; esac; done }
  hub_stop_port(){ n=0; for p in $(hub_own_pids "$1"); do kill "$p" 2>/dev/null && n=$((n+1)); done
    [ "$n" -gt 0 ] && { sleep 1; for p in $(hub_own_pids "$1"); do kill -9 "$p" 2>/dev/null; done; }
    printf '%s\n' "$n"; [ -z "$(hub_own_pids "$1")" ] }
  hub_keeper_pids(){ /bin/ps -eo pid=,command= 2>/dev/null | while read -r p c; do
    case "$c" in *keeper.mjs*_daemon*) printf '%s\n' "$p";; esac; done }
  hub_stop_keepers(){ n=0; for p in $(hub_keeper_pids); do kill "$p" 2>/dev/null && n=$((n+1)); done
    [ "$n" -gt 0 ] && { sleep 1; for p in $(hub_keeper_pids); do kill -9 "$p" 2>/dev/null; done; }
    printf '%s\n' "$n" }
fi

say ""
say "  CLONE FRAME HUB — uninstaller"
say "  ─────────────────────────────"
say ""

# ── 1 · stop the daemon ──────────────────────────────────────────────────────
# Only ever OUR daemon: the pid must be a node process running hub-bridge.mjs, not
# merely something holding port ${PORT}. `lsof -ti tcp:8765` alone once TERMed and
# KILL -9'd whatever else happened to like that port.
STOPPED="$(hub_stop_port "$PORT")"
for other in $(hub_foreign_pids "$PORT"); do
  say "  · left pid $other alone — it holds port ${PORT} but is not the HUB Bridge"
done
if [ "$STOPPED" -gt 0 ]; then ok "stopped the daemon on 127.0.0.1:${PORT}"
else ok "the daemon was not running"; fi

# ── 2 · stop the detached terminal sessions ──────────────────────────────────
KEEPERS="$(hub_stop_keepers)"
if [ "$KEEPERS" -gt 0 ]; then ok "stopped $KEEPERS detached iT session daemon(s)"
else ok "no detached iT sessions were running"; fi

# ── 3 · close the app window ─────────────────────────────────────────────────
# The window runs against a Chromium profile we created inside $CONF. If the data
# is deleted in step 5 while that browser is still running, we would be pulling its
# user-data-dir out from under it. Ask it to quit first; never force it.
if pgrep -f -- "--user-data-dir=$CONF/chrome" >/dev/null 2>&1; then
  pkill -f -- "--user-data-dir=$CONF/chrome" 2>/dev/null || true
  sleep 1
  ok "closed the CLONE FRAME app window"
fi

# ── 4 · the app ──────────────────────────────────────────────────────────────
# BOTH locations. Dragging a newly installed app from ~/Applications to /Applications
# is the most ordinary thing a macOS user does, and this script used to look only in
# the first — printing a green "no app in ~/Applications" while the app sat in the
# other one, so the whole run LOOKED successful and removed nothing.
REMOVED=0
for APP in "$HOME/Applications/CLONE FRAME HUB.app" "/Applications/CLONE FRAME HUB.app"; do
  if [ -d "$APP" ]; then
    if rm -rf "$APP" 2>/dev/null; then ok "removed $APP"; REMOVED=$((REMOVED+1))
    else say "  · could not remove $APP — it may need an administrator; try: sudo rm -rf \"$APP\""; fi
  fi
done
[ "$REMOVED" = 0 ] && ok "no CLONE FRAME HUB.app in ~/Applications or /Applications"

# ── 5 · the data — asked for, never assumed ──────────────────────────────────
say ""
say "  Two things are left, and they are yours:"
say "    $DATA"
say "      the folders every frame reads and writes — Models, Agents, Data,"
say "      Harnesses, Servers, Downloads, Logs"
say "    $CONF"
say "      settings, the pairing token, your agent workspace and its curriculum —"
say "      and the app's private browser profile (its cache and cookies), which is"
say "      usually the largest thing in here"
if [ -d "$CONF" ]; then say "      currently $(du -sh "$CONF" 2>/dev/null | cut -f1) on disk"; fi
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

# ── 6 · and finally this script, if it is the copy the installer left behind ──
# Following the old instructions to the letter left a file called "Uninstall CLONE
# FRAME HUB.command" sitting in ~/Applications for ever, pointing at a program that
# no longer existed. A tool that will not clear its own plate is not finished.
# The shell has already read this file, so removing it now is safe.
say ""
say "  Done."
say ""
case "$SELF" in
  "$HOME/Applications/"*|"/Applications/"*) rm -f -- "$SELF" 2>/dev/null ;;
esac
