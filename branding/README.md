# Branding — CLONE FRAME HUB app icon

`appicon.svg` is the source of truth: a black macOS squircle with the red
double-triangle (the in-app `#tri` menu mark, `--tri` #ff3b30). It also drives the
browser favicon (inlined as an SVG data-URI in `index.html`).

## Rebuild `applet.icns` (macOS, no extra deps)

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --default-background-color=00000000 \
  --window-size=1024,1024 --screenshot=icon.png "file://$PWD/appicon.svg"
mkdir CloneFrame.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s icon.png --out CloneFrame.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) icon.png --out CloneFrame.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns CloneFrame.iconset -o applet.icns
```

## Apply to the launcher app

```sh
APP="$HOME/Applications/CLONE FRAME HUB.app"
cp applet.icns "$APP/Contents/Resources/applet.icns"

# GOTCHA: this AppleScript applet also ships CFBundleIconName + an Assets.car asset
# catalog, and on modern macOS the asset catalog WINS over applet.icns — so replacing
# only the .icns leaves Finder/Dock showing the old icon (while the browser favicon,
# which is separate, already updates). Remove both so applet.icns becomes authoritative:
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist"
rm -f "$APP/Contents/Resources/Assets.car"

codesign --force --sign - "$APP"                       # ad-hoc applet; re-seal after edits
touch "$APP/Contents/Info.plist"; touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
mv "$APP" "$HOME/Applications/.refresh.app" && mv "$HOME/Applications/.refresh.app" "$APP"  # force re-catalog
killall Dock Finder                                    # icon cache is stubborn — this + the rename dance clears it
```
