#!/usr/bin/env bash
# After a deploy: check that frooms.ch serves the invite preview images, so link previews in WhatsApp and
# iMessage don't silently break. If an image is missing, the site answers with the app page (text/html).
set -euo pipefail
SITE="${SITE:-https://frooms.ch}"
for path in og/0/_any.jpg og/0/HG-E-7.jpg og/0/space-MMB79.jpg; do
  for attempt in 1 2 3 4 5; do
    type="$(curl -s -o /dev/null -w '%{content_type}' "$SITE/$path?check=$(date +%s)")"
    [[ "$type" == image/jpeg* ]] && break
    sleep 3
  done
  if [[ "$type" != image/jpeg* ]]; then
    echo "✘ $SITE/$path is served as '$type', not an image: invite link previews are broken. Run npm run deploy again." >&2
    exit 1
  fi
done
echo "✓ Preview images are live on $SITE"
