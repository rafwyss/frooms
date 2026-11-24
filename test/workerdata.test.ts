// The Worker's data for the second revamp: room equipment, "usually this full", the schedule bar's day blocks and
// occupancy reports (worker/equipment.ts, worker/usual.ts, worker/availability.ts dayBlocks, worker/reports.ts).
import { describe, expect, it } from "vitest";

import { dayBlocks, parseAllocations } from "../worker/availability";
import { EQUIPMENT_TTL_S } from "../worker/config";
import { hasScreen, parseEquipment, pickEquipment } from "../worker/equipment";
import { parseReport, readReportLog, readReportSummaries, ReportError, reporterOf, saveReport } from "../worker/reports";
import { zurichToUtc } from "../worker/tz";
import { blend, offsets, readUsual, rebuildUsual, slotOf, type SlotStats, usualAt, usualCurve, usualField } from "../worker/usual";
import { FakeD1, readData } from "./helpers";

const sample = (name: string) => JSON.parse(readData("samples", name));

describe("equipment", () => {
  it("reads the flags from ETH's room details", () => {
    const ml = parseEquipment(sample("room_ML_E_13.json")); // a meeting room with a monitor
    expect(ml).toEqual({ screen: true, projector: false, hdmi: true, wireless: true, blackboard: true, whiteboard: false, flipchart: false });
    const seminar = parseEquipment(sample("room_HG_E_33.1.json")); // a projector; "Dokumentenkamera: keine" is no camera
    expect(seminar).toEqual({ screen: false, projector: true, hdmi: true, wireless: true, blackboard: true, whiteboard: false, flipchart: true });
    const hall = parseEquipment(sample("room_HG_F_1.json"));
    expect(hall).toMatchObject({ projector: true, blackboard: true, hdmi: true });
    expect([ml, seminar, hall].map(hasScreen)).toEqual([true, true, true]);
    expect(hasScreen(null)).toBeNull();
  });

  it("counts an attribute that says none as absent", () => {
    const raw = {
      tabs: [
        { attributes: [{ name: "VIS.PROJ.MONITORE", value: "0" }, { name: "VIS.PROJ.BEAM.HD", value: "keine" }, { name: "VIS.TAF.WB", value: "nicht vorhanden" }] },
        { attributes: null },
        { attributes: [{ name: "VIS.TAF.FLIP", value: "" }, { name: "AUS.WIRELESS.NO", value: "vorhanden" }] },
      ],
    };
    expect(Object.values(parseEquipment(raw)).some(Boolean)).toBe(false);
    expect(hasScreen(parseEquipment(raw))).toBe(false);
    expect(Object.values(parseEquipment(null)).some(Boolean)).toBe(false);
  });

  it("picks rooms never fetched first (Meet's types before others), then those older than 30 days", () => {
    const now = 100 * 86400_000;
    const rooms = [
      { path: "A", typecode: "3650" }, // computer room, never fetched
      { path: "B", typecode: "3420" }, // seminar room, never fetched
      { path: "C", typecode: "3430" }, // fetched long ago
      { path: "D", typecode: "3430" }, // fetched recently
      { path: "E", typecode: "2110" }, // fetched even longer ago
    ];
    const old = now - EQUIPMENT_TTL_S * 1000 - 1;
    const stored = { C: { at: old, flags: null }, D: { at: now - 1000, flags: null }, E: { at: old - 5, flags: null } };
    expect(pickEquipment(rooms, stored, now, 10)).toEqual(["B", "A", "E", "C"]);
    expect(pickEquipment(rooms, stored, now, 2)).toEqual(["B", "A"]);
  });
});

