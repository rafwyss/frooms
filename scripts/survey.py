"""Phase 6 check: survey one week of allocations across Zentrum rooms.

Reports belegungstyp / findetStatt / lehrveranstaltungstyp values, empty responses,
and closing hours per building. One request per room; run sparingly.
"""

import asyncio
import json
import sys
from collections import Counter, defaultdict
from datetime import date

from app.catalogue import parse_catalogue
from app.eth_client import EthClient

TYPECODES = {"3430", "3420", "2110", "3510", "3410"}


async def main(start: str = "2026-10-26", end: str = "2026-11-01") -> None:
    async with EthClient() as client:
        rooms = [r for r in parse_catalogue(await client.catalogue(), "Z") if r.typecode in TYPECODES]

        async def fetch(room):
            try:
                return await client._get(f"/rooms/{room.path}/allocations", **{"from": start, "to": end})
            except Exception as e:  # noqa: BLE001 - survey wants to keep going
                return e

        results = await asyncio.gather(*(fetch(r) for r in rooms))

    typ, findet, lv, vtyp = Counter(), Counter(), Counter(), Counter()
    empty, errors, cancelled = [], [], []
    closing = defaultdict(Counter)
    for room, raw in zip(rooms, results):
        if isinstance(raw, Exception):
            errors.append(f"{room.path}: {raw}")
            continue
        if not raw:
            empty.append(room.path)
        for a in raw:
            s = a.get("belegungsserie") or {}
            v = s.get("veranstaltung") or {}
            typ[s.get("belegungstyp")] += 1
            if s.get("belegungstyp") == 8 and a["date_from"][11:16] not in ("00:00",):
                closing[room.building][a["date_from"][11:16]] += 1
            if v:
                findet[v.get("findetStatt")] += 1
                vtyp[v.get("veranstaltungstyp")] += 1
                if v.get("lehrveranstaltungstyp"):
                    lv[v["lehrveranstaltungstyp"]] += 1
                if v.get("findetStatt") != 1:
                    cancelled.append((room.path, a["date_from"], v.get("allocationTitle"), v.get("findetStatt")))

    print(f"{len(rooms)} rooms, week {start}..{end}")
    print("belegungstyp:", dict(typ))
    print("findetStatt:", dict(findet))
    print("veranstaltungstyp:", dict(vtyp))
    print("lehrveranstaltungstyp:", dict(lv))
    print(f"empty responses ({len(empty)}):", empty)
    print(f"errors ({len(errors)}):", errors)
    print("findetStatt != 1:")
    for c in cancelled[:20]:
        print("  ", c)
    print("weekday closing start times per building:")
    for b, c in sorted(closing.items()):
        print(f"  {b:5} {dict(c)}")


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:]))
