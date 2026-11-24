#!/usr/bin/env bash
# Render the PWA icons in static/icons/ from static/logo.svg and static/icons/maskable.svg with headless Chrome.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

render() { # svg size out
  local svg="$1" size="$2" out="$3"
  printf '<html><body style="margin:0;background:transparent"><img src="file://%s" width="%s" height="%s"></body></html>' \
    "$PWD/$svg" "$size" "$size" > "$tmp/page.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size="$size,$size" --screenshot="$PWD/$out" "file://$tmp/page.html" >/dev/null 2>&1
  echo "$out"
}

render static/logo.svg 192 static/icons/icon-192.png
render static/logo.svg 512 static/icons/icon-512.png
render static/icons/maskable.svg 512 static/icons/maskable-512.png
render static/icons/maskable.svg 180 static/icons/apple-touch-icon.png