describe("usually this full", () => {
  it("weighs the 2 months and the past week half and half", () => {
    expect(blend([40, 30, 60, 3])).toEqual({ pct: 50, n: 30 });
  });

  it("falls back to the 2 months when the past week has no reading, and has nothing with fewer than 3", () => {
    expect(blend([40, 30, null, 0])).toEqual({ pct: 40, n: 30 });
    expect(blend([40, 30, 80, 1])).toEqual({ pct: 60, n: 30 });
    expect(blend([40, 2, 40, 2])).toBeNull();
    expect(blend(undefined)).toBeNull();
    const rows = [{ weekday: 2, slots: { "40": [40, 30, 60, 3] as SlotStats } }];
    expect(usualAt(rows, 2, 40)).toEqual({ pct: 50, n: 30 });
    expect(usualAt(rows, 2, 41)).toBeNull();
    expect(usualAt(rows, 3, 40)).toBeNull();
  });

  it("gives a day's curve of 96 quarter hours and the value at a time", () => {
    const curve = usualCurve({ "40": [40, 30, 61, 3], "41": [10, 1, null, 0] });
    expect(curve).toHaveLength(96);
    expect(curve[40]).toBe(51); // 50.5, rounded
    expect(curve[41]).toBeNull();
    const at = zurichToUtc(2026, 11, 11, 10, 7); // Wednesday 10:07: slot 40
    expect(slotOf(at)).toEqual({ weekday: 2, slot: 40 });
    expect(usualField({ "40": [40, 30, 60, 3] }, at)).toMatchObject({ pct: 50 });
    expect(usualField(undefined, at)).toBeNull();
  });

  it("finds the change to winter time in a window", () => {
    const from = Date.UTC(2026, 9, 1);
    const to = Date.UTC(2026, 10, 13);
    const o = offsets(from, to);
    expect(o).toMatchObject({ before: 2 * 3600_000, after: 3600_000 });
    expect(Math.abs(o.change - Date.UTC(2026, 9, 25, 1))).toBeLessThanOrEqual(1000);
    expect(offsets(Date.UTC(2026, 10, 1), to)).toEqual({ before: 3600_000, after: 3600_000, change: to });
  });

  it("rebuilds the table from the history in Zurich time across the change of time, once per frozen reading", async () => {
    const db = new FakeD1();
    const now = zurichToUtc(2026, 11, 13, 1, 0); // Friday 13 November, 01:00
    const put = db.db.prepare("INSERT INTO occupancy (space, at, measured_at, pct) VALUES (?, ?, ?, ?)");
    const read = (space: string, ms: number, pct: number, fetchedLater = 0) => put.run(space, ms + fetchedLater, ms, pct);
    // Wednesdays at 10:00 Zurich time: in summer time (14 and 21 October) and in winter time (28 October to 11 November).
    const wednesdays = [[10, 14], [10, 21], [10, 28], [11, 4], [11, 11]].map(([m, d]) => zurichToUtc(2026, m, d, 10, 0));
    wednesdays.forEach((t, i) => read("HGH30.1", t, i === 4 ? 100 : 40));
    // The same frozen reading fetched three more times counts once.
    for (const later of [300_000, 600_000, 900_000]) read("HGH30.1", wednesdays[4], 100, later);
    // Older than two months, and another space that isn't asked for: left out.
    read("HGH30.1", zurichToUtc(2026, 9, 9, 10, 0), 0);
    read("OTHER", wednesdays[4], 10);
    await db.batch(rebuildUsual(db.asD1(), ["HGH30.1"], now) as never);

    const rows = db.rows("SELECT space, weekday, slots FROM usual");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ space: "HGH30.1", weekday: 2 });
    const slots = JSON.parse(rows[0].slots) as Record<string, SlotStats>;
    expect(Object.keys(slots)).toEqual(["40"]); // 10:00 in both summer and winter time
    expect(slots["40"]).toEqual([52, 5, 100, 1]); // (4 × 40 + 100) / 5; the past week: Wednesday the 11th only
    expect(usualAt([{ weekday: 2, slots }], 2, 40)).toEqual({ pct: 76, n: 5 }); // half the 2 months, half the past week
    expect(usualAt([{ weekday: 2, slots: { "40": [52, 5, null, 0] } }], 2, 40)).toEqual({ pct: 52, n: 5 }); // a holiday week

    const usual = await readUsual(db.asD1(), 2, now);
    expect(usual.get("HGH30.1")).toEqual(slots);
    // Rebuilding replaces what was there.
    await db.batch(rebuildUsual(db.asD1(), [], now) as never);
    expect(db.rows("SELECT * FROM usual")).toEqual([]);
  });
});

