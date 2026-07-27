#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# CLONE FRAME · HUB — local app launcher
# Starts the local server (if not already up) and opens the HUB as a Google
# Chrome app window. Everything runs on THIS machine. The window auto-pairs.
#
# Branded Google Chrome ONLY. The bundled Chrome-for-Testing runtime was
# removed on purpose: its permanent "for automated testing" banner and
# Google's 403 on sign-in flows (disallowed user agent) made it unusable as
# a daily driver. Chrome's main profile also brings the user's wallet
# extensions and Google session into the app window for free.
#
# Detaches both the server and the browser so they survive a double-click
# launch (launchd reaps the short-lived app process otherwise).
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR="${0:A:h}"          # …/clone-frame-hub/bridge
PORT="${HUB_BRIDGE_PORT:-8765}"
URL="http://127.0.0.1:${PORT}"
CONF="$HOME/.clone-frame-hub"
mkdir -p "$CONF"
umask 077                       # logs may hold hostnames/IPs — create them owner-only (0600)
exec >> "$CONF/launch.log" 2>&1
echo "── launch $(date '+%F %T') ──"

# resolve node (GUI launches have a minimal PATH)
NODE="$(command -v node 2>/dev/null || true)"
[ -z "$NODE" ] && [ -x /opt/homebrew/bin/node ] && NODE=/opt/homebrew/bin/node
[ -z "$NODE" ] && [ -x /usr/local/bin/node ] && NODE=/usr/local/bin/node
if [ -z "$NODE" ]; then
  osascript -e 'display alert "CLONE FRAME HUB" message "Node.js not found. Install Node and try again."' >/dev/null 2>&1
  exit 1
fi
echo "node: $NODE"

# Start the server if it is not up — orphan it via a subshell so it outlives this
# launcher process (survives double-click / launchd).
#
# AND restart it when it is up but STALE. This gate used to ask only "does it answer?",
# and a daemon running last week's code answers perfectly. So after an update the app
# would detect the mismatch, tell the owner to relaunch, and relaunching did nothing —
# the launcher looked at the old process, saw a healthy reply, and skipped. The one
# instruction the app gives for this was the one thing that could not work.
HEALTH="$(/usr/bin/curl -s --max-time 3 "${URL}/health" 2>/dev/null)"
NEEDS_START=0
case "$HEALTH" in
  '')                 NEEDS_START=1 ;;                 # nothing there
  *'"stale":true'*)   NEEDS_START=2 ;;                 # there, but older than the code on disk
esac
if [ "$NEEDS_START" = 2 ]; then
  echo "server is running an older build — restarting it…"
  # Ask it to stop, then make sure. Only ever the process holding OUR port on loopback.
  PIDS="$(/usr/sbin/lsof -ti "tcp:${PORT}" -sTCP:LISTEN 2>/dev/null)"
  for pid in $PIDS; do kill "$pid" 2>/dev/null; done
  for i in $(seq 1 25); do
    /usr/bin/curl -s --max-time 1 "${URL}/health" >/dev/null 2>&1 || break
    sleep 0.2
  done
  for pid in $PIDS; do kill -9 "$pid" 2>/dev/null; done
  NEEDS_START=1
fi
if [ "$NEEDS_START" = 1 ]; then
  echo "starting server…"
  ( cd "$SCRIPT_DIR" && nohup "$NODE" hub-bridge.mjs > "$CONF/server.log" 2>&1 & )
  for i in $(seq 1 60); do
    /usr/bin/curl -s "${URL}/health" >/dev/null 2>&1 && break
    sleep 0.2
  done
fi
FINAL="$(/usr/bin/curl -s --max-time 3 "${URL}/health" 2>/dev/null)"
case "$FINAL" in
  '')               echo "server DID NOT come up" ;;
  *'"stale":true'*) echo "server up — but STILL reports stale; check $CONF/server.log" ;;
  *)                echo "server up · current build" ;;
esac

# ── arm ONE auto-pair for the window we are about to open ─────────────────────
# The bridge injects the pairing token into a served page only when the pairing latch is
# armed, and the latch is spent by the first window. POST /pair re-arms it and is itself
# token-gated — so this launcher proves it is the owner by reading the 0600 token file,
# which it can do because it already runs as the owner (this grants nothing new).
#
# Two things depend on it: a SECOND app window pairs instead of opening dead, and — the
# reason it exists — an EXPIRING session (Settings → Session) is recoverable. When a
# token expires the bridge retires it and mints another; without this line the owner
# would be locked out of their own app until they killed the daemon.
TOKFILE="$CONF/bridge.token"
if [ -r "$TOKFILE" ] && /usr/bin/curl -sf -o /dev/null -X POST \
     -H "Authorization: Bearer $(cat "$TOKFILE")" "${URL}/pair"; then
  echo "pairing armed"
else
  echo "pairing not armed (the window will pair on the bridge's own launch latch)"
fi

# ── macOS privacy permissions the app silently needs ─────────────────────────
# TCC is evaluated per process AT LAUNCH, so a permission granted later does
# nothing until the bridge restarts — and a missing one fails deep inside a
# command ("Operation not permitted", "could not create image from display")
# with no hint of the real cause. Probe both here, once, and say it plainly.
PERM_MISSING=""
# stderr kept in $CONF/perm-probe.err — "denied" here has had ≥2 distinct causes
# (wrong TCC grantee, then something else); never debug it blind again.
if /usr/sbin/screencapture -x /tmp/.cfhub-perm-probe.png >/dev/null 2>"$CONF/perm-probe.err"; then
  rm -f /tmp/.cfhub-perm-probe.png "$CONF/perm-probe.err"
