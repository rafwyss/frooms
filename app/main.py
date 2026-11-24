"""FastAPI app: JSON API under /api, static frontend at /."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from .availability import Status, parse_allocations, room_status
from .catalogue import Room, area_list, building_counts, filter_rooms, parse_catalogue, type_counts
from .config import DEFAULT_AREA, DEFAULT_TYPECODES, PRIMARY_AREAS, STATIC_DIR, TZ
from .eth_client import EthClient

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    client = EthClient()
    state["client"] = client
    raw = await client.catalogue()
    state["rooms"] = parse_catalogue(raw)
    state["areas"] = area_list(raw)
    log.info("Loaded %d rooms in %d areas", len(state["rooms"]), len(state["areas"]))
    yield
    await client.aclose()


app = FastAPI(title="frooms", lifespan=lifespan)


def _csv(value: str | None) -> set[str]:
    return {v.strip() for v in (value or "").split(",") if v.strip()}


def _local(dt: datetime | None) -> str | None:
    return dt.astimezone(TZ).isoformat(timespec="minutes") if dt else None


def _minutes(delta: timedelta | None) -> int | None:
    return int(delta.total_seconds() // 60) if delta is not None else None


@app.get("/api/areas")
def areas():
    return {"default": DEFAULT_AREA, "primary": list(PRIMARY_AREAS), "areas": state["areas"]}


@app.get("/api/buildings")
def buildings(area: str = DEFAULT_AREA, types: str | None = None):
    rooms = filter_rooms(state["rooms"], area, typecodes=_csv(types) or set(DEFAULT_TYPECODES))
    return [{"building": b, "rooms": n} for b, n in building_counts(rooms).items()]


@app.get("/api/types")
def types(area: str = DEFAULT_AREA):
    return {"default": list(DEFAULT_TYPECODES), "types": type_counts(filter_rooms(state["rooms"], area))}


@app.get("/api/dates")
async def dates():
    lo, hi = await state["client"].min_max_dates()
    return {"min": lo.isoformat(), "max": hi.isoformat()}


def _room_entry(room: Room, status: Status, at: datetime) -> dict:
    entry = {
        "room": room.path,
        "building": room.building,
        "seats": room.seats,
        "type": room.type,
        "typecode": room.typecode,
        "status": status.state,
        "free_until": _local(status.free_until),
        "busy_until": _local(status.busy_until),
        "current_title": status.current_title,
        "current_kind": status.current_kind,
        "current_until": _local(status.current_until),
        "next_title": status.next_title,
        "next_kind": status.next_kind,
        "next_gap_minutes": _minutes(status.next_gap),
        "short_gap": status.short_gap,
        "eth_url": room.eth_url,
    }
    if status.state == "free":
        entry["minutes"] = _minutes(status.free_until - at) if status.free_until else None
    elif status.state == "busy":
        entry["minutes"] = _minutes(status.busy_until - at)
    return entry


def _sort_key(entry: dict):
    minutes = entry.get("minutes")
    if entry["status"] == "free":
        return (0, -(minutes if minutes is not None else 10**9))
    if entry["status"] == "busy":
        return (1, minutes)
    return (2, 0)


@app.get("/api/free")
async def free(
    buildings: str = Query(..., description="Comma-separated building codes, e.g. HG,CAB"),
    at: datetime | None = Query(None, description="Local time, e.g. 2026-10-29T14:00; default now"),
    types: str | None = Query(None, description="Comma-separated typecodes; default lecture halls + seminar rooms"),
    min_seats: int | None = None,
):
    client: EthClient = state["client"]
    wanted = _csv(buildings)
    if not wanted:
        raise HTTPException(400, "Pick at least one building")

    at = (at.astimezone(TZ) if at.tzinfo else at.replace(tzinfo=TZ)) if at else datetime.now(TZ)
    lo, hi = await client.min_max_dates()
    if not lo <= at.date() <= hi:
        raise HTTPException(400, f"Time must be between {lo} and {hi}")

    rooms = filter_rooms(state["rooms"], None, wanted, _csv(types) or set(DEFAULT_TYPECODES), min_seats)
    results = await asyncio.gather(*(client.allocations(r.path, at.date()) for r in rooms), return_exceptions=True)

    entries = []
    for room, raw in zip(rooms, results):
        if isinstance(raw, BaseException):
            log.warning("Allocations for %s failed: %s", room.path, raw)
            entries.append({**_room_entry(room, Status(state="no_data"), at), "status": "error"})
            continue
        status = room_status(parse_allocations(raw), at)
        if status.state == "no_data":
            log.warning("No allocation data for %s (empty response)", room.path)
        entries.append(_room_entry(room, status, at))
    entries.sort(key=_sort_key)

    fetched = [client.cached_at(("alloc", r.path, at.date().isoformat())) for r in rooms]
    fetched = [t for t in fetched if t]
    return {
        "at": _local(at),
        "fetched_at": _local(datetime.fromtimestamp(min(fetched), TZ)) if fetched else None,
        "rooms": entries,
    }


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
