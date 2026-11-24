// Profile, friends, check-ins and stars (worker/social.ts, plans/PLAN_ACCOUNTS.md section 7.2). People are signed in
// with real session rows in an in-memory accounts database; the catalogue lookup is faked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, b64url, sha256Hex } from "../worker/auth";
import {
  CHECKIN_DEFAULT_MS,
  LINK_KEPT_MS,
  UNUSED_ACCOUNT_MS,
  cleanAccounts,
  cleanStars,
  contrast,
  handleSocial,
  initials,
  type LookupPlace,
  shortName,
  type SocialEnv,
} from "../worker/social";
import { FakeD1 } from "./helpers";

const lib = new Function(`${readFileSync(join(import.meta.dirname, "..", "static", "lib.js"), "utf8")}; return { cleanStars };`)() as {
  cleanStars: (raw: unknown) => unknown[];
};

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 18, 10, 0);
let db: FakeD1;
let env: SocialEnv;
let clock = NOW;

const lookup: LookupPlace = async (kind, place, area) => {
  if (kind === "room" && place === "HG E 33.1" && area === "zentrum") return { name: "HG E 33.1", building: "HG" };
  if (kind === "room" && place === "CAB G 11" && area === "zentrum") return { name: "CAB G 11", building: "CAB" };
  if (kind === "space" && place === "MMB79" && area === "zentrum") return { name: "Polymensa", building: "MM" };
  return null;
};

interface Person {
  id: string;
  token: string;
  username: string | null;
}

async function person(username: string | null, first: string, last: string, opts: { email?: string; seen?: number } = {}): Promise<Person> {
  const id = `sub-${username ?? first}`;
  const key = `${first} ${last}`.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  db.db
    .prepare("INSERT INTO users (id, username, first_name, last_name, name_key, bg, fg, email_hash, uni, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, '#1f3a5f', '#ffffff', ?, 'eth', ?, ?)")
    .run(id, username, first, last, key, opts.email ? await sha256Hex(opts.email.toLowerCase()) : null, NOW, opts.seen ?? NOW);
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  db.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run(await sha256Hex(token), id, NOW, NOW, NOW + 30 * 24 * HOUR);
  return { id, token, username };
}

