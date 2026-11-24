import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mergeBlocks, parseAllocations, roomStatus } from "../worker/availability";
import { zurichToUtc as local } from "../worker/tz";

const SAMPLES = join(import.meta.dirname, "..", "data", "samples");
const load = (name: string) => parseAllocations(JSON.parse(readFileSync(join(SAMPLES, name), "utf8")));

const H = 3600_000;

function alloc(date_from: string, date_to: string, typ: number = 2, title: string | null = "X", findetStatt = 1) {
  const event = typ === 8 ? null : { allocationTitle: title, findetStatt };
  return { date_from, date_to, belegungsserie: { belegungstyp: typ, veranstaltung: event } };
}

afterEach(() => vi.restoreAllMocks());

describe("ML E 13 sample (week 26.10.–01.11.2026)", () => {
  const ml = load("allocations_ML_E_13.json");

  it("is free before a meeting", () => {
    const s = roomStatus(ml, local(2026, 10, 29, 12, 30));
    expect(s.state).toBe("free");
    expect(s.free_until).toBe(local(2026, 10, 29, 13, 0));
    expect(s.next_title).toBe("Grants Office Meeting");
    expect(s.next_kind).toBe("booking");
    expect(s.short_gap).toBe(false);
  });

  it("flags a short gap", () => {
    const s = roomStatus(ml, local(2026, 10, 29, 14, 20));
    expect(s.state).toBe("free");
    expect(s.free_until).toBe(local(2026, 10, 29, 14, 30));
    expect(s.short_gap).toBe(true);
  });

  it("is busy until the end of a meeting", () => {
    const s = roomStatus(ml, local(2026, 10, 29, 14, 30));
    expect(s.state).toBe("busy");
    expect(s.busy_until).toBe(local(2026, 10, 29, 17, 0));
    expect(s.current_title?.startsWith("Austausch mit Polnischer")).toBe(true);
    expect(s.next_gap).toBe(3 * H);
    expect(s.next_kind).toBe("closed");
  });

  it("is free until closing", () => {
    const s = roomStatus(ml, local(2026, 10, 29, 18, 0));
    expect(s.state).toBe("free");
    expect(s.free_until).toBe(local(2026, 10, 29, 20, 0));
    expect(s.next_kind).toBe("closed");
  });

  it("is closed at the weekend", () => {
    const s = roomStatus(ml, local(2026, 10, 31, 10, 0));
    expect(s.state).toBe("busy");
    expect(s.current_kind).toBe("closed");
    expect(s.busy_until).toBeGreaterThanOrEqual(local(2026, 11, 2, 0, 0));
  });

  it("merges a meeting into the closure", () => {
    const s = roomStatus(ml, local(2026, 10, 27, 19, 0));
    expect(s.state).toBe("busy");
    expect(s.current_title).toBe("Board Meeting 27/10/26");
    expect(s.current_until).toBe(local(2026, 10, 27, 20, 0));
    expect(s.busy_until).toBe(local(2026, 10, 28, 8, 0));
  });
});

it("names the current lecture (ETA F 5)", () => {
  const s = roomStatus(load("allocations_ETA_F_5.json"), local(2026, 10, 26, 11, 0));
  expect(s.state).toBe("busy");
  expect(s.current_title).toBe("Mechanik I");
  expect(s.current_until).toBe(local(2026, 10, 26, 12, 0));
  expect(s.busy_until).toBeGreaterThanOrEqual(local(2026, 10, 26, 12, 0));
});

it("treats an empty response as no data", () => {
  expect(roomStatus(parseAllocations([]), local(2026, 10, 29, 12, 0)).state).toBe("no_data");
});

describe("parsing rules", () => {
  it("turns 23:59 into midnight", () => {
    const [b] = parseAllocations([alloc("2026-10-29T20:00:00", "2026-10-29T23:59:00", 8)]);
    expect(b.end).toBe(local(2026, 10, 30, 0, 0));
    expect(b.kind).toBe("closed");
  });

  it("drops cancelled bookings", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const blocks = parseAllocations([
      alloc("2026-10-29T00:00:00", "2026-10-29T08:00:00", 8),
      alloc("2026-10-29T10:00:00", "2026-10-29T12:00:00", 2, "X", 0),
    ]);
    expect(roomStatus(blocks, local(2026, 10, 29, 11, 0)).state).toBe("free");
  });

  it("drops cancelled lectures (type 13)", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const blocks = parseAllocations([
      alloc("2026-10-29T00:00:00", "2026-10-29T08:00:00", 8),
      alloc("2026-10-29T09:00:00", "2026-10-29T12:00:00", 13, "X", 0),
    ]);
    expect(roomStatus(blocks, local(2026, 10, 29, 10, 0)).state).toBe("free");
  });

  it.each([5, 11])("treats known type %i as busy without warning", (typ) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocks = parseAllocations([alloc("2026-10-29T10:00:00", "2026-10-29T12:00:00", typ, "Gesperrt")]);
    expect(warn).not.toHaveBeenCalled();
    const s = roomStatus(blocks, local(2026, 10, 29, 11, 0));
    expect([s.state, s.current_title]).toEqual(["busy", "Gesperrt"]);
  });

  it("treats an unknown type as busy and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const blocks = parseAllocations([alloc("2026-10-29T10:00:00", "2026-10-29T12:00:00", 99, null)]);
    expect(warn.mock.calls[0][0]).toContain("Unknown belegungstyp");
    const s = roomStatus(blocks, local(2026, 10, 29, 11, 0));
    expect(s.state).toBe("busy");
    expect(s.current_kind).toBe("booking");
    expect(s.current_title).toBe("Booked (type 99)");
  });

  it("keeps the first title when merging, and closed only if all parts are closed", () => {
    const blocks = parseAllocations([
      alloc("2026-10-29T12:00:00", "2026-10-29T14:00:00", 2, "B"),
      alloc("2026-10-29T10:00:00", "2026-10-29T12:00:00", 2, "A"),
      alloc("2026-10-29T13:00:00", "2026-10-29T15:00:00", 8),
      alloc("2026-10-29T20:00:00", "2026-10-29T23:59:00", 8),
    ]);
    const [first, second] = mergeBlocks(blocks);
    expect([first.title, first.kind, first.end]).toEqual(["A", "booking", local(2026, 10, 29, 15, 0)]);
    expect(second.kind).toBe("closed");
  });
});

describe("DST", () => {
  it("counts real time across the autumn switch", () => {
    // 25.10.2026: clocks go back 03:00 -> 02:00, so 01:00-04:00 local is 4 real hours.
    const blocks = parseAllocations([alloc("2026-10-25T04:00:00", "2026-10-25T05:00:00")]);
    const s = roomStatus(blocks, local(2026, 10, 25, 1, 0));
    expect(s.free_until! - local(2026, 10, 25, 1, 0)).toBe(4 * H);
  });

  it("flags a short gap across the spring switch", () => {
    // 29.03.2026: clocks jump 02:00 -> 03:00, so 01:50-03:05 local is only 15 real minutes.
    const blocks = parseAllocations([alloc("2026-03-29T03:05:00", "2026-03-29T04:00:00")]);
    const s = roomStatus(blocks, local(2026, 3, 29, 1, 50));
    expect(s.state).toBe("free");
    expect(s.short_gap).toBe(true);
  });

  it("makes the closed Sunday of the autumn switch 25 hours long", () => {
    const [b] = parseAllocations([alloc("2026-10-25T00:00:00", "2026-10-25T23:59:00", 8)]);
    expect(b.end - b.start).toBe(25 * H);
  });
});
