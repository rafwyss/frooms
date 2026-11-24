"""Pure availability logic: turn raw ETH allocations into a free/busy status. No I/O."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Literal

from .config import SHORT_GAP_MINUTES, TZ

log = logging.getLogger(__name__)

# belegungstyp values seen in a survey of all Zentrum rooms (week of 26.10.2026)
BOOKING_TYPES = {
    2,  # booking: lecture, meeting, exam …
    5,  # blocked / renovation ("Umbau")
    11,  # lecture (seen only with findetStatt 1)
}
CANCELLED = 13  # cancelled lecture, always with findetStatt 0
CLOSED = 8  # building closed, no veranstaltung

Kind = Literal["booking", "closed"]


@dataclass(frozen=True)
class Block:
    """A busy interval. Times are aware datetimes in UTC.

    A merged block keeps its original parts so the status can name whatever is
    running at a given moment rather than the first event of a long chain.
    """

    start: datetime
    end: datetime
    kind: Kind
    title: str | None
    parts: tuple["Block", ...] = field(default=(), compare=False, repr=False)

    @property
    def first(self) -> "Block":
        return self.parts[0] if self.parts else self

    def part_at(self, at: datetime) -> "Block":
        for part in self.parts or (self,):
            if part.start <= at < part.end:
                return part
        return self


@dataclass(frozen=True)
class Status:
    state: Literal["free", "busy", "no_data"]
    # free: when the room stops being free (None = rest of the fetched window)
    free_until: datetime | None = None
    # busy: when the room becomes free again (end of the merged busy block)
    busy_until: datetime | None = None
    # busy: what is running now and until when
    current_title: str | None = None
    current_kind: Kind | None = None
    current_until: datetime | None = None
    # free: what comes next; busy: length of the free gap after busy_until
    next_title: str | None = None
    next_kind: Kind | None = None
    next_gap: timedelta | None = None
    short_gap: bool = False


def _parse_time(value: str) -> datetime:
    naive = datetime.fromisoformat(value)
    if (naive.hour, naive.minute) == (23, 59):
        naive = datetime.combine(naive.date() + timedelta(days=1), datetime.min.time())
    return naive.replace(tzinfo=TZ).astimezone(timezone.utc)


def parse_allocations(raw: list[dict]) -> list[Block]:
    """Convert raw allocation entries into blocks. Cancelled bookings are dropped."""
    blocks = []
    for entry in raw:
        serie = entry.get("belegungsserie") or {}
        typ = serie.get("belegungstyp")
        event = serie.get("veranstaltung") or {}
        start, end = _parse_time(entry["date_from"]), _parse_time(entry["date_to"])

        if typ == CLOSED:
            blocks.append(Block(start, end, "closed", None))
            continue
        if typ == CANCELLED or event.get("findetStatt") == 0:
            log.info("Dropping cancelled booking %r at %s", event.get("allocationTitle"), entry["date_from"])
            continue
        title = event.get("allocationTitle")
        if typ not in BOOKING_TYPES:
            log.warning("Unknown belegungstyp %r at %s, treating as busy", typ, entry["date_from"])
            title = title or f"Booked (type {typ})"
        blocks.append(Block(start, end, "booking", (title or "").strip() or None))
    return blocks


def merge_blocks(blocks: list[Block]) -> list[Block]:
    """Sort and merge overlapping or touching blocks."""
    merged: list[list[Block]] = []
    for block in sorted(blocks, key=lambda b: (b.start, b.end)):
        if merged and block.start <= max(p.end for p in merged[-1]):
            merged[-1].append(block)
        else:
            merged.append([block])

    result = []
    for parts in merged:
        result.append(
            Block(
                start=parts[0].start,
                end=max(p.end for p in parts),
                kind="closed" if all(p.kind == "closed" for p in parts) else "booking",
                title=parts[0].title,
                parts=tuple(parts),
            )
        )
    return result


def _is_short(gap: timedelta | None) -> bool:
    return gap is not None and gap < timedelta(minutes=SHORT_GAP_MINUTES)


def room_status(blocks: list[Block], at: datetime) -> Status:
    """Status of a room at `at` (an aware datetime), given its (unmerged or merged) blocks."""
    if not blocks:
        return Status(state="no_data")

    merged = merge_blocks(blocks)
    for i, block in enumerate(merged):
        if block.end <= at:
            continue
        nxt = merged[i + 1] if i + 1 < len(merged) else None

        if block.start <= at:
            current = block.part_at(at)
            gap = nxt.start - block.end if nxt else None
            return Status(
                state="busy",
                busy_until=block.end,
                current_title=current.title,
                current_kind=current.kind,
                current_until=current.end,
                next_title=nxt.first.title if nxt else None,
                next_kind=nxt.first.kind if nxt else None,
                next_gap=gap,
                short_gap=_is_short(gap),
            )

        return Status(
            state="free",
            free_until=block.start,
            next_title=block.first.title,
            next_kind=block.first.kind,
            short_gap=_is_short(block.start - at),
        )

    return Status(state="free")