/** A request from `who` (signed in), with the page's own Origin unless told otherwise. */
async function call(who: Person | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { Origin: "https://frooms.ch", ...headers };
  if (who) h.Cookie = `${SESSION_COOKIE}=${who.token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const req = new Request(`https://frooms.ch${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handleSocial(req, new URL(req.url), env, lookup, clock);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

let raffi: Person;
let anna: Person;
let ben: Person;

beforeEach(async () => {
  clock = NOW;
  db = new FakeD1("migrations-accounts");
  env = {
    ACCOUNTS: db.asD1(),
    EDUID_ISSUER: "https://login.eduid.ch/",
    EDUID_CLIENT_ID: "frooms_ch_frooms",
    EDUID_CLIENT_SECRET: "secret",
    SESSION_KEY: "k".repeat(43),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  raffi = await person("raffi", "Raffaele", "Wyss", { email: "raffi@student.example.ch" });
  anna = await person("anna_b", "Anna Lena", "von Arx", { email: "anna@uzh.ch" });
  ben = await person("ben", "Ben", "Müller");
});

const befriend = async (a: Person, b: Person) => {
  expect((await call(a, "POST", "/api/friends/requests", { user: b.username })).body).toEqual({ status: "requested" });
  expect((await call(b, "POST", "/api/friends/requests/accept", { user: a.username })).body).toMatchObject({ status: "friends" });
};
const checkIn = (who: Person, body: Record<string, unknown> = {}) =>
  call(who, "POST", "/api/checkin", { kind: "room", place: "HG E 33.1", area: "zentrum", source: "nearby", ...body });
const rowsWith = (id: string) => {
  const tables: [string, string[]][] = [
    ["users", ["id"]],
    ["sessions", ["user_id"]],
    ["friends", ["user_id", "friend_id"]],
    ["friend_requests", ["from_id", "to_id"]],
    ["blocks", ["user_id", "blocked_id"]],
    ["stars", ["user_id"]],
    ["checkins", ["user_id"]],
    ["cred", ["user_id", "ref"]],
    ["report_owners", ["user_id"]],
    ["report_votes", ["user_id"]],
    ["meal_ratings", ["user_id"]],
  ];
  const named = db.rows("SELECT * FROM cred WHERE ref LIKE ?", `%:${id}`); // a 👍's "<report id>:<voter id>"
  return [...named, ...tables.flatMap(([t, cols]) => cols.flatMap((c) => db.rows(`SELECT * FROM ${t} WHERE ${c} = ?`, id)))];
};

describe("names", () => {
  it("shows people as first name and last initial, skipping particles", () => {
    expect(shortName("Raffaele", "Wyss")).toBe("Raffaele W.");
    expect(shortName("Anna Lena", "von Arx")).toBe("Anna Lena A.");
    expect(shortName("Maria", "de la Cruz")).toBe("Maria C.");
    expect(shortName("Jan", "Müller-Lüdenscheidt")).toBe("Jan M.");
    expect(shortName("Émile", "Él")).toBe("Émile É.");
    expect(initials("Anna Lena", "von Arx")).toBe("AA");
    expect(initials("raffaele", "wyss")).toBe("RW");
  });
});

describe("/api/me and the profile", () => {
  it("answers the profile, the running check-in, the number of requests and the stars", async () => {
    await call(anna, "POST", "/api/friends/requests", { user: "raffi" });
    await checkIn(raffi);
    const { status, body, res } = await call(raffi, "GET", "/api/me");
    expect(status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({ username: "raffi", name: "Raffaele W.", initials: "RW", profile_needed: false, requests: 1, stars: [] });
    expect(body.cred).toEqual({ total: 5, level: 1, trusted: false }); // the check-in earned 5
    expect(body.checkin).toEqual({ kind: "room", place: "HG E 33.1", area: "zentrum", building: "HG", name: "HG E 33.1", since: NOW, until: NOW + CHECKIN_DEFAULT_MS });
  });

  it("signed out: 401; another host: sign_in_off", async () => {
    expect((await call(null, "GET", "/api/me")).status).toBe(401);
    const req = new Request("https://abc-fruum.fruum.workers.dev/api/friends");
    const res = await handleSocial(req, new URL(req.url), env, lookup);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "sign_in_off" });
  });

  it("the profile step: username lower case, colours with enough contrast, a taken username gets 409", async () => {
    const neu = await person(null, "Neu", "Ling");
    expect((await call(neu, "GET", "/api/friends")).body).toEqual({ detail: "profile_needed" });
    expect((await call(neu, "GET", "/api/username?u=RAFFI")).body).toEqual({ valid: true, available: false });
    expect((await call(neu, "GET", "/api/username?u=ne")).body).toEqual({ valid: false, available: false });
    expect((await call(neu, "POST", "/api/me/profile", { username: "Raffi", bg: "#000000", fg: "#ffffff" })).status).toBe(409);
    expect((await call(neu, "POST", "/api/me/profile", { username: "neu ling", bg: "#000000", fg: "#ffffff" })).body).toEqual({ detail: "bad_username" });
    expect((await call(neu, "POST", "/api/me/profile", { username: "neu", bg: "#777777", fg: "#888888" })).body).toEqual({ detail: "low_contrast" });
    expect((await call(neu, "POST", "/api/me/profile", { username: "neu", bg: "red", fg: "#ffffff" })).body).toEqual({ detail: "bad_colour" });
    const ok = await call(neu, "POST", "/api/me/profile", { username: "Neu.Ling", bg: "#1F3A5F", fg: "#FFFFFF" });
    expect(ok.body).toEqual({ username: "neu.ling", bg: "#1f3a5f", fg: "#ffffff", bg2: null, fg2: null, metal: null });
    expect((await call(neu, "GET", "/api/friends")).status).toBe(200);
    expect((await call(neu, "GET", "/api/username?u=neu.ling")).body).toEqual({ valid: true, available: true }); // your own
  });

  it("bubble styles: each needs its level, a metal and the gradients exclude each other, every stop must read", async () => {
    const save = (body: Record<string, unknown>) => call(raffi, "POST", "/api/me/profile", { username: "raffi", bg: "#010057", fg: "#ffffff", ...body });
    const setTotal = (n: number) => db.db.prepare("UPDATE users SET cred_total = ? WHERE id = ?").run(n, raffi.id);
    expect((await save({ bg2: "#215caf" })).body).toEqual({ detail: "locked" }); // level 1
    setTotal(100); // level 2
    expect((await save({ bg2: "#215caf" })).body).toEqual({ username: "raffi", bg: "#010057", fg: "#ffffff", bg2: "#215caf", fg2: null, metal: null });
    expect((await save({ fg2: "#f6c945" })).body).toEqual({ detail: "locked" });
    expect((await save({ metal: "bronze" })).body).toEqual({ detail: "locked" });
    setTotal(450); // level 4
    expect((await save({ bg2: "#e3e5e8" })).body).toEqual({ detail: "low_contrast" }); // white letters on a pale stop
    expect((await save({ fg2: "#215caf" })).body).toEqual({ detail: "low_contrast" });
    expect((await save({ bg2: "nope" })).body).toEqual({ detail: "bad_colour" });
    expect((await save({ metal: "platinum" })).body).toEqual({ detail: "bad_style" });
    expect((await save({ metal: "bronze", bg2: "#215caf" })).body).toEqual({ detail: "bad_style" });
    expect((await save({ fg2: "#f6c945" })).body).toMatchObject({ bg2: "#215caf", fg2: "#f6c945", metal: null }); // left out: kept
    expect((await save({ metal: "bronze" })).body).toMatchObject({ bg2: null, fg2: null, metal: "bronze" }); // a metal clears the gradients
    expect((await save({ metal: "silver" })).body).toEqual({ detail: "locked" });
    expect((await save({ bg2: "#215caf" })).body).toMatchObject({ bg2: "#215caf", metal: null }); // a gradient clears the metal
    expect((await save({ metal: "bronze" })).body).toMatchObject({ metal: "bronze" });
    // Points taken back below the level: the style stays, saving again keeps it, but no other one is allowed.
    setTotal(120);
    expect((await save({})).body).toMatchObject({ metal: "bronze" });
    expect((await save({ metal: "bronze", bg2: null, fg2: null })).body).toMatchObject({ metal: "bronze" });
    expect((await save({ fg2: "#f6c945" })).body).toEqual({ detail: "locked" });
    expect((await save({ metal: null })).body).toMatchObject({ bg2: null, fg2: null, metal: null });
    expect((await save({ metal: "bronze" })).body).toEqual({ detail: "locked" });
    // Everyone sees it: /api/me, a friend's list, the leaderboards.
    setTotal(1000);
    await save({ metal: "gold" });
    expect((await call(raffi, "GET", "/api/me")).body).toMatchObject({ bg: "#010057", fg: "#ffffff", bg2: null, fg2: null, metal: "gold" });
    await befriend(raffi, anna);
    expect((await call(anna, "GET", "/api/friends")).body.friends[0]).toMatchObject({ username: "raffi", metal: "gold", bg2: null });
    await call(raffi, "PUT", "/api/cred/board", { on: true });
    const board = (await call(raffi, "GET", "/api/cred/board?range=all")).body;
    expect(board.rows[0]).toMatchObject({ username: "raffi", bubble: { initials: "RW", bg: "#010057", fg: "#ffffff", bg2: null, fg2: null, metal: "gold" } });
  });

  it("contrast follows WCAG", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrast("#ffffff", "#ffffff")).toBe(1);
    expect(contrast("#1f3a5f", "#ffffff")).toBeGreaterThan(3);
  });

  it("changes need the page's Origin", async () => {
    for (const headers of [{ Origin: "https://evil.example" }, { Origin: "" }]) {
      expect((await call(raffi, "POST", "/api/friends/requests", { user: "anna_b" }, headers)).status).toBe(403);
    }
    expect(db.rows("SELECT * FROM friend_requests")).toHaveLength(0);
  });

  it("bodies must be JSON objects", async () => {
    const req = new Request("https://frooms.ch/api/checkin", { method: "POST", headers: { Origin: "https://frooms.ch", Cookie: `${SESSION_COOKIE}=${raffi.token}`, "Content-Type": "text/plain" }, body: "x" });
    expect((await handleSocial(req, new URL(req.url), env, lookup)).status).toBe(415);
    expect((await call(raffi, "POST", "/api/checkin", [1, 2])).status).toBe(400);
  });

  it("the account limiter answers 429", async () => {
    env.ACCOUNT_LIMITER = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const r = await call(raffi, "GET", "/api/friends");
    expect(r.status).toBe(429);
    expect(r.res.headers.get("Retry-After")).toBe("60");
  });

  it("the search limiter covers people search and username checks, keyed by account", async () => {
    const keys: string[] = [];
    env.SEARCH_LIMITER = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: keys.length <= 1 }) } as unknown as RateLimit;
    expect((await call(raffi, "GET", "/api/people?q=anna")).status).toBe(200);
    expect((await call(raffi, "GET", "/api/username?u=xyz")).status).toBe(429);
    expect(keys).toEqual([raffi.id, raffi.id]);
  });
});