describe("day blocks", () => {
  const raw = (rows: [string, string, number][]) => rows.map(([from, to, typ]) => ({ date_from: from, date_to: to, belegungsserie: { belegungstyp: typ, veranstaltung: typ === 8 ? null : { allocationTitle: "x", findetStatt: 1 } } }));

  it("match a room's bookings, in minutes of the day, bookings and closures apart", () => {
    const sampleBlocks = parseAllocations(sample("allocations_ML_E_13.json"));
    expect(dayBlocks(sampleBlocks, "2026-10-29")).toEqual([
      [0, 480, "c"],
      [480, 720, "b"],
      [780, 855, "b"],
      [870, 1020, "b"],
      [1200, 1440, "c"],
    ]);
  });

  it("cut a block crossing midnight to the day", () => {
    const blocks = parseAllocations(raw([["2026-10-29T22:00:00", "2026-10-30T02:00:00", 2], ["2026-10-28T20:00:00", "2026-10-29T07:00:00", 8]]));
    expect(dayBlocks(blocks, "2026-10-29")).toEqual([[0, 420, "c"], [1320, 1440, "b"]]);
    expect(dayBlocks(blocks, "2026-10-30")).toEqual([[0, 120, "b"]]);
    expect(dayBlocks([], "2026-10-30")).toEqual([]);
  });

  it("merge touching bookings but keep a closed evening grey", () => {
    const blocks = parseAllocations(raw([["2026-10-29T08:00:00", "2026-10-29T10:00:00", 2], ["2026-10-29T10:00:00", "2026-10-29T12:00:00", 2], ["2026-10-29T12:00:00", "2026-10-29T23:59:00", 8]]));
    expect(dayBlocks(blocks, "2026-10-29")).toEqual([[480, 720, "b"], [720, 1440, "c"]]);
  });
});

