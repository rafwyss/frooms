// Street cred (worker/cred.ts, plans/PLAN_STREET_CRED.md sections 5, 6 and 8): every rule and cap with the clock moved,
// the summary, log and leaderboards, and the awards for reports and feedback sent through the Worker signed in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, b64url, optionalUser, sha256Hex } from "../worker/auth";
import { CAPS, MAX_LEVEL, POINTS, RECENT_MS, TRUSTED_LIKES, UNLOCKS, award, dayStart, levelOf, levelStart, logLabel, nextUnlock, takeBack } from "../worker/cred";
import { clearMemoryCache } from "../worker/eth";
import worker, { type Env } from "../worker/index";
import { type LookupPlace, cleanAccounts, handleSocial, type SocialEnv } from "../worker/social";
import { clearStoreMemory } from "../worker/store";
import { FakeD1, FakeKV, fakeEth } from "./helpers";

const lib = new Function(`${readFileSync(join(import.meta.dirname, "..", "static", "lib.js"), "utf8")}; return { levelOf, levelStart, CRED_POINTS, CRED_CAPS, CRED_UNLOCKS, TRUSTED_LIKES };`)() as {
  levelOf: (p: number) => number;
  levelStart: (l: number) => number;
  CRED_POINTS: Record<string, number>;
  CRED_CAPS: Record<string, number>;
  CRED_UNLOCKS: Record<number, string>;
  TRUSTED_LIKES: number;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 18, 10, 0); // Wednesday 18 November, 11:00 in Zurich
const MIDNIGHT = Date.UTC(2026, 10, 18, 23, 0); // the 19th begins in Zurich
let db: FakeD1;
let env: SocialEnv;
let clock = NOW;

const lookup: LookupPlace = async (kind, place, area) => {
  if (kind === "room" && ["HG E 33.1", "CAB G 11", "ML E 12"].includes(place) && area === "zentrum") return { name: place, building: place.split(" ")[0] };
  return null;
};

interface Person {
  id: string;
  token: string;
  username: string;
}

async function person(username: string, first: string, last: string): Promise<Person> {
  const id = `sub-${username}`;
  db.db
    .prepare("INSERT INTO users (id, username, first_name, last_name, name_key, bg, fg, uni, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, '#1f3a5f', '#ffffff', 'eth', ?, ?)")
    .run(id, username, first, last, `${first} ${last}`.toLowerCase(), NOW, NOW);
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  db.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run(await sha256Hex(token), id, NOW, NOW, NOW + 400 * DAY);
  return { id, token, username };
}

async function call(who: Person | null, method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { Origin: "https://frooms.ch" };
  if (who) h.Cookie = `${SESSION_COOKIE}=${who.token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const req = new Request(`https://frooms.ch${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handleSocial(req, new URL(req.url), env, lookup, clock);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

const total = (p: Person) => db.rows("SELECT cred_total AS t FROM users WHERE id = ?", p.id)[0].t as number;
const log = (p: Person) => db.rows("SELECT action, points, ref, detail FROM cred WHERE user_id = ? ORDER BY id", p.id);
const checkIn = (who: Person, place = "HG E 33.1") => call(who, "POST", "/api/checkin", { kind: "room", place, area: "zentrum", source: "nearby" });
const befriend = async (a: Person, b: Person) => {
  await call(a, "POST", "/api/friends/requests", { user: b.username });
  return call(b, "POST", "/api/friends/requests/accept", { user: a.username });
};

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
  raffi = await person("raffi", "Raffaele", "Wyss");
  anna = await person("anna_b", "Anna", "von Arx");
  ben = await person("ben", "Ben", "Müller");
});

describe("levels", () => {
  it("start at 0, 100, 250, 450, 700, 1000, 1350 and go up to level 20", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(levelStart)).toEqual([0, 100, 250, 450, 700, 1000, 1350, 1750]);
    expect(levelOf(0)).toBe(1);
    expect(levelOf(99)).toBe(1);
    expect(levelOf(100)).toBe(2);
    expect(levelOf(449)).toBe(3);
    expect(levelOf(1000)).toBe(6);
    expect(MAX_LEVEL).toBe(20);
    expect(levelStart(20)).toBe(10_450);
    expect(levelOf(10_449)).toBe(19);
    expect(levelOf(10_450)).toBe(20);
    expect(levelOf(100_000)).toBe(20);
  });

  it("match lib.js", () => {
    for (let p = 0; p <= 12_000; p += 7) expect(lib.levelOf(p)).toBe(levelOf(p));
    for (let l = 0; l <= 40; l++) expect(lib.levelStart(l)).toBe(levelStart(l));
  });

  it("points, caps, unlocks and the trusted mark match lib.js (the Street cred view's table)", () => {
    expect(lib.CRED_POINTS).toEqual(POINTS);
    expect(lib.CRED_CAPS).toEqual(CAPS);
    expect(lib.CRED_UNLOCKS).toEqual(Object.fromEntries(Object.entries(UNLOCKS).map(([l, u]) => [l, u.label])));
    expect(lib.TRUSTED_LIKES).toBe(TRUSTED_LIKES);
  });

  it("name the next unlock up to gold, then none", () => {
    expect(nextUnlock(1)).toEqual({ level: 2, key: "gradient-bg", label: "Gradient background" });
    expect(nextUnlock(5)).toMatchObject({ level: 6, key: "gold" });
    expect(nextUnlock(6)).toBeNull();
  });
});