describe("search (decision 8)", () => {
  const search = async (q: string, who = raffi) => (await call(who, "GET", `/api/people?q=${encodeURIComponent(q)}`)).body.people;

  it("finds by username prefix, name word start and exact email, and never shows an address or last name", async () => {
    expect((await search("ann")).map((p: { username: string }) => p.username)).toEqual(["anna_b"]);
    expect((await search("arx")).map((p: { username: string }) => p.username)).toEqual(["anna_b"]);
    expect((await search("mull")).map((p: { username: string }) => p.username)).toEqual(["ben"]); // ü folded
    expect((await search("ANNA@UZH.CH")).map((p: { username: string }) => p.username)).toEqual(["anna_b"]);
    expect(await search("anna@uzh")).toEqual([]); // email: exact only
    const [hit] = await search("ann");
    expect(hit).toEqual({ username: "anna_b", name: "Anna Lena A.", initials: "AA", bg: "#1f3a5f", fg: "#ffffff", bg2: null, fg2: null, metal: null, friend: false, request: null });
    expect(JSON.stringify(hit)).not.toMatch(/von|sub-|@/);
  });

  it("needs 3 letters, leaves out yourself and people without a username, returns at most 10", async () => {
    expect(await search("an")).toEqual([]);
    expect(await search("raf")).toEqual([]);
    await person(null, "Annabel", "Half");
    expect((await search("anna")).map((p: { username: string }) => p.username)).toEqual(["anna_b"]);
    for (let i = 0; i < 12; i++) await person(`zed${i}`, "Zed", `Person${i}`);
    expect(await search("zed")).toHaveLength(10);
  });

  it("treats _ and % literally", async () => {
    await person("annaxb", "Other", "One");
    expect((await search("anna_")).map((p: { username: string }) => p.username)).toEqual(["anna_b"]);
    expect(await search("%%%")).toEqual([]);
  });

  it("marks friends and requests", async () => {
    await befriend(raffi, anna);
    await call(raffi, "POST", "/api/friends/requests", { user: "ben" });
    expect((await search("ann"))[0]).toMatchObject({ friend: true, request: null });
    expect((await search("ben"))[0]).toMatchObject({ friend: false, request: "sent" });
    expect((await search("raf", ben))[0]).toMatchObject({ friend: false, request: "received" });
  });
});

