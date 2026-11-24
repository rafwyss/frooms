// Meal ratings (worker/ratings.ts, plans/PLAN_STREET_CRED.md section 10): the dish key and the maths against lib.js,
// GET and PUT /api/meal-ratings through the Worker, validation, the date rule, once-only points and deletion.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, b64url, sha256Hex } from "../worker/auth";
import { clearMemoryCache } from "../worker/eth";
import worker, { type Env } from "../worker/index";
import { dishKey, ratingAverage, ratingValue, rateableDates, roundRating } from "../worker/ratings";
import { clearStoreMemory } from "../worker/store";
import { FakeD1, FakeKV, fakeEth } from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lib = new Function(`${readFileSync(join(import.meta.dirname, "..", "static", "lib.js"), "utf8")}; return { dishKey, ratingAverage, roundRating, snapRating, ratingFigure, ratingAtY, ratingDay, ratingColour, colourContrast, RATING_COLOURS };`)() as Record<string, any>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 18, 11, 0); // Wednesday 18 November, 12:00 in Zurich
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const FACILITY = 100001; // UZH's Obere Mensa, place UM1 (data/uzh.json)

const dish = (line: string, name: string) => ({ line, name, desc: "", type: "vegetarian", tags: [], price: { student: 6.1, internal: 9, external: 13 }, allergens: [], image: null });
const menu = (names: string[]) => ({
  hours: [["11:00", "15:00"]],
  meals: [{ meal: "lunch", name: "Lunch", from: "11:00", to: "14:30", dishes: names.map((n, i) => dish(`Menu ${i + 1}`, n)) }],
});

let accounts: FakeD1;
let fruum: FakeD1;
let env: Env;

interface Person {
  id: string;
  token: string;
}

async function person(username: string): Promise<Person> {
  const id = `sub-${username}`;
  accounts.db
    .prepare("INSERT INTO users (id, username, first_name, last_name, name_key, bg, fg, uni, created_at, last_seen_at) VALUES (?, ?, 'A', 'B', 'a b', '#1f3a5f', '#ffffff', 'eth', ?, ?)")
    .run(id, username, NOW, NOW);
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  accounts.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run(await sha256Hex(token), id, NOW, NOW, NOW + 400 * DAY);
  return { id, token };
}

