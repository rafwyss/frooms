import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EQUIPMENT_PER_RUN, EXPERIMENT_CHECKS_PER_RUN, PREFETCH_ROOMS_PER_RUN } from "../worker/config";
import { clearMemoryCache, EthClient } from "../worker/eth";
import { EATERY_OVERRIDES } from "../worker/overrides";
import { ownCampuses } from "../worker/spaces";
import { acceptSpaces, isQuiet, pickRooms, prefetchTargets, refreshedTargets, refreshesPerRun, runMenuPrefetch, runPrefetch } from "../worker/prefetch";
import { clearStoreMemory, type FetchState, readCatalogue, readFetches } from "../worker/store";
import { FakeD1, FakeKV, fakeEth, readData } from "./helpers";

let kv: FakeKV;
let db: FakeD1;
const client = () => new EthClient("frooms-test", undefined, false);
const NOON = Date.UTC(2026, 9, 29, 11, 0); // 12:00 in Zurich
const NIGHT = Date.UTC(2026, 9, 29, 0, 30); // 01:30 in Zurich
const run = (now = NOON) => runPrefetch({ ROOMS: kv.asKV(), DB: db.asD1() }, client(), now, 0);
const roomCalls = (calls: string[]) => calls.filter((u) => u.includes("/allocations"));
const pathOf = (url: string) => url.match(/path=\/rooms\/(.*)\/allocations/)![1];

