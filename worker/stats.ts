// Usage counters (plans/PLAN_ADMIN_STATS.md, section 5): one row per Zurich day in the accounts database's
// `stats_days` (migrations-accounts/0003_stats.sql), its counts as JSON. A count never carries a user id, a browser id,
// an IP address, a search text or a place: only the metric's name, the day and a number.
//
// The page counts what people use (searches, tabs, menus…) in local storage and sends it in one beacon when it's hidden
// (POST /api/stats). The Worker counts its own events (sign-ins, check-ins…) with bumpStatement(), in the same batch as
// the event's own writes (batchWithBump), so a counted action costs one row write more and no extra round trip.
//
// While the table is missing (frooms.ch until migration 0003 is applied there), counting is skipped: the event's own
// writes still happen, and "no such table" is logged once per isolate.

import { type AuthEnv, answer, authConfig } from "./auth";
import { zurichDate } from "./tz";

export interface StatsEnv extends AuthEnv {
  STATS_LIMITER?: RateLimit; // POST /api/stats: 10 a minute per IP
}

export type MetricGroup = "accounts" | "social" | "contributions" | "use";

export interface Metric {
  key: string;
  label: string;
  group: MetricGroup;
  /** "page": sent by the page's beacon; "worker": counted by the Worker itself (the beacon may not send these). */
  by: "page" | "worker";
}

/** Every counted metric (plan 5.2). The admin page's labels come from here. */
export const METRICS: readonly Metric[] = [
  { key: "load", label: "Page loads", group: "use", by: "page" },
  { key: "load_signed_in", label: "Page loads, signed in", group: "use", by: "page" },
  { key: "tab_study", label: "Opened Study", group: "use", by: "page" },
  { key: "tab_meet", label: "Opened Meet", group: "use", by: "page" },
  { key: "tab_eat", label: "Opened Eat", group: "use", by: "page" },
  { key: "tab_you", label: "Opened You", group: "use", by: "page" },
  { key: "search", label: "Place searches", group: "use", by: "page" },
  { key: "search_pick", label: "Search results opened", group: "use", by: "page" },
  { key: "meal_search", label: "Find your meal opened", group: "use", by: "page" },
  { key: "people_search", label: "People searches", group: "use", by: "page" },
  { key: "place_open", label: "Place pages opened", group: "use", by: "page" },
  { key: "menu_open", label: "Menus opened", group: "use", by: "page" },
  { key: "invite", label: "Invites shared", group: "use", by: "page" },
  { key: "install", label: "Installed as app", group: "use", by: "page" },
  // The tutorial (plans/PLAN_TUTORIAL.md, section 7): opened, and each journey started and finished.
  { key: "tutorial_open", label: "Tutorial opened", group: "use", by: "page" },
  { key: "tutorial_start_friends", label: "Tutorial started: friends", group: "use", by: "page" },
  { key: "tutorial_start_study", label: "Tutorial started: study", group: "use", by: "page" },
  { key: "tutorial_start_meet", label: "Tutorial started: meet", group: "use", by: "page" },
  { key: "tutorial_start_food", label: "Tutorial started: food", group: "use", by: "page" },
  { key: "tutorial_start_map", label: "Tutorial started: map", group: "use", by: "page" },
  { key: "tutorial_done_friends", label: "Tutorial finished: friends", group: "use", by: "page" },
  { key: "tutorial_done_study", label: "Tutorial finished: study", group: "use", by: "page" },
  { key: "tutorial_done_meet", label: "Tutorial finished: meet", group: "use", by: "page" },
  { key: "tutorial_done_food", label: "Tutorial finished: food", group: "use", by: "page" },
  { key: "tutorial_done_map", label: "Tutorial finished: map", group: "use", by: "page" },
  { key: "tutorial_start_cred", label: "Tutorial started: street cred", group: "use", by: "page" },
  { key: "tutorial_done_cred", label: "Tutorial finished: street cred", group: "use", by: "page" },
  { key: "sign_in", label: "Sign-ins", group: "accounts", by: "worker" },
  { key: "account_created", label: "Accounts created", group: "accounts", by: "worker" },
  { key: "account_deleted", label: "Accounts deleted", group: "accounts", by: "worker" },
  { key: "account_expired", label: "Accounts removed after 24 months", group: "accounts", by: "worker" },
  { key: "friend_request", label: "Friend requests sent", group: "social", by: "worker" },
  { key: "checkin", label: "Check-ins", group: "social", by: "worker" },
  { key: "report_vote", label: "Report votes", group: "contributions", by: "worker" },
  { key: "meal_rating", label: "Meal ratings", group: "contributions", by: "worker" },
];

export const PAGE_KEYS: readonly string[] = METRICS.filter((m) => m.by === "page").map((m) => m.key);
export const WORKER_KEYS: readonly string[] = METRICS.filter((m) => m.by === "worker").map((m) => m.key);
const ALL_KEYS = new Set(METRICS.map((m) => m.key));
const PAGE_SET = new Set(PAGE_KEYS);
const WORKER_SET = new Set(WORKER_KEYS);

