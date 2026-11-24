// Route-level checks for the Worker: prefetched data, on-demand fallback, validation, kill switch, rate limiting.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearMemoryCache } from "../worker/eth";
import worker, { type Env } from "../worker/index";
import { parseAllocations } from "../worker/availability";
import { MENU_CRON } from "../worker/config";
import { normalizeRotas } from "../worker/menus";
import { parseCatalogue, roomPath } from "../worker/catalogue";
import { parseReadings } from "../worker/spaces";
import { clearStoreMemory, pack, splitDays, unpack } from "../worker/store";
import { addDays } from "../worker/tz";
import { FakeD1, FakeKV, fakeEth, readData } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

let eth: ReturnType<typeof fakeEth>;
let kv: FakeKV;
let db: FakeD1;
const NOW = Date.UTC(2026, 9, 29, 11, 0); // Thursday 29 October, 12:00 in Zurich
const today = "2026-10-29";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  clearMemoryCache();
  clearStoreMemory();
  eth = fakeEth();
  vi.stubGlobal("fetch", eth.fetch);
  kv = new FakeKV();
  db = new FakeD1();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    ROOMS: kv.asKV(),
    DB: db.asD1(),
    ...overrides,
  };
}

const get = (path: string, e = env()) => worker.fetch(new Request(`https://frooms.test${path}`), e, ctx);
const allocationCalls = () => eth.calls.filter((u) => u.includes("/allocations"));
type Free = { at: string; fetched_at: string | null; stale: boolean; rooms: { room: string; status: string; stale_since?: string }[] };

/** Store the sample week for `rooms`, as a full fetch at `at` would, plus the allowed date range. */
function storeRooms(rooms: string[], at = NOW) {
  const raw = JSON.parse(readData("samples", "allocations_ML_E_13.json"));
  const put = (sql: string, ...args: (string | number)[]) => db.db.prepare(sql).run(...args);
  for (const path of rooms) {
    for (const d of splitDays(raw, today, addDays(today, 32))) {
      put("INSERT OR REPLACE INTO allocations (path, day, at, raw) VALUES (?, ?, ?, ?)", path, d.day, at, JSON.stringify(d.raw));
    }
    put("INSERT OR REPLACE INTO fetches (path, full_from, at) VALUES (?, ?, ?)", path, today, at);
  }
  put("INSERT OR REPLACE INTO meta (key, value) VALUES ('minmax', ?)", JSON.stringify({ at, min: "2026-02-21", max: "2027-02-21" }));
}

it("serves prefetched rooms from D1 without asking ETH", async () => {
  storeRooms(["ML E 12"]);
  const res = await get("/api/free?buildings=ML&at=2026-10-29T12:30");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  const body = (await res.json()) as Free;
  expect(body.at).toBe("2026-10-29T12:30+01:00");
  expect(body.rooms.find((r) => r.room === "ML E 12")!.status).toBe("free");
  expect(body.fetched_at).not.toBeNull();
  expect(eth.calls).toEqual([]);
});

it("serves later days of the prefetched month from D1", async () => {
  storeRooms(["ML E 12"]);
  const body = (await (await get("/api/free?buildings=ML&at=2026-10-30T09:00")).json()) as Free;
  expect(body.rooms.find((r) => r.room === "ML E 12")!.status).toBe("busy"); // the sample's 08:00-18:00 booking
  expect(allocationCalls()).toEqual([]);
});

it("shows a department's room as managed where ETH lists nothing, and ETH's bookings as busy", async () => {
  storeRooms(["HG G 19.1", "HG G 26.1"]);
  type Managed = Omit<Free, "rooms"> & { rooms: { room: string; status: string; managed_by?: string; minutes?: number | null }[] };
  const free = (await (await get("/api/free?buildings=HG&types=3420&at=2026-10-29T12:30")).json()) as Managed;
  const dmath = free.rooms.find((r) => r.room === "HG G 19.1")!;
  expect(dmath).toMatchObject({ status: "managed", managed_by: "D-MATH" });
  expect(dmath.minutes).not.toBeUndefined(); // how long ETH lists nothing, for the order
  const other = free.rooms.find((r) => r.room === "HG G 26.1")!;
  expect(other.status).toBe("free");
  expect(other.managed_by).toBeUndefined();
  expect(free.rooms.indexOf(other)).toBeLessThan(free.rooms.indexOf(dmath)); // free rooms first
  const busy = (await (await get("/api/free?buildings=HG&types=3420&at=2026-10-30T09:00")).json()) as Managed;
  expect(busy.rooms.find((r) => r.room === "HG G 19.1")).toMatchObject({ status: "busy", managed_by: "D-MATH" });
});

it("serves past days from the history, and fetches days missing from it on demand", async () => {
  storeRooms([]);
  const yesterday = addDays(today, -1);
  db.db
    .prepare("INSERT INTO allocations (path, day, at, raw) VALUES ('ML E 12', ?, ?, ?)")
    .run(yesterday, NOW - 30 * 3600_000, JSON.stringify([[`${yesterday}T08:00:00`, `${yesterday}T18:00:00`, 1]]));
  const body = (await (await get(`/api/free?buildings=ML&at=${yesterday}T12:00`)).json()) as Free;
  expect(body.rooms.find((r) => r.room === "ML E 12")!.status).toBe("busy"); // 36 h old, but past days are final
  expect(allocationCalls().length).toBe(body.rooms.length - 1); // only the rooms missing from the history
});

it("marks prefetch targets that aren't stored yet as pending instead of fetching them", async () => {
  const body = (await (await get(`/api/free?buildings=ML&at=${today}T12:00`)).json()) as Free;
  expect(body.rooms.length).toBeGreaterThan(0);
  expect(new Set(body.rooms.map((r) => r.status))).toEqual(new Set(["pending"]));
  expect(allocationCalls()).toEqual([]);
});

it("fetches days after the prefetched month on demand", async () => {
  const later = addDays(today, 32);
  storeRooms([]);
  const body = (await (await get(`/api/free?buildings=ML&at=${later}T12:00`)).json()) as Free;
  expect(body.rooms.length).toBeGreaterThan(0);
  expect(allocationCalls().length).toBe(body.rooms.length);
});

it("serves once-a-day rooms all day, and stale refreshed rooms marked with when they were fetched", async () => {
  storeRooms(["ML H 34.1", "ML F 40"], NOW - 3 * 3600_000); // computer room (once a day), seminar room (refreshed)
  const body = (await (await get(`/api/free?buildings=ML&types=3650,3420&at=${today}T12:00`)).json()) as Free;
  const computer = body.rooms.find((r) => r.room === "ML H 34.1")!;
  expect(computer.status).not.toBe("pending");
  expect(computer.stale_since).toBeUndefined();
  const seminar = body.rooms.find((r) => r.room === "ML F 40")!;
  expect(seminar.status).not.toBe("pending"); // the last bookings we have, rather than none
  expect(seminar.stale_since).toBe(body.fetched_at); // the day's own fetch, here the same as the oldest
  expect(body.stale).toBe(true);
  expect(allocationCalls()).toEqual([]);

  storeRooms(["ML F 40"], NOW);
  clearStoreMemory();
  const fresh = (await (await get(`/api/free?buildings=ML&types=3420&at=${today}T12:00`)).json()) as Free;
  expect(fresh.stale).toBe(false);
  expect(fresh.rooms.find((r) => r.room === "ML F 40")!.stale_since).toBeUndefined();
});

it("marks stale rooms on /api/room and /api/map too", async () => {
  storeRooms(["ML F 40"], NOW - 3 * 3600_000);
  const room = (await (await get(`/api/room?room=ML%20F%2040&at=${today}T12:00`)).json()) as {
    stale: boolean;
    room: { status: string; stale_since?: string };
    bookings: unknown[];
  };
  expect(room.stale).toBe(true);
  expect(room.room.status).not.toBe("pending");
  expect(room.room.stale_since).toBeTruthy();
  expect(room.bookings.length).toBeGreaterThan(0);
  const map = (await (await get(`/api/map?area=Z&rooms=1&types=3420&at=${today}T12:00`)).json()) as {
    stale: boolean;
    rooms: { room: string; stale_since?: string }[];
  };
  expect(map.stale).toBe(true);
  expect(map.rooms.find((r) => r.room === "ML F 40")!.stale_since).toBeTruthy();
});

