"""Print Zentrum buildings and room types from the catalogue snapshot."""

import json
from collections import Counter
from pathlib import Path

SNAPSHOT = Path(__file__).resolve().parent.parent / "data" / "rooms_snapshot.json"


def main() -> None:
    rooms = [r for r in json.loads(SNAPSHOT.read_text()) if r.get("area") == "Z"]
    print(f"{len(rooms)} rooms in Zentrum\n")

    print("Rooms per building:")
    for building, n in sorted(Counter(r["building"] for r in rooms).items()):
        print(f"  {building:6} {n:4}")

    print("\nTypes (typecode, type, count, total seats):")
    types = Counter((r["typecode"], r["type"]) for r in rooms)
    seats = Counter()
    for r in rooms:
        seats[(r["typecode"], r["type"])] += int(r["seats"] or 0)
    for (code, label), n in sorted(types.items(), key=lambda kv: -kv[1]):
        print(f"  {code:6} {label:45} {n:4} {seats[(code, label)]:6}")


if __name__ == "__main__":
    main()
