// The admin page's numbers (worker/admin.ts, plans/PLAN_ADMIN_STATS.md section 7): who may read them, the periods by
// Zurich day (a DST day too), the sources, and the counters while their table is missing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AdminEnv,
  adminIds,
  bucketSql,
  counterFigures,
  dayStart,
  GRAPHQL_URL,
  handleAdmin,
  readStats,
  readVisits,
  type StatsAnswer,
  utcDays,
  VISITS_TTL_S,
  windowAt,
} from "../worker/admin";
import { SESSION_COOKIE, b64url, sha256Hex } from "../worker/auth";
import worker, { type Env } from "../worker/index";
import { bumpStatement } from "../worker/stats";
import { zurichToUtc } from "../worker/tz";
import { FakeD1 } from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 18, 10, 0); // Wed 18 Nov 2026, 11:00 in Zurich
const PREVIEW = "accounts-preview-fruum.fruum.workers.dev";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

let accounts: FakeD1;
let main: FakeD1;
let limited: string[];

async function person(id: string, opts: { username?: string | null; created?: number; seen?: number; uni?: string; board?: number; cred?: number } = {}) {
  accounts.db
    .prepare(
      `INSERT INTO users (id, username, first_name, last_name, name_key, bg, fg, email_hash, uni, created_at, last_seen_at, board, cred_total)
       VALUES (?, ?, 'A', 'B', 'a b', '#000000', '#ffffff', NULL, ?, ?, ?, ?, ?)`,
    )
    .run(id, opts.username === undefined ? id : opts.username, opts.uni ?? "eth", opts.created ?? NOW - 40 * DAY, opts.seen ?? NOW - 40 * DAY, opts.board ?? 0, opts.cred ?? 0);
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  accounts.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run(await sha256Hex(token), id, NOW, NOW, NOW + 30 * DAY);
  return token;
}

function env(overrides: Partial<AdminEnv> = {}): AdminEnv & Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    DB: main.asD1(),
    ACCOUNTS: accounts.asD1(),
    ACCOUNTS_DEV: accounts.asD1(),
    EDUID_ISSUER: "https://login.eduid.ch/",
    EDUID_CLIENT_ID: "frooms_ch_frooms",
    EDUID_CLIENT_SECRET: "secret",
    SESSION_KEY: "k".repeat(43),
    PREVIEW_AUTH_HOST: PREVIEW,
    ADMIN_IDS: " sub-admin , sub-other",
    ACCOUNT_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        limited.push(key);
        return { success: true };
      },
    } as RateLimit,
    ...overrides,
  } as AdminEnv & Env;
}

const get = (token: string | null, opts: { host?: string; e?: AdminEnv; method?: string; now?: number } = {}) => {
  const req = new Request(`https://${opts.host ?? "frooms.ch"}/api/admin/stats`, {
    method: opts.method ?? "GET",
    headers: token ? { Cookie: `${SESSION_COOKIE}=${token}` } : {},
  });
  return handleAdmin(req, opts.e ?? env(), opts.now ?? NOW);
};

const metric = (a: StatsAnswer, group: string, key: string) => {
  const m = a.groups.find((g) => g.key === group)?.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`no metric ${group}.${key}`);
  return m;
};

let admin: string;
let plain: string;

beforeEach(async () => {
  accounts = new FakeD1("migrations-accounts");
  main = new FakeD1();
  limited = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  admin = await person("sub-admin");
  plain = await person("sub-plain");
});

afterEach(() => vi.restoreAllMocks());