it("still serves refreshed rooms from the night in the first hours of the morning", async () => {
  vi.setSystemTime(Date.UTC(2026, 9, 29, 6, 30)); // 07:30
  storeRooms(["ML F 40"], Date.UTC(2026, 9, 29, 0, 30)); // fetched at 01:30
  const body = (await (await get(`/api/free?buildings=ML&at=${today}T07:30`)).json()) as Free;
  expect(body.rooms.find((r) => r.room === "ML F 40")!.status).not.toBe("pending");
  expect(body.rooms.find((r) => r.room === "ML F 40")!.stale_since).toBeUndefined();
  vi.setSystemTime(Date.UTC(2026, 9, 29, 7, 30)); // 08:30: the refresh should have caught up by now
  clearStoreMemory();
  const later = (await (await get(`/api/free?buildings=ML&at=${today}T08:30`)).json()) as Free;
  expect(later.rooms.find((r) => r.room === "ML F 40")!.status).not.toBe("pending");
  expect(later.rooms.find((r) => r.room === "ML F 40")!.stale_since).toBeTruthy();
});

it("stops asking ETH on demand once it rate-limits, and shows those rooms as pending", async () => {
  eth = fakeEth(1);
  vi.stubGlobal("fetch", eth.fetch);
  storeRooms([]);
  const later = addDays(today, 32);
  const first = (await (await get(`/api/free?buildings=HG&types=2110&at=${later}T12:00`)).json()) as Free;
  expect(first.rooms.some((r) => r.status === "pending")).toBe(true);
  const callsAfterFirst = eth.calls.length;
  expect(callsAfterFirst).toBeLessThanOrEqual(1 + 4); // one success, then at most the in-flight batch
  await get(`/api/free?buildings=CAB&types=2110&at=${later}T12:00`);
  expect(eth.calls.length).toBe(callsAfterFirst);
});

