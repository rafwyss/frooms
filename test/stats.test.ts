// Usage counters (worker/stats.ts, plans/PLAN_ADMIN_STATS.md section 5): the daily upsert, POST /api/stats (the page's
// beacon) and the page's side in static/lib.js. The server-side bumps are tested with their events in auth, social,
// cred and ratings' suites.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../worker/index";
import { METRICS, PAGE_KEYS, WORKER_KEYS, batchWithBump, bumpStatement, handleStats } from "../worker/stats";
import { FakeD1 } from "./helpers";

const lib = new Function(`${readFileSync(join(import.meta.dirname, "..", "static", "lib.js"), "utf8")}; return { STATS_KEYS, STATS_MAX, cleanStats, addStat, statsBody };`)() as {
  STATS_KEYS: string[];
  STATS_MAX: number;
  cleanStats: (raw: unknown) => { c: Record<string, number> };
  addStat: (stored: unknown, key: string) => { c: Record<string, number> };
  statsBody: (stored: unknown) => string | null;
};

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PREVIEW = "accounts-preview-fruum.fruum.workers.dev";
const NOW = Date.UTC(2026, 10, 18, 10, 0); // 11:00 in Zurich

let db: FakeD1;
let dev: FakeD1;
let limited: string[];
let allow: boolean;

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    DB: new FakeD1().asD1(),
    ACCOUNTS: db.asD1(),
    ACCOUNTS_DEV: dev.asD1(),
    EDUID_ISSUER: "https://login.eduid.ch/",
    EDUID_CLIENT_ID: "frooms_ch_frooms",
    EDUID_CLIENT_SECRET: "secret",
    SESSION_KEY: "k".repeat(43),
    PREVIEW_AUTH_HOST: PREVIEW,
    STATS_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        limited.push(key);
        return { success: allow };
      },
    } as RateLimit,
    ...overrides,
  };
}

const beacon = (body: unknown, opts: { host?: string; headers?: Record<string, string>; method?: string; e?: Env } = {}) => {
  const host = opts.host ?? "frooms.ch";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const req = new Request(`https://${host}/api/stats`, {
    method: opts.method ?? "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: `https://${host}`, "cf-connecting-ip": "203.0.113.9", ...opts.headers },
    body: (opts.method ?? "POST") === "POST" ? text : undefined,
  });
  return worker.fetch(req, opts.e ?? env(), ctx);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  db = new FakeD1("migrations-accounts");
  dev = new FakeD1("migrations-accounts");
  limited = [];
  allow = true;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the daily upsert", () => {
  it("writes a new day, adds to an existing one, twice in a row, and a new key on an existing day", async () => {
    const d = db.asD1();
    await bumpStatement(d, "2026-11-18", { search: 3, tab_eat: 1 })!.run();
    expect(db.stats()).toEqual({ "2026-11-18": { search: 3, tab_eat: 1 } });
    await bumpStatement(d, "2026-11-18", { search: 2 })!.run();
    await bumpStatement(d, "2026-11-18", { search: 1, tab_eat: 4 })!.run();
    await bumpStatement(d, "2026-11-18", { menu_open: 7, checkin: 1 })!.run();
    await bumpStatement(d, "2026-11-19", { load: 1 })!.run();
    expect(db.stats()).toEqual({
      "2026-11-18": { search: 6, tab_eat: 5, menu_open: 7, checkin: 1 },
      "2026-11-19": { load: 1 },
    });
    // Whole numbers, not 6.0.
    expect(db.rows("SELECT counts FROM stats_days WHERE day = '2026-11-18'")[0].counts).toBe('{"search":6,"tab_eat":5,"menu_open":7,"checkin":1}');
  });

  it("leaves out zeros (nothing at all: no statement), and refuses keys that aren't metrics", () => {
    const d = db.asD1();
    expect(bumpStatement(d, "2026-11-18", { search: 0, checkin: 0 })).toBeNull();
    expect(bumpStatement(d, "2026-11-18", {})).toBeNull();
    expect(() => bumpStatement(d, "2026-11-18", { "search', 1); DROP TABLE users; --": 1 })).toThrow(/Unknown metric/);
    expect(() => bumpStatement(d, "2026-11-18", { search: 1.5 })).toThrow();
  });

  it("batchWithBump: the batch's own writes happen while the table is missing, logged once", async () => {
    db.db.exec("DROP TABLE stats_days");
    const d = db.asD1();
    const insert = () => d.prepare("INSERT INTO blocks (user_id, blocked_id, at) VALUES (?, ?, ?)").bind("a", `b${Math.random()}`, NOW);
    const results = await batchWithBump(d, [insert()], bumpStatement(d, "2026-11-18", { checkin: 1 }));
    expect(results).toHaveLength(1);
    await batchWithBump(d, [insert()], bumpStatement(d, "2026-11-18", { checkin: 1 }));
    expect(db.rows("SELECT * FROM blocks")).toHaveLength(2);
    // Another error is not swallowed.
    await expect(batchWithBump(d, [d.prepare("INSERT INTO nowhere VALUES (1)")], bumpStatement(d, "2026-11-18", { checkin: 1 }))).rejects.toThrow();
  });
});