describe("friends", () => {
  it("25 each while friends: removing takes it back from both, re-adding pays again, either way of connecting", async () => {
    const r = await befriend(raffi, anna);
    expect(r.body).toEqual({ status: "friends", cred: { points: 25, total: 25, level: 1 } });
    expect(total(raffi)).toBe(25);
    expect(total(anna)).toBe(25);
    expect(log(raffi)).toEqual([{ action: "friend", points: 25, ref: anna.id, detail: null }]);

    await call(raffi, "DELETE", "/api/friends?user=anna_b");
    expect(total(raffi)).toBe(0);
    expect(total(anna)).toBe(0);
    expect(log(raffi)).toEqual([]);
    // Removing someone who isn't a friend (any more) costs nothing.
    await call(raffi, "DELETE", "/api/friends?user=anna_b");
    expect(total(raffi)).toBe(0);
    clock += DAY;
    expect((await befriend(anna, raffi)).body.cred.points).toBe(25);
    await call(anna, "DELETE", "/api/friends?user=raffi");
    // The other way: asking someone who asked you.
    await call(anna, "POST", "/api/friends/requests", { user: "raffi" });
    expect((await call(raffi, "POST", "/api/friends/requests", { user: "anna_b" })).body).toEqual({ status: "friends", cred: { points: 25, total: 25, level: 1 } });
    expect(total(raffi)).toBe(25);
    expect(total(anna)).toBe(25);
    // A second friend counts on top; removing the first leaves the second's.
    await call(ben, "POST", "/api/friends/requests", { user: "raffi" });
    expect((await call(raffi, "POST", "/api/friends/requests", { user: "ben" })).body.cred).toEqual({ points: 25, total: 50, level: 1 });
    await call(anna, "DELETE", "/api/friends?user=raffi");
    expect(total(raffi)).toBe(25);
    expect(total(ben)).toBe(25);
  });

  it("not again when the friend deletes the account and signs up again (edu-ID gives the same id)", async () => {
    await befriend(raffi, anna);
    expect((await call(anna, "DELETE", "/api/me")).status).toBeLessThan(300);
    // Raffi's row no longer names Anna, and keeps the 25.
    const [row] = log(raffi);
    expect(row).toMatchObject({ action: "friend", points: 25 });
    expect(row.ref).not.toContain(anna.id);
    expect(row.ref).toMatch(/^former:[0-9a-f]{64}$/);
    // Anna comes back with the same sub and befriends Raffi again: nothing more for Raffi.
    anna = await person("anna_b", "Anna", "von Arx");
    await befriend(anna, raffi);
    expect(total(raffi)).toBe(25);
    expect(log(raffi)).toHaveLength(1);
    // Ben, a new pair, still counts.
    await befriend(raffi, ben);
    expect(total(raffi)).toBe(50);
  });

  it("is taken back by a block, which ends the friendship", async () => {
    await befriend(raffi, anna);
    await call(raffi, "POST", "/api/blocks", { user: "anna_b" });
    expect(total(raffi)).toBe(0);
    expect(total(anna)).toBe(0);
    await call(raffi, "DELETE", "/api/blocks?user=anna_b");
    db.db.prepare("DELETE FROM blocks").run();
    await befriend(raffi, anna);
    expect(total(raffi)).toBe(25);
  });
});

describe("check-ins", () => {
  it("5 each, at most 4 a day; the cap resets at Zurich midnight", async () => {
    const places = ["HG E 33.1", "CAB G 11", "ML E 12", "HG E 33.1", "CAB G 11"];
    const got: number[] = [];
    for (const p of places) {
      got.push((await checkIn(raffi, p)).body.cred.points);
      clock += 3 * HOUR; // 11:00, 14:00, 17:00, 20:00, 23:00 in Zurich
    }
    expect(got).toEqual([5, 5, 5, 5, 0]);
    expect(total(raffi)).toBe(20);
    clock = MIDNIGHT - 1;
    expect((await checkIn(raffi, "ML E 12")).body.cred.points).toBe(0);
    clock = MIDNIGHT;
    expect((await checkIn(raffi, "HG E 33.1")).body.cred).toEqual({ points: 5, total: 25, level: 1 });
  });

  it("nothing for the same place again within 2 hours", async () => {
    expect((await checkIn(raffi)).body.cred.points).toBe(5);
    clock += 30 * MINUTE;
    await call(raffi, "DELETE", "/api/checkin");
    clock += 30 * MINUTE;
    expect((await checkIn(raffi)).body.cred.points).toBe(0);
    expect((await checkIn(raffi, "CAB G 11")).body.cred.points).toBe(5);
    clock = NOW + 2 * HOUR + 1; // 2 hours after the one that earned (the one at NOW + 1 h didn't)
    expect((await checkIn(raffi)).body.cred.points).toBe(5);
    clock = NOW + 3 * HOUR + 1;
    expect((await checkIn(raffi)).body.cred.points).toBe(0);
  });

  it("names the place in the log, and the ref is the check-in", async () => {
    await checkIn(raffi, "CAB G 11");
    const id = db.rows("SELECT id FROM checkins")[0].id;
    expect(log(raffi)).toEqual([{ action: "checkin", points: 5, ref: String(id), detail: "CAB G 11" }]);
  });

  it("changing the end or checking out earns nothing", async () => {
    await checkIn(raffi);
    await call(raffi, "PATCH", "/api/checkin", { until: NOW + 2 * HOUR });
    await call(raffi, "DELETE", "/api/checkin");
    expect(total(raffi)).toBe(5);
  });
});

describe("invites", () => {
  it("3 each, at most 5 a day; signed in only; known kinds only", async () => {
    const got: number[] = [];
    for (let i = 0; i < 6; i++) got.push((await call(raffi, "POST", "/api/cred/invite", { kind: i % 2 ? "place" : "friend-link" })).body.cred.points);
    expect(got).toEqual([3, 3, 3, 3, 3, 0]);
    expect((await call(raffi, "POST", "/api/cred/invite", { kind: "spam" })).status).toBe(400);
    expect((await call(null, "POST", "/api/cred/invite", { kind: "meal" })).status).toBe(401);
    clock = MIDNIGHT;
    expect((await call(raffi, "POST", "/api/cred/invite", { kind: "checkin" })).body.cred).toEqual({ points: 3, total: 18, level: 1 });
    expect(log(raffi).map((r) => r.ref)).toEqual(["2026-11-18:1", "2026-11-18:2", "2026-11-18:3", "2026-11-18:4", "2026-11-18:5", "2026-11-19:1"]);
  });
});

