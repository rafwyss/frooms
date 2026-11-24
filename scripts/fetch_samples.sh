#!/usr/bin/env bash
# Fetch the room catalogue and test samples from ETH's room-info API.
# Note: the ML E 13 / ETA F 5 samples cover 26.10.–01.11.2026 and back the tests; don't re-download them.
# --cookpit refetches the three Cookpit rotas (Polyterrasse 9, Alumni quattro 14, Rice Up! 22, with nutrition). They
# back the menu tests too, which pin the week of 9.11.2026: refetching means moving those dates (test/menus.test.ts,
# test/prefetch.test.ts, test/worker.test.ts "menus").
set -euo pipefail
cd "$(dirname "$0")/.."

BASE='https://ethz.ch/bin/ethz/roominfo'
UA="frooms (personal project${FROOMS_CONTACT:+; $FROOMS_CONTACT})"

if [[ "${1:-}" == "--cookpit" ]]; then
  for f in 9 14 22; do
    curl -sS -A "$UA" "https://idapps.ethz.ch/cookpit-pub-services/v1/weeklyrotas?client-id=ethz-wcms&lang=en&facility=$f&valid-after=$(date +%F)&valid-before=$(date -v+14d +%F)&rs-first=0&rs-size=50" \
      -o "data/samples/cookpit_rotas_f$f.json"
  done
  exit 0  # only the rotas, not the catalogue
fi

curl -sS -A "$UA" "$BASE?path=/v2/rooms&lang=de" -o data/rooms_snapshot.json

if [[ "${1:-}" == "--samples" ]]; then
  curl -sS -A "$UA" "$BASE?path=/rooms/ML%20E%2013/allocations&from=2026-10-26&to=2026-11-01" \
    -o data/samples/allocations_ML_E_13.json
  curl -sS -A "$UA" "$BASE?path=/v2/rooms/ML%20E%2013&lang=de" -o data/samples/room_ML_E_13.json
  curl -sS -A "$UA" "$BASE?path=/min-max-allocation-date" -o data/samples/min_max_date.json
  curl -sS -A "$UA" "$BASE?path=/rooms/ETA%20F%205/allocations&from=2026-10-26&to=2026-11-01" \
    -o data/samples/allocations_ETA_F_5.json
fi

for f in data/rooms_snapshot.json data/samples/*.json; do
  [[ -f "$f" ]] || continue
  printf '%-45s %8s bytes  starts with: %s\n' "$f" "$(wc -c < "$f" | tr -d ' ')" "$(head -c 1 "$f")"
done