else
  PERM_MISSING="Screen Recording"
fi
ls "$HOME/Desktop" >/dev/null 2>&1 || PERM_MISSING="${PERM_MISSING:+$PERM_MISSING and }Full Disk Access"
if [ -n "$PERM_MISSING" ]; then
  # TCC attributes these permissions to the RESPONSIBLE process at the top of the
  # launch tree — the .app bundle the user double-clicked — not to $NODE or this
  # shell. Naming node here sent the user to grant the wrong binary (2026-07-25).
  APP_BUNDLE="$HOME/Applications/CLONE FRAME HUB.app"
  echo "macOS permission missing: $PERM_MISSING (grant to: $APP_BUNDLE)"
  osascript -e "display alert \"CLONE FRAME HUB\" message \"macOS is withholding: $PERM_MISSING.
The agent's screenshots and file access will fail until you grant it.

System Settings → Privacy & Security → $PERM_MISSING → add the APP itself:
$APP_BUNDLE

(Not node — macOS attributes the permission to the app you double-clicked.)

Then quit and relaunch the app (permissions only apply at start-up).\"" >/dev/null 2>&1 || true
fi

# ── Optional: the NATIVE Electron shell (opt-in) ──────────────────────────────
# The daily driver is now a Chrome --app window (below) — light, and it brings the
# user's real Chrome profile (wallet extensions + Google session) into the app for
# free. The Electron shell is heavier and only worth it for deep work ON the in-app
# Browser: there it's a REAL top-level WebContentsView (full pages, real navigation)
# instead of an iframe that degrades to a read-only preview on framing-blocked sites.
# Opt in with:  HUB_SHELL=electron ./launch.sh
# CFHUB_DEBUG=<port> adds a local remote-debugging port to Electron (testing only).
APP_DIR="${SCRIPT_DIR:h}/electron"
ELECTRON_APP="$APP_DIR/node_modules/electron/dist/Electron.app"
ELECTRON_CLI="$APP_DIR/node_modules/electron/cli.js"
if [ "${HUB_SHELL:-}" = "electron" ] && [ -d "$ELECTRON_APP" ]; then
  # `open` makes macOS treat it as a proper (self-responsible) app launch — needed for
  # any WebAuthn/Touch ID prompt inside the view; a nohup spawn makes the terminal the
  # responsible process and macOS silently refuses those prompts.
  echo "launching native Electron shell (self-responsible)"
  /usr/bin/open -na "$ELECTRON_APP" --args "$APP_DIR" ${CFHUB_DEBUG:+--remote-debugging-port=$CFHUB_DEBUG}
  echo "done"
  exit 0
elif [ "${HUB_SHELL:-}" = "electron" ] && [ -f "$ELECTRON_CLI" ]; then
  # fallback: run cli.js through the resolved node (PATH-independent); no passkeys
  echo "launching native Electron shell (node cli fallback)"
  ( cd "$APP_DIR" && nohup "$NODE" "$ELECTRON_CLI" . >> "$CONF/electron.log" 2>&1 & )
  echo "done"
  exit 0
fi

# ── DEFAULT: Google Chrome app window ─────────────────────────────────────────
if [ -d "/Applications/Google Chrome.app" ]; then
  # HUB_PROFILE=app  (default) → the HUB's own dedicated Chrome profile at
  #                   $CONF/chrome (migrated from the retired CfT profile, so
  #                   the app's Store/sessions carried over). Isolated from the
  #                   user's everyday browsing, and lets us seed profile prefs
  #                   the app needs without ever touching the real profile.
  # HUB_PROFILE=main → the user's real Chrome profile (wallet extensions +
  #                   existing Google session inside the app window).
  PROFILE="${HUB_PROFILE:-app}"
  echo "opening Google Chrome app window (profile: $PROFILE)"
  if [ "$PROFILE" = "main" ]; then
    /usr/bin/open -na "Google Chrome" --args \
      --app="$URL" \
      --no-first-run --no-default-browser-check
  else
    # Allow third-party cookies in the app profile (cookie_controls_mode 0):
    # anti-bot walls (Cloudflare Turnstile) and site logins set their cookies
    # from INSIDE the embedded frame — with 3P cookies blocked those cookies
    # never land and challenges/logins loop forever. Solving once must be
    # enough. Idempotent: only writes when the pref isn't already 0.
    mkdir -p "$CONF/chrome/Default"
    "$NODE" -e 'const f=process.argv[1],fs=require("fs");let j={};try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}j.profile=j.profile||{};if(j.profile.cookie_controls_mode!==0){j.profile.cookie_controls_mode=0;fs.writeFileSync(f,JSON.stringify(j))}' "$CONF/chrome/Default/Preferences" 2>/dev/null || true
    /usr/bin/open -na "Google Chrome" --args \
      --app="$URL" \
      --user-data-dir="$CONF/chrome" \
      --no-first-run --no-default-browser-check
  fi
else
  echo "Google Chrome not found — opening default browser"
  osascript -e 'display alert "CLONE FRAME HUB" message "Google Chrome is not installed. Opening in your default browser — install Chrome for the full app-window experience."' >/dev/null 2>&1 || true
  /usr/bin/open "$URL"
fi
echo "done"