describe("award and takeBack", () => {
  it("every action has points; the caps are as in the plan", () => {
    expect(POINTS).toEqual({ friend: 25, checkin: 5, report: 3, report_liked: 1, report_vote: 1, invite: 3, problem: 5, feedback: 10, meal_rating: 3, bug: 50 });
    expect(CAPS).toEqual({ checkin: 4, report: 10, report_vote: 20, invite: 5, problem: 3, feedback: 1, meal_rating: 5 });
  });

  it("the same ref twice adds once; a 👍 taken back lowers the total", async () => {
    const d = db.asD1();
    await d.batch(await award(d, anna.id, "report_liked", `5:${raffi.id}`, clock, "HG E 33.1"));
    expect(await award(d, anna.id, "report_liked", `5:${raffi.id}`, clock)).toEqual([]);
    await d.batch(await award(d, anna.id, "report_liked", `5:${ben.id}`, clock, "HG E 33.1"));
    expect(total(anna)).toBe(2);
    await d.batch(await takeBack(d, anna.id, "report_liked", `5:${raffi.id}`));
    expect(await takeBack(d, anna.id, "report_liked", `5:${raffi.id}`)).toEqual([]);
    expect(total(anna)).toBe(1);
    expect(log(anna).map((r) => r.ref)).toEqual([`5:${ben.id}`]);
  });

  it("an insert that was ignored adds nothing (changes() guard)", async () => {
    const d = db.asD1();
    const first = await award(d, raffi.id, "meal_rating", "9|2026-11-18|lunch|1|rösti", clock, "Rösti");
    const second = await award(d, raffi.id, "meal_rating", "9|2026-11-18|lunch|1|rösti", clock, "Rösti");
    await d.batch(first);
    await d.batch(second); // prepared before the first ran: a race
    expect(total(raffi)).toBe(3);
  });

  it("the day begins at Zurich midnight, also across a clock change", () => {
    expect(dayStart(NOW)).toBe(Date.UTC(2026, 10, 17, 23, 0));
    expect(dayStart(MIDNIGHT)).toBe(MIDNIGHT);
    expect(dayStart(Date.UTC(2026, 2, 29, 12, 0))).toBe(Date.UTC(2026, 2, 28, 23, 0)); // summer time began that night
    expect(dayStart(Date.UTC(2026, 6, 1, 21, 59))).toBe(Date.UTC(2026, 5, 30, 22, 0));
  });
});

describe("GET /api/cred and the log", () => {
  it("totals, recent of 30 days, level and the next unlock, the 5 latest", async () => {
    clock = NOW - 31 * DAY;
    await befriend(raffi, anna);
    clock = NOW - 29 * DAY;
    await checkIn(raffi);
    clock = NOW;
    for (let i = 0; i < 4; i++) await call(raffi, "POST", "/api/cred/invite", { kind: "meal" });
    const { body } = await call(raffi, "GET", "/api/cred");
    expect(body).toMatchObject({ total: 42, recent: 17, level: 1, levelStart: 0, nextLevelAt: 100, nextUnlock: { level: 2, label: "Gradient background" }, board: false });
    expect(body.latest).toHaveLength(5);
    expect(body.latest[0]).toMatchObject({ action: "invite", points: 3, label: "Invited friends", at: NOW });
    expect(body.latest[4]).toMatchObject({ action: "checkin", label: "Checked in at HG E 33.1" });
    clock = NOW + DAY + 1;
    expect((await call(raffi, "GET", "/api/cred")).body).toMatchObject({ total: 42, recent: 12 }); // the check-in is 31 days old now
  });

  it("GET /api/me carries the total, the level and the trusted mark (the menu's badge, the toast)", async () => {
    db.db.prepare("UPDATE users SET cred_total = 460, likes_received = 20 WHERE id = ?").run(raffi.id);
    expect((await call(raffi, "GET", "/api/me")).body.cred).toEqual({ total: 460, level: 4, trusted: true });
    expect((await call(anna, "GET", "/api/me")).body.cred).toEqual({ total: 0, level: 1, trusted: false });
  });

  it("labels every action", () => {
    expect(logLabel("friend", null, "anna_b")).toBe("Friends with @anna_b");
    expect(logLabel("friend", null, null)).toBe("Friends with a former user");
    expect(logLabel("report", "HG E 41")).toBe("Reported occupancy at HG E 41");
    expect(logLabel("report_liked", "HG E 41")).toBe("Your report at HG E 41 got a 👍");
    expect(logLabel("report_vote", null)).toBe("Rated a report");
    expect(logLabel("problem", null)).toBe("Reported a problem");
    expect(logLabel("feedback", null)).toBe("Sent feedback");
    expect(logLabel("meal_rating", "Älplermagronen")).toBe("Rated Älplermagronen");
  });

  it("pages by 50, filters by Zurich day, lists the days with entries", async () => {
    await befriend(raffi, anna);
    const put = db.db.prepare("INSERT INTO cred (user_id, at, action, points, ref) VALUES (?, ?, 'report_vote', 1, ?)");
    for (let i = 0; i < 60; i++) put.run(raffi.id, NOW - DAY + i * MINUTE, `r${i}`); // the 17th, from 11:00
    put.run(raffi.id, MIDNIGHT - 1, "late"); // 23:59:59 on the 18th, Zurich time
    put.run(raffi.id, MIDNIGHT, "next"); // the 19th
    const first = (await call(raffi, "GET", "/api/cred/log")).body;
    expect(first.entries).toHaveLength(50);
    expect(first.more).toBe(true);
    expect(first.days).toEqual(["2026-11-19", "2026-11-18", "2026-11-17"]);
    expect(first.entries[0]).toMatchObject({ label: "Rated a report", points: 1 });
    const second = (await call(raffi, "GET", `/api/cred/log?before=${first.entries[49].id}`)).body;
    expect(second.entries).toHaveLength(13);
    expect(second.more).toBe(false);
    expect(second.days).toBeUndefined();
    expect(second.entries.at(-1)).toMatchObject({ label: "Friends with @anna_b" });
    const day = (await call(raffi, "GET", "/api/cred/log?day=2026-11-18")).body;
    expect(day.entries.map((e: { action: string }) => e.action)).toEqual(["report_vote", "friend"]);
    expect((await call(raffi, "GET", "/api/cred/log?day=2026-11-17")).body.entries).toHaveLength(50);
    expect((await call(raffi, "GET", "/api/cred/log?day=yesterday")).status).toBe(400);
    expect((await call(raffi, "GET", "/api/cred/log?before=x")).status).toBe(400);
    expect((await call(anna, "GET", "/api/cred/log")).body.entries).toHaveLength(1); // only your own
  });
});

