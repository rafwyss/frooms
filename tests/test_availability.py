import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from app.availability import Block, merge_blocks, parse_allocations, room_status
from app.config import TZ

SAMPLES = Path(__file__).resolve().parent.parent / "data" / "samples"


def local(*args) -> datetime:
    return datetime(*args, tzinfo=TZ)


def load(name: str) -> list[Block]:
    return parse_allocations(json.loads((SAMPLES / name).read_text()))


@pytest.fixture(scope="module")
def ml_e_13():
    return load("allocations_ML_E_13.json")


@pytest.fixture(scope="module")
def eta_f_5():
    return load("allocations_ETA_F_5.json")


def alloc(date_from, date_to, typ=2, title="X", findet_statt=1):
    event = None if typ == 8 else {"allocationTitle": title, "findetStatt": findet_statt}
    return {"date_from": date_from, "date_to": date_to, "belegungsserie": {"belegungstyp": typ, "veranstaltung": event}}


# --- ML E 13 sample (week 26.10.–01.11.2026) ---

def test_free_before_meeting(ml_e_13):
    s = room_status(ml_e_13, local(2026, 10, 29, 12, 30))
    assert s.state == "free"
    assert s.free_until == local(2026, 10, 29, 13, 0)
    assert s.next_title == "Grants Office Meeting"
    assert s.next_kind == "booking"
    assert not s.short_gap


def test_short_gap(ml_e_13):
    s = room_status(ml_e_13, local(2026, 10, 29, 14, 20))
    assert s.state == "free"
    assert s.free_until == local(2026, 10, 29, 14, 30)
    assert s.short_gap


def test_busy_until_end_of_meeting(ml_e_13):
    s = room_status(ml_e_13, local(2026, 10, 29, 14, 30))
    assert s.state == "busy"
    assert s.busy_until == local(2026, 10, 29, 17, 0)
    assert s.current_title.startswith("Austausch mit Polnischer")
    assert s.next_gap == timedelta(hours=3)
    assert s.next_kind == "closed"


def test_free_until_closing(ml_e_13):
    s = room_status(ml_e_13, local(2026, 10, 29, 18, 0))
    assert s.state == "free"
    assert s.free_until == local(2026, 10, 29, 20, 0)
    assert s.next_kind == "closed"


def test_weekend_closed(ml_e_13):
    s = room_status(ml_e_13, local(2026, 10, 31, 10, 0))
    assert s.state == "busy"
    assert s.current_kind == "closed"
    assert s.busy_until >= local(2026, 11, 2, 0, 0)


def test_meeting_merges_into_closure(ml_e_13):
    s = room_status(ml_e_13, local(2026, 10, 27, 19, 0))
    assert s.state == "busy"
    assert s.current_title == "Board Meeting 27/10/26"
    assert s.current_until == local(2026, 10, 27, 20, 0)
    assert s.busy_until == local(2026, 10, 28, 8, 0)


def test_lecture_title_is_the_current_one(eta_f_5):
    s = room_status(eta_f_5, local(2026, 10, 26, 11, 0))
    assert s.state == "busy"
    assert s.current_title == "Mechanik I"
    assert s.current_until == local(2026, 10, 26, 12, 0)
    assert s.busy_until >= local(2026, 10, 26, 12, 0)


def test_empty_is_no_data():
    assert room_status(parse_allocations([]), local(2026, 10, 29, 12, 0)).state == "no_data"


# --- parsing rules ---

def test_2359_becomes_midnight():
    [b] = parse_allocations([alloc("2026-10-29T20:00:00", "2026-10-29T23:59:00", typ=8)])
    assert b.end == local(2026, 10, 30, 0, 0)
    assert b.kind == "closed"


def test_cancelled_booking_is_dropped():
    blocks = parse_allocations([
        alloc("2026-10-29T00:00:00", "2026-10-29T08:00:00", typ=8),
        alloc("2026-10-29T10:00:00", "2026-10-29T12:00:00", findet_statt=0),
    ])
    s = room_status(blocks, local(2026, 10, 29, 11, 0))
    assert s.state == "free"


def test_cancelled_lecture_type_13_is_dropped():
    blocks = parse_allocations([
        alloc("2026-10-29T00:00:00", "2026-10-29T08:00:00", typ=8),
        alloc("2026-10-29T09:00:00", "2026-10-29T12:00:00", typ=13, findet_statt=0),
    ])
    assert room_status(blocks, local(2026, 10, 29, 10, 0)).state == "free"


@pytest.mark.parametrize("typ", [5, 11])
def test_known_busy_types_do_not_warn(typ, caplog):
    blocks = parse_allocations([alloc("2026-10-29T10:00:00", "2026-10-29T12:00:00", typ=typ, title="Gesperrt")])
    assert "Unknown" not in caplog.text
    s = room_status(blocks, local(2026, 10, 29, 11, 0))
    assert (s.state, s.current_title) == ("busy", "Gesperrt")


def test_unknown_type_is_busy(caplog):
    blocks = parse_allocations([alloc("2026-10-29T10:00:00", "2026-10-29T12:00:00", typ=99, title=None)])
    assert "Unknown belegungstyp" in caplog.text
    s = room_status(blocks, local(2026, 10, 29, 11, 0))
    assert s.state == "busy"
    assert s.current_kind == "booking"


def test_merge_keeps_first_title_and_closed_only_if_all_closed():
    blocks = parse_allocations([
        alloc("2026-10-29T12:00:00", "2026-10-29T14:00:00", title="B"),
        alloc("2026-10-29T10:00:00", "2026-10-29T12:00:00", title="A"),
        alloc("2026-10-29T13:00:00", "2026-10-29T15:00:00", typ=8),
        alloc("2026-10-29T20:00:00", "2026-10-29T23:59:00", typ=8),
    ])
    first, second = merge_blocks(blocks)
    assert (first.title, first.kind, first.end) == ("A", "booking", local(2026, 10, 29, 15, 0))
    assert second.kind == "closed"


# --- DST ---

def test_dst_autumn_gap_counts_real_time():
    # 25.10.2026: clocks go back 03:00 -> 02:00, so 01:00-04:00 local is 4 real hours.
    blocks = parse_allocations([alloc("2026-10-25T04:00:00", "2026-10-25T05:00:00")])
    s = room_status(blocks, local(2026, 10, 25, 1, 0))
    assert s.free_until - local(2026, 10, 25, 1, 0) == timedelta(hours=4)


def test_dst_spring_short_gap():
    # 29.03.2026: clocks jump 02:00 -> 03:00, so 01:50-03:05 local is only 15 real minutes.
    blocks = parse_allocations([alloc("2026-03-29T03:05:00", "2026-03-29T04:00:00")])
    s = room_status(blocks, local(2026, 3, 29, 1, 50))
    assert s.state == "free"
    assert s.short_gap


def test_dst_closed_sunday_spans_25_hours():
    [b] = parse_allocations([alloc("2026-10-25T00:00:00", "2026-10-25T23:59:00", typ=8)])
    assert b.end - b.start == timedelta(hours=25)
