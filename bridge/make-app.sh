#!/bin/zsh
# Builds a double-clickable macOS app that launches the HUB.
# Uses osacompile (AppleScript applet) so the bundle has a REAL Mach-O
# executable — LaunchServices/Finder launch it reliably on modern macOS,
# unlike a shell-script-as-CFBundleExecutable (which `open` silently ignores).
#
# Usage:  zsh make-app.sh                    → ~/Applications/CLONE FRAME HUB.app
#         zsh make-app.sh /some/dir          → /some/dir/CLONE FRAME HUB.app
#         zsh make-app.sh --bundle [dir]     → SELF-CONTAINED app (see below)
#
# --bundle copies the whole app payload INSIDE the .app, at
#   CLONE FRAME HUB.app/Contents/Resources/hub/
# so the bundle is the entire program: index.html, the runtime assets, the daemon
# and its node_modules. Nothing points back at the folder you downloaded, so that
# folder can go in the Trash, and updating is what anyone would guess it is —
# delete the old .app, run the new installer. Without the flag (the developer
# flow) the .app is a shortcut into the working tree, exactly as before.
set -e
SCRIPT_DIR="${0:A:h}"
BUNDLE=0
if [ "${1:-}" = "--bundle" ]; then BUNDLE=1; shift; fi
LAUNCH="$SCRIPT_DIR/launch.sh"
chmod +x "$LAUNCH"
DEST_DIR="${1:-$HOME/Applications}"
mkdir -p "$DEST_DIR"
APP="$DEST_DIR/CLONE FRAME HUB.app"
rm -rf "$APP"

# AppleScript applet that fires the launcher (launch.sh detaches server+browser).
# In bundle mode the launcher it fires is the COPY inside the bundle, so the app
# never depends on where it was installed from.
if [ "$BUNDLE" = 1 ]; then
  osacompile -o "$APP" -e 'do shell script quoted form of (POSIX path of (path to resource "hub:bridge:launch.sh"))'
else
  osacompile -o "$APP" -e "do shell script \"'$LAUNCH'\""
fi

# metadata
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName 'CLONE FRAME HUB'" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string 'CLONE FRAME HUB'" "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 'CLONE FRAME HUB'" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string 'io.cloneframe.hub'" "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier 'io.cloneframe.hub'" "$PLIST" 2>/dev/null || true
# ONE version number. This line carried 0.2.0 while package.json said 0.3.0, so the .app the
# owner double-clicked reported a version two releases old in Finder's Get Info. Read it from
# the manifest, like every other surface does through the @@CF_VERSION@@ build token.
# …and read it through SCRIPT_DIR, which zsh sets correctly. This line used to say
# ${BASH_SOURCE[0]} under a #!/bin/zsh shebang: zsh leaves that empty, so `dirname ""`
# is "." and the version came from whatever directory you happened to be standing in.
# It looked right only because everyone ran it from bridge/.
APP_VERSION="$(node -p "require('$SCRIPT_DIR/package.json').version" 2>/dev/null || echo 0.0.0)"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string '$APP_VERSION'" "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString '$APP_VERSION'" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool false" "$PLIST" 2>/dev/null || true

# optional custom icon (replaces the applet icon) if hub.icns is present
if [ -f "$SCRIPT_DIR/hub.icns" ]; then
  cp "$SCRIPT_DIR/hub.icns" "$APP/Contents/Resources/applet.icns"
fi

# ── bundle mode: copy the whole payload in, BEFORE signing ───────────────────────
# HUB_ROOT is path.dirname(BRIDGE_DIR) — the daemon serves the app from its own
# parent directory — so laying the tree down as Resources/hub/{index.html,bridge,…}
# is all it takes. Everything the daemon WRITES lives in ~/.clone-frame-hub and
# ~/CloneFrame, never in here, so a read-only bundle is correct and your data
# survives deleting the app.
if [ "$BUNDLE" = 1 ]; then
  ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  HUBDIR="$APP/Contents/Resources/hub"
  mkdir -p "$HUBDIR"
  # The payload, named explicitly. An allowlist, not "everything except" — a folder
  # added to the tree tomorrow must not silently ride into everyone's Applications.
  for item in index.html mdlite.js privy-login.js vendor bridge agent context integrations package.json; do
    [ -e "$ROOT/$item" ] && cp -R "$ROOT/$item" "$HUBDIR/"
  done
  # dist/index.html wins over the root copy when both exist (transport/static.mjs), and
  # they are byte-identical — ship one, not two, and let the root file be the one.
  rm -rf "$HUBDIR/dist"
  # Never inherit a machine's node_modules. It carries dev dependencies, and worse, it
  # carries whatever that machine happened to have installed — a bundle must be built from
  # the manifest, not from someone's working tree. At ANY depth: agent/.pi/npm/node_modules
  # is four levels down, is gitignored, is symlinked from ~/.pi at runtime rather than read
  # from here, and was 23 MB of the first bundle this produced.
  find "$HUBDIR" -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true
  find "$HUBDIR" -name .DS_Store -delete 2>/dev/null || true
  echo "  · installing the daemon's dependencies into the bundle…"
  ( cd "$HUBDIR/bridge" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 ) || \
    echo "  ! npm install failed inside the bundle — the app still runs, minus the features those add-ons power"
  chmod +x "$HUBDIR/bridge/launch.sh" "$HUBDIR/bridge/make-app.sh" 2>/dev/null || true
fi

# ad-hoc sign so Gatekeeper/LaunchServices launch it without warnings.
# LAST: signing seals the bundle, so anything copied in afterwards invalidates it.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

# register with Launch Services
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
echo "✓ created: $APP"