describe("leaderboards", () => {
  const board = (who: Person, range: string) => call(who, "GET", `/api/cred/board?range=${range}`);

  it("403 without the opt-in; lists only the opted-in, ties to who got there first", async () => {
    clock = NOW - 40 * DAY;
    await befriend(raffi, anna); // 25 each, long ago
    clock = NOW;
    await checkIn(ben); // 5 recent
    expect((await board(raffi, "all")).status).toBe(403);
    expect((await call(raffi, "PUT", "/api/cred/board", { on: true })).body).toEqual({ board: true });
    expect((await call(raffi, "PUT", "/api/cred/board", { on: "yes" })).status).toBe(400);
    let all = (await board(raffi, "all")).body;
    expect(all.rows).toEqual([{ rank: 1, username: "raffi", name: "Raffaele W.", bubble: { initials: "RW", bg: "#1f3a5f", fg: "#ffffff", bg2: null, fg2: null, metal: null }, points: 25, me: true }]);
    expect(JSON.stringify(all)).not.toMatch(/anna|ben|Wyss|sub-/);
    // Anna joins: 25 as well, earned at the same moment; she joined later, so she's second.
    clock = NOW + MINUTE;
    await call(anna, "PUT", "/api/cred/board", { on: true });
    all = (await board(anna, "all")).body;
    expect(all.rows.map((r: { username: string; rank: number }) => [r.rank, r.username])).toEqual([[1, "raffi"], [2, "anna_b"]]);
    expect(all.you).toEqual({ rank: 2, points: 25 });
    // Recent: nobody opted in has points in the last 30 days.
    expect((await board(raffi, "recent")).body).toEqual({ range: "recent", rows: [], more: false, you: { rank: null, points: 0 } });
    await call(ben, "PUT", "/api/cred/board", { on: true });
    const recent = (await board(raffi, "recent")).body;
    expect(recent.rows.map((r: { username: string; points: number }) => [r.username, r.points])).toEqual([["ben", 5]]);
    expect((await board(ben, "all")).body.you).toEqual({ rank: 3, points: 5 });
    expect((await board(raffi, "weekly")).status).toBe(400);
    // Leaving hides you and closes the boards to you.
    await call(raffi, "PUT", "/api/cred/board", { on: false });
    expect((await board(raffi, "all")).status).toBe(403);
    expect((await board(anna, "all")).body.rows.map((r: { username: string }) => r.username)).toEqual(["anna_b", "ben"]);
  });

  it("pages of 50 for everyone who joined (after=<rank>), with your own row and whether more follow", async () => {
    const put = db.db.prepare("INSERT INTO cred (user_id, at, action, points, ref) VALUES (?, ?, 'report_vote', ?, 'x')");
    for (let i = 0; i < 55; i++) {
      const p = await person(`p${i}`, "P", `N${i}`);
      put.run(p.id, NOW - i * MINUTE, 100 - i);
      db.db.prepare("UPDATE users SET board = 1, board_at = ?, cred_total = ?, cred_at = ? WHERE id = ?").run(NOW, 100 - i, NOW - i * MINUTE, p.id);
    }
    await call(raffi, "PUT", "/api/cred/board", { on: true });
    await call(raffi, "POST", "/api/cred/invite", { kind: "meal" });
    for (const range of ["recent", "all"]) {
      const b = (await board(raffi, range)).body;
      expect(b.rows).toHaveLength(50);
      expect(b.rows[0]).toMatchObject({ rank: 1, username: "p0", points: 100 });
      expect(b.rows.some((r: { me: boolean }) => r.me)).toBe(false);
      expect(b.more).toBe(true);
      expect(b.you).toEqual({ rank: 56, points: 3 });
      // The next page: ranks 51 to 56, the last one yours, and nothing after it.
      const next = (await call(raffi, "GET", `/api/cred/board?range=${range}&after=50`)).body;
      expect(next.rows.map((r: { rank: number }) => r.rank)).toEqual([51, 52, 53, 54, 55, 56]);
      expect(next.rows.at(-1)).toMatchObject({ username: "raffi", me: true });
      expect(next.more).toBe(false);
      expect((await call(raffi, "GET", `/api/cred/board?range=${range}&after=56`)).body).toMatchObject({ rows: [], more: false, you: { rank: 56 } });
    }
    expect((await call(raffi, "GET", "/api/cred/board?range=all&after=-1")).status).toBe(400);
    expect((await call(raffi, "GET", "/api/cred/board?range=all&after=x")).status).toBe(400);
  });

  it("the profile step's \"Show me on the leaderboards\" joins them; left unticked it doesn't", async () => {
    const step = (who: Person, extra: Record<string, unknown>) => call(who, "POST", "/api/me/profile", { username: who.username, bg: "#1f3a5f", fg: "#ffffff", ...extra });
    expect((await step(raffi, {})).body.board).toBeUndefined();
    expect(db.rows("SELECT board FROM users WHERE id = ?", raffi.id)[0].board).toBe(0);
    expect((await step(anna, { board: true })).body).toMatchObject({ username: "anna_b", board: true });
    expect(db.rows("SELECT board, board_at FROM users WHERE id = ?", anna.id)[0]).toEqual({ board: 1, board_at: NOW });
    // Only true joins: anything else changes nothing (leaving is on the Street cred page).
    await step(anna, { board: false });
    expect(db.rows("SELECT board FROM users WHERE id = ?", anna.id)[0].board).toBe(1);
  });
});

