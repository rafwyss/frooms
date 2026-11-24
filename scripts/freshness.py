"""Phase 6 check: does allocation data change during the day?

First run saves today's allocations for a sample of rooms; later runs diff against that snapshot.
"""

import asyncio
import json
from datetime import datetime

from app.catalogue import filter_rooms, parse_catalogue
from app.config import CACHE_DIR, DEFAULT_TYPECODES, TZ
from app.eth_client import EthClient

BUILDINGS = {"HG", "CAB", "ML", "ETZ"}


def key(a: dict) -> tuple:
    v = (a.get("belegungsserie") or {}).get("veranstaltung") or {}
    return (a["date_from"], a["date_to"], a["belegungsserie"]["belegungstyp"], v.get("allocationTitle"), v.get("findetStatt"))


async def main() -> None:
    today = datetime.now(TZ).date()
    path = CACHE_DIR / f"freshness_{today}.json"
    async with EthClient() as client:
        rooms = filter_rooms(parse_catalogue(await client.catalogue()), "Z", BUILDINGS, set(DEFAULT_TYPECODES))
        raws = await asyncio.gather(*(client.allocations(r.path, today) for r in rooms))
    now = {r.path: sorted(map(list, map(key, raw))) for r, raw in zip(rooms, raws)}

    if not path.exists():
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"saved_at": datetime.now(TZ).isoformat(), "rooms": now}))
        print(f"Saved snapshot of {len(now)} rooms to {path}. Run again later today to compare.")
        return

    old = json.loads(path.read_text())
    changed = 0
    for room, entries in now.items():
        before = old["rooms"].get(room, [])
        added = [e for e in entries if e not in before]
        removed = [e for e in before if e not in entries]
        if added or removed:
            changed += 1
            print(room)
            for e in removed:
                print("  -", e)
            for e in added:
                print("  +", e)
    print(f"{changed} of {len(now)} rooms changed since {old['saved_at'][:16]}")


if __name__ == "__main__":
    asyncio.run(main())
