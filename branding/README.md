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
codesign --force --sign - "$APP"   # the applet is ad-hoc signed; re-seal it
touch "$APP"; killall Dock Finder  # refresh the icon cache
```