describe("who may read it", () => {
  it("gives 404 to everyone but the admins, with the body of an unknown /api path", async () => {
    const unknown = await worker.fetch(new Request("https://frooms.ch/api/nothing-here"), env(), ctx);
    const unknownBody = await unknown.json();
    for (const res of [
      await get(null), // signed out
      await get(plain), // signed in, not an admin
      await get(admin, { e: env({ ADMIN_IDS: "" }) }), // nobody is
      await get(admin, { e: env({ ADMIN_IDS: undefined }) }),
      await get(admin, { host: "fruum.fruum.workers.dev" }), // a host without sign-in
      await get(admin, { method: "POST" }),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(unknownBody);
    }
    expect(limited).toEqual([]); // only the admin's calls count against the limit
  });

  it("gives 404 before the profile step is done", async () => {
    const token = await person("sub-new", { username: null });
    expect((await get(token, { e: env({ ADMIN_IDS: "sub-new" }) })).status).toBe(404);
  });

  it("answers an admin with every group, never cached, and counts the call", async () => {
    const res = await get(admin);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const a = (await res.json()) as StatsAnswer;
    expect(a.groups.map((g) => g.key)).toEqual(["accounts", "social", "contributions", "use"]);
    expect(a.day).toBe("2026-11-18");
    expect(a.host_db).toBe("fruum-accounts");
    expect(a.counters).toBe("ok");
    expect(a.visits).toBeNull();
    expect(a.visits_reason).toBe("no_token");
    expect(limited).toEqual(["sub-admin"]);
    for (const g of a.groups) for (const m of g.metrics) expect(m.label && m.source).toBeTruthy();
  });

  it("goes through the router, and the preview reads its own accounts database and labels fruum as production", async () => {
    const dev = new FakeD1("migrations-accounts");
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    dev.db.prepare("INSERT INTO users (id, username, first_name, last_name, name_key, uni, created_at, last_seen_at) VALUES ('sub-admin', 'x', 'A', 'B', 'a b', 'uzh', ?, ?)").run(NOW, NOW);
    dev.db.prepare("INSERT INTO sessions VALUES (?, 'sub-admin', ?, ?, ?)").run(await sha256Hex(token), NOW, NOW, NOW + 30 * DAY);
    const req = new Request(`https://${PREVIEW}/api/admin/stats`, { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });
    const res = await worker.fetch(req, env({ ACCOUNTS_DEV: dev.asD1() }), ctx);
    expect(res.status).toBe(200);
    const a = (await res.json()) as StatsAnswer;
    expect(a.host_db).toBe("fruum-accounts-dev");
    expect(metric(a, "accounts", "accounts").total).toBe(1); // dev's one account, not production's two
    expect(metric(a, "contributions", "reports").source).toContain("production");
    expect(metric(a, "contributions", "feedback").note).toContain("production");
  });

  it("splits ADMIN_IDS on commas and trims", () => {
    expect([...adminIds(" a, b ,,c ")]).toEqual(["a", "b", "c"]);
    expect(adminIds("").size).toBe(0);
    expect(adminIds(undefined).size).toBe(0);
  });
});

describe("periods", () => {
  it("are Zurich days: a DST day is 25 hours, and 23:30 and 00:30 local fall on their own days", async () => {
    // Summer time ends on Sunday 25 October 2026 at 03:00 local.
    const now = zurichToUtc(2026, 10, 26, 12);
    const w = windowAt(now);
    expect(w.days.length).toBe(30);
    expect(w.days[0]).toBe("2026-09-27");
    expect(w.days[29]).toBe("2026-10-26");
    expect(dayStart("2026-10-26") - dayStart("2026-10-25")).toBe(25 * HOUR);
    expect(dayStart("2026-03-30") - dayStart("2026-03-29")).toBe(23 * HOUR);

    const at = (d: number, h: number, m: number) => zurichToUtc(2026, 10, d, h, m);
    for (const t of [at(25, 23, 30), at(26, 0, 30), at(24, 23, 30), at(25, 0, 30), zurichToUtc(2026, 9, 26, 23, 30)]) {
      main.db.prepare("INSERT INTO feedback (at, category, message) VALUES (?, 'idea', 'x')").run(t);
    }
    const a = await readStats(accounts.asD1(), main.asD1(), now, true);
    const f = metric(a, "contributions", "feedback");
    expect(f.today).toBe(1); // 26 Oct 00:30
    expect(f.series!.slice(-3)).toEqual([1, 2, 1]); // 24th 23:30; 25th 00:30 and 23:30; 26th 00:30
    expect(f.d7).toBe(4);
    expect(f.d30).toBe(4);
    expect(f.total).toBe(5); // 26 Sept is the day before the window
  });

  it("lists the newest feedback in full, newest first, at most 100", async () => {
    const add = main.db.prepare("INSERT INTO feedback (at, category, message, email, context) VALUES (?, ?, ?, ?, ?)");
    for (let i = 0; i < 105; i++) add.run(NOW - (i + 1) * HOUR, "idea", `old ${i}`, null, null);
    add.run(NOW - 60_000, "broken", "Line one\nline two", "a@student.ethz.ch", JSON.stringify({ tab: "study", buildings: ["HG"] }));
    add.run(NOW - 30_000, "other", "bad context", null, "not json");
    const { feedback } = await readStats(accounts.asD1(), main.asD1(), NOW, true);
    expect(feedback.length).toBe(100);
    expect(feedback[0]).toMatchObject({ category: "other", message: "bad context", email: null, context: null });
    expect(feedback[1]).toMatchObject({ category: "broken", message: "Line one\nline two", email: "a@student.ethz.ch", context: { tab: "study", buildings: ["HG"] } });
    expect(feedback[2].message).toBe("old 0");
    expect(feedback.map((f) => f.at)).toEqual([...feedback.map((f) => f.at)].sort((x, y) => y - x));
  });

  it("splits today, 7 and 30 days at Zurich midnight", async () => {
    const midnight = dayStart("2026-11-18");
    const checkin = (t: number) =>
      accounts.db.prepare("INSERT INTO checkins (user_id, kind, place, area, building, name, started_at, until, ended_at, source) VALUES ('sub-plain', 'room', 'HG E 1', 'zentrum', 'HG', 'HG E 1', ?, ?, ?, 'place')").run(t, t + HOUR, t + HOUR);
    for (const t of [midnight, midnight - 1, dayStart("2026-11-12"), dayStart("2026-11-12") - 1, dayStart("2026-10-20"), dayStart("2026-10-20") - 1]) checkin(t);
    const c = metric(await readStats(accounts.asD1(), main.asD1(), NOW, true), "social", "checkins");
    expect([c.today, c.d7, c.d30, c.total]).toEqual([1, 3, 5, 6]);
  });

  it("gives every series 30 numbers, oldest first, today last", async () => {
    main.db.prepare("INSERT INTO reports (at, kind, place_kind, place, area, value, reporter) VALUES (?, 'level', 'room', 'HG E 1', 'zentrum', 0, 'r1')").run(dayStart("2026-10-20") + HOUR);
    main.db.prepare("INSERT INTO reports (at, kind, place_kind, place, area, value, reporter) VALUES (?, 'level', 'room', 'HG E 1', 'zentrum', 0, 'r1')").run(NOW - HOUR);
    main.db.prepare("INSERT INTO reports (at, kind, place_kind, place, area, value, reporter) VALUES (?, 'level', 'room', 'HG E 1', 'zentrum', 0, 'r2')").run(NOW - HOUR);
    const a = await readStats(accounts.asD1(), main.asD1(), NOW, true);
    const r = metric(a, "contributions", "reports");
    expect(r.series!.length).toBe(30);
    expect(r.series![0]).toBe(1); // 20 Oct is the window's first day
    expect(r.series![29]).toBe(2);
    expect(r.series!.reduce((x, y) => x + y)).toBe(3);
    const browsers = metric(a, "contributions", "reporters");
    expect([browsers.total, browsers.d30, browsers.d7, browsers.today]).toEqual([null, 2, 2, 2]);
    expect(r.total).toBe(3); // from the id counter
    expect(browsers.series![0]).toBe(1);
    for (const g of a.groups) for (const m of g.metrics) if (m.series) expect(m.series.length).toBe(30);
  });

  it("writes only numbers into the bucket SQL", () => {
    expect(() => bucketSql("at; DROP TABLE users", windowAt(NOW))).toThrow();
    expect(bucketSql("at", windowAt(NOW))).toMatch(/^CASE WHEN at >= \d+ THEN 29 .* ELSE -1 END$/);
  });
});

describe("sources", () => {
  it("counts accounts, the active ones, universities, profiles and the leaderboards from users", async () => {
    await person("sub-today", { created: NOW - HOUR, seen: NOW - HOUR, uni: "uzh", board: 1, cred: 40 });
    await person("sub-week", { created: NOW - 3 * DAY, seen: NOW - 3 * DAY, username: null, cred: 2 });
    const a = await readStats(accounts.asD1(), main.asD1(), NOW, true);
    const acc = metric(a, "accounts", "accounts");
    expect([acc.total, acc.d30, acc.d7, acc.today]).toEqual([4, 2, 2, 1]);
    const active = metric(a, "accounts", "active");
    expect([active.total, active.d30, active.d7, active.today]).toEqual([null, 2, 2, 1]);
    expect(active.series).toBeUndefined();
    expect(metric(a, "accounts", "by_uni").parts!.map((p) => p.total)).toEqual([3, 1]);
    expect(metric(a, "accounts", "no_profile").total).toBe(1);
    expect(metric(a, "accounts", "board").total).toBe(1);
    expect(metric(a, "contributions", "cred").total).toBe(42);
  });

  it("halves the friendships (two rows each)", async () => {
    const add = (x: string, y: string, t: number) => accounts.db.prepare("INSERT INTO friends VALUES (?, ?, ?)").run(x, y, t);
    add("sub-admin", "sub-plain", NOW - HOUR);
    add("sub-plain", "sub-admin", NOW - HOUR);
    add("sub-a", "sub-b", NOW - 50 * DAY);
    add("sub-b", "sub-a", NOW - 50 * DAY);
    const f = metric(await readStats(accounts.asD1(), main.asD1(), NOW, true), "social", "friendships");
    expect([f.total, f.d30, f.today]).toEqual([2, 1, 1]);
  });

  it("counts starred places, Street cred and the meal ratings kept now", async () => {
    accounts.db.prepare("INSERT INTO stars VALUES ('sub-admin', ?, ?)").run(JSON.stringify([{ k: 1 }, { k: 2 }]), NOW);
    accounts.db.prepare("INSERT INTO stars VALUES ('sub-plain', '[]', ?)").run(NOW);
    accounts.db.prepare("INSERT INTO cred (user_id, at, action, points, ref) VALUES ('sub-admin', ?, 'checkin', 5, 'a'), ('sub-admin', ?, 'checkin', 5, 'b')").run(NOW - HOUR, NOW - 10 * DAY);
    accounts.db.prepare("INSERT INTO meal_ratings (dish, date, place, user_id, taste, at) VALUES ('d', '2026-11-18', 'p', 'sub-admin', 1, ?)").run(NOW - HOUR);
    const a = await readStats(accounts.asD1(), main.asD1(), NOW, true);
    const stars = metric(a, "social", "stars");
    expect(stars.total).toBe(1);
    expect(stars.parts![0].total).toBe(2);
    const cred = metric(a, "contributions", "cred");
    expect([cred.d30, cred.d7, cred.today]).toEqual([10, 5, 5]);
    expect(metric(a, "contributions", "meal_rating").parts![0]).toMatchObject({ key: "meal_ratings_kept", total: 1, today: 1 });
  });

  it("adds up the counters by day, with the first day as `since`", async () => {
    const d = accounts.asD1();
    await bumpStatement(d, "2026-09-01", { sign_in: 4, search: 1 })!.run();
    await bumpStatement(d, "2026-11-13", { sign_in: 2, account_deleted: 1 })!.run();
    await bumpStatement(d, "2026-11-18", { sign_in: 1, account_expired: 3, tab_eat: 5 })!.run();
    const a = await readStats(d, main.asD1(), NOW, true);
    const s = metric(a, "accounts", "sign_in");
    expect([s.total, s.d30, s.d7, s.today, s.since]).toEqual([7, 3, 3, 1, "2026-09-01"]);
    expect(s.series!.slice(-6)).toEqual([2, 0, 0, 0, 0, 1]);
    const del = metric(a, "accounts", "account_deleted");
    expect([del.total, del.today]).toEqual([4, 3]);
    expect(del.parts!.map((p) => [p.key, p.total])).toEqual([["account_deleted", 1], ["account_expired", 3]]);
    expect(metric(a, "use", "tab_eat").today).toBe(5);
    expect(metric(a, "use", "search").total).toBe(1);
    expect(a.groups.find((g) => g.key === "use")!.metrics.length).toBe(27); // with the street cred journey's two
  });

  it("an empty counters table has zeros and no `since`", () => {
    expect(counterFigures(new Map(), ["sign_in"], windowAt(NOW))).toMatchObject({ total: 0, today: 0, since: null });
  });

  it("while the counters' table is missing: counters \"missing\", their numbers empty, the tables' metrics still there", async () => {
    accounts.db.exec("DROP TABLE stats_days");
    await person("sub-today", { created: NOW - HOUR });
    const res = await get(admin);
    expect(res.status).toBe(200);
    const a = (await res.json()) as StatsAnswer;
    expect(a.counters).toBe("missing");
    const s = metric(a, "accounts", "sign_in");
    expect([s.total, s.d30, s.today, s.since]).toEqual([null, null, null, null]);
    expect(s.note).toMatch(/Not set up/);
    expect(metric(a, "accounts", "accounts").today).toBe(1);
  });
});

describe("visits from Cloudflare", () => {
  const withToken = (o: Partial<AdminEnv> = {}) =>
    env({ CF_ANALYTICS_TOKEN: "tok", CF_ACCOUNT_ID: "acct", CF_SITE_TAG: "site", ...o });

  /** An answer in the shape Cloudflare's GraphQL API gives (data.viewer.accounts[0].rumPageloadEventsAdaptiveGroups). */
  const answerOf = (rows: { date: string; visits: number; count: number }[]) => ({
    data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: rows.map((r) => ({ count: r.count, sum: { visits: r.visits }, dimensions: { date: r.date } })) }] } },
    errors: null,
  });

  let calls: { url: string; init: RequestInit }[];
  const stub = (body: unknown, status = 200) =>
    (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

  /** The Cache API's match and put over a Map, enough for readVisits. */
  function memoryCache() {
    const store = new Map<string, string>();
    return {
      store,
      cache: {
        match: async (req: Request) => (store.has(req.url) ? new Response(store.get(req.url)) : undefined),
        put: async (req: Request, res: Response) => void store.set(req.url, await res.text()),
      } as unknown as Cache,
    };
  }

  beforeEach(() => {
    calls = [];
  });

  it("parses Cloudflare's answer into UTC days, with no total", async () => {
    const days = utcDays(NOW);
    expect(days[29]).toBe("2026-11-18");
    const body = answerOf([
      { date: days[0], visits: 5, count: 9 },
      { date: days[25], visits: 3, count: 4 },
      { date: days[29], visits: 7, count: 20 },
      { date: "2026-10-01", visits: 100, count: 100 }, // outside the window: ignored
    ]);
    const { group, reason } = await readVisits(withToken(), NOW, { fetch: stub(body), cache: null });
    expect(reason).toBeUndefined();
    expect(group!.label).toBe("Visits (UTC days)");
    expect(group!.day).toBe("2026-11-18");
    const [visits, views] = group!.metrics;
    expect([visits.total, visits.d30, visits.d7, visits.today]).toEqual([null, 15, 10, 7]);
    expect([views.total, views.d30, views.d7, views.today]).toEqual([null, 33, 24, 20]);
    expect(visits.series!.length).toBe(30);
    expect(visits.series![0]).toBe(5);

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(GRAPHQL_URL);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.query).toContain("rumPageloadEventsAdaptiveGroups");
    expect(sent.variables.accountTag).toBe("acct");
    expect(sent.variables.filter.AND).toContainEqual({ siteTag: "site" });
    expect(sent.variables.filter.AND[0].datetime_geq).toBe("2026-10-20T00:00:00Z");
  });

  it("uses the UTC day, not Zurich's, just after Zurich midnight", async () => {
    const now = Date.UTC(2026, 10, 18, 23, 30); // 00:30 on the 19th in Zurich
    const { group } = await readVisits(withToken(), now, { fetch: stub(answerOf([{ date: "2026-11-18", visits: 2, count: 2 }])), cache: null });
    expect(group!.day).toBe("2026-11-18");
    expect(group!.metrics[0].today).toBe(2);
  });

  it("without a token asks nothing and says why", async () => {
    for (const e of [env(), withToken({ CF_ANALYTICS_TOKEN: " " })]) {
      expect(await readVisits(e, NOW, { fetch: stub({}), cache: null })).toEqual({ group: null, reason: "no_token" });
    }
    expect(await readVisits(withToken({ CF_SITE_TAG: "" }), NOW, { fetch: stub({}), cache: null })).toEqual({ group: null, reason: "no_site" });
    expect(calls).toEqual([]);
  });

  it("an error, a GraphQL error or a timeout: null with a reason, and the rest of the page still answers", async () => {
    expect((await readVisits(withToken(), NOW, { fetch: stub({ errors: [{ message: "not authorized" }] }, 200), cache: null })).reason).toBe("error");
    expect((await readVisits(withToken(), NOW, { fetch: stub({}, 403), cache: null })).reason).toBe("error");
    const broken = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect((await readVisits(withToken(), NOW, { fetch: broken, cache: null })).reason).toBe("error");
    const slow = ((_: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    expect((await readVisits(withToken(), NOW, { fetch: slow, cache: null, timeoutMs: 10 })).reason).toBe("timeout");

    const res = await handleAdmin(new Request("https://frooms.ch/api/admin/stats", { headers: { Cookie: `${SESSION_COOKIE}=${admin}` } }), withToken(), NOW, {
      fetch: stub({}, 500),
      cache: null,
    });
    expect(res.status).toBe(200);
    const a = (await res.json()) as StatsAnswer;
    expect(a.visits).toBeNull();
    expect(a.visits_reason).toBe("error");
    expect(a.groups.length).toBe(4);
  });

  it("caches a good answer for 10 minutes under a key without anything about who asked; failures aren't cached", async () => {
    const { cache, store } = memoryCache();
    const good = stub(answerOf([{ date: "2026-11-18", visits: 4, count: 6 }]));
    await readVisits(withToken(), NOW, { fetch: good, cache });
    expect(calls.length).toBe(1);
    expect([...store.keys()]).toEqual(["https://cache.frooms.internal/admin/visits/site"]);

    const again = await readVisits(withToken(), NOW + 5 * 60_000, { fetch: good, cache });
    expect(calls.length).toBe(1); // from the cache
    expect(again.group!.metrics[0].today).toBe(4);

    await readVisits(withToken(), NOW + VISITS_TTL_S * 1000 + 1, { fetch: good, cache });
    expect(calls.length).toBe(2); // older than 10 minutes: asked again

    const other = memoryCache();
    await readVisits(withToken(), NOW, { fetch: stub({}, 500), cache: other.cache });
    expect(other.store.size).toBe(0);
  });

  it("an admin's answer carries the visits group", async () => {
    const res = await handleAdmin(new Request("https://frooms.ch/api/admin/stats", { headers: { Cookie: `${SESSION_COOKIE}=${admin}` } }), withToken(), NOW, {
      fetch: stub(answerOf([{ date: "2026-11-18", visits: 1, count: 1 }])),
      cache: null,
    });
    const a = (await res.json()) as StatsAnswer;
    expect(a.visits!.key).toBe("visits");
    expect(a.visits_reason).toBeUndefined();
  });
});