describe("POST /api/stats", () => {
  it("counts the page's keys on the Zurich day, answers 204, never cached", async () => {
    const res = await beacon({ c: { search: 3, tab_eat: 1 } });
    expect(res.status).toBe(204);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await beacon({ c: { search: 2, load: 1 } });
    expect(db.stats()).toEqual({ "2026-11-18": { search: 5, tab_eat: 1, load: 1 } });
    expect(limited).toEqual(["203.0.113.9", "203.0.113.9"]);
    expect(dev.stats()).toEqual({});
  });

  it("the preview host counts in fruum-accounts-dev", async () => {
    expect((await beacon({ c: { invite: 2 } }, { host: PREVIEW })).status).toBe(204);
    expect(dev.stats()).toEqual({ "2026-11-18": { invite: 2 } });
    expect(db.stats()).toEqual({});
  });

  it("drops unknown keys; nothing left: nothing written", async () => {
    expect((await beacon({ c: { search: 1, someday: 4 } })).status).toBe(204);
    expect((await beacon({ c: { someday: 4 } })).status).toBe(204);
    expect(db.stats()).toEqual({ "2026-11-18": { search: 1 } });
  });

  it("refuses the Worker's own keys, zero, negative, fractional, over 50, non-numbers and bad bodies with 400", async () => {
    const bad: unknown[] = [
      { c: { sign_in: 1 } },
      { c: { search: 1, account_created: 1 } },
      { c: { search: 0 } },
      { c: { search: -2 } },
      { c: { search: 1.5 } },
      { c: { search: 51 } },
      { c: { search: "3" } },
      { c: { search: null } },
      { c: [1] },
      { c: null },
      {},
      [],
      "not json",
      "null",
    ];
    for (const body of bad) {
      const res = await beacon(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await beacon({ c: { search: 50 } })).status).toBe(204);
    expect(db.stats()).toEqual({ "2026-11-18": { search: 50 } });
  });

  it("refuses a body over 2 KB", async () => {
    const big = JSON.stringify({ c: { search: 1 }, pad: "x".repeat(2100) });
    expect((await beacon(big)).status).toBe(400);
    expect(db.stats()).toEqual({});
  });

  it("hosts without an accounts database: 204 and nothing written", async () => {
    for (const host of ["frooms.test", "fruum.fruum.workers.dev", "abc123-fruum.fruum.workers.dev"]) {
      expect((await beacon({ c: { search: 1 } }, { host })).status).toBe(204);
    }
    // Plain http (wrangler dev on 127.0.0.1) has sign-in off too.
    const local = await handleStats(new Request("http://127.0.0.1:8787/api/stats", { method: "POST", body: '{"c":{"search":1}}' }), env());
    expect(local.status).toBe(204);
    expect(db.stats()).toEqual({});
    expect(dev.stats()).toEqual({});
    expect(limited).toEqual([]);
  });

  it("over the rate limit: 204 and nothing written", async () => {
    allow = false;
    expect((await beacon({ c: { search: 1 } })).status).toBe(204);
    expect(db.stats()).toEqual({});
  });

  it("another site's page can't count; a request without Origin can", async () => {
    expect((await beacon({ c: { search: 1 } }, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    const req = new Request("https://frooms.ch/api/stats", { method: "POST", body: '{"c":{"search":1}}' });
    expect((await worker.fetch(req, env(), ctx)).status).toBe(204);
    expect(db.stats()).toEqual({ "2026-11-18": { search: 1 } });
  });

  it("doesn't read the session cookie and needs no sign-in", async () => {
    const res = await beacon({ c: { search: 1 } }, { headers: { Cookie: "__Host-frooms_session=nonsense" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("only POST", async () => {
    expect((await beacon(null, { method: "GET" })).status).toBe(405);
  });

  it("the table missing: 204, nothing written, no error", async () => {
    db.db.exec("DROP TABLE stats_days");
    expect((await beacon({ c: { search: 1 } })).status).toBe(204);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("the Zurich day at 23:30 and 00:30 around both DST changes", async () => {
    const at = async (ms: number) => {
      vi.setSystemTime(ms);
      await beacon({ c: { load: 1 } });
    };
    // Summer time ends on 25 October 2026 (03:00 CEST → 02:00 CET).
    await at(Date.UTC(2026, 9, 24, 21, 30)); // 23:30 CEST, 24 Oct
    await at(Date.UTC(2026, 9, 24, 22, 30)); // 00:30 CEST, 25 Oct
    await at(Date.UTC(2026, 9, 25, 22, 30)); // 23:30 CET, 25 Oct
    await at(Date.UTC(2026, 9, 25, 23, 30)); // 00:30 CET, 26 Oct
    // Summer time begins on 29 March 2026 (02:00 CET → 03:00 CEST).
    await at(Date.UTC(2026, 2, 28, 22, 30)); // 23:30 CET, 28 Mar
    await at(Date.UTC(2026, 2, 28, 23, 30)); // 00:30 CET, 29 Mar
    await at(Date.UTC(2026, 2, 29, 21, 30)); // 23:30 CEST, 29 Mar
    await at(Date.UTC(2026, 2, 29, 22, 30)); // 00:30 CEST, 30 Mar
    expect(db.stats()).toEqual({
      "2026-03-28": { load: 1 },
      "2026-03-29": { load: 2 },
      "2026-03-30": { load: 1 },
      "2026-10-24": { load: 1 },
      "2026-10-25": { load: 2 },
      "2026-10-26": { load: 1 },
    });
  });
});

describe("the page's side (lib.js)", () => {
  it("counts the same keys as the Worker's page metrics", () => {
    expect([...lib.STATS_KEYS].sort()).toEqual([...PAGE_KEYS].sort());
    expect(lib.STATS_MAX).toBe(50);
    expect(METRICS.map((m) => m.key).sort()).toEqual([...PAGE_KEYS, ...WORKER_KEYS].sort());
  });

  it("adds one, caps at 50, ignores unknown keys, and never changes what it was given", () => {
    const start = { c: { search: 2 } };
    expect(lib.addStat(start, "search")).toEqual({ c: { search: 3 } });
    expect(start).toEqual({ c: { search: 2 } });
    expect(lib.addStat(start, "tab_eat")).toEqual({ c: { search: 2, tab_eat: 1 } });
    expect(lib.addStat(start, "sign_in")).toEqual({ c: { search: 2 } });
    expect(lib.addStat({ c: { search: 50 } }, "search")).toEqual({ c: { search: 50 } });
    expect(lib.addStat(null, "load")).toEqual({ c: { load: 1 } });
  });

  it("cleans what storage gave back, and the beacon's body is null when there's nothing", () => {
    expect(lib.cleanStats({ c: { search: 70, load: 0, tab_you: -1, invite: 1.5, menu_open: "2", other: 3, sign_in: 2 } })).toEqual({ c: { search: 50 } });
    expect(lib.cleanStats("junk")).toEqual({ c: {} });
    expect(lib.statsBody({ c: {} })).toBeNull();
    expect(lib.statsBody(null)).toBeNull();
    expect(JSON.parse(lib.statsBody({ c: { search: 2, other: 1 } })!)).toEqual({ c: { search: 2 } });
  });

  it("whatever the page sends after cleaning, the Worker takes", async () => {
    let stored: unknown = null;
    for (const key of [...lib.STATS_KEYS, ...lib.STATS_KEYS, "search"]) stored = lib.addStat(stored, key);
    expect((await beacon(lib.statsBody(stored))).status).toBe(204);
    expect(db.stats()["2026-11-18"].search).toBe(3);
  });
});