async function call(who: Person | null, method: string, path: string, body?: unknown, host = "frooms.ch") {
  const headers: Record<string, string> = { Origin: `https://${host}` };
  if (who) headers.Cookie = `${SESSION_COOKIE}=${who.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request(`https://${host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

const rate = (who: Person | null, values: Record<string, unknown>, d: Record<string, unknown> = {}) =>
  call(who, "PUT", "/api/meal-ratings", { place: "UM1", date: "2026-11-18", meal: "lunch", line: "Menu 1", name: "Älplermagronen", ...d, ...values });
const read = (who: Person | null, date = "2026-11-18") => call(who, "GET", `/api/meal-ratings?place=UM1&date=${date}`);
const KEY = dishKey(FACILITY, "2026-11-18", "lunch", "Menu 1", "Älplermagronen");
const total = (p: Person) => accounts.rows("SELECT cred_total AS t FROM users WHERE id = ?", p.id)[0].t as number;

let raffi: Person;
let anna: Person;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  clearMemoryCache();
  clearStoreMemory();
  vi.stubGlobal("fetch", fakeEth().fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  accounts = new FakeD1("migrations-accounts");
  fruum = new FakeD1();
  env = {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    ROOMS: new FakeKV().asKV(),
    DB: fruum.asD1(),
    ACCOUNTS: accounts.asD1(),
    EDUID_ISSUER: "https://login.eduid.ch/",
    EDUID_CLIENT_ID: "frooms_ch_frooms",
    EDUID_CLIENT_SECRET: "secret",
    SESSION_KEY: "k".repeat(43),
  } as Env;
  const insert = fruum.db.prepare("INSERT INTO menu_days (facility, date, at, data) VALUES (?, ?, ?, ?)");
  const names = ["Älplermagronen", "Rösti", "Curry", "Pizza", "Salad", "Soup", "Burger"];
  for (const date of ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]) insert.run(FACILITY, date, NOW, JSON.stringify(menu(names)));
  raffi = await person("raffi");
  anna = await person("anna");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the dish key and the maths", () => {
  it("joins the parts with |, the name trimmed and lower-cased, as lib.js does", () => {
    expect(dishKey(9, "2026-11-18", "lunch", "Street", "  Älplermagronen ")).toBe("9|2026-11-18|lunch|Street|älplermagronen");
    const cases: [number | string, string, string, string, string][] = [[9, "2026-11-18", "lunch", "Street", "Rösti"], ["100001", "2026-11-17", "dinner", "", " PIZZA  "]];
    for (const args of cases) expect(lib.dishKey(...args)).toBe(dishKey(...args));
  });

  it("Ø is the mean of the category means present, rounded to 0.1, the same in lib.js", () => {
    const cases: (number | null)[][] = [[3.5, 2, null], [null, null, null], [-1.25, null, null], [5, -5, 0.5], [0.05, -0.1, null], [1 / 3, 1 / 3, 1 / 3]];
    for (const c of cases) expect(lib.ratingAverage(c)).toBe(ratingAverage(c));
    expect(ratingAverage([3.5, 2, null])).toBe(2.8);
    expect(ratingAverage([null, null, null])).toBeNull();
    expect(Object.is(roundRating(-0.04), 0)).toBe(true);
    expect(Object.is(lib.roundRating(-0.04), 0)).toBe(true);
  });

  it("takes -5 to 5 in steps of 0.5, null when unset", () => {
    expect([ratingValue(undefined), ratingValue(null), ratingValue(-5), ratingValue(4.5), ratingValue(0)]).toEqual([null, null, -5, 4.5, 0]);
    for (const bad of [5.5, -5.5, 0.3, "1", NaN, Infinity, true]) expect(() => ratingValue(bad)).toThrow();
    // The page snaps what it sends the same way.
    expect([lib.snapRating(0.3), lib.snapRating(7), lib.snapRating(-9), lib.snapRating("2,25"), lib.snapRating(""), lib.snapRating("x")]).toEqual([0.5, 5, -5, 2.5, null, null]);
  });

  it("today and yesterday in Zurich take ratings, across midnight", () => {
    expect(rateableDates(NOW)).toEqual(["2026-11-18", "2026-11-17"]);
    expect(rateableDates(Date.UTC(2026, 10, 18, 23, 5))).toEqual(["2026-11-19", "2026-11-18"]);
  });
});