describe("reports", () => {
  const CLIENT = "0123456789abcdef0123456789abcdef";
  const NOW = Date.UTC(2026, 10, 13, 13, 0);
  const base = { kind: "level", place_kind: "room", place: "HG E 33.1", area: "Z", value: 2, client: CLIENT };

  it("checks every field", () => {
    expect(parseReport(base)).toEqual({ ...base, estimate: null });
    expect(parseReport({ ...base, kind: "pct", place_kind: "space", place: "HGH30.1", value: 70, estimate: 60 })).toMatchObject({ value: 70, estimate: 60 });
    const bad = [
      null,
      { ...base, kind: "loud" },
      { ...base, place_kind: "desk" },
      { ...base, value: 3 },
      { ...base, value: 1.5 },
      { ...base, kind: "pct", value: 50 }, // percentages are for spaces
      { ...base, kind: "rating", place_kind: "space", value: 6 },
      { ...base, client: "short" },
      { ...base, place: "" },
      { ...base, area: "zentrum" },
      { ...base, kind: "rating", place_kind: "space", value: 2, estimate: 140 },
    ];
    for (const b of bad) expect(() => parseReport(b), JSON.stringify(b)).toThrow(ReportError);
  });

  it("stores a hashed reporter, replaces the same reporter's report within 2 hours and adds one after", async () => {
    const db = new FakeD1();
    const r = parseReport(base);
    expect((await saveReport(db.asD1(), r, NOW)).stored).toBe("new");
    const hash = await reporterOf(CLIENT);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.rows("SELECT reporter, value, at FROM reports")).toEqual([{ reporter: hash, value: 2, at: NOW }]);
    expect(JSON.stringify(db.rows("SELECT * FROM reports"))).not.toContain(CLIENT);

    expect((await saveReport(db.asD1(), { ...r, value: 1 }, NOW + 3600_000)).stored).toBe("replaced");
    expect(db.rows("SELECT value, at FROM reports")).toEqual([{ value: 1, at: NOW + 3600_000 }]);
    expect((await saveReport(db.asD1(), { ...r, value: 0 }, NOW + 3600_000 + 2 * 3600_000 + 1)).stored).toBe("new");
    expect(db.rows("SELECT COUNT(*) AS n FROM reports")[0].n).toBe(2);
    // Another browser counts on its own.
    expect((await saveReport(db.asD1(), { ...r, client: "f".repeat(32) }, NOW + 3600_000)).stored).toBe("new");
  });

  it("keeps the first rating", async () => {
    const db = new FakeD1();
    const r = parseReport({ ...base, kind: "rating", place_kind: "space", place: "HGH30.1", value: 2, estimate: 60 });
    expect((await saveReport(db.asD1(), r, NOW)).stored).toBe("new");
    expect((await saveReport(db.asD1(), { ...r, value: -3 }, NOW + 60_000)).stored).toBe("kept");
    expect(db.rows("SELECT value, estimate FROM reports")).toEqual([{ value: 2, estimate: 60 }]);
  });

  it("caps the reports per day", async () => {
    const db = new FakeD1();
    const put = db.db.prepare("INSERT INTO reports (at, kind, place_kind, place, area, value, reporter) VALUES (?, 'level', 'room', 'X', 'Z', 0, 'r')");
    for (let i = 0; i < 2000; i++) put.run(NOW - 1000);
    await expect(saveReport(db.asD1(), parseReport(base), NOW)).rejects.toMatchObject({ status: 429 });
  });

  it("sums up the past 2 hours and logs the past 4, without ratings", async () => {
    const db = new FakeD1();
    const put = db.db.prepare("INSERT INTO reports (at, kind, place_kind, place, area, value, reporter) VALUES (?, ?, ?, ?, 'Z', ?, ?)");
    put.run(NOW - 60_000, "level", "space", "HGH30.1", 2, "a");
    put.run(NOW - 120_000, "level", "space", "HGH30.1", 2, "b");
    put.run(NOW - 180_000, "level", "space", "HGH30.1", 1, "c");
    put.run(NOW - 240_000, "pct", "space", "HGH30.1", 70, "a");
    put.run(NOW - 300_000, "pct", "space", "HGH30.1", 81, "b");
    put.run(NOW - 360_000, "rating", "space", "HGH30.1", 5, "a");
    put.run(NOW - 3 * 3600_000, "level", "space", "HGH30.1", 0, "d"); // in the log, not in the summary
    put.run(NOW - 5 * 3600_000, "level", "space", "HGH30.1", 0, "e"); // too old for both
    put.run(NOW - 60_000, "level", "room", "HGH30.1", 0, "f"); // a room of the same name: apart
    const summaries = await readReportSummaries(db.asD1(), "space", ["HGH30.1", "MMB79"], NOW);
    expect(summaries.get("HGH30.1")).toEqual({ levels: [0, 1, 2], pct: 76, n_pct: 2, last: NOW - 60_000 });
    expect(summaries.has("MMB79")).toBe(false);
    const log = await readReportLog(db.asD1(), "space", "HGH30.1", NOW);
    expect(log.map((r) => [r.kind, r.value])).toEqual([["level", 2], ["level", 2], ["level", 1], ["pct", 70], ["pct", 81], ["level", 0]]);
    expect(Object.keys(log[0])).toEqual(["id", "at", "kind", "value"]); // the row id (for votes), never the reporter
  });
});