beforeEach(() => {
  clearMemoryCache();
  clearStoreMemory();
  kv = new FakeKV();
  db = new FakeD1();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Refreshes per run for the catalogue the run reads (Zentrum and Hönggerberg only). */
const runRefreshes = async () => refreshesPerRun(refreshedTargets(await readCatalogue(kv as unknown as KVNamespace)).values());

/** Mark every room as fetched at `at` for the week starting `day`, with no bookings on `day`. */
function seedAll(day: string, at: number) {
  const catalogue = JSON.parse(readData("rooms_snapshot.json"));
  const raw = JSON.stringify([]);
  for (const path of prefetchTargets(catalogue)) {
    db.db.prepare("INSERT INTO fetches (path, full_from, at) VALUES (?, ?, ?)").run(path, day, at);
    db.db.prepare("INSERT INTO allocations (path, day, at, raw) VALUES (?, ?, ?, ?)").run(path, day, at, raw);
  }
  kv.store.set("catalogue", JSON.stringify({ at, raw: catalogue }));
  db.db.prepare("INSERT INTO meta (key, value) VALUES ('minmax', ?)").run(JSON.stringify({ at, min: "2026-02-21", max: "2027-02-21" }));
}

it("prefetches every room and refreshes seminar rooms and lecture halls every 30 minutes, meeting rooms hourly", () => {
  const catalogue = JSON.parse(readData("rooms_snapshot.json"));
  const targets = prefetchTargets(catalogue);
  expect(targets.length).toBe(447);
  expect(targets).toContain("ML E 12");
  expect(targets.every((t) => !t.startsWith("UNKNOWN"))).toBe(true);
  const refreshed = refreshedTargets(catalogue);
  expect(refreshed.size).toBe(276); // 149 seminar rooms, 72 lecture halls, 55 meeting rooms
  expect(refreshed.get("ML E 12")).toBe(1800); // lecture hall
  expect([...refreshed.values()].filter((s) => s === 3600).length).toBe(55);
  expect(refreshed.has("LEE E 308")).toBe(false); // multi-purpose room: once a day
});

it("orders rooms: never fetched, then an older full fetch, then least recently fetched", () => {
  const f: Record<string, FetchState> = {
    A: { fullFrom: "2026-10-29", at: 300 },
    B: { fullFrom: "2026-10-28", at: 900 },
    C: { fullFrom: "2026-10-29", at: 100 },
  };
  expect(pickRooms(["A", "B", "C", "D"], f, "2026-10-29", 10)).toEqual(["D", "B", "C", "A"]);
  expect(pickRooms(["A", "B", "C", "D"], f, "2026-10-29", 2)).toEqual(["D", "B"]);
  expect(pickRooms(["A", "B", "C", "D"], f, "2026-10-29", 10, { quiet: true })).toEqual(["D", "B"]);
  // Rooms that aren't refreshed are fetched once a day, then left alone.
  expect(pickRooms(["A", "B", "C", "D"], f, "2026-10-29", 10, { refreshed: new Set(["A", "B"]) })).toEqual(["D", "B", "A"]);
});

it("refreshes rooms only when due, and only a few per run", () => {
  const f: Record<string, FetchState> = {
    A: { fullFrom: "2026-10-29", at: 300 },
    B: { fullFrom: "2026-10-29", at: 100 },
    C: { fullFrom: "2026-10-29", at: 200 },
    D: { fullFrom: "2026-10-28", at: 900 },
  };
  expect(pickRooms(["A", "B", "C", "D"], f, "2026-10-29", 10, { refreshBefore: 250 })).toEqual(["D", "B", "C"]);
  expect(pickRooms(["A", "B", "C", "D"], f, "2026-10-29", 10, { maxRefresh: 1 })).toEqual(["D", "B"]);
  expect(pickRooms(["A", "B", "C", "D"], f, "2026-10-29", 1, { maxRefresh: 5 })).toEqual(["D"]); // full fetches first
  expect(refreshesPerRun(Array(204).fill(3600))).toBe(7); // 204 rooms an hour, 30 runs an hour
  expect(refreshesPerRun([...Array(221).fill(1800), ...Array(55).fill(3600)])).toBe(17); // 14.7 + 1.8
  expect(refreshesPerRun(Array(15).fill(1800))).toBe(1); // exactly one, not two from rounding
  // Each room's own interval: A is due (fetched at 300, due before 400), C isn't (due before 150).
  const due = { A: 400, B: 50, C: 150 } as Record<string, number>;
  expect(pickRooms(["A", "B", "C", "D"], f, "2026-10-29", 10, { refreshBefore: (p) => due[p] })).toEqual(["D", "A"]);
});

it("treats 22:00-06:00 Zurich time as quiet hours", () => {
  expect(isQuiet(Date.UTC(2026, 9, 29, 21, 30))).toBe(true); // 22:30 CET
  expect(isQuiet(Date.UTC(2026, 9, 29, 4, 59))).toBe(true); // 05:59 CET
  expect(isQuiet(Date.UTC(2026, 9, 29, 5, 0))).toBe(false); // 06:00 CET
  expect(isQuiet(Date.UTC(2026, 9, 29, 12, 0))).toBe(false);
});

it("fetches a room's whole month first, one row per day, in a single D1 batch", async () => {
  const eth = fakeEth();
  vi.stubGlobal("fetch", eth.fetch);
  const result = await run(NIGHT);
  // At night, a few rooms' equipment after the rooms (worker/equipment.ts).
  expect(eth.calls.length).toBe(PREFETCH_ROOMS_PER_RUN + EQUIPMENT_PER_RUN);
  expect(eth.calls.slice(PREFETCH_ROOMS_PER_RUN).every((u) => /path=\/v2\/rooms\/[A-Z]/.test(u))).toBe(true);
  expect(eth.calls[0]).toContain("/v2/rooms");
  expect(eth.calls[1]).toContain("min-max");
  expect(eth.calls[2]).toContain("/studyspaces.json");
  expect(eth.calls[3]).toContain("/studyspaces/availability.json");
  expect(roomCalls(eth.calls).every((u) => u.includes("from=2026-10-29&to=2026-11-30"))).toBe(true);
  expect(kv.puts).toEqual(["catalogue", "spaces", "equipment"]);
  expect(db.batches).toBe(2); // the rooms, and (the day's first run) "usually this full" in a batch of its own

  const fetched = PREFETCH_ROOMS_PER_RUN - 4;
  expect(db.rows("SELECT COUNT(*) AS n FROM allocations")[0].n).toBe(fetched * 33); // today to today+32
  const room = pathOf(roomCalls(eth.calls)[0]);
  const days = db.rows("SELECT day, raw FROM allocations WHERE path = ? ORDER BY day", room);
  expect(days[0].day).toBe("2026-10-29");
  expect(JSON.parse(days[0].raw).length).toBe(5); // the sample's bookings starting on the 29th
  expect(days[4].day).toBe("2026-11-02");
  expect(JSON.parse(days[4].raw)).toEqual([]); // fetched, but beyond the sample's week
  expect(Object.values(await readFetches(db.asD1())).every((f) => f.fullFrom === "2026-10-29")).toBe(true);
  expect(result.fetched).toBe(PREFETCH_ROOMS_PER_RUN);
});

it("moves on to the next rooms on the following run, without refetching catalogue or dates", async () => {
  const eth = fakeEth();
  vi.stubGlobal("fetch", eth.fetch);
  await run(NIGHT);
  const first = new Set(roomCalls(eth.calls).map(pathOf));
  clearMemoryCache();
  eth.calls.length = 0;
  await run(NIGHT + 120_000);
  const rooms = roomCalls(eth.calls);
  expect(rooms.length).toBe(PREFETCH_ROOMS_PER_RUN);
  expect(eth.calls.length).toBe(PREFETCH_ROOMS_PER_RUN + EQUIPMENT_PER_RUN); // the rest is equipment
  expect(rooms.map(pathOf).some((p) => first.has(p))).toBe(false);
});

it("keeps a month of history and deletes older days once a day", async () => {
  const insert = db.db.prepare("INSERT INTO allocations (path, day, at, raw) VALUES ('ML E 12', ?, 1, '[]')");
  insert.run("2026-09-27"); // 32 days ago
  insert.run("2026-09-28"); // 31 days ago
  vi.stubGlobal("fetch", fakeEth().fetch);
  await run(NIGHT);
  const past = () => db.rows("SELECT day FROM allocations WHERE day < '2026-10-29' ORDER BY day").map((r) => r.day);
  expect(past()).toEqual(["2026-09-28"]);
  expect(db.rows("SELECT value FROM meta WHERE key = 'cleaned'")[0].value).toBe("2026-10-29");

  insert.run("2026-09-01");
  clearMemoryCache();
  await run(NIGHT + 120_000);
  expect(past()).toEqual(["2026-09-01", "2026-09-28"]); // not again the same day
});

it("refreshes only today and tomorrow once the month is fetched, a few rooms per run, and checks a few once-a-day rooms", async () => {
  seedAll("2026-10-29", NIGHT);
  const eth = fakeEth();
  vi.stubGlobal("fetch", eth.fetch);
  const result = await run();
  const calls = roomCalls(eth.calls);
  const refreshes = await runRefreshes();
  expect(calls.length).toBe(refreshes + EXPERIMENT_CHECKS_PER_RUN);
  expect(calls.every((u) => u.includes("from=2026-10-29&to=2026-10-30"))).toBe(true);
  const refreshed = refreshedTargets(await readCatalogue(kv as unknown as KVNamespace));
  const paths = calls.map(pathOf);
  expect(paths.slice(0, refreshes).every((p) => refreshed.has(p))).toBe(true);
  expect(paths.slice(refreshes).some((p) => refreshed.has(p))).toBe(false);
  expect(result.checked).toBe(EXPERIMENT_CHECKS_PER_RUN);

  // The seeded days were empty, so every booking in the sample's 29th and 30th shows up as added.
  const checks = db.rows("SELECT source, SUM(checks) AS n, SUM(changed) AS changed FROM exp_checks GROUP BY source ORDER BY source");
  expect(checks).toEqual([
    { source: "check", n: EXPERIMENT_CHECKS_PER_RUN, changed: EXPERIMENT_CHECKS_PER_RUN },
    { source: "refresh", n: refreshes, changed: refreshes },
  ]);
  const changes = db.rows("SELECT kind, upcoming, COUNT(*) AS n FROM exp_changes WHERE source = 'check' GROUP BY kind, upcoming");
  expect(changes.every((c) => c.kind === "added")).toBe(true);
  expect(changes.find((c) => c.upcoming === 0)).toBeTruthy(); // the 29th's morning had passed at noon
});

it("logs nothing and checks nothing in quiet hours or after the experiment ends", async () => {
  seedAll("2026-11-12", Date.UTC(2026, 10, 12, 0, 30));
  const eth = fakeEth();
  vi.stubGlobal("fetch", eth.fetch);
  const result = await run(Date.UTC(2026, 10, 12, 11, 0)); // 12 November, noon
  expect(result.checked).toBe(0);
  expect(roomCalls(eth.calls).length).toBe(await runRefreshes());
  expect(db.rows("SELECT * FROM exp_checks")).toEqual([]);
});

it("stops at the first rate limit and pauses later runs", async () => {
  const eth = fakeEth(5);
  vi.stubGlobal("fetch", eth.fetch);
  const now = Date.now(); // the backoff is measured on the real clock
  const result = await run(now);
  expect(eth.calls.length).toBe(6); // 5 ok, then one 503 and no retry
  expect(result.backoffUntil).toBeGreaterThanOrEqual(now + 120_000);
  // catalogue + dates + study spaces + occupancy + 1 room
  expect(db.rows("SELECT COUNT(DISTINCT path) AS n FROM allocations")[0].n).toBe(1);
  expect(Number(db.rows("SELECT value FROM meta WHERE key = 'backoff_until'")[0].value)).toBe(result.backoffUntil);

  clearMemoryCache();
  eth.calls.length = 0;
  const skipped = await run(now + 60_000);
  expect(skipped.skipped).toBe("backoff");
  expect(eth.calls).toEqual([]);
});

describe("study spaces", () => {
  const sample = JSON.parse(readData("samples", "studyspaces_availability.json")).data as { attributes: Record<string, unknown> }[];
  const withReading = sample.filter((d) => d.attributes.timestamp).length;
  const occupancyCalls = (calls: string[]) => calls.filter((u) => u.includes("/studyspaces/availability.json"));
  const listCalls = (calls: string[]) => calls.filter((u) => u.includes("/studyspaces.json"));

  it("stores every reading with ETH's own timestamp, and the latest ones for the page", async () => {
    vi.stubGlobal("fetch", fakeEth().fetch);
    await run();
    // Sensors in Zurich that aren't on ETH's list (CHNF46, HILB21, MLH37.1) are kept; the sample has none in Basel.
    expect(db.rows("SELECT COUNT(*) AS n FROM occupancy")[0].n).toBe(withReading);
    const hg = db.rows("SELECT * FROM occupancy WHERE space = 'HGH30.1'")[0];
    expect(hg).toMatchObject({ people: 98, capacity: 150, pct: 60, status: "yellow", trend: "steady", active: 1 });
    expect(hg.measured_at).toBe(Date.parse("2026-11-01T15:40:20.469+01:00"));
    // A sensor that only reports a timestamp (stuck since 15 October) is kept too, to measure such gaps.
    expect(db.rows("SELECT people FROM occupancy WHERE space = 'HCIG5.1'")).toEqual([{ people: null }]);
    const live = JSON.parse(db.rows("SELECT value FROM meta WHERE key = 'spaces_live'")[0].value);
    expect(live.readings["MMB79"].capacity).toBe(650);
    expect(kv.json("spaces").raw.length).toBe(62); // 66 without Basel's 4
  });

  it("fetches the occupancy every 5 minutes by day and every 15 at night, the list hourly, and keeps repeat readings", async () => {
    const eth = fakeEth();
    vi.stubGlobal("fetch", eth.fetch);
    for (const minutes of [0, 2, 4, 6, 8, 10, 12, 62]) {
      clearMemoryCache();
      await run(NOON + minutes * 60_000);
    }
    expect(occupancyCalls(eth.calls).length).toBe(4); // 0, 6, 12, 62
    expect(listCalls(eth.calls).length).toBe(2); // 0, 62
    // ETH's sample never changes, so the same readings are stored again: that's how frozen sensors show up.
    expect(db.rows("SELECT COUNT(DISTINCT measured_at) AS n, COUNT(*) AS rows FROM occupancy WHERE space = 'HGH30.1'")[0]).toEqual({ n: 1, rows: 4 });

    eth.calls.length = 0;
    for (const minutes of [0, 6, 12, 16]) {
      clearMemoryCache();
      await run(NIGHT + 86_400_000 + minutes * 60_000); // the following night
    }
    expect(occupancyCalls(eth.calls).length).toBe(2); // 0, 16
  });

  it("keeps the stored list when ETH sends a much shorter one, until it has done so for a day", () => {
    const full = JSON.parse(readData("samples", "studyspaces_en.json")).data as unknown[];
    const stored = acceptSpaces(null, full, 0);
    expect(stored.raw.length).toBe(62);
    const short = ownCampuses(full).slice(0, 38); // as ETH sent on 2026-11-21
    const kept = acceptSpaces(stored, short, 3600_000);
    expect(kept.raw.length).toBe(62);
    expect(kept).toMatchObject({ at: 3600_000, shortSince: 3600_000 });
    expect(acceptSpaces(kept, short, 7200_000)).toMatchObject({ shortSince: 3600_000 });
    expect(acceptSpaces(kept, short, 3600_000 + 86_400_000).raw.length).toBe(38); // a day of short lists: they're gone
    const back = acceptSpaces(kept, full, 7200_000); // the full list again
    expect(back.raw.length).toBe(62);
    expect(back.shortSince).toBeUndefined();
    expect(acceptSpaces(stored, ownCampuses(full).slice(0, 55), 0).raw.length).toBe(55); // a few fewer: taken
  });

  it("doesn't count an unusable response as a fetch", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("studyspaces") ? new Response(JSON.stringify({ data: [] })) : fakeEth().fetch(url),
    );
    await run();
    expect(db.rows("SELECT COUNT(*) AS n FROM occupancy")[0].n).toBe(0);
    expect(db.rows("SELECT * FROM meta WHERE key IN ('occupancy_at', 'spaces_live')")).toEqual([]);
    expect(kv.store.has("spaces")).toBe(false);
  });
});

