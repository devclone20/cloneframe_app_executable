#!/bin/zsh
# Builds a double-clickable macOS app that launches the HUB.
# Uses osacompile (AppleScript applet) so the bundle has a REAL Mach-O
# executable — LaunchServices/Finder launch it reliably on modern macOS,
# unlike a shell-script-as-CFBundleExecutable (which `open` silently ignores).
#
# Usage:  zsh make-app.sh            → ~/Applications/CLONE FRAME HUB.app
#         zsh make-app.sh /some/dir  → /some/dir/CLONE FRAME HUB.app
set -e
SCRIPT_DIR="${0:A:h}"
LAUNCH="$SCRIPT_DIR/launch.sh"
chmod +x "$LAUNCH"
DEST_DIR="${1:-$HOME/Applications}"
mkdir -p "$DEST_DIR"
APP="$DEST_DIR/CLONE FRAME HUB.app"
rm -rf "$APP"

# AppleScript applet that fires the launcher (launch.sh detaches server+browser)
osacompile -o "$APP" -e "do shell script \"'$LAUNCH'\""

# metadata
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName 'CLONE FRAME HUB'" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string 'CLONE FRAME HUB'" "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 'CLONE FRAME HUB'" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string 'io.cloneframe.hub'" "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier 'io.cloneframe.hub'" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string '0.2.0'" "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString '0.2.0'" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool false" "$PLIST" 2>/dev/null || true

# optional custom icon (replaces the applet icon) if hub.icns is present
if [ -f "$SCRIPT_DIR/hub.icns" ]; then
  cp "$SCRIPT_DIR/hub.icns" "$APP/Contents/Resources/applet.icns"
fi

# ad-hoc sign so Gatekeeper/LaunchServices launch it without warnings
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

# register with Launch Services
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
echo "✓ created: $APP"
