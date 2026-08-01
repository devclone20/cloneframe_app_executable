# ─────────────────────────────────────────────────────────────────────────────
# CLONE FRAME HUB — who is ours, and how to stop it.  (sourced, never executed)
#
# WHY THIS FILE EXISTS. `lsof -ti tcp:8765` filters by PORT NUMBER alone. Whatever
# holds that port — somebody's dev server, a tunnel, an unrelated app that happens
# to like it — got a TERM and then a KILL -9 from us. That was found and fixed in
# uninstall.command, the lesson was written down there… and launch.sh, twenty lines
# of shell away and running on EVERY app launch, kept doing it for another month
# (DEBUG4 · CF4-A-002).
#
# A rule that lives in two copies is a rule that loses one of them. So it lives
# here, once, and everything that stops a CLONE FRAME process calls it:
#
#   bridge/launch.sh        restarting a stale daemon
#   uninstall.command       removing the program
#   scripts/dev-smoke.sh    cleaning up after the gate
#
# POSIX sh on purpose — the callers are a mix of zsh and bash.
# ─────────────────────────────────────────────────────────────────────────────

# hub_own_pids PORT
#   Echo the pids LISTENING on PORT that are actually the HUB Bridge. Anything
#   else holding that port is not ours and is never printed, so a caller cannot
#   kill it by accident even if it wanted to.
hub_own_pids() {
  _hp_port="${1:-8765}"
  for _hp_pid in $(/usr/sbin/lsof -ti "tcp:${_hp_port}" -sTCP:LISTEN 2>/dev/null); do
    case "$(/bin/ps -o command= -p "$_hp_pid" 2>/dev/null)" in
      *hub-bridge.mjs*) printf '%s\n' "$_hp_pid" ;;
    esac
  done
}

# hub_foreign_pids PORT
#   The other half of the same question: pids holding PORT that are NOT ours.
#   A caller that wants to say "left pid N alone" needs this, and computing it
#   here keeps the two answers from drifting apart.
hub_foreign_pids() {
  _hp_port="${1:-8765}"
  for _hp_pid in $(/usr/sbin/lsof -ti "tcp:${_hp_port}" -sTCP:LISTEN 2>/dev/null); do
    case "$(/bin/ps -o command= -p "$_hp_pid" 2>/dev/null)" in
      *hub-bridge.mjs*) ;;
      *) printf '%s\n' "$_hp_pid" ;;
    esac
  done
}

# hub_stop_port PORT
#   Stop OUR daemon on PORT and make sure it is gone. TERM, wait up to ~5s for it
#   to leave on its own (it has a shutdown handler that reaps the browser engine
#   and the keeper daemons), then KILL, then verify.
#   Echoes how many it stopped. Returns 0 if the port is free afterwards, 1 if not.
hub_stop_port() {
  _hp_port="${1:-8765}"
  _hp_n=0
  for _hp_pid in $(hub_own_pids "$_hp_port"); do
    kill "$_hp_pid" 2>/dev/null && _hp_n=$((_hp_n + 1))
  done
  if [ "$_hp_n" -gt 0 ]; then
    _hp_i=0
    while [ "$_hp_i" -lt 25 ]; do
      [ -z "$(hub_own_pids "$_hp_port")" ] && break
      sleep 0.2
      _hp_i=$((_hp_i + 1))
    done
    for _hp_pid in $(hub_own_pids "$_hp_port"); do kill -9 "$_hp_pid" 2>/dev/null; done
    sleep 0.2
  fi
  printf '%s\n' "$_hp_n"
  [ -z "$(hub_own_pids "$_hp_port")" ]
}

# hub_keeper_pids
#   iT Keeper session daemons. These are spawned DETACHED and unref'd on purpose —
#   a terminal that survives a reload is the feature (bridge/keeper.mjs:328) — but
#   nothing in the product ever took them down again: not quitting, not stopping the
#   daemon, and not the uninstaller, whose guard matches `hub-bridge.mjs` and so
#   cannot see a process running `keeper.mjs` (DEBUG4 · CF4-B-005). Each one holds a
#   live shell, and one producing output never hits the 12h idle cap.
hub_keeper_pids() {
  /bin/ps -eo pid=,command= 2>/dev/null | while read -r _hp_pid _hp_cmd; do
    case "$_hp_cmd" in
      *keeper.mjs*_daemon*) printf '%s\n' "$_hp_pid" ;;
    esac
  done
}

# hub_stop_keepers
#   Stop every keeper daemon and verify. Echoes how many were stopped.
hub_stop_keepers() {
  _hp_n=0
  for _hp_pid in $(hub_keeper_pids); do
    kill "$_hp_pid" 2>/dev/null && _hp_n=$((_hp_n + 1))
  done
  if [ "$_hp_n" -gt 0 ]; then
    sleep 1
    for _hp_pid in $(hub_keeper_pids); do kill -9 "$_hp_pid" 2>/dev/null; done
  fi
  printf '%s\n' "$_hp_n"
}