describe("menus", () => {
  const WED = Date.UTC(2026, 10, 11, 11, 0); // Wednesday 11 November, 12:00 in Zurich (the samples start on the 9th)
  const runMenus = (now = WED) => runMenuPrefetch({ ROOMS: kv.asKV(), DB: db.asD1() }, client(), now);
  const cookpitCalls = (calls: string[]) => calls.filter((u) => u.includes("cookpit"));
  const days = (facility: number) => db.rows("SELECT date, at, data FROM menu_days WHERE facility = ? ORDER BY date", facility);
  /** Every facility of ours fetched at `at`, except `due`. */
  function fetchedAllBut(due: number[], at: number) {
    for (const id of Object.keys(EATERY_OVERRIDES).map(Number)) {
      if (due.includes(id)) continue;
      db.db.prepare("INSERT OR REPLACE INTO menu_fetches (facility, at, ok, lines) VALUES (?, ?, 1, 1)").run(id, at);
    }
  }

  it("stores the facility list once a day and fetches one facility per run, three weeks in one request", async () => {
    const eth = fakeEth();
    vi.stubGlobal("fetch", eth.fetch);
    fetchedAllBut([9], WED - 60_000);
    const res = await runMenus();
    expect(res).toMatchObject({ facility: 9, written: 14, deleted: 0 }); // Cookpit has two weeks so far
    const calls = cookpitCalls(eth.calls);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("/facilities?client-id=ethz-wcms&lang=en");
    expect(calls[1]).toContain("/weeklyrotas?client-id=ethz-wcms&lang=en&facility=9&valid-after=2026-11-09&valid-before=2026-11-29");
    expect(kv.json("eateries").raw.length).toBe(22);
    expect(days(9).map((r) => r.date)[0]).toBe("2026-11-09");
    expect(db.rows("SELECT * FROM menu_fetches WHERE facility = 9")[0]).toMatchObject({ ok: 1, lines: 1 });
    expect(db.batches).toBe(1);

    // Next run: nothing due, no request at all.
    eth.calls.length = 0;
    expect(await runMenus(WED + 120_000)).toMatchObject({ facility: null, written: 0 });
    expect(cookpitCalls(eth.calls)).toEqual([]);
  });

  it("writes only the days that changed, and deletes the days Cookpit no longer has", async () => {
    vi.stubGlobal("fetch", fakeEth().fetch);
    fetchedAllBut([9], WED - 60_000);
    await runMenus();
    // Stored at the real time: mark this fetch as older, and its days, so the next run is due and its writes stand out.
    db.db.prepare("UPDATE menu_fetches SET at = ? WHERE facility = 9").run(WED - 2 * 3600_000);
    db.db.prepare("UPDATE menu_days SET at = 1 WHERE facility = 9").run();
    const before = days(9);
    db.db.prepare("UPDATE menu_days SET data = '{}' WHERE facility = 9 AND date = '2026-11-12'").run();
    db.db.prepare("INSERT INTO menu_days (facility, date, at, data) VALUES (9, '2026-11-27', 1, '{}')").run();
    db.db.prepare("INSERT INTO menu_days (facility, date, at, data) VALUES (9, '2026-10-20', 1, '{}')").run(); // history: kept

    // At a fixed time by day: at night the interval is longer, so a real clock would make this depend on the hour.
    fetchedAllBut([9], WED);
    const res = await runMenus(WED);
    expect(res).toMatchObject({ facility: 9, written: 1, deleted: 1 });
    const after = days(9);
    expect(after.find((r) => r.date === "2026-11-12")!.data).toBe(before.find((r) => r.date === "2026-11-12")!.data);
    expect(after.filter((r) => r.at > before[0].at).map((r) => r.date)).toEqual(["2026-11-12"]);
    expect(after.map((r) => r.date)).toContain("2026-10-20");
    expect(after.map((r) => r.date)).not.toContain("2026-11-27");
  });

  it("remembers places without menu lines (cafés) and deletes days older than 60 days once a day", async () => {
    vi.stubGlobal("fetch", fakeEth().fetch);
    fetchedAllBut([2], WED - 60_000);
    db.db.prepare("INSERT INTO menu_days (facility, date, at, data) VALUES (9, '2026-09-08', 1, '{}'), (9, '2026-09-17', 1, '{}')").run();
    await runMenus();
    expect(db.rows("SELECT * FROM menu_fetches WHERE facility = 2")[0]).toMatchObject({ ok: 1, lines: 0 });
    expect(db.rows("SELECT date FROM menu_days WHERE facility = 9").map((r) => r.date)).toEqual(["2026-09-17"]);
  });

  it("skips its turn during ETH's backoff, and sets the backoff when rate-limited", async () => {
    const eth = fakeEth(1); // the facility list works, the rotas don't
    vi.stubGlobal("fetch", eth.fetch);
    fetchedAllBut([9], WED - 60_000);
    await runMenus();
    const until = Number(db.rows("SELECT value FROM meta WHERE key = 'backoff_until'")[0].value);
    expect(until).toBeGreaterThan(WED);
    expect(db.rows("SELECT * FROM menu_fetches WHERE facility = 9")[0]).toMatchObject({ ok: 0 });

    clearMemoryCache();
    eth.calls.length = 0;
    expect(await runMenus(WED + 30_000)).toMatchObject({ skipped: "backoff" });
    expect(eth.calls).toEqual([]);
  });
});
