#!/usr/bin/env bash
# Fails when ETH's floor plans would be published: static/map/floors/ may hold only an index.json whose content is
# {}, and static/map.js's FLOOR_PLANS must be false. Run by CI for pushes to main and pull requests into main.
# `scripts/floors.sh release` removes it (and its CI step) once ETH agrees to frooms showing the floor plans.
set -euo pipefail
root="$(dirname "$0")/.."
dir="$root/static/map/floors"
bad=0
if ! grep -q '^const FLOOR_PLANS = false;' "$root/static/map.js"; then
  echo "static/map.js must have FLOOR_PLANS = false on main (floor plans aren't released yet; scripts/floors.sh off)" >&2
  bad=1
fi
[ -d "$dir" ] || exit $bad
for f in "$dir"/* "$dir"/.[!.]*; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  if [ "$name" = "index.json" ]; then
    if [ "$(tr -d '[:space:]' < "$f")" != "{}" ]; then
      echo "static/map/floors/index.json must be {} on main (floor plans aren't released yet; scripts/floors.sh off)" >&2
      bad=1
    fi
  else
    echo "static/map/floors/$name must not be on main (floor plans aren't released yet)" >&2
    bad=1
  fi
done
exit $bad