describe("on the page (lib.js)", () => {
  it("writes the figure with one decimal, + for positive, a real minus, a dash for none", () => {
    expect([2.5, -1, 0, -0.04, 2.25, null].map(lib.ratingFigure)).toEqual(["+2.5", "\u22121.0", "0.0", "0.0", "+2.3", "\u2013"]);
  });

  it("reads a bar's track from the top (+5) through the middle (0) to the bottom (-5), snapped", () => {
    expect([0, 75, 150, 40, 76].map((y) => lib.ratingAtY(y, 150))).toEqual([5, 0, -5, 2.5, 0]);
  });

  it("rates today's and yesterday's dishes, shows past ones, hides those to come", () => {
    expect(["2026-11-18", "2026-11-17", "2026-11-10", "2026-11-19"].map((d) => lib.ratingDay(d, "2026-11-18", "2026-11-17"))).toEqual(["rate", "rate", "past", "future"]);
  });

  it("colours from red through the neutral to green, readable on the card in both themes (4.5:1)", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "static", "style.css"), "utf8");
    const token = (block: string, name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`).exec(block)?.[1];
    const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    for (const theme of ["light", "dark"] as const) {
      const stops = lib.RATING_COLOURS[theme];
      // style.css has the same colours (the page reads the CSS; lib.js's are the fallback).
      const block = theme === "light" ? css : dark;
      expect([token(block, "--rate-neg"), token(block, "--rate-zero"), token(block, "--rate-pos")]).toEqual([stops.neg, stops.zero, stops.pos]);
      const card = theme === "light" ? "#ffffff" : "#1b1e22";
      expect(lib.ratingColour(-5, stops)).toBe(stops.neg);
      expect(lib.ratingColour(0, stops)).toBe(stops.zero);
      expect(lib.ratingColour(5, stops)).toBe(stops.pos);
      for (let v = -5; v <= 5; v += 0.5) expect(lib.colourContrast(lib.ratingColour(v, stops), card)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("GET and PUT /api/meal-ratings", () => {
  it("averages each category over those who set it, Ø over the categories, and counts", async () => {
    expect((await rate(raffi, { taste: 4, portion: 2 })).status).toBe(200);
    expect((await rate(anna, { taste: 3 })).status).toBe(200);
    const out = await read(null);
    expect(out.res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(out.res.headers.get("Vary")).toBe("Cookie");
    expect(out.body.dishes).toEqual({ [KEY]: { avg: 2.8, taste: 3.5, portion: 2, value: null, n: 2, nTaste: 2, nPortion: 1, nValue: 0 } });
    // Signed in: your own values too, and the answer is never cached.
    const mine = await read(raffi);
    expect(mine.res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mine.body.dishes[KEY].mine).toEqual({ taste: 4, portion: 2, value: null });
    // Nobody else is named.
    expect(JSON.stringify(out.body) + JSON.stringify(mine.body)).not.toMatch(/sub-|anna/);
    // Another day, another dish: nothing.
    expect((await read(null, "2026-11-17")).body.dishes).toEqual({});
  });

  it("answers the dish's new summary and cred; the first rating earns 3, rating again replaces it and earns nothing", async () => {
    const first = await rate(raffi, { taste: 4, portion: -1.5, value: 0 });
    expect(first.body).toEqual({
      key: KEY,
      dish: { avg: 0.8, taste: 4, portion: -1.5, value: 0, n: 1, nTaste: 1, nPortion: 1, nValue: 1, mine: { taste: 4, portion: -1.5, value: 0 } },
      cred: { points: 3, total: 3, level: 1 },
    });
    expect(accounts.rows("SELECT action, points, ref, detail FROM cred")).toEqual([{ action: "meal_rating", points: 3, ref: KEY, detail: "Älplermagronen" }]);
    // The name as the page sends it may differ in case and spaces; it is the same dish.
    const again = await rate(raffi, { taste: -2 }, { name: " älplermagronen" });
    expect(again.body.dish).toMatchObject({ avg: -2, taste: -2, portion: null, value: null, n: 1, mine: { taste: -2, portion: null, value: null } });
    expect(again.body.cred.points).toBe(0);
    expect(total(raffi)).toBe(3);
    expect(accounts.rows("SELECT COUNT(*) AS n FROM meal_ratings")[0].n).toBe(1);
  });

  it("removing your rating deletes it and takes back its 3; rating again earns them again", async () => {
    await rate(raffi, { taste: 4 });
    await rate(anna, { taste: 2 });
    const dish = { place: "UM1", date: "2026-11-18", meal: "lunch", line: "Menu 1", name: "Älplermagronen" };
    const gone = await call(raffi, "DELETE", "/api/meal-ratings", dish);
    expect(gone.status).toBe(200);
    expect(gone.body).toMatchObject({ key: KEY, dish: { taste: 2, n: 1, mine: null }, cred: { points: 0, total: 0 } });
    expect(total(raffi)).toBe(0);
    expect(accounts.rows("SELECT COUNT(*) AS n FROM meal_ratings")[0].n).toBe(1);
    expect((await call(raffi, "DELETE", "/api/meal-ratings", dish)).status).toBe(200); // none left: fine
    expect((await rate(raffi, { taste: 1 })).body.cred.points).toBe(3);
    expect((await call(null, "DELETE", "/api/meal-ratings", dish)).status).toBe(401);
    expect((await call(raffi, "DELETE", "/api/meal-ratings", { ...dish, name: "Nope" })).status).toBe(404);
  });

  it("counts a new rating once (usage counters); rating again doesn't, past the cred cap still does", async () => {
    await rate(raffi, { taste: 4 });
    await rate(raffi, { taste: -1 });
    await rate(anna, { value: 2 });
    for (const [i, name] of ["Rösti", "Curry", "Pizza", "Salad", "Soup"].entries()) await rate(raffi, { taste: 1 }, { name, line: `Menu ${i + 2}` });
    expect(accounts.stats()).toEqual({ "2026-11-18": { meal_rating: 7 } });
    accounts.db.exec("DROP TABLE stats_days");
    expect((await rate(anna, { taste: 1 }, { name: "Rösti", line: "Menu 2" })).status).toBe(200);
    expect(accounts.rows("SELECT COUNT(*) AS n FROM meal_ratings")[0].n).toBe(8); // 7 counted, and this one
  });

  it("at most 5 dishes a day earn", async () => {
    const got: number[] = [];
    for (const [i, name] of ["Älplermagronen", "Rösti", "Curry", "Pizza", "Salad", "Soup"].entries()) {
      got.push((await rate(raffi, { taste: 1 }, { name, line: `Menu ${i + 1}` })).body.cred.points);
    }
    expect(got).toEqual([3, 3, 3, 3, 3, 0]);
    expect(accounts.rows("SELECT COUNT(*) AS n FROM meal_ratings")[0].n).toBe(6); // every rating is kept
    // The cap resets at Zurich midnight; yesterday's dishes still take ratings.
    vi.setSystemTime(Date.UTC(2026, 10, 18, 23, 5));
    expect((await rate(raffi, { taste: 1 }, { name: "Burger", line: "Menu 7" })).body.cred.points).toBe(3);
  });

  it("takes today's and yesterday's dishes only", async () => {
    expect((await rate(raffi, { taste: 1 }, { date: "2026-11-17" })).status).toBe(200);
    expect(await rate(raffi, { taste: 1 }, { date: "2026-11-19" })).toMatchObject({ status: 400, body: { detail: "not_rateable" } });
    expect(await rate(raffi, { taste: 1 }, { date: "2026-11-16" })).toMatchObject({ status: 400, body: { detail: "not_rateable" } });
  });

  it("refuses bad values, no value, unknown dishes and places, and signed out", async () => {
    for (const v of [{ taste: 5.5 }, { taste: 0.3 }, { portion: "2" }, {}, { taste: null, portion: null, value: null }]) {
      expect(await rate(raffi, v)).toMatchObject({ status: 400, body: { detail: "bad_rating" } });
    }
    expect(await rate(raffi, { taste: 1 }, { meal: "dinner" })).toMatchObject({ status: 404, body: { detail: "no_such_dish" } });
    expect(await rate(raffi, { taste: 1 }, { line: "Menu 2" })).toMatchObject({ status: 404, body: { detail: "no_such_dish" } });
    expect(await rate(raffi, { taste: 1 }, { name: "Tofu" })).toMatchObject({ status: 404, body: { detail: "no_such_dish" } });
    expect(await rate(raffi, { taste: 1 }, { place: "UM99" })).toMatchObject({ status: 404, body: { detail: "no_such_dish" } });
    expect(await rate(raffi, { taste: 1 }, { meal: "breakfast" })).toMatchObject({ status: 400, body: { detail: "bad_dish" } });
    expect(await rate(raffi, { taste: 1 }, { date: "18.11.2026" })).toMatchObject({ status: 400, body: { detail: "bad_dish" } });
    expect((await rate(null, { taste: 1 })).status).toBe(401);
    expect((await call(raffi, "POST", "/api/meal-ratings", { taste: 1 })).status).toBe(405);
    expect(accounts.rows("SELECT * FROM meal_ratings")).toEqual([]);
    expect(total(raffi)).toBe(0);
  });

  it("is off on hosts without sign-in", async () => {
    expect((await call(null, "GET", "/api/meal-ratings?place=UM1&date=2026-11-18", undefined, "frooms.test")).body).toEqual({ detail: "sign_in_off" });
    expect((await rate(raffi, { taste: 1 }, {})).status).toBe(200);
    const other = await call(raffi, "PUT", "/api/meal-ratings", { place: "UM1", date: "2026-11-18", meal: "lunch", line: "Menu 1", name: "Rösti", taste: 1 }, "frooms.test");
    expect(other.status).toBe(404);
  });

  it("asks for a place and a date", async () => {
    expect((await call(null, "GET", "/api/meal-ratings?place=UM1")).status).toBe(400);
    expect((await call(null, "GET", "/api/meal-ratings?date=2026-11-18")).status).toBe(400);
    expect((await call(null, "GET", "/api/meal-ratings?place=UM1&date=tomorrow")).status).toBe(400);
  });

  it("deleting the account takes its ratings along; the averages follow", async () => {
    await rate(raffi, { taste: 4 });
    await rate(anna, { taste: 2 });
    const res = await call(raffi, "DELETE", "/api/me");
    expect(res.status).toBe(204);
    expect(accounts.rows("SELECT user_id FROM meal_ratings")).toEqual([{ user_id: anna.id }]);
    expect((await read(null)).body.dishes[KEY]).toMatchObject({ avg: 2, taste: 2, n: 1 });
  });
});
