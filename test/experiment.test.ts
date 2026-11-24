import { beforeEach, expect, it, vi } from "vitest";

import { diffBookings, experimentSummary, logComparison, pickChecks } from "../worker/experiment";
import { pack } from "../worker/store";
import { FakeD1, readData } from "./helpers";

const sample = () => pack(JSON.parse(readData("samples", "allocations_ML_E_13.json")));
const NOON = Date.UTC(2026, 9, 29, 11, 0);

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});

it("finds nothing when the bookings are the same", () => {
  expect(diffBookings(sample(), sample())).toEqual({ added: [], removed: [] });
});

it("reports new bookings, and cancelled ones as removed", () => {
  const before = sample();
  const after = sample();
  after.push(["2026-10-29T18:00:00", "2026-10-29T19:00:00", 2, "Short-notice meeting", 1]);
  const i = after.findIndex((p) => p[0] === "2026-10-29T13:00:00");
  after[i] = [after[i][0], after[i][1], 13, (after[i] as any[])[3], 0]; // cancelled
  const { added, removed } = diffBookings(before, after);
  expect(added.map((b) => b.title)).toEqual(["Short-notice meeting"]);
  expect(removed.length).toBe(1);
});

it("picks once-a-day rooms already fetched today, least recently fetched first", () => {
  const fetches = {
    A: { fullFrom: "2026-10-29", at: 5 },
    B: { fullFrom: "2026-10-29", at: 1 },
    C: { fullFrom: "2026-10-28", at: 0 }, // not fetched for today yet: the regular prefetch comes first
    D: { fullFrom: "2026-10-29", at: 0 }, // refreshed anyway
    E: { fullFrom: "2026-10-29", at: 2 },
  };
  expect(pickChecks(["A", "B", "C", "D", "E"], fetches, "2026-10-29", 2, new Set(["D"]), new Set(["E"]))).toEqual(["B", "A"]);
});

it("summarises checks and changes per room type", async () => {
  const db = new FakeD1();
  const after = [...sample(), ["2026-10-29T18:00:00", "2026-10-29T19:00:00", 2, "Exam", 1]] as ReturnType<typeof sample>;
  const base = { typecode: "3430", today: "2026-10-29", now: NOON, prevAt: NOON - 3 * 3_600_000 };
  await db.batch([
    ...logComparison(db.asD1(), { ...base, path: "ML E 12", source: "check", before: sample(), after }),
    ...logComparison(db.asD1(), { ...base, path: "ML D 28", source: "check", before: sample(), after: sample() }),
  ] as any);
  const s = await experimentSummary(db.asD1(), JSON.parse(readData("rooms_snapshot.json")), NOON);
  expect(s.active).toBe(true);
  expect(s.first_day).toBe("2026-10-29");
  expect(s.types).toEqual([
    {
      typecode: "3430",
      type: "Hörsaal",
      rooms: expect.any(Number),
      source: "check",
      checks: 2,
      changed: 1,
      hours: 6,
      added: 1,
      added_upcoming: 1,
      removed: 0,
      removed_upcoming: 0,
      rooms_changed: 1,
    },
  ]);
  expect(s.recent[0]).toMatchObject({ path: "ML E 12", kind: "added", title: "Exam", upcoming: true, date_from: "2026-10-29T18:00+01:00" });
});