describe("the daily clean-up", () => {
  it("drops log rows after 12 months but friends', report links and votes after 2 days, meal ratings after 60; the total stays", async () => {
    clock = NOW - 400 * DAY;
    await befriend(raffi, anna);
    await checkIn(raffi);
    clock = NOW - 3 * DAY;
    await checkIn(raffi, "CAB G 11");
    db.db.prepare("INSERT INTO report_owners VALUES (1, ?, ?), (2, ?, ?)").run(raffi.id, NOW - 3 * DAY, raffi.id, NOW - HOUR);
    db.db.prepare("INSERT INTO report_votes VALUES (1, ?, 1, ?), (2, ?, 0, ?)").run(anna.id, NOW - 3 * DAY, anna.id, NOW - HOUR);
    const rate = db.db.prepare("INSERT INTO meal_ratings VALUES (?, ?, 'F9', ?, 1, NULL, NULL, ?)");
    rate.run("old", "2026-09-18", raffi.id, NOW - 61 * DAY);
    rate.run("kept", "2026-09-19", raffi.id, NOW - 60 * DAY);
    db.db.prepare("UPDATE users SET last_seen_at = ?").run(NOW);
    expect(total(raffi)).toBe(35);
    await cleanAccounts(db.asD1(), NOW);
    expect(log(raffi).map((r) => r.action)).toEqual(["friend", "checkin"]);
    expect(total(raffi)).toBe(35);
    expect(db.rows("SELECT report_id FROM report_owners")).toEqual([{ report_id: 2 }]);
    expect(db.rows("SELECT report_id FROM report_votes")).toEqual([{ report_id: 2 }]);
    expect(db.rows("SELECT dish FROM meal_ratings")).toEqual([{ dish: "kept" }]);
  });

  it("drops bug reports 90 days after the decision, or after 12 months still pending; deleting the account drops them all", async () => {
    const put = db.db.prepare("INSERT INTO bug_reports (id, user_id, at, summary, status, decided_at) VALUES (?, ?, ?, 'x', ?, ?)");
    put.run(1, raffi.id, NOW - 100 * DAY, "rewarded", NOW - 91 * DAY);
    put.run(2, raffi.id, NOW - 100 * DAY, "declined", NOW - 89 * DAY);
    put.run(3, raffi.id, NOW - 366 * DAY, "pending", null);
    put.run(4, raffi.id, NOW - 300 * DAY, "pending", null);
    put.run(5, anna.id, NOW - DAY, "pending", null);
    db.db.prepare("UPDATE users SET last_seen_at = ?").run(NOW);
    await cleanAccounts(db.asD1(), NOW);
    expect(db.rows("SELECT id FROM bug_reports ORDER BY id").map((r) => r.id)).toEqual([2, 4, 5]);
    expect((await call(raffi, "DELETE", "/api/me")).status).toBeLessThan(300);
    expect(db.rows("SELECT id FROM bug_reports ORDER BY id").map((r) => r.id)).toEqual([5]);
  });
});

describe("optionalUser", () => {
  const req = (host: string, token?: string) =>
    new Request(`https://${host}/api/report`, { method: "POST", headers: token ? { Cookie: `${SESSION_COOKIE}=${token}` } : {} });

  it("is null signed out, with a bad session, before the profile step and on a host without sign-in", async () => {
    expect(await optionalUser(req("frooms.ch"), env, NOW)).toBeNull();
    expect(await optionalUser(req("frooms.ch", "x".repeat(43)), env, NOW)).toBeNull();
    expect(await optionalUser(req("abc-fruum.fruum.workers.dev", raffi.token), env, NOW)).toBeNull();
    expect(await optionalUser(req("frooms.ch", raffi.token), { ...env, SESSION_KEY: "short" }, NOW)).toBeNull();
    db.db.prepare("UPDATE users SET username = NULL WHERE id = ?").run(ben.id);
    expect(await optionalUser(req("frooms.ch", ben.token), env, NOW)).toBeNull();
  });

  it("names the person, renews like requireUser, and swallows a broken database", async () => {
    const signed = await optionalUser(req("frooms.ch", raffi.token), env, NOW);
    expect(signed?.user.id).toBe(raffi.id);
    expect(signed?.setCookie).toBeUndefined();
    expect((await optionalUser(req("frooms.ch", raffi.token), env, NOW + 2 * DAY))?.setCookie).toMatch(/^__Host-frooms_session=/);
    const broken = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    expect(await optionalUser(req("frooms.ch", raffi.token), { ...env, ACCOUNTS: broken }, NOW)).toBeNull();
  });
});

// --- Reports and feedback through the Worker (POST /api/report, POST /api/feedback) ---------------------------------

