// UZH: the booking calendar's rooms (worker/uzh.ts), the University Library (worker/uzhspaces.ts), the UZH prefetch
// (worker/uzhprefetch.ts) and the routes that serve them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseAllocations, roomStatus } from "../worker/availability";
import { roomPath } from "../worker/catalogue";
import worker, { type Env } from "../worker/index";
import { clearStoreMemory, splitPacked, unpack } from "../worker/store";
import { parseNaive } from "../worker/tz";
import { blocksOf, isClosedWidget, mapBuilding, packBlocks, parseOccusense, parseTitle, parseUzhCatalogue, roomParts, UZH_SNAPSHOT, UzhClient } from "../worker/uzh";
import { runUzhPrefetch } from "../worker/uzhprefetch";
import { closureAt, hoursLines, LIBRARIES_SNAPSHOT, parseClosure, UZH_SENSORS, uzhLibraries } from "../worker/uzhspaces";
import { FakeD1, FakeKV, readData } from "./helpers";

const ROOM51 = JSON.parse(readData("samples", "uzh_calendar_room51.json"));
const IRCHEL_DAY = JSON.parse(readData("samples", "uzh_calendar_day_irchel.json"));
const SENSOR_HTML = readData("samples", "uzh_occusense_2.html");
const ETH_ROOMS = JSON.parse(readData("rooms_snapshot.json")) as { area: string; building: string }[];
const zurich = (s: string) => parseNaive(s)!;
const rooms = parseUzhCatalogue(UZH_SNAPSHOT);
const byCode = new Map(rooms.map((r) => [r.code!, r]));