describe("friends", () => {
  it("request, accept, list, remove", async () => {
    expect((await call(raffi, "POST", "/api/friends/requests", { user: "Anna_B" })).body).toEqual({ status: "requested" });
    let a = (await call(anna, "GET", "/api/friends")).body;
    expect(a.incoming.map((p: { username: string }) => p.username)).toEqual(["raffi"]);
    expect((await call(raffi, "GET", "/api/friends")).body.outgoing.map((p: { username: string }) => p.username)).toEqual(["anna_b"]);
    expect((await call(anna, "POST", "/api/friends/requests/accept", { user: "raffi" })).body).toMatchObject({ status: "friends" });
    a = (await call(anna, "GET", "/api/friends")).body;
    expect(a).toMatchObject({ incoming: [], outgoing: [], friends: [{ username: "raffi", name: "Raffaele W.", since: NOW }] });
    expect(db.rows("SELECT * FROM friend_requests")).toHaveLength(0);
    expect((await call(anna, "DELETE", "/api/friends?user=raffi")).status).toBe(204);
    expect(db.rows("SELECT * FROM friends")).toHaveLength(0);
  });

  it("asking someone who asked you makes you friends at once", async () => {
    await call(anna, "POST", "/api/friends/requests", { user: "raffi" });
    expect((await call(raffi, "POST", "/api/friends/requests", { user: "anna_b" })).body).toMatchObject({ status: "friends" });
    expect(db.rows("SELECT * FROM friends")).toHaveLength(2);
  });

  it("decline and withdraw", async () => {
    await call(anna, "POST", "/api/friends/requests", { user: "raffi" });
    await call(raffi, "DELETE", "/api/friends/requests?user=anna_b");
    await call(raffi, "POST", "/api/friends/requests", { user: "ben" });
    await call(raffi, "DELETE", "/api/friends/requests?user=ben");
    expect(db.rows("SELECT * FROM friend_requests")).toHaveLength(0);
    expect((await call(raffi, "POST", "/api/friends/requests/accept", { user: "anna_b" })).status).toBe(404);
  });

  it("no requests to yourself or to nobody; at most 30 a day", async () => {
    expect((await call(raffi, "POST", "/api/friends/requests", { user: "raffi" })).status).toBe(404);
    expect((await call(raffi, "POST", "/api/friends/requests", { user: "ghost" })).status).toBe(404);
    for (let i = 0; i < 31; i++) await person(`p${i}`, "P", `${i}`);
    for (let i = 0; i < 30; i++) expect((await call(raffi, "POST", "/api/friends/requests", { user: `p${i}` })).status).toBe(200);
    expect((await call(raffi, "POST", "/api/friends/requests", { user: "p30" })).body).toEqual({ detail: "too_many_friend_requests" });
    clock = NOW + 25 * HOUR;
    expect((await call(raffi, "POST", "/api/friends/requests", { user: "p30" })).status).toBe(200);
  });

  it("blocking removes the friendship and hides both from each other", async () => {
    await befriend(raffi, anna);
    expect((await call(anna, "POST", "/api/blocks", { user: "raffi" })).status).toBe(204);
    expect(db.rows("SELECT * FROM friends")).toHaveLength(0);
    expect((await call(raffi, "GET", "/api/people?q=anna")).body.people).toEqual([]);
    expect((await call(anna, "GET", "/api/people?q=raffi")).body.people).toEqual([]);
    expect((await call(raffi, "POST", "/api/friends/requests", { user: "anna_b" })).status).toBe(404);
    expect((await call(anna, "POST", "/api/friends/requests", { user: "raffi" })).status).toBe(404);
  });
});

