"""Phase 3 check: print today's allocations for a few HG rooms."""

import asyncio
import sys
from datetime import datetime

from app.availability import merge_blocks, parse_allocations, room_status
from app.catalogue import filter_rooms, parse_catalogue
from app.config import DEFAULT_TYPECODES, TZ
from app.eth_client import EthClient


async def main(n: int = 3) -> None:
    now = datetime.now(TZ)
    async with EthClient() as client:
        rooms = filter_rooms(parse_catalogue(await client.catalogue()), "Z", {"HG"}, set(DEFAULT_TYPECODES))[:n]
        raws = await asyncio.gather(*(client.allocations(r.path, now.date()) for r in rooms))
        for room, raw in zip(rooms, raws):
            blocks = parse_allocations(raw)
            print(f"\n{room.path} ({room.type}, {room.seats} seats): {len(raw)} entries")
            for b in merge_blocks(blocks):
                for p in b.parts:
                    print(f"  {p.start.astimezone(TZ):%a %d.%m %H:%M}–{p.end.astimezone(TZ):%H:%M}  {p.kind:7}  {p.title or ''}")
            print("  status now:", room_status(blocks, now))


if __name__ == "__main__":
    asyncio.run(main(*map(int, sys.argv[1:])))