describe("catalogue", () => {
  it("reads code, seats and the kind of space from a title", () => {
    expect(parseTitle("KOL-F-101 (209 Plätze) **")).toMatchObject({ building: "KOL", floor: "F", room: "101", code: "KOL-F-101", seats: 209, unit: "Plätze" });
    expect(parseTitle("BIN-0-K.11/12 (36 Plätze)")).toMatchObject({ building: "BIN", floor: "0", room: "K.11/12", seats: 36 });
    expect(parseTitle("KOL-G-201 Aula (280 / mit Emporen 359 Plätze ) **")?.seats).toBe(280);
    expect(parseTitle("Y-Lichthof (800 Personen)")).toBeNull();
    expect(parseTitle("Y13-M-Foyer Aquarium (44 Personen)")).toMatchObject({ unit: "Personen" });
    expect(parseTitle("Mensa oben, zfv, inkl. Terrasse (min. 60 / max. 200 Plätze)")).toBeNull();
    expect(parseTitle("KOL-E-12")).toMatchObject({ code: "KOL-E-12", seats: null });
  });

  it("splits combined rooms into their parts", () => {
    expect(roomParts("K.11/12/13")).toEqual(["K.11", "K.12", "K.13"]);
    expect(roomParts("62/68/70")).toEqual(["62", "68", "70"]);
    expect(roomParts("101")).toEqual(["101"]);
  });

  it("keeps the teaching rooms and leaves out event spaces, apéro areas and combinations of listed rooms", () => {
    const codes = new Set(rooms.map((r) => r.code));
    for (const kept of ["KOL-F-101", "HAH-E-03", "Y15-G-20", "BIN-0-K.02", "AND-5-29/31", "Y13-L-11/13", "Y21-F-65", "KOL-G-201"]) {
      expect(codes, kept).toContain(kept);
    }
    for (const left of ["BIN-0-K.11/12", "Y22-F-62/68/70", "AND-3-02/06", "KUM-E-1/2/3", "BIN-0-Mall", "Y24-Medizinerhof", "KOL-K-Küche"]) {
      expect(codes, left).not.toContain(left);
    }
    expect(rooms.some((r) => /Apéro|Lichthof|Empfang|Studienplätze/.test(UZH_SNAPSHOT.find((s) => s.id === r.uzh!.id)!.title))).toBe(false);
    expect(new Set(rooms.map((r) => r.area))).toEqual(new Set(["UZ", "UI", "UO"]));
    expect(rooms.length).toBeGreaterThan(150);
  });

  it("calls rooms from 100 seats lecture halls, the rest seminar rooms, and labs teaching labs", () => {
    expect(byCode.get("KOL-F-101")).toMatchObject({ typecode: "3430", type: "Lecture hall", seats: 209 });
    expect(byCode.get("KOL-F-103")).toMatchObject({ typecode: "3420", type: "Seminar room" });
    expect(byCode.get("Y14-F-21")).toMatchObject({ typecode: "3610", type: "Teaching lab" });
  });

  it("keys UZH rooms by their code, which can't clash with ETH's room paths", () => {
    expect(roomPath(byCode.get("HAH-E-10")!)).toBe("HAH-E-10");
    expect(rooms.every((r) => !roomPath(r).includes(" "))).toBe(true);
    // ETH's buildings in our areas never share a code with UZH's (the frontend sends the area anyway).
    const eth = new Set(ETH_ROOMS.filter((r) => ["Z", "H"].includes(r.area)).map((r) => r.building));
    expect(rooms.filter((r) => eth.has(r.building))).toEqual([]);
  });

  it("links each room to UniAbility", () => {
    expect(byCode.get("KOL-F-101")!.url).toMatch(/^https:\/\/www\.uniability\.uzh\.ch\/static\/current\/buildings\/KOL\//);
  });
});

describe("map", () => {
  const campuses = JSON.parse(readData("map", "campuses.json"));
  it("draws every UZH building with rooms or libraries, or says why not", () => {
    for (const area of ["UZ", "UI", "UO"]) {
      const doc = JSON.parse(readData("..", "static", "map", `${area}.json`));
      const codes = new Set([
        ...rooms.filter((r) => r.area === area).map((r) => mapBuilding(r.building)),
        ...uzhLibraries(LIBRARIES_SNAPSHOT).filter((l) => l.area === area).map((l) => mapBuilding(l.building)),
      ]);
      const left = Object.keys(campuses[area].not_on_map ?? {});
      for (const code of codes) expect(code in doc.buildings || left.includes(code), `${area} ${code}`).toBe(true);
    }
  });

  it("writes the buildings without an outline as label only, with no anchor and the smallest size", () => {
    const doc = JSON.parse(readData("..", "static", "map", "UI.json"));
    for (const code of ["Y03", "Y04", "Y16"]) {
      expect(doc.buildings[code], code).toEqual({ d: "", outline: false, size: 0, name: null, mensa: false });
    }
    for (const area of ["UZ", "UI", "UO"]) {
      const map = JSON.parse(readData("..", "static", "map", `${area}.json`));
      const left = Object.keys(campuses[area].not_on_map ?? {});
      for (const [code, b] of Object.entries<{ d: string; x?: number; outline?: boolean }>(map.buildings)) {
        // Label only exactly when listed in not_on_map; every other building has an outline and an anchor.
        expect(b.outline === false, `${area} ${code}`).toBe(left.includes(code));
        if (b.outline !== false) expect(b.d.startsWith("M") && typeof b.x === "number", `${area} ${code}`).toBe(true);
      }
    }
  });
});

describe("bookings", () => {
  const packed = packBlocks(blocksOf(ROOM51, 51)!);

  it("reads UZH's times as Zurich wall-clock time, without the Z", () => {
    expect(packed.find((p) => p[0].startsWith("2026-11-10"))).toEqual(["2026-11-10T10:15:00", "2026-11-10T12:00:00", 2]);
    expect(packed.every((p) => !p[0].endsWith("Z") && !p[1].endsWith("Z"))).toBe(true);
  });

  it("never keeps a booking's free text", () => {
    expect(JSON.stringify(ROOM51)).not.toContain("Kommentar");
    expect(packed.every((p) => p.length === 3)).toBe(true);
  });

  it("tells closures from bookings, keeps a block crossing midnight once and every block of a recurring closure", () => {
    const y15 = IRCHEL_DAY.RessourceList.find((r: { Title: string }) => r.Title.startsWith("Y15-G-20 "));
    const day = packBlocks(y15.BlockList);
    expect(day.filter((p) => p[2] === 8)).toEqual([
      ["2026-11-03T01:00:00", "2026-11-03T07:00:00", 8],
      ["2026-11-03T19:00:00", "2026-11-04T01:00:00", 8],
    ]);
    expect(day.filter((p) => p[2] === 2)).toHaveLength(5);
    const blocks = parseAllocations(unpack(day));
    expect(roomStatus(blocks, zurich("2026-11-03T09:50"))).toMatchObject({ state: "free", free_until: zurich("2026-11-03T10:15") });
    expect(roomStatus(blocks, zurich("2026-11-03T23:00"))).toMatchObject({ state: "busy", current_kind: "closed" });
  });
});

describe("libraries", () => {
  const libs = uzhLibraries(LIBRARIES_SNAPSHOT);
  const byId = new Map(libs.map((l) => [l.id, l]));

  it("reads a sensor's widget", () => {
    expect(parseOccusense(SENSOR_HTML, 1000)).toMatchObject({ pct: 30, capacity: 220, people: 66, measured_at: 1000 }); // "ca. 70% frei von 220"
    expect(parseOccusense("<p>nothing</p>", 1000)).toBeNull();
    expect(isClosedWidget("text: { value: 'geschlossen', className: 'x' }")).toBe(true);
    expect(isClosedWidget(SENSOR_HTML)).toBe(false);
  });

  it("lists the locations on our campuses, one per sensor where a location has several", () => {
    expect(byId.get("UB4.2")).toMatchObject({ name: "UB Study Center Irchel West", area: "UI", building: "Y63", category: "library" });
    expect(byId.get("UB4.23")?.name).toBe("UB Study Center Irchel East/South");
    expect(byId.get("UB43")).toMatchObject({ name: "UB Law", area: "UZ", building: "RAI", room: "RAI-E-400", seats: 558 });
    expect(byId.get("UB20")).toMatchObject({ area: "UO", building: "BIN" });
    expect(byId.has("UB26")).toBe(false); // Botanical garden: not on our campuses
    expect(byId.has("UB82")).toBe(false); // no hours published at all
    expect(libs.every((l) => l.hours.length > 0)).toBe(true);
    expect(libs.every((l) => /^UB[0-9.]+$/.test(l.id))).toBe(true); // share links (SHARE_SPACE)
    for (const s of UZH_SENSORS) expect(byId.has(s.id), s.id).toBe(true);
  });

  it("writes the hours as parseHours reads them, with UZH-card hours where they're all there is", () => {
    expect(byId.get("UB43")!.hours[0]).toBe("Mon - Fri: 08.00 - 20.00");
    expect(byId.get("UB4.2")).toMatchObject({ hours: ["Mon - Sun: 07.00 - 23.00"], notice: "With a UZH or ETH card" }); // data/uzh.json library_notes
    expect(byId.get("UB105")).toMatchObject({ notice: "UZH members only (UZH card)" });
    expect(byId.get("UB70")!.hours).toContain("With a UZH card: Mon - Fri: 07.00 - 22.00, Sat: 07.00 - 13.30, Sun: Closed");
    expect(hoursLines({})).toEqual([]);
  });

  it("reads closures: a date alone is the whole day", () => {
    expect(parseClosure({ schliessungvon: "2026-05-01 00:00:00", schliessungbis: "2026-05-01 00:00:00", bezeichnung_en: "Labour Day" })).toEqual([
      zurich("2026-05-01T00:00"), zurich("2026-05-02T00:00"), "Labour Day",
    ]);
    expect(parseClosure({ schliessungvon: "2026-05-13 16:00:00", schliessungbis: "2026-05-14 00:00:00" })).toEqual([
      zurich("2026-05-13T16:00"), zurich("2026-05-15T00:00"), null,
    ]);
    const lib = { ...byId.get("UB43")!, closures: [parseClosure({ schliessungvon: "2026-12-24 00:00:00", schliessungbis: "2026-12-24 00:00:00" })!] };
    expect(closureAt(lib, zurich("2026-12-24T10:00"))).not.toBeNull();
    expect(closureAt(lib, zurich("2026-12-25T10:00"))).toBeNull();
  });
});

// A fake 3V-Rooms: the anonymous login's redirects and cookies, the calendar (401 without the session), and the
// library's server.
const BOOK = "https://uzh.book.3vrooms.app";
const IDP = "https://uzh.idp.3vrooms.app";
const PORTAL = `${BOOK}/default/Anonymous/Calendar/PortalFind`;

function fakeUzh({ busyAfter = Infinity } = {}) {
  const calls: string[] = [];
  let calendarCalls = 0;
  const redirect = (to: string, cookies: string[] = []) => {
    const headers = new Headers({ location: to });
    for (const c of cookies) headers.append("set-cookie", c);
    return new Response(null, { status: 302, headers });
  };
  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const cookie = new Headers(init.headers).get("cookie") ?? "";
    calls.push(`${init.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.href.startsWith(PORTAL)) {
      if (cookie.includes(".AspNet.Cookies=auth")) return new Response('<select id="filtersettingSelector"></select>');
      return redirect(`${IDP}/connect/authorize?client_id=rooms`, ["ASP.NET_SessionId=s1; path=/; secure; HttpOnly"]);
    }
    if (url.origin === IDP && url.pathname === "/connect/authorize") {
      if (!cookie.includes("RoomsPro.Cookie=idp")) return redirect("/Account/Login?ReturnUrl=x", [".AspNetCore.Culture=c%3Dde; path=/"]);
      return new Response(
        `<form name="form" method="post" action="${BOOK}/Default"><input type="hidden" name="code" value="c0de" />` +
          `<input type="hidden" name="state" value="a&amp;b" /><input type="hidden" name="iss" value="${IDP}/" /></form>`,
      );
    }
    if (url.origin === IDP && url.pathname === "/Account/Login") return redirect("/Account/AnonymousLogin?ReturnUrl=x");
    if (url.origin === IDP && url.pathname === "/Account/AnonymousLogin") {
      return redirect("/connect/authorize?client_id=rooms", [".AspNetCore.RoomsPro.Cookie=idp1; path=/; secure"]);
    }
    if (url.href === `${BOOK}/Default` && init.method === "POST") {
      const body = new URLSearchParams(String(init.body));
      if (body.get("code") !== "c0de" || body.get("state") !== "a&b" || !cookie.includes("ASP.NET_SessionId=s1")) return new Response("bad", { status: 400 });
      return redirect("/default/Anonymous/Calendar/PortalFind", [".AspNet.Cookies=auth1; path=/; secure; HttpOnly"]);
    }
    if (url.pathname === "/default/api/v1.0/calendar") {
      if (++calendarCalls > busyAfter) return new Response("busy", { status: 503, headers: { "retry-after": "300" } });
      if (!cookie.includes(".AspNet.Cookies=auth1")) return new Response('{"Message":"401"}', { status: 401 });
      const p = url.searchParams;
      if (p.get("filtersettingId")) {
        const area = { "24885": "UZ", "22059": "UI", "15325": "UO" }[p.get("filtersettingId")!]!;
        const own = UZH_SNAPSHOT.filter((r) => r.area === area);
        const standort = String(own[0].standort);
        return Response.json({ RessourceList: [], StandortList: [{ Id: standort, RessourceList: own.map((r) => ({ Id: r.id, Title: r.title, BlockList: [] })) }] });
      }
      // One room: HAH-E-10's month, as that room.
      const id = Number(p.get("id"));
      return Response.json({ RessourceList: [{ ...ROOM51.RessourceList[0], Id: id }], StandortList: [] });
    }
    if (url.href.includes("occusense")) return new Response(SENSOR_HTML);
    if (url.href.includes("bibapi")) return Response.json(LIBRARIES_SNAPSHOT);
    return new Response("not found", { status: 404 });
  };
  return { calls, fetch };
}

const UA = "frooms-test";
const TUE = Date.UTC(2026, 10, 10, 9, 0); // Tuesday 10 November, 10:00 in Zurich

describe("client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("logs in anonymously in 7 requests and keeps the session's cookies", async () => {
    const uzh = fakeUzh();
    vi.stubGlobal("fetch", uzh.fetch);
    const client = new UzhClient(UA);
    await client.login();
    expect(uzh.calls).toHaveLength(7);
    expect(uzh.calls.at(-2)).toBe(`POST ${BOOK}/Default`);
    expect(client.session).toContain(".AspNet.Cookies=auth1");
    expect(client.session).not.toContain("RoomsPro"); // the login server's cookies stay there
  });

  it("logs in again when the session has expired", async () => {
    const uzh = fakeUzh();
    vi.stubGlobal("fetch", uzh.fetch);
    const client = new UzhClient(UA, "ASP.NET_SessionId=old; .AspNet.Cookies=expired");
    const packed = await client.room({ id: 51, standort: 3 }, "2026-11-09", "2026-12-10");
    expect(packed.length).toBeGreaterThan(10);
    expect(uzh.calls.filter((c) => c.includes("/calendar"))).toHaveLength(2);
    expect(client.session).toContain("auth1");
  });
});

describe("prefetch", () => {
  let kv: FakeKV;
  let db: FakeD1;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: TUE });
    kv = new FakeKV();
    db = new FakeD1();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const run = (now = TUE) => runUzhPrefetch({ ROOMS: kv.asKV(), DB: db.asD1() }, UA, now, 0);

  it("logs in, refreshes a campus, fetches rooms within its budget and reads the sensors", async () => {
    const uzh = fakeUzh();
    vi.stubGlobal("fetch", uzh.fetch);
    const first = await run();
    expect(first).toMatchObject({ requests: 10, fetched: 2, failed: 0, sensors: UZH_SENSORS.length });
    expect(kv.json("uzh_catalogue").areas).toEqual({ UZ: TUE });
    expect(kv.json("uzh_libraries").raw.length).toBe(LIBRARIES_SNAPSHOT.length);
    const paths = db.rows("SELECT path, full_from FROM fetches");
    expect(paths).toHaveLength(2);
    expect(paths.every((p) => /^[A-Z0-9]{3}-/.test(p.path) && p.full_from === "2026-11-10")).toBe(true);
    expect(db.rows("SELECT COUNT(*) AS n FROM allocations")[0].n).toBe(2 * 33);
    expect(db.rows("SELECT COUNT(*) AS n FROM occupancy")[0].n).toBe(UZH_SENSORS.length);
    const state = JSON.parse(db.rows("SELECT value FROM meta WHERE key = 'uzh'")[0].value);
    expect(state.session).toContain("auth1");

    // The next run keeps the session: one campus and 9 rooms, no login; the sensors wait their interval.
    uzh.calls.length = 0;
    const second = await run(TUE + 120_000);
    expect(second).toMatchObject({ requests: 10, fetched: 9, sensors: 0 });
    expect(uzh.calls.some((c) => c.includes("/Account/"))).toBe(false);
    expect(kv.json("uzh_catalogue").areas).toMatchObject({ UZ: TUE, UI: TUE + 120_000 });
  });

  it("backs off when UZH says it's busy, and skips runs until then", async () => {
    vi.stubGlobal("fetch", fakeUzh({ busyAfter: 1 }).fetch);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await run();
    expect(first.fetched).toBe(0);
    const state = JSON.parse(db.rows("SELECT value FROM meta WHERE key = 'uzh'")[0].value);
    expect(state.backoffUntil).toBeGreaterThanOrEqual(TUE + 299_000);
    expect(await run(TUE + 120_000)).toMatchObject({ skipped: "backoff" });
  });
});

describe("routes", () => {
  let kv: FakeKV;
  let db: FakeD1;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const calls: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: TUE });
    clearStoreMemory();
    kv = new FakeKV();
    db = new FakeD1();
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string) => (calls.push(url), new Response("unexpected", { status: 500 })));
    const put = (sql: string, ...args: (string | number)[]) => db.db.prepare(sql).run(...args);
    put("INSERT OR REPLACE INTO meta (key, value) VALUES ('minmax', ?)", JSON.stringify({ at: TUE, min: "2026-02-21", max: "2027-02-21" }));
    for (const d of splitPacked(packBlocks(blocksOf(ROOM51, 51)!), "2026-11-10", "2026-12-12")) {
      put("INSERT INTO allocations (path, day, at, raw) VALUES (?, ?, ?, ?)", "HAH-E-10", d.day, TUE, JSON.stringify(d.raw));
    }
    put("INSERT INTO fetches (path, full_from, at) VALUES (?, ?, ?)", "HAH-E-10", "2026-11-10", TUE);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const env = (): Env => ({ ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher, ROOMS: kv.asKV(), DB: db.asD1() });
  const get = async (path: string) => {
    const res = await worker.fetch(new Request(`https://frooms.test${path}`), env(), ctx);
    return { status: res.status, body: (await res.json()) as any };
  };

  it("lists UZH's buildings per campus", async () => {
    const { body } = await get("/api/buildings?area=UZ");
    expect(body.map((b: { building: string }) => b.building)).toEqual(expect.arrayContaining(["KOL", "HAH", "RAI"]));
    expect(body.map((b: { building: string }) => b.building)).not.toContain("Y15");
  });

  it("serves UZH rooms from D1 only: stored ones with their status, others pending, later days without data", async () => {
    const { body } = await get("/api/free?area=UZ&buildings=HAH&at=2026-11-10T10:30");
    const hah10 = body.rooms.find((r: { room: string }) => r.room === "HAH-E-10");
    expect(hah10).toMatchObject({ status: "busy", busy_until: "2026-11-10T12:00+01:00", eth_url: expect.stringContaining("uniability") });
    expect(body.rooms.filter((r: { status: string }) => r.status === "pending").length).toBeGreaterThan(0);
    const later = await get("/api/free?area=UZ&buildings=HAH&at=2027-01-20T10:30");
    expect(later.body.rooms.every((r: { status: string }) => r.status === "no_data")).toBe(true);
    expect(calls).toEqual([]);
  });

  it("serves UZH's libraries with the sensors' readings", async () => {
    const reading = { people: 55, capacity: 220, pct: 25, status: null, trend: null, measured_at: TUE - 60_000, active: true };
    db.db.prepare("INSERT INTO meta (key, value) VALUES ('uzh_spaces_live', ?)").run(JSON.stringify({ at: TUE - 60_000, readings: { "UB4.2": reading } }));
    const { body } = await get("/api/spaces?area=UI");
    const west = body.spaces.find((s: { id: string }) => s.id === "UB4.2");
    expect(west).toMatchObject({ category: "library", open: true, occupancy: { pct: 25, status: "green" } });
    expect(west.eth).toBeUndefined();
    // Libraries, then Irchel's mensas (no menus stored here, so closed; study spaces when open between meals), no ETH places on Irchel,
    expect(body.spaces.every((s: { category: string }) => s.category === "library" || s.category === "mensa")).toBe(true);
    // and its cafés without menus (The Yard, Irchel Bar), open by their hours.
    expect(body.spaces.filter((s: { category: string }) => s.category === "mensa").map((s: { id: string }) => s.id).sort()).toEqual(["UC1", "UC2", "UM11", "UM12", "UM6", "UM7", "UM8"]);
    const yard = body.spaces.find((s: { id: string }) => s.id === "UC1");
    expect(yard).toMatchObject({ name: "The Yard", building: "Y13", kind: "cafe", menu: false, study: false, info_url: "https://www.zfv.ch/de/essen-gehen/yard" });
    expect(yard.hours).toEqual(["Today: 09:00 - 14:00"]);
    expect(body.spaces.find((s: { id: string }) => s.id === "UM6")).toMatchObject({ kind: "mensa", study: true, open: false });
    expect(calls).toEqual([]);
  });

  it("shows a library open with a UZH card outside its regular hours, inside its card hours", async () => {
    // UB Sciences (Y15): 09:00 to 17:00, with a UZH card 07:00 to 23:00 every day.
    const sciences = async (at: string) => (await get(`/api/spaces?area=UI&at=${at}`)).body.spaces.find((s: { id: string }) => s.id === "UB1");
    expect(await sciences("2026-11-10T12:00")).toMatchObject({ open: true, card_only: false, card_uzh: false });
    expect(await sciences("2026-11-10T18:30")).toMatchObject({ open: true, card_only: true, card_uzh: true, until: "2026-11-10T23:00+01:00" });
    expect(await sciences("2026-11-10T23:30")).toMatchObject({ open: false, card_uzh: false });
  });

  it("serves one UZH room with its day's bookings, never with titles", async () => {
    const { status, body } = await get("/api/room?room=HAH-E-10&area=UZ&at=2026-11-10T10:30");
    expect(status).toBe(200);
    expect(body.room).toMatchObject({ room: "HAH-E-10", status: "busy" });
    expect(body.bookings.length).toBeGreaterThan(0);
    expect(body.bookings.every((b: { title: string | null; from: string }) => b.title === null && b.from.startsWith("2026-11-10"))).toBe(true);
    expect(calls).toEqual([]);
  });

  it("counts the rooms of buildings drawn as part of another there on the map (KOH in KOL), and KO2 on its own", async () => {
    const put = (sql: string, ...args: (string | number)[]) => db.db.prepare(sql).run(...args);
    for (const path of ["KOH-B-10", "KO2-F-180"]) {
      for (const d of splitPacked(packBlocks(blocksOf(ROOM51, 51)!), "2026-11-10", "2026-12-12")) {
        put("INSERT INTO allocations (path, day, at, raw) VALUES (?, ?, ?, ?)", path, d.day, TUE, JSON.stringify(d.raw));
      }
    }
    const { body } = await get("/api/map?area=UZ&at=2026-11-10T08:00");
    const codes = body.buildings.map((b: { building: string }) => b.building);
    expect(codes).toContain("KOL");
    expect(codes).toContain("KO2");
    expect(codes).not.toContain("KOH");
    const kol = body.buildings.find((b: { building: string }) => b.building === "KOL");
    expect(kol.rooms.total).toBe(rooms.filter((r) => ["KOL", "KOH"].includes(r.building) && ["3420", "3430"].includes(r.typecode)).length);
    expect(kol.rooms.free).toBe(1); // KOH-B-10, free until 10:15
    const ko2 = body.buildings.find((b: { building: string }) => b.building === "KO2");
    expect(ko2.rooms.total).toBe(rooms.filter((r) => r.building === "KO2" && ["3420", "3430"].includes(r.typecode)).length);
    expect(ko2.rooms.free).toBe(1); // KO2-F-180
  });

  it("reports the UZH prefetch on /api/status", async () => {
    const { body } = await get("/api/status");
    expect(body.uzh).toMatchObject({ rooms: rooms.length, current_for_today: 1 });
  });

  describe("mensas on the two Zentrum campuses", () => {
    // Obere Mensa (UM1) has today's lunch stored, as the UZH menu prefetch stores it.
    const day = {
      hours: [["11:00", "15:00"]],
      meals: [{ meal: "lunch", name: "Lunch", from: "11:00", to: "14:30", dishes: [
        { line: "Menu 1", name: "Pasta", desc: "", type: "vegetarian", tags: ["pasta"], price: { student: 6.1, internal: 9, external: 13 }, allergens: [], image: null },
      ] }],
    };
    beforeEach(() => {
      db.db.prepare("INSERT INTO menu_days (facility, date, at, data) VALUES (?, ?, ?, ?)").run(100001, "2026-11-10", TUE, JSON.stringify(day));
    });
    type Entry = { id: string; area?: string; partner?: boolean; category: string; open: boolean; menu: boolean; info_url: string };
    const byId = (body: { spaces: Entry[] }) => new Map(body.spaces.map((s) => [s.id, s]));

    it("lists UZH Zentrum's mensas with ETH Zentrum's, each with its own area", async () => {
      const uz = byId((await get("/api/spaces?area=UZ&at=2026-11-10T12:00")).body);
      expect(uz.get("UM1")).toMatchObject({ category: "mensa", open: true, menu: true, info_url: expect.stringContaining("food2050.ch") });
      expect(uz.get("UM1")!.partner).toBeUndefined();
      expect(uz.get("UM6")).toBeUndefined(); // Irchel's stay on Irchel
      expect(uz.get("MMB79")).toMatchObject({ category: "mensa", area: "Z", partner: true });
      // Only ETH's mensas come along, not its study spaces.
      expect([...uz.values()].filter((s) => s.partner).every((s) => s.category === "mensa")).toBe(true);

      const z = byId((await get("/api/spaces?area=Z&at=2026-11-10T12:00")).body);
      expect(z.get("UM1")).toMatchObject({ area: "UZ", partner: true, open: true });
      expect(z.get("MMB79")!.partner).toBeUndefined();
      expect([...z.values()].some((s) => s.category !== "mensa")).toBe(true);

      const ui = byId((await get("/api/spaces?area=UI")).body);
      expect([...ui.values()].some((s) => s.partner)).toBe(false);
      expect(calls).toEqual([]);
    });

    it("compares both universities' Zentrum mensas, and serves a UZH mensa's menu", async () => {
      const { body } = await get("/api/menus?area=UZ&date=2026-11-10");
      const ids = body.places.map((p: { id: string }) => p.id);
      expect(ids).toEqual(expect.arrayContaining(["UM1", "UM2", "MMB79"]));
      expect(ids).not.toContain("UM6");
      expect(body.places.find((p: { id: string }) => p.id === "UM1").day.meals[0].dishes[0].name).toBe("Pasta");
      const menu = await get("/api/menu?place=UM1&from=2026-11-10&days=1");
      expect(menu.status).toBe(200);
      expect(menu.body.place).toMatchObject({ id: "UM1", area: "UZ", building: "MEN", menu: true });
      expect(menu.body.days).toHaveLength(1);
    });

    it("maps the other campus's mensas on their own buildings, and finds UZH's mensas in search", async () => {
      const { body } = await get("/api/map?area=UZ&at=2026-11-10T12:00");
      const mm = body.buildings.find((b: { building: string }) => b.building === "MM");
      expect(mm).toMatchObject({ partner: true, study: { total: 0 } });
      const men = body.buildings.find((b: { building: string }) => b.building === "MEN");
      expect(men).toMatchObject({ partner: false, mensa: true });
      expect(men.mensas.map((m: { id: string }) => m.id).sort()).toEqual(["UM1", "UM2"]);
      const index = await get("/api/index");
      expect(index.body.spaces).toEqual(expect.arrayContaining([["UM1", "UZ", "Obere Mensa", "MEN", "mensa"]]));
    });
  });
});
