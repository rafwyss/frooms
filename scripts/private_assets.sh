#!/usr/bin/env bash
# Copies the images frooms uses but may not publish (the mensa photos, UZH's share backgrounds; git-ignored here) from
# the private repo's private-assets/ into this checkout, then checks that every image the public lists name is there.
# CI's deploy job runs it with the private repo checked out at .private; locally the private repo defaults to
# ../frooms-priv. Run it before `npm run deploy` or `wrangler versions upload`, or those go out without the photos.
#
#   scripts/private_assets.sh [path-to-frooms-priv]
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
priv="${1:-$root/../frooms-priv}"
src="$priv/private-assets"
[ -d "$src/static" ] || { echo "No private assets at $src (give the path to frooms-priv)" >&2; exit 1; }
cp "$src"/static/mensa-photos/*.webp "$root/static/mensa-photos/"
cp "$src"/assets/share-backgrounds/* "$root/assets/share-backgrounds/"

# Every photo index.json lists and every background backgrounds.json and meals.json name must exist, so a deploy never
# goes out with some missing.
python3 - "$root" <<'EOF'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
missing = [f"static/mensa-photos/{i}.webp" for i in json.loads((root / "static/mensa-photos/index.json").read_text())
           if not (root / "static/mensa-photos" / f"{i}.webp").exists()]
bg = root / "assets/share-backgrounds"
for name in ("backgrounds.json", "meals.json"):
    missing += [f"assets/share-backgrounds/{s['file']}" for s in json.loads((bg / name).read_text()) if not (bg / s["file"]).exists()]
if missing:
    sys.exit("Missing private assets: " + ", ".join(missing))
print("Private assets in place.")
EOF