describe("check-ins", () => {
  it("only friends see a running check-in, with the person as the page may show them", async () => {
    await befriend(raffi, anna);
    await checkIn(anna, { place: "MMB79", kind: "space", source: "search" });
    await checkIn(ben);
    const { checkins } = (await call(raffi, "GET", "/api/friends/checkins")).body;
    expect(checkins).toEqual([
      {
        person: { username: "anna_b", name: "Anna Lena A.", initials: "AA", bg: "#1f3a5f", fg: "#ffffff", bg2: null, fg2: null, metal: null },
        kind: "space", place: "MMB79", area: "zentrum", building: "MM", name: "Polymensa", since: NOW, until: NOW + CHECKIN_DEFAULT_MS,
      },
    ]);
    expect((await call(ben, "GET", "/api/friends/checkins")).body.checkins).toEqual([]);
  });

  it("a check-in past its end isn't shown; a new one after it works", async () => {
    await befriend(raffi, anna);
    await checkIn(anna, { until: NOW + HOUR });
    clock = NOW + HOUR;
    expect((await call(raffi, "GET", "/api/friends/checkins")).body.checkins).toEqual([]);
    expect((await call(anna, "GET", "/api/me")).body.checkin).toBeNull();
    clock = NOW + 2 * HOUR;
    expect((await checkIn(anna, { place: "CAB G 11" })).status).toBe(201);
    const rows = db.rows("SELECT place, ended_at, ended_by FROM checkins ORDER BY id");
    expect(rows).toEqual([
      { place: "HG E 33.1", ended_at: NOW + HOUR, ended_by: null }, // ran out at its end
      { place: "CAB G 11", ended_at: null, ended_by: null },
    ]);
  });

  it("a second check-in ends the first", async () => {
    await checkIn(raffi);
    clock = NOW + HOUR;
    await checkIn(raffi, { place: "CAB G 11" });
    expect(db.rows("SELECT place, ended_at, ended_by FROM checkins ORDER BY id")).toEqual([
      { place: "HG E 33.1", ended_at: NOW + HOUR, ended_by: "moved" },
      { place: "CAB G 11", ended_at: null, ended_by: null },
    ]);
  });

  it("refuses a building, an unknown place, a bad source and an end beyond 12 hours", async () => {
    expect((await checkIn(raffi, { kind: "building", place: "HG" })).body).toEqual({ detail: "bad_kind" });
    expect((await checkIn(raffi, { place: "HG Z 99" })).body).toEqual({ detail: "unknown_place" });
    expect((await checkIn(raffi, { area: "hoenggerberg" })).status).toBe(404);
    expect((await checkIn(raffi, { source: "gps" })).body).toEqual({ detail: "bad_source" });
    expect((await checkIn(raffi, { until: NOW + 13 * HOUR })).body).toEqual({ detail: "bad_until" });
    expect((await checkIn(raffi, { until: NOW - 1 })).body).toEqual({ detail: "bad_until" });
    expect(db.rows("SELECT * FROM checkins")).toHaveLength(0);
  });

  it("the end time can be changed; check-out ends it", async () => {
    expect((await call(raffi, "PATCH", "/api/checkin", { until: NOW + HOUR })).status).toBe(404);
    await checkIn(raffi);
    expect((await call(raffi, "PATCH", "/api/checkin", { until: NOW + 5 * HOUR })).body.checkin.until).toBe(NOW + 5 * HOUR);
    clock = NOW + HOUR;
    expect((await call(raffi, "DELETE", "/api/checkin")).status).toBe(204);
    expect(db.rows("SELECT ended_at, ended_by FROM checkins")).toEqual([{ ended_at: NOW + HOUR, ended_by: "user" }]);
    expect((await call(raffi, "GET", "/api/me")).body.checkin).toBeNull();
  });
});

