#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# Installs the bundled browser runtime (Chrome for Testing) into THIS folder.
# CLONE FRAME launches in it so the Framer extension loads (branded Google Chrome
# 142+ ignores --load-extension). Chrome for Testing is a Chromium-family build
# published by Google specifically for automation — it honors --load-extension.
# Idempotent. ~172MB download from Google's official chrome-for-testing storage.
# ─────────────────────────────────────────────────────────────────────────────
set -e
DIR="${0:A:h}"
ARCH="mac-arm64"; [ "$(uname -m)" = "x86_64" ] && ARCH="mac-x64"
API="https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
# the zip extracts to a top-level folder named chrome-<arch>/
APP="$DIR/chrome-$ARCH/Google Chrome for Testing.app"

if [ -d "$APP" ]; then echo "Chrome for Testing already installed at:\n  $APP"; exit 0; fi

# resolve node (to parse the JSON API) — GUI launches have a minimal PATH
NODE="$(command -v node 2>/dev/null || true)"
[ -z "$NODE" ] && [ -x /opt/homebrew/bin/node ] && NODE=/opt/homebrew/bin/node
[ -z "$NODE" ] && [ -x /usr/local/bin/node ] && NODE=/usr/local/bin/node
if [ -z "$NODE" ]; then echo "node not found — needed to resolve the download URL"; exit 1; fi

URL="$(curl -s -m 25 "$API" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const u=j.channels.Stable.downloads.chrome.find(x=>x.platform===process.argv[1]);process.stdout.write(u?u.url:"")}catch(e){}})' "$ARCH")"
[ -z "$URL" ] && { echo "could not resolve Chrome for Testing URL for $ARCH"; exit 1; }

echo "downloading Chrome for Testing ($ARCH) — ~172MB\n  $URL"
ZIP="$DIR/.cft.zip"
curl -L --fail -m 900 -o "$ZIP" "$URL"
echo "unzipping…"
/usr/bin/unzip -q -o "$ZIP" -d "$DIR"
rm -f "$ZIP"
# clear the Gatekeeper quarantine so it launches without a security prompt
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
[ -x "$APP/Contents/MacOS/Google Chrome for Testing" ] && echo "✓ Chrome for Testing installed at:\n  $APP" || { echo "install looks incomplete"; exit 1; }