describe("reports and feedback, signed in or not", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const W_NOW = Date.UTC(2026, 9, 29, 11, 0); // the samples' day (worker.test.ts)
  let fruum: FakeD1;
  let wenv: Env;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: W_NOW });
    clearMemoryCache();
    clearStoreMemory();
    vi.stubGlobal("fetch", fakeEth().fetch);
    fruum = new FakeD1();
    wenv = {
      ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
      ROOMS: new FakeKV().asKV(),
      DB: fruum.asD1(),
      ...(env as Partial<Env>),
    } as Env;
    db.db.prepare("UPDATE sessions SET renewed_at = ?, expires_at = ?").run(W_NOW, W_NOW + 30 * DAY);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const post = async (path: string, body: unknown, who: Person | null, host = "frooms.ch") => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: `https://${host}` };
    if (who) headers.Cookie = `${SESSION_COOKIE}=${who.token}`;
    const res = await worker.fetch(new Request(`https://${host}${path}`, { method: "POST", headers, body: JSON.stringify(body) }), wenv, ctx);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const client = (i: number) => `${String(i).padStart(2, "0")}${"a".repeat(30)}`;
  const report = (i: number, extra: Record<string, unknown> = {}) => ({ kind: "level", place_kind: "room", place: "ML E 12", area: "Z", value: 2, client: client(i), ...extra });

  it("a new report earns 3 and is linked to the account; a replaced one earns nothing", async () => {
    const first = await post("/api/report", report(1), raffi);
    expect(first.body).toMatchObject({ stored: "new", cred: { points: 3, total: 3, level: 1 } });
    const id = fruum.rows("SELECT id FROM reports")[0].id;
    expect(db.rows("SELECT report_id, user_id, at FROM report_owners")).toEqual([{ report_id: id, user_id: raffi.id, at: W_NOW }]);
    expect(log(raffi)).toEqual([{ action: "report", points: 3, ref: String(id), detail: "ML E 12" }]);
    // The same reading again: the same row, its votes kept.
    const same = await post("/api/report", report(1), raffi);
    expect(same.body).toMatchObject({ stored: "replaced", cred: { points: 0, total: 3 } });
    expect(fruum.rows("SELECT id FROM reports")).toEqual([{ id }]);
    // Another reading: a new row (the old one's votes don't move to it), linked again, still nothing earned.
    const again = await post("/api/report", report(1, { value: 1 }), raffi);
    expect(again.body).toMatchObject({ stored: "replaced", cred: { points: 0, total: 3 } });
    const rows = fruum.rows("SELECT id, value FROM reports");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(id);
    expect(rows[0].value).toBe(1);
    expect(db.rows("SELECT report_id FROM report_owners WHERE report_id = ?", rows[0].id)).toHaveLength(1);
    // fruum never gets a user id.
    expect(JSON.stringify(fruum.rows("SELECT * FROM reports"))).not.toContain("sub-");
  });

  it("removing your report deletes it and takes back its 3 and its 👍; replaced first, the 3 still goes", async () => {
    const del = async (body: unknown, who: Person | null = raffi) => {
      const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://frooms.ch" };
      if (who) headers.Cookie = `${SESSION_COOKIE}=${who.token}`;
      const res = await worker.fetch(new Request("https://frooms.ch/api/report", { method: "DELETE", headers, body: JSON.stringify(body) }), wenv, ctx);
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    await post("/api/report", report(1), raffi);
    // Replaced with another reading: a new row, the 3 moves with it.
    await post("/api/report", report(1, { value: 1 }), raffi);
    const id = fruum.rows("SELECT id FROM reports")[0].id;
    expect(log(raffi)).toEqual([{ action: "report", points: 3, ref: String(id), detail: "ML E 12" }]);
    await post("/api/reports/vote", { id, up: true }, anna);
    expect(total(raffi)).toBe(4);
    const { value, ...which } = report(1);
    const res = await del(which, null); // signed out too: the browser's id says whose it is
    expect(res).toMatchObject({ status: 200, body: { ok: true, removed: true, summary: null } });
    expect(fruum.rows("SELECT * FROM reports")).toEqual([]);
    expect(total(raffi)).toBe(0);
    expect(db.rows("SELECT likes_received FROM users WHERE id = ?", raffi.id)[0].likes_received).toBe(0);
    expect(db.rows("SELECT * FROM report_owners WHERE report_id = ?", id)).toEqual([]);
    expect(db.rows("SELECT * FROM report_votes")).toEqual([]);
    expect(total(anna)).toBe(1); // the voter keeps hers
    // Again: nothing left to remove. Someone else's browser can't remove yours.
    expect((await del(which)).body.removed).toBe(false);
    await post("/api/report", report(1), raffi);
    expect((await del({ ...which, client: client(2) })).body.removed).toBe(false);
    expect(fruum.rows("SELECT id FROM reports")).toHaveLength(1);
    // A rating of the estimate can be removed too (here there's none).
    expect((await del({ ...which, kind: "rating", place_kind: "space", place: "HGH30.1" })).body.removed).toBe(false);
    expect((await del({ ...which, kind: "level", place_kind: "desk" })).status).toBe(400);
  });

  it("signed out, or on a host without sign-in: no cred, no link", async () => {
    expect((await post("/api/report", report(2), null)).body.cred).toBeUndefined();
    expect((await post("/api/report", report(3), raffi, "frooms.test")).body.cred).toBeUndefined();
    expect(db.rows("SELECT * FROM report_owners")).toEqual([]);
    expect(total(raffi)).toBe(0);
  });

  it("at most 10 reports a day earn", async () => {
    const got: number[] = [];
    for (let i = 0; i < 11; i++) got.push((await post("/api/report", report(i + 10), raffi)).body.cred.points);
    expect(got).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 0]);
    expect(db.rows("SELECT COUNT(*) AS n FROM report_owners")[0].n).toBe(11); // every new report is linked
  });

  it("feedback: a problem 5 (3 a day), an idea or other 10 (1 a day), a person nothing; signed out nothing", async () => {
    const send = async (category: string, who: Person | null = raffi) => (await post("/api/feedback", { category, message: "hi" }, who)).body;
    expect((await send("broken")).cred).toEqual({ points: 5, total: 5, level: 1 });
    expect((await send("wrong-info")).cred.points).toBe(5);
    expect((await send("broken")).cred.points).toBe(5);
    expect((await send("wrong-info")).cred.points).toBe(0);
    expect((await send("idea")).cred.points).toBe(10);
    expect((await send("other")).cred.points).toBe(0);
    expect((await send("person")).cred.points).toBe(0);
    expect((await send("idea", null)).cred).toBeUndefined();
    expect(await post("/api/feedback", { category: "idea", message: "x", website: "spam" }, anna)).toMatchObject({ body: { ok: true } });
    expect(total(anna)).toBe(0);
    expect(total(raffi)).toBe(25);
    expect(log(raffi).map((r) => r.action)).toEqual(["problem", "problem", "problem", "feedback"]);
    // The stored feedback has no user.
    expect(JSON.stringify(fruum.rows("SELECT * FROM feedback"))).not.toContain("sub-");
    // The caps reset at Zurich midnight.
    vi.setSystemTime(Date.UTC(2026, 9, 29, 23, 0));
    expect((await send("idea")).cred.points).toBe(10);
  });

  // --- Bug reports (worker/bugs.ts) ---

  it("a bug report: pending without instant points, 3 waiting at most; an admin rewards 50 once or declines with a reason", async () => {
    wenv.ADMIN_IDS = anna.id;
    const bug = (who: Person | null, message = "The star doesn't stick") =>
      post("/api/feedback", { category: "broken", message, bug: true, context: { mode: "rooms", picked: { element: "button.sheet-star" } } }, who);
    const first = await bug(raffi);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ ok: true, bug: "pending", cred: { points: 0, total: 0 } });
    const id = fruum.rows("SELECT id FROM feedback")[0].id as number;
    expect(db.rows("SELECT id, user_id, summary, status FROM bug_reports")).toEqual([{ id, user_id: raffi.id, summary: "The star doesn't stick", status: "pending" }]);
    // fruum still never gets a user id; the picked element is in the context.
    expect(JSON.stringify(fruum.rows("SELECT * FROM feedback"))).not.toContain("sub-");
    expect(fruum.rows("SELECT context FROM feedback")[0].context).toContain("sheet-star");
    // Signed out, `bug` is plain feedback (no link); a bug flag on another category is ignored too.
    expect((await bug(null)).body).toEqual({ ok: true });
    expect((await post("/api/feedback", { category: "idea", message: "x", bug: true }, ben)).body).toMatchObject({ cred: { points: 10 } });
    expect(db.rows("SELECT COUNT(*) AS n FROM bug_reports")[0].n).toBe(1);
    // Three waiting: the fourth is refused before anything is stored.
    await bug(raffi, "two");
    await bug(raffi, "three");
    const before = fruum.rows("SELECT COUNT(*) AS n FROM feedback")[0].n;
    const fourth = await bug(raffi, "four");
    expect(fourth.status).toBe(409);
    expect(fourth.body.code).toBe("bugs_pending");
    expect(fruum.rows("SELECT COUNT(*) AS n FROM feedback")[0].n).toBe(before);

    // The admin page lists them with their messages; nobody else gets the endpoint.
    const stats = await get("/api/admin/stats", anna);
    expect(stats.body.bugs.map((b: any) => [b.username, b.status, b.message])).toEqual([["raffi", "pending", "The star doesn't stick"], ["raffi", "pending", "two"], ["raffi", "pending", "three"]]);
    expect((await post("/api/admin/bug", { id, decision: "reward" }, raffi)).status).toBe(404);

    const reward = await post("/api/admin/bug", { id, decision: "reward" }, anna);
    expect(reward.body).toMatchObject({ id, status: "rewarded", cred: { points: 50, total: 50 } });
    expect(log(raffi)).toEqual([{ action: "bug", points: 50, ref: String(id), detail: null }]);
    expect((await post("/api/admin/bug", { id, decision: "reward" }, anna)).status).toBe(409);
    expect(total(raffi)).toBe(50);

    const ids = db.rows("SELECT id FROM bug_reports WHERE status = 'pending' ORDER BY id").map((r) => r.id as number);
    expect((await post("/api/admin/bug", { id: ids[0], decision: "decline" }, anna)).body.detail).toBe("reason_needed");
    expect((await post("/api/admin/bug", { id: ids[0], decision: "decline", reason: "x".repeat(121) }, anna)).body.detail).toBe("reason_too_long");
    const no = await post("/api/admin/bug", { id: ids[0], decision: "decline", reason: "  Already  known, fixed tomorrow " }, anna);
    expect(no.body).toEqual({ id: ids[0], status: "declined", reason: "Already known, fixed tomorrow" });
    expect(total(raffi)).toBe(50);

    // The sender sees all three on their Street cred page, newest first; one is free again, so a new one goes through.
    const mine = await get("/api/cred", raffi);
    expect(mine.body.bugs.map((b: any) => [b.status, b.reason])).toEqual([["pending", null], ["declined", "Already known, fixed tomorrow"], ["rewarded", null]]);
    expect((await bug(raffi, "four")).status).toBe(201);
  });

  // --- Report votes (section 9) ---

  const get = async (path: string, who: Person | null, host = "frooms.ch") => {
    const headers: Record<string, string> = who ? { Cookie: `${SESSION_COOKIE}=${who.token}` } : {};
    const res = await worker.fetch(new Request(`https://${host}${path}`, { headers }), wenv, ctx);
    return { status: res.status, body: (await res.json()) as Record<string, any>, res };
  };
  const LOG = "/api/reports?place_kind=room&place=ML+E+12&area=Z";
  const vote = (who: Person | null, id: number, up: boolean | null) => post("/api/reports/vote", { id, up }, who);
  const likes = (p: Person) => db.rows("SELECT likes_received AS n FROM users WHERE id = ?", p.id)[0].n as number;
  const sendReport = async (who: Person | null, i: number) => {
    await post("/api/report", report(i), who);
    return fruum.rows("SELECT MAX(id) AS id FROM reports")[0].id as number;
  };

  it("a 👍 earns the voter 1 once per report and the owner 1 per 👍; flips and removal take the owner's back", async () => {
    const id = await sendReport(anna, 30);
    const up = await vote(raffi, id, true);
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ report: { id, up: 1, down: 0, trusted: false, mine: false, vote: 1 }, cred: { points: 1, total: 1, level: 1 } });
    expect(total(anna)).toBe(4);
    expect(likes(anna)).toBe(1);
    expect(log(anna).at(-1)).toEqual({ action: "report_liked", points: 1, ref: `${id}:${raffi.id}`, detail: "ML E 12" });

    const down = await vote(raffi, id, false);
    expect(down.body).toMatchObject({ report: { up: 0, down: 1, vote: -1 }, cred: { points: 0, total: 1 } });
    expect(total(anna)).toBe(3);
    expect(likes(anna)).toBe(0);

    const none = await vote(raffi, id, null);
    expect(none.body.report).toMatchObject({ up: 0, down: 0, vote: 0 });
    expect(db.rows("SELECT * FROM report_votes")).toEqual([]);
    expect(total(anna)).toBe(3);

    // Voting again after removing: the voter earns nothing more, the owner gets the 👍 again.
    expect((await vote(raffi, id, true)).body.cred.points).toBe(0);
    expect(total(raffi)).toBe(1);
    expect(total(anna)).toBe(4);
    expect(likes(anna)).toBe(1);
    // A second voter.
    expect((await vote(ben, id, true)).body.report).toMatchObject({ up: 2, down: 0, vote: 1 });
    expect(likes(anna)).toBe(2);
  });

  it("counts a new vote once (usage counters): not a flip, not a removal", async () => {
    const id = await sendReport(anna, 32);
    await vote(raffi, id, true);
    await vote(raffi, id, false);
    await vote(raffi, id, null);
    expect(db.stats()).toEqual({ "2026-10-29": { report_vote: 1 } });
    await vote(raffi, id, true); // after removing, a vote again
    await vote(ben, id, false);
    expect(db.stats()).toEqual({ "2026-10-29": { report_vote: 3 } });
  });

  it("refuses your own report, old, unknown and rating reports, bad votes, and signed out", async () => {
    const id = await sendReport(anna, 31);
    expect(await vote(anna, id, true)).toMatchObject({ status: 403, body: { detail: "own_report" } });
    expect((await vote(raffi, 9999, true)).status).toBe(404);
    expect((await vote(raffi, id, 1 as unknown as boolean)).status).toBe(400);
    expect((await post("/api/reports/vote", { id: "1", up: true }, raffi)).status).toBe(400);
    expect((await vote(null, id, true)).status).toBe(401);
    fruum.db
      .prepare("INSERT INTO reports (at, kind, place_kind, place, area, value, reporter, estimate) VALUES (?, 'rating', 'space', 'HGH30.1', 'Z', 3, 'x', 50)")
      .run(W_NOW);
    const rating = fruum.rows("SELECT id FROM reports WHERE kind = 'rating'")[0].id as number;
    expect((await vote(raffi, rating, true)).status).toBe(404);
    vi.setSystemTime(W_NOW + 4 * HOUR + MINUTE);
    db.db.prepare("UPDATE sessions SET renewed_at = ?").run(W_NOW + 4 * HOUR);
    expect(await vote(raffi, id, true)).toMatchObject({ status: 404, body: { detail: "no_such_report" } });
    expect(db.rows("SELECT * FROM report_votes")).toEqual([]);
  });

  it("a report sent signed out can be voted on, earning only the voter", async () => {
    const id = await sendReport(null, 33);
    expect((await vote(raffi, id, true)).body).toMatchObject({ report: { up: 1, trusted: false }, cred: { points: 1 } });
    expect(db.rows("SELECT COUNT(*) AS n FROM cred WHERE action = 'report_liked'")[0].n).toBe(0);
  });

  it("at most 20 votes a day earn", async () => {
    const got: number[] = [];
    for (let i = 0; i < 21; i++) got.push((await vote(raffi, await sendReport(null, 40 + i), i % 2 === 0)).body.cred.points);
    expect(got.slice(0, 20).every((p) => p === 1)).toBe(true);
    expect(got[20]).toBe(0);
  });

  it("the log has counts and the trusted mark for everyone, `mine` and `vote` only signed in, and never the reporter", async () => {
    const annas = await sendReport(anna, 34);
    const others = await sendReport(ben, 35);
    await vote(raffi, annas, true);
    await vote(ben, annas, false);
    const out = await get(LOG, null);
    expect(out.res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(out.res.headers.get("Vary")).toBe("Cookie");
    const keys = new Set(out.body.reports.flatMap((r: object) => Object.keys(r)));
    expect([...keys].sort()).toEqual(["at", "down", "id", "kind", "trusted", "up", "value"]);
    expect(out.body.reports.find((r: { id: number }) => r.id === annas)).toMatchObject({ up: 1, down: 1, trusted: false });
    expect(JSON.stringify(out.body)).not.toMatch(/sub-|anna|ben/);

    const mine = await get(LOG, anna);
    expect(mine.res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mine.body.reports.find((r: { id: number }) => r.id === annas)).toMatchObject({ mine: true, vote: 0 });
    expect(mine.body.reports.find((r: { id: number }) => r.id === others)).toMatchObject({ mine: false, vote: 0 });
    const raffis = await get(LOG, raffi);
    expect(raffis.body.reports.find((r: { id: number }) => r.id === annas)).toMatchObject({ mine: false, vote: 1 });
    expect(JSON.stringify(raffis.body)).not.toMatch(/sub-|anna|ben/);
  });

  it("trusted at 20 👍 received, for everyone; back to untrusted at 19 after a flip", async () => {
    const id = await sendReport(anna, 36);
    db.db.prepare("UPDATE users SET likes_received = 19 WHERE id = ?").run(anna.id);
    expect((await get(LOG, null)).body.reports[0].trusted).toBe(false);
    expect((await vote(raffi, id, true)).body.report.trusted).toBe(true);
    expect(likes(anna)).toBe(20);
    expect((await get(LOG, null)).body.reports[0].trusted).toBe(true);
    expect((await get(LOG, ben)).body.reports[0]).toMatchObject({ trusted: true, mine: false });
    // anna's own summary says so too (the Street cred view, phase 4).
    expect((await call(anna, "GET", "/api/cred")).body).toMatchObject({ likes: 20, trusted: true });
    expect((await vote(raffi, id, false)).body.report.trusted).toBe(false);
    expect(likes(anna)).toBe(19);
    expect((await get(LOG, null)).body.reports[0].trusted).toBe(false);
  });

  it("deleting the voter takes their votes along; the owner keeps the 👍 they got", async () => {
    const id = await sendReport(anna, 37);
    await vote(raffi, id, true);
    const res = await worker.fetch(new Request("https://frooms.ch/api/me", { method: "DELETE", headers: { Origin: "https://frooms.ch", Cookie: `${SESSION_COOKIE}=${raffi.token}` } }), wenv, ctx);
    expect(res.status).toBe(204);
    expect(db.rows("SELECT * FROM report_votes")).toEqual([]);
    expect(total(anna)).toBe(4);
    expect(likes(anna)).toBe(1);
    expect(JSON.stringify(db.rows("SELECT * FROM cred"))).not.toContain(raffi.id);
    expect((await get(LOG, null)).body.reports[0]).toMatchObject({ up: 0, down: 0 });
  });

  it("a failing accounts database doesn't fail the report", async () => {
    db.db.exec("DROP TABLE report_owners");
    const r = await post("/api/report", report(4), raffi);
    expect(r.status).toBe(200);
    expect(r.body.stored).toBe("new");
    expect(r.body.cred).toBeUndefined();
  });
});

it("RECENT_MS is 30 days", () => expect(RECENT_MS).toBe(30 * DAY));
