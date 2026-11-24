"""Write golden outputs of the Python logic to test/golden/, so the Worker's TS port can be checked for parity.

Run from the project root: python -m scripts.golden
"""

import json
from datetime import datetime, timedelta

from app.availability import parse_allocations, room_status
from app.catalogue import area_list, building_counts, filter_rooms, parse_catalogue, type_counts
from app.config import DATA_DIR, DEFAULT_TYPECODES, ROOT, TZ

OUT = ROOT / "test" / "golden"
SAMPLES = DATA_DIR / "samples"


def _iso(dt):
    return dt.astimezone(TZ).isoformat(timespec="minutes") if dt else None


def _status(s):
    return {
        "state": s.state,
        "free_until": _iso(s.free_until),
        "busy_until": _iso(s.busy_until),
        "current_title": s.current_title,
        "current_kind": s.current_kind,
        "current_until": _iso(s.current_until),
        "next_title": s.next_title,
        "next_kind": s.next_kind,
        "next_gap_minutes": int(s.next_gap.total_seconds() // 60) if s.next_gap is not None else None,
        "short_gap": s.short_gap,
    }


def statuses() -> dict:
    out = {}
    for name in ("allocations_ML_E_13.json", "allocations_ETA_F_5.json"):
        blocks = parse_allocations(json.loads((SAMPLES / name).read_text()))
        at, end, rows = datetime(2026, 10, 26, tzinfo=TZ), datetime(2026, 11, 2, tzinfo=TZ), []
        while at < end:
            rows.append({"at": _iso(at), **_status(room_status(blocks, at))})
            at += timedelta(minutes=15)
        out[name] = rows
    return out


def catalogue() -> dict:
    raw = json.loads((DATA_DIR / "rooms_snapshot.json").read_text())
    rooms = parse_catalogue(raw)
    hg = filter_rooms(rooms, "Z", {"HG"}, set(DEFAULT_TYPECODES))
    return {
        "areas": area_list(raw),
        "buildings_Z_default": building_counts(filter_rooms(rooms, "Z", typecodes=set(DEFAULT_TYPECODES))),
        "types_Z": type_counts(filter_rooms(rooms, "Z")),
        "hg_default": [{"path": r.path, "seats": r.seats, "eth_url": r.eth_url} for r in hg],
        "min_seats_100_Z": [r.path for r in filter_rooms(rooms, "Z", None, set(DEFAULT_TYPECODES), 100)],
    }


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "statuses.json").write_text(json.dumps(statuses(), ensure_ascii=False))
    (OUT / "catalogue.json").write_text(json.dumps(catalogue(), ensure_ascii=False))
    print("wrote", OUT)
