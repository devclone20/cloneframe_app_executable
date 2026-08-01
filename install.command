#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# CLONE FRAME HUB — installer.
#
# Double-click this file. It builds "CLONE FRAME HUB.app" in ~/Applications with
# the whole program inside it — the app, its runtime assets, and the local daemon
# — and opens it. After that this folder is no longer needed and can go in the
# Trash; nothing points back at it.
#
# From Terminal instead:   zsh install.command
# (Use Terminal if macOS refuses the double-click: a file downloaded from the web
# carries a quarantine flag, and Finder will ask you to right-click → Open once.)
#
# TO UPDATE: drag the old "CLONE FRAME HUB.app" to the Trash, download the new
# release, and run this again. Your data is NOT in the app — it lives in
# ~/CloneFrame and ~/.clone-frame-hub — so an update never touches it.
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "${0:A:h}"                 # Finder runs .command files from your home folder
ROOT="$PWD"

say(){ printf '%s\n' "$*"; }
ok(){  printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad(){ printf '  \033[31m✗\033[0m %s\n' "$*"; }

say ""
say "  CLONE FRAME HUB — installer"
say "  ───────────────────────────"
say ""

# ── 1 · the app itself must be here ──────────────────────────────────────────
if [ ! -f "$ROOT/index.html" ] || [ ! -d "$ROOT/bridge" ]; then
  bad "this does not look like the CLONE FRAME HUB download"
  say "    Expected index.html and bridge/ next to this installer."
  say "    Re-download from https://github.com/devclone20/cloneframe_app_executable/releases/latest"
  say ""; read -r "?  Press return to close…"; exit 1
fi
ok "found the app ($(du -h "$ROOT/index.html" | cut -f1) index.html)"

# ── 2 · Node ─────────────────────────────────────────────────────────────────
# A GUI launch has a minimal PATH, so look where Node actually installs itself.
NODE="$(command -v node 2>/dev/null || true)"
[ -z "$NODE" ] && [ -x /opt/homebrew/bin/node ] && NODE=/opt/homebrew/bin/node
[ -z "$NODE" ] && [ -x /usr/local/bin/node ] && NODE=/usr/local/bin/node
if [ -z "$NODE" ]; then
  bad "Node.js is not installed"
  say ""
  say "    CLONE FRAME needs Node to run the small local daemon that talks to"
  say "    your machine. Install it from https://nodejs.org (the LTS build), or"
  say "    with Homebrew:  brew install node"
  say ""
  say "    Then run this installer again."
  say ""; read -r "?  Press return to close…"; exit 1
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  bad "Node $("$NODE" -v) is too old — CLONE FRAME needs 18 or newer"
  say "    Update from https://nodejs.org and run this again."
  say ""; read -r "?  Press return to close…"; exit 1
fi
export PATH="$(dirname "$NODE"):$PATH"
ok "Node $("$NODE" -v)"

# ── 3 · the daemon's add-ons ─────────────────────────────────────────────────
# Five small packages, every one imported behind a guard: the daemon boots without
# any of them, you simply lose that feature. node-pty is native, so it is the one
# that can fail — and it fails to a working app with no live terminal, not to a
# broken install. Say which, rather than printing a wall of npm output.
say "  · installing the daemon's add-ons (ws, node-pty, imapflow, mailparser, nodemailer)…"
if ( cd "$ROOT/bridge" && npm install --omit=dev --no-audit --no-fund >/tmp/cfhub-install.log 2>&1 ); then
  ok "add-ons installed"
else
  bad "some add-ons did not build — see /tmp/cfhub-install.log"
  say "    This is almost always node-pty, the live terminal, wanting the Xcode"
  say "    command line tools:  xcode-select --install"
  say "    Everything else still works; iT will say the terminal is unavailable."
fi

# ── 4 · build the double-clickable app, with the payload inside it ───────────
say "  · building CLONE FRAME HUB.app…"
zsh "$ROOT/bridge/make-app.sh" --bundle "$HOME/Applications"
APP="$HOME/Applications/CLONE FRAME HUB.app"
[ -d "$APP" ] || { bad "the app was not created"; read -r "?  Press return to close…"; exit 1; }

# Put the uninstaller somewhere the owner will actually find it. It also lives inside the
# bundle, but nobody goes hunting in Contents/Resources — and the line below used to tell
# people to run it while the line after told them to Trash the folder holding it.
UNINST="$HOME/Applications/Uninstall CLONE FRAME HUB.command"
cp "$ROOT/uninstall.command" "$UNINST" 2>/dev/null && chmod +x "$UNINST" 2>/dev/null
[ -f "$UNINST" ] && ok "uninstaller: $UNINST"

# ── 5 · open it ──────────────────────────────────────────────────────────────
say ""
ok "installed: $APP"
say ""
say "  Your data lives OUTSIDE the app and survives every update:"
say "    ~/CloneFrame          folders every frame reads and writes"
say "    ~/.clone-frame-hub    settings, pairing token, agent workspace"
say ""
say "  To update: Trash the app, download the new release, run its installer."
say "  To remove: Trash the app — or, for a full cleanup that also stops the daemon"
say "             and offers to delete your data:"
say "             $UNINST"
say ""
say "  This folder is no longer needed — the app carries everything it needs."
say ""
open "$APP"
say "  Opening…"
say ""
