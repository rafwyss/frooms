"""Load and filter the room catalogue (/v2/rooms)."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from urllib.parse import urlencode

from .config import AREA_LABELS

ETH_DETAIL_PAGE = "https://ethz.ch/staffnet/en/service/rooms-and-buildings/roominfo/detail.html"


@dataclass(frozen=True)
class Room:
    area: str
    region: str
    building: str
    floor: str
    room: str
    seats: int | None
    typecode: str
    type: str

    @property
    def path(self) -> str:
        """Room path as the allocations endpoint expects it, e.g. 'ML E 13' (not the padded id)."""
        return f"{self.building} {self.floor} {self.room}"

    @property
    def eth_url(self) -> str:
        """ETH's details page for this room (photos, seats, equipment)."""
        query = urlencode({"region": self.region, "building": self.building, "floor": self.floor, "room": self.room})
        return f"{ETH_DETAIL_PAGE}?{query}"


def _seats(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_catalogue(raw: list[dict], area: str | None = None) -> list[Room]:
    """Rooms of one area (e.g. "Z"), or of all areas if `area` is None."""
    return [
        Room(
            area=r["area"],
            region=r.get("region") or r["area"],
            building=r["building"],
            floor=r["floor"],
            room=r["room"],
            seats=_seats(r.get("seats")),
            typecode=r.get("typecode") or "",
            type=r.get("type") or "",
        )
        for r in raw
        if r.get("area") and (area is None or r["area"] == area)
    ]


def filter_rooms(
    rooms: list[Room],
    area: str | None = None,
    buildings: set[str] | None = None,
    typecodes: set[str] | None = None,
    min_seats: int | None = None,
) -> list[Room]:
    return [
        r
        for r in rooms
        if (not area or r.area == area)
        and (not buildings or r.building in buildings)
        and (not typecodes or r.typecode in typecodes)
        and (not min_seats or (r.seats or 0) >= min_seats)
    ]


def area_list(raw: list[dict]) -> list[dict]:
    """Areas with their display name and room count, largest first."""
    counts = Counter(r["area"] for r in raw if r.get("area"))
    names = {r["area"]: (r.get("location") or {}).get("areaDesc") or r.get("locationName") or r["area"] for r in raw if r.get("area")}
    return [
        {"area": a, "name": AREA_LABELS.get(a, names[a]), "rooms": n}
        for a, n in counts.most_common()
    ]


def building_counts(rooms: list[Room]) -> dict[str, int]:
    return dict(sorted(Counter(r.building for r in rooms).items()))


def type_counts(rooms: list[Room]) -> list[dict]:
    counts = Counter((r.typecode, r.type) for r in rooms)
    return [
        {"typecode": code, "type": label, "count": n}
        for (code, label), n in sorted(counts.items(), key=lambda kv: -kv[1])
    ]