describe("stars (section 7.4)", () => {
  const star = (i: number, extra: Record<string, unknown> = {}) => ({ kind: "room", id: `HG E ${i}`, area: "zentrum", name: `HG E ${i}`, building: "HG", ...extra });

  it("round-trip through the account", async () => {
    const stars = [star(1, { typecode: "SEMINAR" }), { kind: "building", id: "CAB", area: "zentrum", name: "CAB" }, { kind: "space", id: "MMB79", area: "zentrum", name: "Polymensa", building: "MM", category: "mensa" }];
    expect((await call(raffi, "PUT", "/api/me/stars", { stars })).body.stars).toHaveLength(3);
    expect((await call(raffi, "GET", "/api/me/stars")).body.stars).toEqual(lib.cleanStars(stars));
    expect((await call(raffi, "GET", "/api/me")).body.stars).toHaveLength(3);
    expect((await call(anna, "GET", "/api/me/stars")).body.stars).toEqual([]);
  });

  it("41 entries are cut to 40; unknown kinds, broken entries and extra fields are dropped", async () => {
    const many = Array.from({ length: 41 }, (_, i) => star(i));
    const { stars } = (await call(raffi, "PUT", "/api/me/stars", { stars: many })).body;
    expect(stars).toHaveLength(40);
    expect(stars[0].id).toBe("HG E 0");
    const messy = [{ kind: "friend", id: "x", area: "zentrum" }, null, { kind: "room", id: 5, area: "zentrum" }, star(1, { secret: "x" }), star(1)];
    expect((await call(raffi, "PUT", "/api/me/stars", { stars: messy })).body.stars).toEqual([star(1)]);
  });

  it("the Worker's cleanStars matches lib.js", () => {
    const lists: unknown[] = [
      undefined,
      "nope",
      [],
      Array.from({ length: 45 }, (_, i) => star(i % 43)),
      [star(1), star(1, { name: "dup" }), { kind: "building", id: "HG", area: "zentrum", building: "XX" }, { kind: "space", id: "A", area: "z" }],
      [{ kind: "room", id: "R", area: "a", typecode: 5, category: "mensa" }, { kind: "x" }, 7, null],
    ];
    for (const list of lists) expect(cleanStars(list)).toEqual(lib.cleanStars(list));
  });

  it("leaves out entries with very long texts", () => {
    expect(cleanStars([star(1, { name: "x".repeat(201) }), star(2)])).toEqual([star(2)]);
  });
});