it("offers dates from a month back to 4 months ahead, and rejects times outside them", async () => {
  storeRooms([]);
  const range = JSON.stringify({ at: NOW, min: "2026-02-21", max: "2027-12-31" }); // ETH's own range is wider
  db.db.prepare("UPDATE meta SET value = ? WHERE key = 'minmax'").run(range);
  expect(await (await get("/api/dates")).json()).toEqual({ min: "2026-09-28", max: "2027-02-28" });
  for (const at of ["2026-09-27T12:00", "2027-03-01T12:00"]) {
    const res = await get(`/api/free?buildings=HG&at=${at}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe("Time must be between 2026-09-28 and 2027-02-28");
  }
});

it.each([
  ["/api/free", "Pick at least one building"],
  ["/api/free?buildings=XYZ", "Unknown building: XYZ"],
  ["/api/free?buildings=HG&at=2030-01-01T10:00", "Time must be between"],
  ["/api/free?buildings=HG&at=soon", "at must look like"],
  ["/api/free?buildings=HG&min_seats=-1", "min_seats must be a whole number"],
  ["/api/free?buildings=A,B,C,D,E,F,G,H,I,J,K", "at most 10 buildings"],
  ["/api/free?buildings=HG&types=3430,3420,2110", "Too many rooms"],
])("rejects %s without asking ETH for allocations", async (path, detail) => {
  storeRooms([]);
  const res = await get(path);
  expect(res.status).toBe(400);
  expect(((await res.json()) as { detail: string }).detail).toContain(detail);
  expect(allocationCalls()).toEqual([]);
});

it("returns 404 for unknown API paths and passes other paths to the assets", async () => {
  expect((await get("/api/nope")).status).toBe(404);
  expect(await (await get("/index.html")).text()).toBe("asset");
});

it("pauses the API with the kill switch", async () => {
  const res = await get("/api/free?buildings=ML", env({ FROOMS_DISABLED: "1" }));
  expect(res.status).toBe(503);
  expect(eth.calls).toEqual([]);
});

it("rate limits /api/free per IP", async () => {
  const keys: string[] = [];
  const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } as RateLimit;
  const res = await worker.fetch(
    new Request("https://frooms.test/api/free?buildings=ML", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
    env({ RATE_LIMITER: limiter }),
    ctx,
  );
  expect(res.status).toBe(429);
  expect(res.headers.get("Retry-After")).toBe("60");
  expect(keys).toEqual(["203.0.113.7"]);
  expect(eth.calls).toEqual([]);
});

it("uses the bundled catalogue until the prefetch has stored one, without asking ETH", async () => {
  const res = await get("/api/buildings");
  expect(res.status).toBe(200);
  expect(((await res.json()) as unknown[]).length).toBeGreaterThan(0);
  expect(eth.calls).toEqual([]);
});

it("names room types in English (data/overrides.json), not ETH's German, and has ETH's two locations and UZH's three", async () => {
  const types = (await (await get("/api/types?area=Z")).json()) as { types: { typecode: string; type: string }[] };
  expect(types.types.find((t) => t.typecode === "3430")?.type).toBe("Lecture hall"); // ETH: Hörsaal
  expect(types.types.find((t) => t.typecode === "3420")?.type).toBe("Seminar room"); // ETH: Seminare / Kurse
  const areas = (await (await get("/api/areas")).json()) as { areas: { area: string; name: string }[] };
  expect(areas.areas.map((a) => [a.area, a.name])).toEqual([
    ["Z", "ETH Zentrum"],
    ["H", "ETH Hönggerberg"],
    ["UZ", "UZH Zentrum"],
    ["UI", "UZH Irchel"],
    ["UO", "UZH Oerlikon"],
  ]); // CHOICES.md
});

it("offers Meet only meeting rooms, seminar rooms and lecture halls, with the last two picked by default", async () => {
  const types = (await (await get("/api/types?area=Z")).json()) as { default: string[]; types: { typecode: string; type: string }[] };
  expect(types.types.map((t) => t.type)).toEqual(["Meeting room", "Seminar room", "Lecture hall"]);
  expect(types.default).toEqual(["3420", "3430"]);
});

it("reports prefetch progress on /api/status", async () => {
  storeRooms(["ML E 12"]);
  const body = (await (await get("/api/status")).json()) as Record<string, unknown>;
  expect(body.current_for_today).toBe(1);
  expect(body.prefetch_rooms).toBe(428); // Zentrum and Hönggerberg only
  expect(body.refreshed_rooms).toBe(264); // seminar rooms, lecture halls and meeting rooms
  expect(body.oldest_refreshed_minutes).toBe(0); // ML E 12, a lecture hall, just fetched
  expect(body.eth_backoff_until).toBeNull();
});

it("serves the experiment summary", async () => {
  const res = await get("/api/experiment");
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ until: "2026-11-12", active: true, types: [], recent: [] });
});

it("packs allocations for storage without losing what parseAllocations reads", () => {
  const raw = JSON.parse(readData("samples", "allocations_ML_E_13.json"));
  raw.push({ date_from: "2026-10-29T18:00:00", date_to: "2026-10-29T19:00:00", belegungsserie: { belegungstyp: 6 } });
  const roundTrip = unpack(JSON.parse(JSON.stringify(pack(raw))));
  expect(parseAllocations(roundTrip)).toEqual(parseAllocations(raw));
  expect(roundTrip.at(-1)!.belegungsserie.veranstaltung).toBeNull();
});

describe("invite links", () => {
  const index = readFileSync("static/index.html", "utf8");
  const assets = (images: string[]) =>
    ({
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        if (path === "/") return new Response(index);
        return new Response(null, { status: images.includes(path) ? 200 : 404 });
      },
    }) as unknown as Fetcher;
  const meta = (html: string, property: string) => html.match(new RegExp(`<meta property="${property}" content="([^"]*)"`))?.[1];

  it("puts the room and its pre-rendered image into the preview tags", async () => {
    const res = await get("/share?room=HG+E+1.1&bg=2&b=HG", env({ ASSETS: assets(["/og/2/HG-E-1-1.jpg"]) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(meta(html, "og:title")).toBe("I&#39;m in HG E 1.1, come join me!");
    expect(meta(html, "og:image")).toBe("https://frooms.test/og/2/HG-E-1-1.jpg");
    expect(meta(html, "og:url")).toBe("https://frooms.test/share?room=HG+E+1.1&#38;bg=2&#38;b=HG");
    expect(html).toContain("<title>I&#39;m in HG E 1.1, come join me!</title>");
  });

  it("falls back to the generic preview for unknown images and odd input", async () => {
    const e = env({ ASSETS: assets([]) });
    expect(meta(await (await get("/share?room=HG+E+1.1&bg=2", e)).text(), "og:image")).toBe("https://frooms.test/og/0/_any.jpg");
    const html = await (await get(`/share?room=${encodeURIComponent('"><script>x</script>')}&bg=0`, e)).text();
    expect(html).not.toContain("<script>x");
    expect(meta(html, "og:title")).toBe("frooms - Friends, free rooms &amp; more at ETH and UZH");
  });

  it("uses the background's own general preview for a room or space without an image of its own", async () => {
    const e = env({ ASSETS: assets(["/og/3/_any.jpg", "/og/3/KOL-F-101.jpg"]) });
    expect(meta(await (await get("/share?room=KOL-F-101&bg=3", e)).text(), "og:image")).toBe("https://frooms.test/og/3/KOL-F-101.jpg");
    expect(meta(await (await get("/share?room=KOL-G-201&bg=3", e)).text(), "og:image")).toBe("https://frooms.test/og/3/_any.jpg");
    expect(meta(await (await get("/share?space=HGH30.1&bg=3", e)).text(), "og:image")).toBe("https://frooms.test/og/3/_any.jpg");
  });

  it("invites to a study space or mensa by its name", async () => {
    const e = env({ ASSETS: assets(["/og/1/space-MMB79.jpg"]) });
    const mensa = await (await get("/share?space=MMB79&bg=1&mode=mensa", e)).text();
    expect(meta(mensa, "og:title")).toBe("Join me at Mensa Polyterrasse!");
    expect(meta(mensa, "og:image")).toBe("https://frooms.test/og/1/space-MMB79.jpg");
    const library = await (await get("/share?space=HGH30.1&bg=1", e)).text();
    expect(meta(library, "og:title")).toBe("I&#39;m at HG Library/Info-Center, come join me!");
    expect(meta(library, "og:image")).toBe("https://frooms.test/og/0/_any.jpg"); // no image rendered for it here
    expect(meta(await (await get("/share?space=NOPE&bg=1", e)).text(), "og:title")).toBe("frooms - Friends, free rooms &amp; more at ETH and UZH");
  });

  it("invites for lunch or dinner at a mensa, at a time or now, with the meal's own image", async () => {
    const e = env({ ASSETS: assets(["/og/meal/1/space-MMB79-lunch-1215.jpg", "/og/meal/1/space-MMB79-lunch-today.jpg", "/og/meal/1/space-MMB79-lunch-tomorrow.jpg", "/og/meal/1/space-F14-dinner-now.jpg"]) });
    const at = await (await get("/share?space=MMB79&meal=lunch&t=1215&bg=1&mode=mensa", e)).text();
    expect(meta(at, "og:title")).toBe("Lunch at Mensa Polyterrasse at 12:15?");
    expect(meta(at, "og:image")).toBe("https://frooms.test/og/meal/1/space-MMB79-lunch-1215.jpg");
    const now = await (await get("/share?space=F14&meal=dinner&t=now&bg=1", e)).text();
    expect(meta(now, "og:title")).toBe("Dinner at Alumni quattro now?");
    expect(meta(now, "og:image")).toBe("https://frooms.test/og/meal/1/space-F14-dinner-now.jpg");
    // A time without an image of its own (not a quarter hour, or outside the meal): the day's image.
    const odd = await (await get("/share?space=MMB79&meal=lunch&t=1207&bg=1", e)).text();
    expect(meta(odd, "og:title")).toBe("Lunch at Mensa Polyterrasse today?");
    expect(meta(odd, "og:image")).toBe("https://frooms.test/og/meal/1/space-MMB79-lunch-today.jpg");
    // Another day (the link's `at`): the title says which.
    vi.setSystemTime(Date.UTC(2026, 10, 4, 21, 0)); // Wednesday evening
    const tomorrow = await (await get("/share?space=MMB79&meal=lunch&t=1215&bg=1&at=2026-11-05T12:15", e)).text();
    expect(meta(tomorrow, "og:title")).toBe("Lunch at Mensa Polyterrasse tomorrow at 12:15?");
    const friday = await (await get("/share?space=MMB79&meal=lunch&t=1215&bg=1&at=2026-11-06T12:15", e)).text();
    expect(meta(friday, "og:title")).toBe("Lunch at Mensa Polyterrasse on Friday at 12:15?");
    const noTime = await (await get("/share?space=MMB79&meal=lunch&bg=1&at=2026-11-05T11:15", e)).text();
    expect(meta(noTime, "og:title")).toBe("Lunch at Mensa Polyterrasse tomorrow?");
    // The image says the same day as the title: never "today?" for tomorrow's lunch.
    expect(meta(noTime, "og:image")).toBe("https://frooms.test/og/meal/1/space-MMB79-lunch-tomorrow.jpg");
    // Not a mensa (a cafeteria): a plain invite.
    expect(meta(await (await get("/share?space=F2&meal=lunch&t=1215&bg=1", e)).text(), "og:title")).toBe("Join me at CafeBar!");
  });
});

describe("map", () => {
  type Summary = {
    building: string;
    mensa: boolean;
    study: { open: number; best: { id: string } | null };
    rooms: { free: number; unknown: number } | null;
  };
  type MapBody = { at: string; fetched_at: string | null; buildings: Summary[] };
  const map = async (query: string) => (await (await get(`/api/map?${query}`)).json()) as MapBody;
  const of = (body: MapBody, b: string) => body.buildings.find((s) => s.building === b)!;

  it("summarises a whole area from D1 and the feeds, without asking ETH", async () => {
    storeRooms(["ML E 12"]);
    const at = "2026-10-29T12:30";
    const res = await get(`/api/map?area=Z&at=${at}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    const body = (await res.json()) as MapBody;
    expect(body.at).toBe("2026-10-29T12:30+01:00");
    expect(body.fetched_at).not.toBeNull();

    // Same rule as the list: free, and for two more hours (or the rest of the stored window).
    const free = ((await (await get(`/api/free?buildings=ML&at=${at}`)).json()) as Free).rooms as unknown as
      { room: string; status: string; minutes: number | null }[];
    const e12 = free.find((r) => r.room === "ML E 12")!;
    const ml = of(body, "ML");
    expect(ml.rooms!.free).toBe(e12.status === "free" && (e12.minutes === null || e12.minutes >= 120) ? 1 : 0);
    const mlRooms = ((await (await get("/api/buildings?area=Z")).json()) as { building: string; rooms: number }[])
      .find((b) => b.building === "ML")!.rooms;
    expect(ml.rooms!.unknown).toBe(mlRooms - 1); // only ML E 12 is stored

    // Study spaces: the library is the suggestion; the mensa building is flagged, not counted.
    expect(of(body, "HG").study.best!.id).toBe("HGH30.1");
    expect(of(body, "MM")).toMatchObject({ mensa: true, study: { open: 0, best: null } });
    expect(allocationCalls()).toEqual([]);
  });

  it("sends the location's mensa order, for the map's place labels", async () => {
    const order = async (area: string) => ((await (await get(`/api/map?area=${area}`)).json()) as { order: string[] }).order;
    expect((await order("Z")).slice(0, 2)).toEqual(["MMB79", "UM1"]);
    expect((await order("Z")).at(-1)).toBe("F5"); // Dozentenfoyer last
    expect(await order("UZ")).toEqual(await order("Z"));
  });

  it("covers every lecture hall and seminar room of the area in one request", async () => {
    storeRooms(["ML E 12"]);
    const body = await map("area=Z");
    const total = body.buildings.reduce((n, b) => n + (b.rooms ? b.rooms.free + b.rooms.unknown : 0), 0);
    expect(total).toBeGreaterThan(90);
  });

  it("has no room counts outside the stored range, and checks the time", async () => {
    storeRooms(["ML E 12"]);
    const body = await map("area=Z&at=2027-01-14T10:00");
    expect(body.buildings.every((b) => b.rooms === null)).toBe(true);
    expect(of(body, "HG").study.open).toBeGreaterThan(0);
    expect((await get("/api/map?at=tomorrow")).status).toBe(400);
    expect(eth.calls).toEqual([]);
  });
});

describe("map options", () => {
  type Body = { min_free: number; buildings: { building: string; rooms: { free: number } | null }[]; rooms?: { room: string; status: string; building: string }[] | null };
  const map = async (query: string) => (await (await get(`/api/map?${query}`)).json()) as Body;
  const ml = (b: Body) => b.buildings.find((s) => s.building === "ML")!.rooms!.free;

  it("counts rooms free for a shorter time with min_free", async () => {
    storeRooms(["ML E 12"]); // free 12:00 to 13:00 on the 29th
    const long = await map("area=Z&at=2026-10-29T12:00");
    const short = await map("area=Z&at=2026-10-29T12:00&min_free=30");
    expect(long.min_free).toBe(120);
    expect(short.min_free).toBe(30);
    expect(ml(long)).toBe(0);
    expect(ml(short)).toBe(1);
  });

  it("rejects a bad min_free", async () => {
    for (const v of ["10", "300", "abc"]) expect((await get(`/api/map?area=Z&min_free=${v}`)).status).toBe(400);
  });

  it("lists the area's rooms with rooms=1, the same entries as /api/free", async () => {
    storeRooms(["ML E 12", "ML F 40"]);
    const at = "2026-10-29T12:00";
    const body = await map(`area=Z&at=${at}&rooms=1&types=3420,3430`);
    const free = (await (await get(`/api/free?area=Z&buildings=ML&types=3420,3430&at=${at}`)).json()) as Free;
    const mine = body.rooms!.filter((r) => r.building === "ML");
    // The same entries, plus each room's equipment, day blocks and reports (the list's own fields).
    expect(mine.map(({ equipment, blocks, reports, ...r }: Record<string, unknown>) => r)).toEqual(free.rooms);
    expect(mine.every((r: Record<string, unknown>) => "equipment" in r && "blocks" in r && "reports" in r)).toBe(true);
    expect(body.rooms!.length).toBeGreaterThan(mine.length); // the whole area, no building needed
    // Without rooms=1 there's no list; outside the stored range it's null.
    expect((await map(`area=Z&at=${at}`)).rooms).toBeUndefined();
    expect((await map("area=Z&at=2027-01-14T10:00&rooms=1")).rooms).toBeNull();
    expect(allocationCalls()).toEqual([]);
  });

  it("filters the list by seats", async () => {
    storeRooms([]);
    const all = await map("area=Z&rooms=1&types=3420");
    const big = await map("area=Z&rooms=1&types=3420&min_seats=60");
    expect(big.rooms!.length).toBeGreaterThan(0);
    expect(big.rooms!.length).toBeLessThan(all.rooms!.length);
  });
});

describe("one room", () => {
  type Room = { at: string; room: { room: string; status: string }; bookings: { from: string; to: string; kind: string; title: string | null }[] };
  const room = async (query: string) => {
    const res = await get(`/api/room?${query}`);
    return { status: res.status, body: (await res.json()) as Room, res };
  };

  it("serves a free room with its day", async () => {
    storeRooms(["ML E 12"]);
    const { status, body, res } = await room("room=ML+E+12&area=Z&at=2026-10-29T12:30");
    expect(status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(body.room).toMatchObject({ room: "ML E 12", status: "free" });
    expect(body.bookings.map((b) => [b.from.slice(11, 16), b.to.slice(11, 16), b.kind])).toEqual([
      ["00:00", "08:00", "closed"],
      ["08:00", "12:00", "booking"],
      ["13:00", "14:15", "booking"],
      ["14:30", "17:00", "booking"],
      ["20:00", "00:00", "closed"], // ETH's 23:59 means midnight
    ]);
    expect(allocationCalls()).toEqual([]);
  });

  it("serves a busy room", async () => {
    storeRooms(["ML E 12"]);
    const { body } = await room("room=ML%20E%2012&at=2026-10-29T13:30");
    expect(body.room).toMatchObject({ status: "busy" });
    expect(body.bookings.length).toBe(5);
  });

  it("is pending when not stored yet inside the prefetched month, and 404 for an unknown room", async () => {
    storeRooms([]);
    expect((await room("room=ML+E+12&at=2026-10-29T12:30")).body.room.status).toBe("pending");
    expect((await room("room=XYZ+E+1")).status).toBe(404);
    expect((await room("room=ML+E+12&area=H")).status).toBe(404);
    expect(allocationCalls()).toEqual([]);
  });

  it("is rate limited with /api/free", async () => {
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    expect((await get("/api/room?room=ML+E+12", env({ RATE_LIMITER: limiter }))).status).toBe(429);
  });
});

describe("search index", () => {
  type Index = { rooms: [string, string, string, number | null][]; spaces: [string, string, string, string, string][]; buildings: string[][] };

  it("lists every room, space and building of all five locations, small", async () => {
    const res = await get("/api/index");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
    const text = await res.text();
    expect(text.length).toBeLessThan(60_000);
    const body = JSON.parse(text) as Index;
    expect(body.rooms).toContainEqual(["HG E 1.1", "Z", expect.any(String), expect.anything()]);
    expect(body.rooms.some(([path, area]) => path === "KOL-F-101" && area === "UZ")).toBe(true);
    expect(body.spaces).toContainEqual(["MMB79", "Z", "Mensa Polyterrasse", expect.any(String), "mensa"]);
    expect(body.spaces.some(([id, area, , , cat]) => id === "HGH30.1" && area === "Z" && cat === "library")).toBe(true);
    expect(body.spaces.some(([, area, , , cat]) => area.startsWith("U") && cat === "library")).toBe(true);
    expect(body.buildings).toContainEqual(["HG", "Z"]);
    expect(body.buildings).toContainEqual(["KOL", "UZ"]);
    // No hidden or merged place (Octavo, Kiosk CLA, Clausiusbar's second room).
    const ids = body.spaces.map(([id]) => id);
    for (const gone of ["F23", "F4", "CLAD1.1"]) expect(ids).not.toContain(gone);
    expect(new Set(body.rooms.map(([, area]) => area))).toEqual(new Set(["Z", "H", "UZ", "UI", "UO"]));
  });
});

describe("study spaces", () => {
  // Sunday 1 November 2026, 15:45 in Zurich: 5 minutes after the sample's readings.
  const SUNDAY = Date.UTC(2026, 10, 1, 14, 45);
  type Spaces = {
    at: string;
    fetched_at: string | null;
    spaces: { id: string; category: string; study: boolean; open: boolean; until: string | null; opens_at: string | null; occupancy: { pct: number; status: string; age_minutes: number } | null }[];
  };
  const spaces = async (query: string) => (await (await get(`/api/spaces?${query}`)).json()) as Spaces;

  function storeLive(at: number) {
    const readings = parseReadings(JSON.parse(readData("samples", "studyspaces_availability.json")).data);
    db.db.prepare("INSERT INTO meta (key, value) VALUES ('spaces_live', ?)").run(JSON.stringify({ at, readings }));
  }

  beforeEach(() => {
    vi.setSystemTime(SUNDAY);
  });

  it("lists one area's spaces with ETH's occupancy estimates, without asking ETH", async () => {
    storeLive(SUNDAY - 60_000);
    const res = await get("/api/spaces?area=Z");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    const body = (await res.json()) as Spaces;
    // ETH Zentrum's 45 study spaces, SPH Zentrum, Fabrik, IPZ Hangar, and UZH Zentrum's 5 mensas (study spaces between their meals).
    expect(body.spaces.filter((s) => s.study).length).toBe(53);
    expect(body.spaces.find((s) => s.id === "SPHZ")).toMatchObject({ open: true, open_text: "Open for SPH projects", hours: ["Makerspace: Mon - Fri 08:00 - 20:00", "SPH projects: open 24/7"] });
    expect(body.fetched_at).toBe("2026-11-01T15:44+01:00");
    const hg = body.spaces.find((s) => s.id === "HGH30.1")!;
    expect(hg).toMatchObject({ category: "library", open: true, until: "2026-11-01T17:00+01:00" });
    expect(hg.occupancy).toEqual({ pct: 60, status: "yellow", trend: "steady", age_minutes: 4 });
    // Closed spaces get no estimate, even if their sensor reports one.
    expect(body.spaces.find((s) => s.id === "MMB79")).toMatchObject({ open: false, occupancy: null, opens_at: "2026-11-02T06:00+01:00" });
    expect(eth.calls).toEqual([]);
  });

  it("sorts open spaces with an estimate first, least full first, and closed ones last", async () => {
    storeLive(SUNDAY - 60_000);
    const list = (await spaces("area=Z")).spaces;
    const rank = (s: Spaces["spaces"][number]) => (s.open && s.occupancy ? 0 : s.open ? 1 : 2);
    expect(list.map(rank)).toEqual([...list.map(rank)].sort());
    const pcts = list.filter((s) => s.occupancy).map((s) => s.occupancy!.pct);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));
  });

  it("shows estimates only for now, and none once they're stale", async () => {
    storeLive(SUNDAY - 60_000);
    const later = await spaces("area=Z&at=2026-11-02T10:00");
    expect(later.fetched_at).toBeNull();
    expect(later.spaces.every((s) => s.occupancy === null)).toBe(true);
    expect(later.spaces.find((s) => s.id === "MMB79")).toMatchObject({ open: true, until: "2026-11-02T21:00+01:00" });

    clearStoreMemory();
    vi.setSystemTime(SUNDAY + 20 * 60_000);
    expect((await spaces("area=Z")).spaces.every((s) => s.occupancy === null)).toBe(true);
  });

  it("works from the bundled list before the prefetch has run", async () => {
    const body = await spaces("area=H");
    expect(body.spaces.filter((s) => s.study).length).toBe(18); // with IPZ Hangar
    expect(body.fetched_at).toBeNull();
    expect((await get("/api/spaces?at=yesterday")).status).toBe(400);
  });
});

describe("menus", () => {
  const WED = Date.UTC(2026, 10, 11, 11, 30); // Wednesday 11 November, 12:30 in Zurich (the samples start on the 9th)
  type Place = {
    id: string; name: string; category: string; building: string; kind: string | null; study: boolean; menu: boolean;
    facility: number | null; open: boolean; meal: boolean; until: string | null; open_until: string | null; opens_at: string | null;
    meals_today: { meal: string; from: string; to: string }[];
    meals_next: { date: string; meals: { meal: string; from: string; to: string }[] } | null;
  };
  const spaces = async (query: string) => ((await (await get(`/api/spaces?${query}`)).json()) as { spaces: Place[] }).spaces;

  /** The fixtures' three weeks of Mensa Polyterrasse (9), Alumni quattro (14) and Rice Up! (22), as the prefetch stores them. */
  function storeMenus() {
    for (const f of [9, 14, 22]) {
      for (const r of normalizeRotas(JSON.parse(readData("samples", `cookpit_rotas_f${f}.json`)), "2026-11-09", "2026-11-29")) {
        db.db.prepare("INSERT INTO menu_days (facility, date, at, data) VALUES (?, ?, ?, ?)").run(f, r.date, WED, JSON.stringify(r.day));
      }
      db.db.prepare("INSERT INTO menu_fetches (facility, at, ok, lines) VALUES (?, ?, 1, 1)").run(f, WED);
    }
    db.db.prepare("INSERT INTO menu_fetches (facility, at, ok, lines) VALUES (2, ?, 1, 0)").run(WED); // CafeBar
  }

  beforeEach(() => {
    vi.setSystemTime(WED);
    storeMenus();
  });

  it("gives a mensa that is a study space its meal times from the menus, and both statuses", async () => {
    const lunch = (await spaces("area=Z")).find((s) => s.id === "MMB79")!;
    expect(lunch).toMatchObject({
      kind: "mensa", study: true, menu: true, facility: 9, open: true, meal: true,
      until: "2026-11-11T14:00+01:00", open_until: "2026-11-11T21:00+01:00",
    });
    expect(lunch.meals_today).toEqual([{ meal: "lunch", from: "11:15", to: "14:00" }, { meal: "dinner", from: "17:30", to: "19:30" }]);
    clearStoreMemory();
    const between = (await spaces("area=Z&at=2026-11-11T15:00")).find((s) => s.id === "MMB79")!;
    expect(between).toMatchObject({ open: true, meal: false, until: "2026-11-11T21:00+01:00" });
    // A lunch that ends at 13:30 in Cookpit ends then (the study-space feed says 14:00).
    db.db.prepare("UPDATE menu_days SET data = json_set(data, '$.meals[0].to', '13:30') WHERE facility = 9 AND date = '2026-11-16'").run();
    const next = (await spaces("area=Z&at=2026-11-16T13:45")).find((s) => s.id === "MMB79")!;
    expect(next).toMatchObject({ meal: false });
  });

  it("falls back to the study-space feed's meal times without menus, and marks other spaces as plain study spaces", async () => {
    const h = await spaces("area=H");
    // FUSION is a mensa, so it has a Menu button even before its menus are stored (the panel says so).
    expect(h.find((s) => s.id === "HCIF5")).toMatchObject({ facility: 20, kind: "mensa", menu: true, meals_today: [{ meal: "lunch", from: "11:00", to: "14:00" }] });
    expect(h.find((s) => s.id === "HILE2.1")).toMatchObject({ kind: null, study: true, menu: false, facility: null, meals_today: [] });
  });

  it("adds the places with menus only, open when Cookpit says so", async () => {
    const h = await spaces("area=H");
    const riceUp = h.find((s) => s.id === "F22")!;
    expect(riceUp).toMatchObject({
      name: "Rice Up!", building: "HIT", category: "mensa", kind: "mensa", study: false, menu: true,
      open: true, meal: true, until: "2026-11-11T14:00+01:00",
    });
    expect(h.find((s) => s.id === "F14")).toMatchObject({ name: "Alumni quattro", building: "HIL", open: true, meal: true, until: "2026-11-11T16:00+01:00" });
    // Bellavista has no menus stored: closed, without a menu.
    expect(h.find((s) => s.id === "F15")).toMatchObject({ building: "HGP", open: false, menu: false, opens_at: null });
    clearStoreMemory();
    const later = (await spaces("area=H&at=2026-11-11T15:00")).find((s) => s.id === "F22")!;
    expect(later).toMatchObject({ open: false, opens_at: "2026-11-12T11:00+01:00" });
    // After today's lunch: tomorrow's meals, to invite for them.
    expect(later.meals_next).toEqual({ date: "2026-11-12", meals: [{ meal: "lunch", from: "11:00", to: "14:00" }] });
    const z = await spaces("area=Z");
    expect(z.find((s) => s.id === "F2")).toMatchObject({ name: "CafeBar", building: "HG", kind: "cafe", menu: false });
    expect(z.find((s) => s.id === "MMC81")).toMatchObject({ kind: "cafe" }); // Einstein & Zweistein, ours
  });

  it("names each mensa's flagship dish for the Eat tab's card: the flagship line's dish of the current or next meal", async () => {
    type Card = { id: string; flagship: { line: string; name: string; price: { student: number | null }; image: number | null } | null };
    const cards = async (q: string) => ((await (await get(`/api/spaces?${q}`)).json()) as { spaces: Card[] }).spaces;
    const of = (list: Card[], id: string) => list.find((s) => s.id === id)!.flagship;
    // Wednesday lunch: Mensa Polyterrasse's Street line (data/overrides.json), with today's photo.
    const z = await cards("area=Z");
    expect(of(z, "MMB79")).toEqual({ line: "Street", name: "Nippon Burger", price: { student: 11.5, internal: 13.5, external: 17.5 }, image: 78706 });
    expect(of(z, "F2")).toBeNull(); // CafeBar: no menu
    expect(of(z, "HGH30.1")).toBeNull(); // the library: no menu
    // Between the meals: dinner's; the evening line "Street Abend" counts as Street.
    expect(of(await cards("area=Z&at=2026-11-11T15:00"), "MMB79")).toMatchObject({ line: "Street Abend", name: "Chicken Milanese", image: 78479 });
    // Saturday: Monday's lunch, whose photo isn't served yet.
    expect(of(await cards("area=Z&at=2026-11-14T13:45"), "MMB79")).toMatchObject({ line: "Street", name: "Dragon Chicken Strips", image: null });
    // Rice Up!'s flagship line; Alumni quattro's at dinner; a mensa without stored menus has none.
    const h = await cards("area=H&at=2026-11-11T17:00");
    expect(of(h, "F22")).toMatchObject({ line: "Grilled Shrimps", image: 71803 }); // lunch is over, no dinner: tomorrow's lunch
    expect(of(await cards("area=H"), "F22")).toMatchObject({ line: "Grilled Shrimps", name: "Grilled shrimps Bowl", price: { student: 11.9 } });
    expect(of(h, "F14")).toMatchObject({ line: "World Pot Abend", name: "Rahmschnitzel" });
    expect(of(h, "HCIF5")).toBeNull();
  });

  it("serves one place's week, with the meals that have a menu", async () => {
    const res = await get("/api/menu?place=MMB79&from=2026-11-09&days=7");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");
    const body = (await res.json()) as {
      place: { id: string; kind: string; menu: boolean }; today: string;
      days: { date: string; hours: string[][]; meals: { meal: string; dishes: { name: string }[] }[] }[];
      slots: { date: string; meal: string; to: string }[];
    };
    expect(body.place).toMatchObject({ id: "MMB79", kind: "mensa", menu: true });
    expect(body.today).toBe("2026-11-11");
    expect(body.days.map((d) => d.date)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
    expect(body.days[0].meals[0].dishes[0].name).toBe("Chicken Cordon Bleu");
    // Slots: from this Monday, weekdays only, this week and next (Cookpit has two weeks of Polyterrasse).
    expect(body.slots.slice(0, 2)).toEqual([{ date: "2026-11-09", meal: "lunch", to: "14:00" }, { date: "2026-11-09", meal: "dinner", to: "19:30" }]);
    expect(body.slots.length).toBe(20);
    expect(eth.calls).toEqual([]);
  });

  it.each([
    ["/api/menu?place=NOPE", 404, "Unknown place"],
    ["/api/menu?place=MMB79&from=soon", 400, "from must look like"],
    ["/api/menu?place=MMB79&days=30", 400, "days must be between"],
    ["/api/menus?date=2026-13-45", 400, "date must look like"],
  ])("rejects %s", async (path, status, detail) => {
    const res = await get(path);
    expect(res.status).toBe(status);
    expect(((await res.json()) as { detail: string }).detail).toContain(detail);
  });

  it("serves every place of an area for one day, for the comparison", async () => {
    const res = await get("/api/menus?area=H&date=2026-11-11");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");
    const body = (await res.json()) as {
      date: string; places: { id: string; kind: string; day: { meals: { meal: string; dishes: unknown[] }[] } | null }[];
      slots: { date: string; meal: string }[];
    };
    expect(body.date).toBe("2026-11-11");
    const ids = body.places.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["F22", "F14", "F15", "HPRD70.2", "HCIF5"]));
    expect(ids).not.toContain("MMB79");
    expect(body.places.find((p) => p.id === "F14")!.day!.meals.map((m) => m.meal)).toEqual(["lunch", "dinner"]);
    expect(body.places.find((p) => p.id === "F15")!.day).toBeNull();
    // Alumni quattro and Rice Up! have menus for all three weeks; dinner only at Alumni quattro.
    expect(body.slots.filter((s) => s.date === "2026-11-23").map((s) => s.meal)).toEqual(["lunch", "dinner"]);
    expect(new Set(body.slots.map((s) => s.date)).size).toBe(15);
  });

  it("serves photos of today's and tomorrow's dishes only", async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 9, 11, 0)); // Monday, the cordon bleu's day
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect((init?.headers as Record<string, string>)["User-Agent"]).toContain("frooms");
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "Content-Type": "image/jpeg" } });
    });
    const ok = await get("/api/meal-image/78456");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("image/jpeg");
    expect(ok.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(calls).toEqual(["https://idapps.ethz.ch/cookpit-pub-services/v1/images/78456?client-id=ethz-wcms"]);
    // Tomorrow's (Tuesday's) dishes too.
    expect((await get("/api/meal-image/78464")).status).toBe(200);
    // Not on today's or tomorrow's menus (Wednesday's dish, a prefix of a real id, junk): no request to ETH.
    for (const id of ["78473", "7845", "78456x", "../facilities"]) expect((await get(`/api/meal-image/${id}`)).status).toBe(404);
    expect(calls.length).toBe(2);
    // UZH's: food2050's photo, by its object name, also only while its dish is on today's or tomorrow's menu.
    const photo = "dish-media/zfv/9bf4ca97/2026-11-09-mittagsverpflegung-one/1794824450945-u5ohdidc3v";
    const day = { hours: [["11:00", "14:00"]], meals: [{ meal: "lunch", name: "Lunch", from: "11:00", to: "14:00", dishes: [{ name: "Curry", image: photo }] }] };
    db.db.prepare("INSERT INTO menu_days (facility, date, at, data) VALUES (100006, '2026-11-09', 0, ?)").run(JSON.stringify(day));
    expect((await get(`/api/meal-image/${photo}`)).status).toBe(200);
    expect(calls.at(-1)).toBe(`https://storage.googleapis.com/dish-images-prod/${encodeURIComponent(photo)}`);
    for (const id of ["dish-media/zfv/9bf4ca97/2026-11-09-mittagsverpflegung-one/other", "dish-media/zfv/9bf4ca97", "dish-media%2F..%2Fx"]) {
      expect((await get(`/api/meal-image/${id}`)).status).toBe(404);
    }
    expect(calls.length).toBe(3);
  });

  it("resizes photos when an Images binding is configured", async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 9, 11, 0));
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3])));
    const steps: unknown[] = [];
    const transformer = {
      transform: (t: unknown) => (steps.push(t), transformer),
      output: async (o: unknown) => (steps.push(o), { response: () => new Response("webp", { headers: { "Content-Type": "image/webp" } }) }),
    };
    const IMAGES = { input: () => transformer } as unknown as ImagesBinding;
    const res = await get("/api/meal-image/78456", env({ IMAGES }));
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(steps).toEqual([{ width: 640 }, { format: "image/webp" }]);
  });

  it("runs the menu prefetch on its own cron, and the room prefetch on the other", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const scheduled = (cron: string) => worker.scheduled!({ cron, scheduledTime: WED, noRetry() {} } as ScheduledController, env(), ctx);
    // UZH's prefetch runs after the menus (skipped here during its own backoff; test/uzh.test.ts covers it).
    db.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('uzh', ?)").run(JSON.stringify({ backoffUntil: WED + 60_000 }));
    await scheduled(MENU_CRON);
    expect(eth.calls.length).toBeGreaterThan(0);
    expect(eth.calls.every((u) => u.includes("cookpit"))).toBe(true);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Menu prefetch:/), expect.stringMatching(/^UZH prefetch skipped/)]),
    );
    // The room prefetch (skipped here during a backoff, so the test doesn't wait for its pauses between requests).
    db.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('backoff_until', ?)").run(String(WED + 60_000));
    await scheduled("*/2 * * * *");
    expect(log.mock.calls.at(-1)![0]).toMatch(/^Prefetch skipped/);
    log.mockRestore();
  });

  it("serves full meals only (CHF 5 and up) and sends the location's mensa order", async () => {
    // Wednesday's lunch at Mensa Polyterrasse gets a salad by the 100 g and a fish under CHF 5 at the top.
    const cheap = (name: string, student: number) => ({ line: "Street", name, desc: "", type: "other", tags: [], price: { student, internal: student, external: student }, allergens: [], nutrition: null, image: null });
    const stored = JSON.parse((db.db.prepare("SELECT data FROM menu_days WHERE facility = 9 AND date = '2026-11-11'").get() as { data: string }).data);
    stored.meals[0].dishes = [cheap("Salad per 100 g", 2.5), cheap("Kabeljau loins", 4.8), ...stored.meals[0].dishes];
    db.db.prepare("UPDATE menu_days SET data = ? WHERE facility = 9 AND date = '2026-11-11'").run(JSON.stringify(stored));
    type Day = { meals: { dishes: { name: string; price: { student: number | null } }[] }[] };
    const names = (day: Day) => day.meals[0].dishes.map((d) => d.name);
    const menu = (await (await get("/api/menu?place=MMB79&from=2026-11-11&days=1")).json()) as { days: Day[] };
    expect(names(menu.days[0])).not.toContain("Salad per 100 g");
    expect(names(menu.days[0])).not.toContain("Kabeljau loins");
    expect(names(menu.days[0]).length).toBeGreaterThan(0);
    const menus = (await (await get("/api/menus?area=Z&date=2026-11-11")).json()) as { places: { id: string; day: Day | null }[]; order: string[] };
    const poly = menus.places.find((p) => p.id === "MMB79")!.day!;
    expect(poly.meals[0].dishes.every((d) => d.price.student == null || d.price.student >= 5)).toBe(true);
    expect(menus.order.slice(0, 3)).toEqual(["MMB79", "UM1", "UM2"]);
    // The stored day keeps them.
    expect((db.db.prepare("SELECT data FROM menu_days WHERE facility = 9 AND date = '2026-11-11'").get() as { data: string }).data).toContain("Kabeljau loins");
    const z = (await (await get("/api/spaces?area=Z")).json()) as { order: string[] };
    const uz = (await (await get("/api/spaces?area=UZ")).json()) as { order: string[] };
    expect(z.order.at(-1)).toBe("F5"); // Dozentenfoyer last
    expect(uz.order).toEqual(z.order); // UZH Zentrum uses Zentrum's
  });

  it("puts the places with menus only on the map", async () => {
    type MapBody = { buildings: { building: string; mensa: boolean; mensas: { id: string; state: string }[] }[] };
    const body = (await (await get("/api/map?area=H")).json()) as MapBody;
    const hit = body.buildings.find((b) => b.building === "HIT")!;
    expect(hit.mensas).toEqual([expect.objectContaining({ id: "F22", state: "food" })]);
    expect(body.buildings.find((b) => b.building === "HGP")).toMatchObject({ mensa: true, mensas: [expect.objectContaining({ state: "closed" })] });
  });
});