export const MAX_BEACON_BYTES = 2048;
export const MAX_BEACON_VALUE = 50;

export type Increments = Partial<Record<string, number>>;

/**
 * The statement that adds `increments` to `day`'s row (plan 5.1), or null when there is nothing to add. The SQL is
 * built from METRICS' keys only (anything else throws: a programming error); the numbers are bound.
 */
export function bumpStatement(db: D1Database, day: string, increments: Increments): D1PreparedStatement | null {
  const entries = Object.entries(increments).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0);
  if (!entries.length) return null;
  for (const [key, n] of entries) {
    if (!ALL_KEYS.has(key) || !/^[a-z_]+$/.test(key)) throw new Error(`Unknown metric ${key}`);
    if (!Number.isInteger(n)) throw new Error(`Metric ${key} by ${n}`);
  }
  const sets = entries.map(([key], i) => `'$.${key}', coalesce(json_extract(counts, '$.${key}'), 0) + CAST(?${i + 3} AS INTEGER)`);
  return db
    .prepare(`INSERT INTO stats_days (day, counts) VALUES (?1, ?2) ON CONFLICT (day) DO UPDATE SET counts = json_set(counts, ${sets.join(", ")})`)
    .bind(day, JSON.stringify(Object.fromEntries(entries)), ...entries.map(([, n]) => n));
}

/** A Worker event's bump for the Zurich day of `now` (null when nothing is counted). */
export const bumpFor = (db: D1Database, now: number, increments: Increments) => bumpStatement(db, zurichDate(now), increments);

let missingLogged = false;

/** Whether an error is D1's (or SQLite's) "no such table: stats_days"; logged once per isolate when it is. */
export function statsMissing(e: unknown): boolean {
  const missing = /no such table:?\s*stats_days/i.test(e instanceof Error ? e.message : String(e));
  if (missing && !missingLogged) {
    missingLogged = true;
    console.log("Usage counters skipped: no such table stats_days (apply migrations-accounts/0003_stats.sql)");
  }
  return missing;
}

/**
 * `db.batch(statements)` with the counter's bump added at the end, so the results' indices are the statements' own.
 * D1 runs a batch as one transaction: while `stats_days` is missing the whole batch fails without writing anything, so
 * it is sent again without the bump (only then a second round trip).
 */
export async function batchWithBump(db: D1Database, statements: D1PreparedStatement[], bump: D1PreparedStatement | null): Promise<D1Result[]> {
  if (!bump) return db.batch(statements);
  try {
    return await db.batch([...statements, bump]);
  } catch (e) {
    if (!statsMissing(e)) throw e;
    return statements.length ? db.batch(statements) : [];
  }
}

/** Why a beacon's body is refused (400), or its increments: page keys only, each an integer 1 to 50. */
export function beaconIncrements(text: string): Increments | string {
  if (new TextEncoder().encode(text).byteLength > MAX_BEACON_BYTES) return "too_large";
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "bad_json";
  }
  const c = (body as { c?: unknown } | null)?.c;
  if (!body || typeof body !== "object" || Array.isArray(body) || !c || typeof c !== "object" || Array.isArray(c)) return "bad_body";
  const out: Increments = {};
  for (const [key, n] of Object.entries(c as Record<string, unknown>)) {
    if (WORKER_SET.has(key)) return "not_a_page_metric";
    if (!PAGE_SET.has(key)) continue; // unknown keys (an older or newer page) are dropped
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_BEACON_VALUE) return "bad_count";
    out[key] = n;
  }
  return out;
}

const NO_CONTENT = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

/**
 * POST /api/stats (plan 5.4): the page's counts, `{"c": {"search": 3}}` as text/plain (navigator.sendBeacon). Only on
 * hosts with an accounts database (frooms.ch, the accounts preview); elsewhere 204 and nothing written. No sign-in, and
 * the session cookie isn't read. Over the rate limit: 204, nothing written. Counted on the Worker's Zurich day.
 */
export async function handleStats(request: Request, env: StatsEnv, now = Date.now()): Promise<Response> {
  if (request.method !== "POST") return answer({ detail: "Method not allowed" }, 405, { Allow: "POST" });
  const cfg = authConfig(request, env);
  if (!cfg) return NO_CONTENT();
  // Another site's page may not count here (a beacon carries its Origin; tools without one are let through).
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) return answer({ detail: "bad_origin" }, 403);
  if (env.STATS_LIMITER) {
    const { success } = await env.STATS_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
    if (!success) return NO_CONTENT();
  }
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > MAX_BEACON_BYTES) return answer({ detail: "too_large" }, 400);
  const parsed = beaconIncrements(await request.text());
  if (typeof parsed === "string") return answer({ detail: parsed }, 400);
  const bump = bumpFor(cfg.db, now, parsed);
  if (!bump) return NO_CONTENT();
  try {
    await bump.run();
  } catch (e) {
    if (!statsMissing(e)) console.error(`Counting a beacon failed: ${e instanceof Error ? e.message : e}`);
  }
  return NO_CONTENT();
}