describe("deleting the account", () => {
  it("leaves no row with the person's id; their check-ins stay without them", async () => {
    await befriend(raffi, anna);
    await call(raffi, "POST", "/api/friends/requests", { user: "ben" });
    await call(raffi, "POST", "/api/blocks", { user: "ben" });
    await call(raffi, "PUT", "/api/me/stars", { stars: [{ kind: "building", id: "HG", area: "zentrum" }] });
    await checkIn(raffi, { until: NOW + HOUR });
    clock = NOW + 2 * HOUR;
    await checkIn(raffi, { place: "CAB G 11" });
    // Street cred: a report link, a vote on Anna's report (her 👍 point names him), a meal rating.
    db.db.prepare("INSERT INTO report_owners VALUES (7, ?, ?)").run(raffi.id, clock);
    db.db.prepare("INSERT INTO report_owners VALUES (8, ?, ?)").run(anna.id, clock);
    db.db.prepare("INSERT INTO report_votes VALUES (8, ?, 1, ?)").run(raffi.id, clock);
    db.db.prepare("INSERT INTO cred (user_id, at, action, points, ref) VALUES (?, ?, 'report_liked', 1, ?)").run(anna.id, clock, `8:${raffi.id}`);
    db.db.prepare("INSERT INTO meal_ratings VALUES ('9|2026-11-18|lunch|1|rösti', '2026-11-18', 'F9', ?, 2, NULL, NULL, ?)").run(raffi.id, clock);
    expect(db.rows("SELECT COUNT(*) AS n FROM cred WHERE user_id = ?", raffi.id)[0].n).toBe(3); // a friend, two check-ins
    const { status, res } = await call(raffi, "DELETE", "/api/me");
    expect(status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toMatch(/^__Host-frooms_session=; .*Max-Age=0/);
    expect(rowsWith(raffi.id)).toEqual([]);
    // Anna keeps what she earned through him, without his id.
    expect(db.rows("SELECT action, points, ref LIKE 'former:%' AS former FROM cred WHERE user_id = ? ORDER BY id", anna.id)).toEqual([
      { action: "friend", points: 25, former: 1 },
      { action: "report_liked", points: 1, former: 1 },
    ]);
    expect((await call(anna, "GET", "/api/cred/log")).body.entries.map((e: { label: string }) => e.label)).toContain("Friends with a former user");
    expect(db.rows("SELECT report_id FROM report_owners")).toEqual([{ report_id: 8 }]);
    expect(db.rows("SELECT user_id, place, ended_at, ended_by FROM checkins ORDER BY id")).toEqual([
      { user_id: null, place: "HG E 33.1", ended_at: NOW + HOUR, ended_by: null },
      { user_id: null, place: "CAB G 11", ended_at: NOW + 2 * HOUR, ended_by: "user" },
    ]);
    expect((await call(raffi, "GET", "/api/me")).status).toBe(401);
    expect((await call(anna, "GET", "/api/friends")).body.friends).toEqual([]);
  });

  it("works before the profile step too", async () => {
    const neu = await person(null, "Neu", "Ling");
    expect((await call(neu, "DELETE", "/api/me")).status).toBe(204);
    expect(rowsWith(neu.id)).toEqual([]);
  });
});

describe("the daily clean-up", () => {
  it("removes expired sessions, unlinks check-ins after 12 months and deletes accounts unused for 24 months", async () => {
    const later = NOW + LINK_KEPT_MS + 2 * HOUR;
    await checkIn(raffi, { until: NOW + HOUR }); // ends (runs out) a year before `later`
    db.db.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").run(NOW, anna.id);
    const old = await person("old", "Old", "Timer", { seen: later - UNUSED_ACCOUNT_MS - 1 });
    db.db.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").run(later + HOUR, old.id);
    clock = later - HOUR;
    db.db.prepare("UPDATE sessions SET expires_at = ?, renewed_at = ? WHERE user_id = ?").run(later + HOUR, clock, ben.id);
    expect((await checkIn(ben)).status).toBe(201); // recent: stays linked
    db.db.prepare("UPDATE users SET last_seen_at = ? WHERE id IN (?, ?, ?)").run(later, raffi.id, anna.id, ben.id);

    const result = await cleanAccounts(db.asD1(), later);
    expect(result.accounts).toBe(1);
    expect(result.unlinked).toBe(1);
    expect(rowsWith(old.id)).toEqual([]);
    expect(db.rows("SELECT user_id FROM sessions ORDER BY user_id").map((r) => r.user_id)).not.toContain(anna.id);
    expect(db.rows("SELECT user_id, place FROM checkins ORDER BY id")).toEqual([
      { user_id: null, place: "HG E 33.1" },
      { user_id: ben.id, place: "HG E 33.1" },
    ]);
    expect(db.rows("SELECT username FROM users ORDER BY username").map((r) => r.username)).toEqual(["anna_b", "ben", "raffi"]);
  });
});

describe("usage counters (plans/PLAN_ADMIN_STATS.md 5.2)", () => {
  const today = () => db.stats()["2026-11-18"] ?? {};

  it("a check-in counts once each", async () => {
    expect((await checkIn(raffi)).status).toBe(201);
    expect((await checkIn(raffi, { place: "CAB G 11" })).status).toBe(201);
    expect(today()).toEqual({ checkin: 2 });
  });

  it("a friend request counts once; asking again, or answering one, doesn't", async () => {
    await call(raffi, "POST", "/api/friends/requests", { user: "anna_b" });
    await call(raffi, "POST", "/api/friends/requests", { user: "anna_b" });
    expect(today()).toEqual({ friend_request: 1 });
    await call(anna, "POST", "/api/friends/requests", { user: "raffi" }); // she had been asked: friends now
    await call(ben, "POST", "/api/friends/requests", { user: "anna_b" });
    await call(anna, "POST", "/api/friends/requests/accept", { user: "ben" });
    expect(today()).toEqual({ friend_request: 2 });
  });

  it("deleting the account counts", async () => {
    expect((await call(raffi, "DELETE", "/api/me")).status).toBe(204);
    expect(today()).toEqual({ account_deleted: 1 });
  });

  it("the clean-up counts the accounts it removes, on its Zurich day", async () => {
    const later = NOW + UNUSED_ACCOUNT_MS + 2 * HOUR;
    db.db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(later, raffi.id);
    expect((await cleanAccounts(db.asD1(), later)).accounts).toBe(2);
    expect(db.stats()).toEqual({ "2028-11-17": { account_expired: 2 } });
    expect(await cleanAccounts(db.asD1(), later)).toMatchObject({ accounts: 0 });
    expect(db.stats()).toEqual({ "2028-11-17": { account_expired: 2 } });
  });

  it("the table missing: the events' own writes still happen", async () => {
    db.db.exec("DROP TABLE stats_days");
    expect((await checkIn(raffi)).status).toBe(201);
    expect(db.rows("SELECT * FROM checkins")).toHaveLength(1);
    expect((await call(raffi, "POST", "/api/friends/requests", { user: "anna_b" })).body).toEqual({ status: "requested" });
    expect(db.rows("SELECT * FROM friend_requests")).toHaveLength(1);
    expect((await call(ben, "DELETE", "/api/me")).status).toBe(204);
    expect(rowsWith(ben.id)).toEqual([]);
    db.db.prepare("UPDATE users SET last_seen_at = 0 WHERE id = ?").run(anna.id);
    expect((await cleanAccounts(db.asD1(), NOW)).accounts).toBe(1);
    expect(rowsWith(anna.id)).toEqual([]);
  });
});