describe("feedback", () => {
  const post = (body: unknown, e = env(), headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request("https://frooms.test/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      e,
      ctx,
    );
  const stored = () => db.rows("SELECT category, message, email, context, at FROM feedback");

  it("stores a submission with its context", async () => {
    const res = await post({ category: "wrong-info", message: "  HG E 41 was locked  ", email: "a@b.ch", context: { mode: "rooms" } });
    expect(res.status).toBe(201);
    expect(stored()).toEqual([{ category: "wrong-info", message: "HG E 41 was locked", email: "a@b.ch", context: '{"mode":"rooms"}', at: NOW }]);
  });

  it("takes reports about a person (accounts, decision 13)", async () => {
    expect((await post({ category: "person", message: "About @someone: spam requests" })).status).toBe(201);
    expect(stored()[0].category).toBe("person");
  });

  it("rejects missing or invalid fields", async () => {
    expect((await post({ category: "spam", message: "hi" })).status).toBe(400);
    expect((await post({ category: "idea", message: "   " })).status).toBe(400);
    expect((await post({ category: "idea", message: "x".repeat(4001) })).status).toBe(400);
    expect((await post({ category: "idea", message: "hi", email: "not-an-email" })).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect(stored()).toEqual([]);
  });

  it("drops oversized context but keeps the message", async () => {
    await post({ category: "other", message: "hi", context: { big: "x".repeat(3000) } });
    expect(stored()[0].context).toBeNull();
  });

  it("quietly drops submissions that fill in the hidden field", async () => {
    expect((await post({ category: "idea", message: "buy now", website: "spam.example" })).status).toBe(201);
    expect(stored()).toEqual([]);
  });

  it("refuses other origins and non-JSON bodies", async () => {
    expect((await post({ category: "idea", message: "hi" }, env(), { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ category: "idea", message: "hi" }, env(), { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post({ category: "idea", message: "hi" }, env(), { Origin: "https://frooms.test" })).status).toBe(201);
  });

  it("rate limits per IP", async () => {
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const res = await post({ category: "idea", message: "hi" }, env({ FEEDBACK_LIMITER: limiter }));
    expect(res.status).toBe(429);
    expect(stored()).toEqual([]);
  });

  it("caps the total per day", async () => {
    const put = db.db.prepare("INSERT INTO feedback (at, category, message) VALUES (?, 'idea', 'x')");
    for (let i = 0; i < 200; i++) put.run(NOW - 1000);
    expect((await post({ category: "idea", message: "one more" })).status).toBe(503);
  });

  /** A fake email binding that records what it was asked to send, and a ctx that collects background work. */
  function mailer(fail = false) {
    const sent: EmailMessageBuilder[] = [];
    const binding = { send: async (m: EmailMessageBuilder) => (sent.push(m), fail ? Promise.reject(new Error("nope")) : { messageId: "1" }) };
    const pending: Promise<unknown>[] = [];
    const bg = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const e = env({ FEEDBACK_EMAIL: binding as unknown as SendEmail, FEEDBACK_TO: "me@example.ch" });
    const postWith = (body: unknown) =>
      worker.fetch(new Request("https://frooms.test/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), e, bg);
    return { sent, pending, postWith };
  }

  it("emails the whole feedback, with Reply-To set to the sender", async () => {
    const m = mailer();
    const message = "HG E 41 was locked all afternoon, although frooms showed it free\nSecond line";
    const res = await m.postWith({ category: "wrong-info", message, email: "a@b.ch", context: { mode: "rooms", buildings: ["HG", "ML"], types: [] } });
    await Promise.all(m.pending);
    expect(res.status).toBe(201);
    expect(m.sent).toHaveLength(1);
    const mail = m.sent[0];
    expect(mail.to).toBe("me@example.ch");
    expect(mail.from).toEqual({ email: "feedback@notify.frooms.ch", name: "frooms feedback" });
    expect(mail.replyTo).toBe("a@b.ch");
    expect(mail.subject).toBe("[frooms] Wrong room info: HG E 41 was locked all afternoon, although frooms showed it…");
    expect(mail.text).toContain("Category: Wrong room info");
    expect(mail.text).toContain(message);
    expect(mail.text).toContain("Sent: 2026-10-29 12:00 (Zurich time)");
    expect(mail.text).toContain("  buildings: HG, ML");
    expect(mail.text).not.toContain("types:");
  });

  it("emails without Reply-To when no address was given", async () => {
    const m = mailer();
    await m.postWith({ category: "idea", message: "Dark map please" });
    await Promise.all(m.pending);
    expect(m.sent[0].replyTo).toBeUndefined();
    expect(m.sent[0].text).toContain("From: not given");
  });

  it("keeps the feedback when the email fails, and sends none for honeypot hits", async () => {
    const m = mailer(true);
    expect((await m.postWith({ category: "idea", message: "hi" })).status).toBe(201);
    await Promise.all(m.pending);
    expect(stored()).toHaveLength(1);
    await m.postWith({ category: "idea", message: "spam", website: "x" });
    expect(m.sent).toHaveLength(1);
  });

  it("still answers GET-only for the other API routes", async () => {
    const res = await worker.fetch(new Request("https://frooms.test/api/free", { method: "POST" }), env(), ctx);
    expect(res.status).toBe(405);
  });
});

describe("reports, equipment, usual, day blocks and microwaves", () => {
  const CLIENT = "0123456789abcdef0123456789abcdef";
  const post = (body: unknown, e = env(), headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request("https://frooms.test/api/report", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }),
      e,
      ctx,
    );
  const room = { kind: "level", place_kind: "room", place: "ML E 12", area: "Z", value: 2, client: CLIENT };
  const space = { kind: "pct", place_kind: "space", place: "HGH30.1", area: "Z", value: 70, client: CLIENT, estimate: 60 };
  type Listed = { room: string; equipment: Record<string, boolean> | null; blocks: [number, number, string][] | null; reports: { levels: number[] } | null };

  it("takes a report about now and answers with the place's summary", async () => {
    const res = await post(room);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stored: "new", summary: { levels: [0, 0, 1], pct: null, n_pct: 0, last: NOW } });
    const again = (await (await post({ ...room, value: 1 })).json()) as { stored: string; summary: { levels: number[] } };
    expect(again).toMatchObject({ stored: "replaced", summary: { levels: [0, 1, 0] } });
    expect((await (await post(space)).json()) as object).toMatchObject({ summary: { pct: 70, n_pct: 1 } });
    // The UZH libraries and the places with menus only count too.
    expect((await post({ ...room, place_kind: "space", place: "F22", area: "H" })).status).toBe(200);
  });

  it("refuses unknown places, bad values, other origins and too many reports", async () => {
    expect((await post({ ...room, place: "ML E 99" })).status).toBe(404);
    expect((await post({ ...room, area: "H" })).status).toBe(404);
    expect((await post({ ...space, place: "NOPE1" })).status).toBe(404);
    expect((await post({ ...room, value: 7 })).status).toBe(400);
    expect((await post(room, env(), { Origin: "https://evil.example" })).status).toBe(403);
    const limiter = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    expect((await post(room, env({ REPORT_LIMITER: limiter }))).status).toBe(429);
    expect(db.rows("SELECT COUNT(*) AS n FROM reports")[0].n).toBe(0);
  });

  it("takes a microwave spot's queue, and lists it with the spaces", async () => {
    const queue = { kind: "queue", place_kind: "microwave", place: "MW-MM-1", area: "Z", value: 2, client: CLIENT };
    const res = await post(queue);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stored: "new", summary: { queue: [0, 0, 1, 0] } });
    expect((await post({ ...queue, value: 4 })).status).toBe(400);
    expect((await post({ ...queue, kind: "level" })).status).toBe(400);
    expect((await post({ ...room, kind: "queue", value: 1 })).status).toBe(400);
    expect((await post({ ...queue, place: "MW-NOPE" })).status).toBe(404);
    const listed = (await (await get("/api/spaces?area=Z")).json()) as { microwaves: { id: string; reports: unknown }[] };
    expect(listed.microwaves.find((m) => m.id === "MW-MM-1")?.reports).toMatchObject({ queue: [0, 0, 1, 0] });
    const log = (await (await get("/api/reports?place_kind=microwave&place=MW-MM-1&area=Z")).json()) as { reports: unknown[] };
    expect(log.reports).toEqual([{ id: 1, at: NOW, kind: "queue", value: 2 }]);
  });

  it("serves a place's log of the past 4 hours", async () => {
    await post(room);
    const res = await get("/api/reports?place_kind=room&place=ML+E+12&area=Z");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    const body = (await res.json()) as { reports: unknown[]; summary: unknown };
    // No sign-in on this host: no votes or marks, only the entry.
    expect(body.reports).toEqual([{ id: 1, at: NOW, kind: "level", value: 2 }]);
    expect(body.summary).toMatchObject({ levels: [0, 0, 1] });
    expect((await get("/api/reports?place_kind=desk&place=x")).status).toBe(400);
  });

  it("lists rooms with their equipment, day blocks and reports, and filters on a screen or projector", async () => {
    storeRooms(["ML E 12", "ML F 40", "ML E 13"]);
    kv.store.set("equipment", JSON.stringify({
      "ML E 13": { at: NOW, flags: { screen: true, projector: false, hdmi: true, wireless: true, blackboard: true, whiteboard: false, flipchart: false } },
      "ML F 40": { at: NOW, flags: { screen: false, projector: false, hdmi: false, wireless: false, blackboard: true, whiteboard: false, flipchart: false } },
    }));
    await post(room);
    const at = "2026-10-29T12:00";
    const list = async (q: string) => ((await (await get(`/api/map?area=Z&at=${at}&rooms=1&types=2110,3420,3430${q}`)).json()) as { rooms: Listed[] }).rooms;
    const all = await list("");
    const of = (rooms: Listed[], r: string) => rooms.find((x) => x.room === r);
    expect(of(all, "ML E 13")!.equipment).toMatchObject({ screen: true });
    expect(of(all, "ML E 12")).toMatchObject({ equipment: null, reports: { levels: [0, 0, 1] } });
    expect(of(all, "ML E 12")!.blocks).toEqual([[0, 480, "c"], [480, 720, "b"], [780, 855, "b"], [870, 1020, "b"], [1200, 1440, "c"]]);
    expect(of(all, "ML F 40")!.reports).toBeNull();
    expect(all.find((r) => r.room !== "ML E 12" && r.room !== "ML F 40" && r.room !== "ML E 13")!.blocks).toBeNull(); // not stored: pending

    const screen = await list("&equip=screen");
    expect(of(screen, "ML E 13")).toBeDefined();
    expect(of(screen, "ML F 40")).toBeUndefined(); // known: no screen, no projector
    expect(of(screen, "ML E 12")).toBeDefined(); // unknown: the page groups it
    expect(screen.length).toBe(all.length - 1);
    expect((await get(`/api/map?area=Z&rooms=1&equip=hdmi`)).status).toBe(400);

    // Another time: no reports.
    const later = ((await (await get("/api/map?area=Z&at=2026-10-30T10:00&rooms=1")).json()) as { rooms: Listed[] }).rooms;
    expect(later.every((r) => r.reports === null)).toBe(true);
  });

  it("keeps a whole Zentrum day under 400 KB", async () => {
    storeRooms(parseCatalogue(JSON.parse(readData("rooms_snapshot.json")), "Z").map(roomPath));
    const res = await get("/api/map?area=Z&at=2026-10-29T12:00&rooms=1&types=2110,3420,3430,3650");
    const text = await res.text();
    const body = JSON.parse(text) as { rooms: Listed[] };
    expect(body.rooms.filter((r) => r.blocks).length).toBeGreaterThan(100);
    expect(text.length).toBeLessThan(400_000);
  });

  it("gives one room its equipment, day blocks and reports", async () => {
    storeRooms(["ML E 12"]);
    kv.store.set("equipment", JSON.stringify({ "ML E 12": { at: NOW, flags: { screen: false, projector: true, hdmi: true, wireless: false, blackboard: true, whiteboard: false, flipchart: false } } }));
    await post(room);
    const body = (await (await get("/api/room?room=ML+E+12&area=Z")).json()) as { room: Listed };
    expect(body.room.equipment).toMatchObject({ projector: true });
    expect(body.room.reports).toMatchObject({ levels: [0, 0, 1] });
    expect(body.room.blocks).toHaveLength(5);
    const later = (await (await get("/api/room?room=ML+E+12&area=Z&at=2026-10-30T09:00")).json()) as { room: Listed };
    expect(later.room.reports).toBeNull();
    expect(later.room.blocks).toEqual([[0, 480, "c"], [480, 1080, "b"], [1200, 1440, "c"]]);
  });

  it("gives the spaces their reports, how full they usually are and the location's microwaves", async () => {
    await post(space);
    const slots = { "48": [40, 30, 60, 3] }; // Thursday 12:00
    db.db.prepare("INSERT INTO usual (space, weekday, slots) VALUES ('HGH30.1', 3, ?)").run(JSON.stringify(slots));
    type Body = { spaces: { id: string; reports: { pct: number } | null; usual: { pct: number | null; curve: (number | null)[] } | null }[]; microwaves: { id: string; count: number }[] };
    const body = (await (await get("/api/spaces?area=Z")).json()) as Body;
    const hg = body.spaces.find((s) => s.id === "HGH30.1")!;
    expect(hg.reports).toMatchObject({ pct: 70, n_pct: 1 });
    expect(hg.usual!.pct).toBe(50);
    expect(hg.usual!.curve).toHaveLength(96);
    expect(body.spaces.find((s) => s.id === "MMB79")).toMatchObject({ reports: null, usual: null });
    expect(body.microwaves.map((m) => m.id)).toEqual(["MW-MM-1", "MW-MM-2", "MW-MM-3", "MW-CHN-1", "MW-CAB-1", "MW-ETZ-1", "MW-GLC-1", "MW-KOL-1", "MW-C1R-1"]);
    // UZH Zentrum sees both Zentrums' microwaves; Hönggerberg only its own.
    expect(((await (await get("/api/spaces?area=UZ")).json()) as Body).microwaves).toHaveLength(9);
    expect(((await (await get("/api/spaces?area=H")).json()) as Body).microwaves.map((m) => m.id)).toEqual(["MW-HIL-1", "MW-HPR-1"]);
    // Another day: no reports, and the usual curve of that weekday (none stored for Friday).
    const friday = (await (await get("/api/spaces?area=Z&at=2026-10-30T12:00")).json()) as Body;
    expect(friday.spaces.find((s) => s.id === "HGH30.1")).toMatchObject({ reports: null, usual: null });
  });
});
