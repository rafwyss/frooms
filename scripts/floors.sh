#!/usr/bin/env bash
# ETH's floor plans live in the private repo (frooms-priv, folder floors-release/) until ETH agrees to frooms
# showing them. This script brings them into this checkout.
#
#   scripts/floors.sh on [path-to-frooms-priv]   copy them in and turn the floor view on, for local work only
#   scripts/floors.sh off                        take them out again and turn the floor view off
#   scripts/floors.sh release [path]             publish them for good: copy them in, turn the floor view on,
#                                                and remove every guard (ignore rules, .assetsignore, CI check)
#
# After `on`, static/map/floors/index.json and static/map.js show as changed: never commit them (CI's
# scripts/check_no_floors.sh fails on both). The plans themselves are git-ignored and static/.assetsignore keeps
# them off every upload, previews included. The private repo defaults to ../frooms-priv.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cmd="${1:-}"
priv="${2:-$root/../frooms-priv}"
src="$priv/floors-release"

flag() { # flag true|false: set FLOOR_PLANS in static/map.js
  sed -i.bak -E "s/^const FLOOR_PLANS = (true|false);/const FLOOR_PLANS = $1;/" "$root/static/map.js"
  rm "$root/static/map.js.bak"
  grep -q "^const FLOOR_PLANS = $1;" "$root/static/map.js" || { echo "FLOOR_PLANS not found in static/map.js" >&2; exit 1; }
}

copy_in() {
  [ -f "$src/static/map/floors/index.json" ] || { echo "No floor plans at $src (give the path to frooms-priv)" >&2; exit 1; }
  cp "$src"/static/map/floors/*.json "$root/static/map/floors/"
  mkdir -p "$root/data/floors/edits"
  cp "$src"/data/floors/*.json "$root/data/floors/"
  cp "$src"/data/floors/edits/*.json "$root/data/floors/edits/"
  flag true
}

case "$cmd" in
  on)
    copy_in
    echo "Floor plans on (local only: don't commit static/map.js's FLOOR_PLANS or static/map/floors/index.json)."
    ;;
  off)
    find "$root/static/map/floors" -type f ! -name index.json -delete
    echo "{}" > "$root/static/map/floors/index.json"
    find "$root/data/floors" -mindepth 1 ! -name levels.json -delete
    flag false
    echo "Floor plans off. Edits made meanwhile (data/floors/) are gone: copy them to $src first if you want to keep them."
    ;;
  release)
    copy_in
    # The ignore rules and the upload guard
    sed -i.bak -E '/^# ETH.s floor plans aren.t public/,/^!\/data\/floors\/levels\.json$/d' "$root/.gitignore"
    sed -i.bak -E '/^# The floor plans \(ETH/d; /^map\/floors$/d' "$root/static/.assetsignore"
    # The CI check
    sed -i.bak -E '/# ETH.s floor plans stay off main/,/run: scripts\/check_no_floors\.sh/d' "$root/.github/workflows/ci.yml"
    rm -f "$root/.gitignore.bak" "$root/static/.assetsignore.bak" "$root/.github/workflows/ci.yml.bak"
    rm "$root/scripts/check_no_floors.sh"
    echo "Floor plans released. Check \`git status\` and \`git diff\`, run the tests, then commit and push to main."
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
