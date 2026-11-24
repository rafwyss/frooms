// The admin page's numbers (plans/PLAN_ADMIN_STATS.md, section 7): GET /api/admin/stats, for the accounts whose edu-ID
// id is in the secret ADMIN_IDS only. Everyone else, signed in or not, gets the same 404 as an unknown /api path, so the
// endpoint isn't advertised.
//
// Each metric has a total, the last 30 days, the last 7 days and today (Zurich calendar days, from worker/tz.ts, so a
// DST day is 23 or 25 hours long) and, where it makes sense, a 30-day daily series, oldest first. The numbers come from
// the tables themselves where their history is complete (accounts, friendships, check-ins, reports, feedback…) and from
// the usage counters (`stats_days`, worker/stats.ts) where it isn't (sign-ins, deleted accounts, votes, page use).
//
// Reads per page view (plans/ADMIN_STATS_DECISIONS.md, "rows read"): the accounts' small tables are scanned whole, the
// two that grow fastest (reports, the cred log) only back 30 days through their `at` index; the reports' total comes
// from their AUTOINCREMENT counter. One batch per database, and the counters on their own (they may be missing).
//
// The answer also carries the newest 100 feedback messages in full (fruum's `feedback`), so they can be read on the page;
// the email per feedback (worker/feedback.ts) is unchanged.
//
// Visits (section 8.1) come from Cloudflare Web Analytics through Cloudflare's GraphQL API, with the read-only token in
// the secret CF_ANALYTICS_TOKEN, by UTC day (Cloudflare's days), cached 10 minutes. Without the token, or when Cloudflare
// fails or is slow, `visits` is null with a reason and the page links to the Web Analytics dashboard.

import { type AuthConfig, AuthError, answer, authConfig, PRODUCTION_HOST, requireUser, sameOrigin } from "./auth";
import { type AdminBug, adminBugs, decideBug } from "./bugs";
import { type SocialEnv } from "./social";
import { METRICS, statsMissing } from "./stats";
import { addDays, type IsoDate, zurichDate, zurichToUtc } from "./tz";

export interface AdminEnv extends SocialEnv {
  DB: D1Database;
  /** Comma-separated edu-ID ids (users.id) that may read the admin page. Empty or unset: nobody. */
  ADMIN_IDS?: string;
  /** Read-only API token (Account Analytics: Read) for the visits; unset: the page links to the dashboard instead. */
  CF_ANALYTICS_TOKEN?: string;
  /** The Cloudflare account (a var; not a secret). */
  CF_ACCOUNT_ID?: string;
  /** The Web Analytics site (a var): the token in static/index.html's beacon (plans/ADMIN_STATS_DECISIONS.md). */
  CF_SITE_TAG?: string;
}

export const DAYS = 30;
const WEEK = 7;

/** A metric's numbers: null where a period has no value (the page shows "–"). */
export interface Figures {
  total: number | null;
  d30: number | null;
  d7: number | null;
  today: number | null;
  /** 30 numbers, one per Zurich day, oldest first (the last is today). */
  series?: number[];
}

export interface Part extends Figures {
  key: string;
  label: string;
  note?: string;
}

export interface MetricOut extends Figures {
  key: string;
  label: string;
  /** Where the numbers come from, shown on the page as a small note. */
  source: string;
  note?: string;
  /** Counters only: the first day in `stats_days` (counting began then), or null while it is empty or missing. */
  since?: string | null;
  /** Numbers that belong to this metric: each university, each way an account goes, ratings kept now. */
  parts?: Part[];
}

export interface Group {
  key: string;
  label: string;
  metrics: MetricOut[];
  /** Visits only: the last day of the series (a UTC day, Cloudflare's), where it differs from the answer's `day`. */
  day?: IsoDate;
}

export interface StatsAnswer {
  day: IsoDate;
  host_db: "fruum-accounts" | "fruum-accounts-dev";
  generated_at: number;
  groups: Group[];
  /** Visits from Cloudflare Web Analytics (phase 2): a group of its own, by UTC day; null without a token. */
  visits: Group | null;
  /** Why `visits` is null: no_token (CF_ANALYTICS_TOKEN unset), no_site (a var unset), timeout or error. */
  visits_reason?: VisitsReason;
  counters: "ok" | "missing";
  /** The newest feedback (fruum's `feedback`, newest first, at most FEEDBACK_LIST): the email notifications keep going too. */
  feedback: FeedbackItem[];
  /** Bug reports (worker/bugs.ts): every pending one, oldest first, then those decided in the last 30 days. */
  bugs: BugItem[];
}

/** A bug report with its message and context from fruum's `feedback` (null fields when that row is gone). */
export interface BugItem extends AdminBug {
  message: string | null;
  context: Record<string, unknown> | null;
}

/** The bug reports with their feedback rows (one query on fruum, the ids as one JSON parameter). */
async function bugItems(db: D1Database, main: D1Database, now: number): Promise<BugItem[]> {
  const bugs = await adminBugs(db, now);
  if (!bugs.length) return [];
  const { results } = await main
    .prepare("SELECT id, at, category, message, email, context FROM feedback WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(bugs.map((b) => b.id)))
    .all<Record<string, unknown>>();
  const rows = new Map(results.map((r) => [num(r.id), feedbackItem(r)]));
  return bugs.map((b) => ({ ...b, message: rows.get(b.id)?.message ?? null, context: rows.get(b.id)?.context ?? null }));
}

export const FEEDBACK_LIST = 100;

export interface FeedbackItem {
  id: number;
  at: number;
  category: string;
  message: string;
  email: string | null;
  /** What the sender had open (worker/feedback.ts), or null when none was sent or it isn't JSON. */
  context: Record<string, unknown> | null;
}

function feedbackItem(r: Record<string, unknown>): FeedbackItem {
  let context: Record<string, unknown> | null = null;
  if (typeof r.context === "string") {
    try {
      const parsed = JSON.parse(r.context);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) context = parsed as Record<string, unknown>;
    } catch {
      // not JSON: shown without context
    }
  }
  return {
    id: num(r.id),
    at: num(r.at),
    category: String(r.category ?? ""),
    message: String(r.message ?? ""),
    email: typeof r.email === "string" && r.email ? r.email : null,
    context,
  };
}

/** The ids in ADMIN_IDS: split on commas, trimmed, empty ones dropped. */
export const adminIds = (value: string | undefined) => new Set((value ?? "").split(",").map((s) => s.trim()).filter(Boolean));

// --- Periods --------------------------------------------------------------------------------------------------------

/** The Zurich day `day` starts at this instant (ms). */
export function dayStart(day: IsoDate): number {
  const [y, m, d] = day.split("-").map(Number);
  return zurichToUtc(y, m, d);
}

export interface Window {
  today: IsoDate;
  /** The 30 days, oldest first; the last is today. */
  days: IsoDate[];
  /** When each of them starts (ms), the same order. */
  starts: number[];
}

export function windowAt(now: number): Window {
  const today = zurichDate(now);
  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i - (DAYS - 1)));
  return { today, days, starts: days.map(dayStart) };
}

/**
 * SQL for the day bucket of `col`: 0 (29 days ago) to 29 (today), -1 for anything older. The boundaries are integers
 * computed here (never input), so they are written into the SQL rather than bound (D1 allows 100 bound values).
 */
export function bucketSql(col: string, w: Window): string {
  if (!/^[a-z_]+$/.test(col) || !w.starts.every(Number.isSafeInteger)) throw new Error("bad bucket");
  const whens = w.starts.map((s, i) => [s, i] as const).reverse().map(([s, i]) => `WHEN ${col} >= ${s} THEN ${i}`);
  return `CASE ${whens.join(" ")} ELSE -1 END`;
}

/** Per bucket (-1 to 29) a number, as the bucketed queries answer. */
type Buckets = Map<number, number>;

const bucketsOf = (rows: Record<string, unknown>[], col = "n"): Buckets =>
  new Map(rows.map((r) => [Number(r.b), Number(r[col] ?? 0)]));

/** Total, 30 days, 7 days, today and the series from per-day buckets (bucket -1: older than 30 days, total only). */
export function figuresOf(b: Buckets, opts: { total?: boolean; series?: boolean } = {}): Figures {
  const at = (i: number) => b.get(i) ?? 0;
  const series = Array.from({ length: DAYS }, (_, i) => at(i));
  const sum = (from: number) => series.slice(from).reduce((a, n) => a + n, 0);
  return {
    total: opts.total === false ? null : sum(0) + at(-1),
    d30: sum(0),
    d7: sum(DAYS - WEEK),
    today: at(DAYS - 1),
    ...(opts.series === false ? {} : { series }),
  };
}

const totalOnly = (n: number | null): Figures => ({ total: n, d30: null, d7: null, today: null });

// --- Reading ------------------------------------------------------------------------------------------------------

interface Rows {
  results?: Record<string, unknown>[];
}

const rowsOf = (r: Rows | undefined) => r?.results ?? [];
const num = (v: unknown) => (typeof v === "number" ? v : v == null ? 0 : Number(v));

/** The usage counters: per day its counts, or "missing" while `stats_days` doesn't exist. */
async function readCounters(db: D1Database): Promise<Map<IsoDate, Record<string, number>> | "missing"> {
  try {
    const { results } = await db.prepare("SELECT day, counts FROM stats_days ORDER BY day").all<{ day: string; counts: string }>();
    const out = new Map<IsoDate, Record<string, number>>();
    for (const r of results ?? []) {
      try {
        out.set(r.day, JSON.parse(r.counts) as Record<string, number>);
      } catch {
        // a row that isn't JSON counts as empty
      }
    }
    return out;
  } catch (e) {
    if (statsMissing(e)) return "missing";
    throw e;
  }
}

/** A counter's figures (several keys are added up) from the days read, by the window's days. */
export function counterFigures(days: Map<IsoDate, Record<string, number>> | "missing", keys: string[], w: Window): Figures & { since: string | null } {
  if (days === "missing") return { total: null, d30: null, d7: null, today: null, since: null };
  const b: Buckets = new Map();
  const index = new Map(w.days.map((d, i) => [d, i]));
  for (const [day, counts] of days) {
    // Days after today (a clock running ahead somewhere) go with today; days before the window are "older".
    const i = index.get(day) ?? (day > w.today ? DAYS - 1 : -1);
    const n = keys.reduce((a, k) => a + (Number.isFinite(counts[k]) ? Number(counts[k]) : 0), 0);
    b.set(i, (b.get(i) ?? 0) + n);
  }
  const since = days.size ? [...days.keys()].sort()[0] : null;
  return { ...figuresOf(b), since };
}

const label = (key: string) => METRICS.find((m) => m.key === key)?.label ?? key;

/** Everything the admin page shows (plan 7.1), read from the accounts database `db` and `fruum` (`main`). */
export async function readStats(db: D1Database, main: D1Database, now: number, production: boolean): Promise<StatsAnswer> {
  const w = windowAt(now);
  const bucket = (col: string) => bucketSql(col, w);
  const [s0, s23, s29] = [w.starts[0], w.starts[DAYS - WEEK], w.starts[DAYS - 1]];

  const [accounts, fruum, counters] = await Promise.all([
    db.batch([
      // 0: accounts by when they were made (accounts that still exist)
      db.prepare(`SELECT ${bucket("created_at")} AS b, COUNT(*) AS n FROM users GROUP BY b`),
      // 1: one pass over the accounts for everything else about them
      db.prepare(
        `SELECT COUNT(*) AS total, SUM(last_seen_at >= ?1) AS a30, SUM(last_seen_at >= ?2) AS a7, SUM(last_seen_at >= ?3) AS a1,
           SUM(username IS NULL) AS no_profile, SUM(board = 1) AS board, SUM(uni = 'eth') AS eth, SUM(uni = 'uzh') AS uzh,
           SUM(cred_total) AS cred
         FROM users`,
      ).bind(s0, s23, s29),
      // 2: friendships, each once (two rows each: the one with the smaller id first)
      db.prepare(`SELECT ${bucket("since")} AS b, COUNT(*) AS n FROM friends WHERE user_id < friend_id GROUP BY b`),
      // 3: check-ins (kept; only their person is unlinked after 12 months)
      db.prepare(`SELECT ${bucket("started_at")} AS b, COUNT(*) AS n FROM checkins GROUP BY b`),
      // 4: starred places
      db.prepare("SELECT COUNT(*) AS people, SUM(json_array_length(list)) AS places FROM stars WHERE list != '[]'"),
      // 5: meal ratings kept now (60 days)
      db.prepare(`SELECT ${bucket("at")} AS b, COUNT(*) AS n FROM meal_ratings GROUP BY b`),
      // 6: Street cred awarded in the 30 days (the total is users.cred_total, above)
      db.prepare(`SELECT ${bucket("at")} AS b, SUM(points) AS n FROM cred WHERE at >= ?1 GROUP BY b`).bind(s0),
    ]) as Promise<Rows[]>,
    main.batch([
      // 0: occupancy reports of the 30 days (index reports_at), and per day the browsers that sent them
      main.prepare(`SELECT ${bucket("at")} AS b, COUNT(*) AS n, COUNT(DISTINCT reporter) AS r FROM reports WHERE at >= ?1 GROUP BY b`).bind(s0),
      // 1: the browsers that sent reports, per period (distinct counts can't be added up from the days); 30 days only
      main.prepare(
        `SELECT COUNT(DISTINCT reporter) AS d30, COUNT(DISTINCT CASE WHEN at >= ?2 THEN reporter END) AS d7,
           COUNT(DISTINCT CASE WHEN at >= ?3 THEN reporter END) AS today
         FROM reports WHERE at >= ?1`,
      ).bind(s0, s23, s29),
      // 2: every report ever sent, from the AUTOINCREMENT counter: one row read instead of the whole table
      main.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'reports'"),
      // 3: feedback
      main.prepare(`SELECT ${bucket("at")} AS b, COUNT(*) AS n FROM feedback GROUP BY b`),
      // 4: the newest feedback itself, for reading on the page (index feedback_at)
      main.prepare("SELECT id, at, category, message, email, context FROM feedback ORDER BY at DESC, id DESC LIMIT ?1").bind(FEEDBACK_LIST),
    ]) as Promise<Rows[]>,
    readCounters(db),
  ]);

  const u = rowsOf(accounts[1])[0] ?? {};
  const stars = rowsOf(accounts[4])[0] ?? {};
  const reporters = rowsOf(fruum[1])[0] ?? {};
  const reports = figuresOf(bucketsOf(rowsOf(fruum[0])));
  const missing = counters === "missing";
  const counted = (key: string, keys = [key], extra: Partial<MetricOut> = {}): MetricOut => ({
    key,
    label: label(key),
    source: `Counter ${keys.join(" + ")}`,
    ...counterFigures(counters, keys, w),
    ...(missing ? { note: "Not set up: apply migrations-accounts/0003_stats.sql" } : {}),
    ...extra,
  });
  const fromFruum = production ? "fruum" : "fruum (production)";
  const productionNote = production ? undefined : "From production: this host's accounts are test accounts, but reports and feedback are frooms.ch's.";

  const deleted = counted("account_deleted", ["account_deleted", "account_expired"]);
  deleted.parts = [
    { key: "account_deleted", label: "Deleted by their owner", ...counterFigures(counters, ["account_deleted"], w) },
    { key: "account_expired", label: label("account_expired"), ...counterFigures(counters, ["account_expired"], w) },
  ].map(({ since: _, series: __, ...p }) => p);

  const ratings = counted("meal_rating");
  ratings.parts = [{ key: "meal_ratings_kept", label: "Kept now", note: "Ratings are kept 60 days", ...figuresOf(bucketsOf(rowsOf(accounts[5])), { series: false }) }];

  const groups: Group[] = [
    {
      key: "accounts",
      label: "Accounts",
      metrics: [
        { key: "accounts", label: "Accounts (now)", source: "users, by created_at", note: "Periods: accounts made then that still exist", ...figuresOf(bucketsOf(rowsOf(accounts[0]))) },
        counted("account_created"),
        { ...deleted, label: "Accounts deleted" },
        {
          key: "active",
          label: "Active accounts",
          source: "users.last_seen_at",
          note: "Renewed at most once a day, so \"today\" means \"in about the last day\"",
          total: null,
          d30: num(u.a30),
          d7: num(u.a7),
          today: num(u.a1),
        },
        {
          key: "by_uni",
          label: "By university",
          source: "users.uni",
          ...totalOnly(num(u.total)),
          parts: [
            { key: "eth", label: "ETH Zurich", ...totalOnly(num(u.eth)) },
            { key: "uzh", label: "University of Zurich", ...totalOnly(num(u.uzh)) },
          ],
        },
        { key: "no_profile", label: "Profile not finished", source: "users without a username", ...totalOnly(num(u.no_profile)) },
        counted("sign_in"),
        { key: "board", label: "On the leaderboards", source: "users.board", ...totalOnly(num(u.board)) },
      ],
    },
    {
      key: "social",
      label: "Social",
      metrics: [
        { key: "friendships", label: "Friendships", source: "friends (two rows each), by since", note: "Friendships that still exist", ...figuresOf(bucketsOf(rowsOf(accounts[2]))) },
        counted("friend_request"),
        { key: "checkins", label: "Check-ins", source: "checkins, by started_at", ...figuresOf(bucketsOf(rowsOf(accounts[3]))) },
        {
          key: "stars",
          label: "People with starred places",
          source: "stars",
          ...totalOnly(num(stars.people)),
          parts: [{ key: "starred_places", label: "Places starred", ...totalOnly(num(stars.places)) }],
        },
      ],
    },
    {
      key: "contributions",
      label: "Contributions",
      metrics: [
        {
          key: "reports",
          label: "Occupancy reports",
          source: `${fromFruum}: reports, by at; total from its id counter`,
          note: productionNote ?? "Total: every report sent, withdrawn ones too",
          ...reports,
          total: Math.max(num(rowsOf(fruum[2])[0]?.seq), reports.d30 ?? 0),
        },
        {
          key: "reporters",
          label: "Reporting browsers",
          source: `${fromFruum}: distinct reports.reporter`,
          note: productionNote ?? "Distinct over 30 days at most (a total would read every report)",
          total: null,
          d30: num(reporters.d30),
          d7: num(reporters.d7),
          today: num(reporters.today),
          series: figuresOf(bucketsOf(rowsOf(fruum[0]), "r")).series,
        },
        counted("report_vote", ["report_vote"], { note: missing ? undefined : "Votes are deleted after 2 days, so only the counter has totals" }),
        ratings,
        { key: "feedback", label: "Feedback", source: `${fromFruum}: feedback, by at`, note: productionNote, ...figuresOf(bucketsOf(rowsOf(fruum[3]))) },
        {
          key: "cred",
          label: "Street cred awarded",
          source: "Total: users.cred_total; periods: the cred log",
          note: "Total of accounts that still exist; the log keeps 12 months",
          ...figuresOf(bucketsOf(rowsOf(accounts[6]))),
          total: num(u.cred),
        },
      ],
    },
    {
      key: "use",
      label: "Use",
      metrics: METRICS.filter((m) => m.group === "use").map((m) => counted(m.key)),
    },
  ];
  // Undefined notes are dropped from the JSON anyway; drop them here too, so the tests see what the page gets.
  for (const g of groups) for (const m of g.metrics) if (m.note === undefined) delete m.note;

  return {
    day: w.today,
    host_db: production ? "fruum-accounts" : "fruum-accounts-dev",
    generated_at: now,
    groups,
    visits: null,
    visits_reason: "no_token",
    counters: missing ? "missing" : "ok",
    feedback: rowsOf(fruum[4]).map(feedbackItem),
    // Without the table (migrations-accounts/0004 not applied yet) the rest of the page still loads.
    bugs: await bugItems(db, main, now).catch((e) => {
      console.error(`Admin bug reports failed: ${e instanceof Error ? e.message : e}`);
      return [];
    }),
  };
}

// --- Visits from Cloudflare Web Analytics (section 8.1) -------------------------------------------------------------

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
export const VISITS_TTL_S = 600;
export const VISITS_TIMEOUT_MS = 3000;
const VISITS_CACHE_KEY = "https://cache.frooms.internal/admin/visits";

export type VisitsReason = "no_token" | "no_site" | "timeout" | "error";

/** Page loads (`count`) and visits (`sum.visits`) of the Web Analytics site per UTC day. No user detail anywhere. */
export const VISITS_QUERY = `query Visits($accountTag: string, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      rumPageloadEventsAdaptiveGroups(limit: 100, filter: $filter, orderBy: [date_ASC]) {
        count
        sum { visits }
        dimensions { date }
      }
    }
  }
}`;

interface VisitsRow {
  count?: number;
  sum?: { visits?: number };
  dimensions?: { date?: string };
}

export interface VisitsDeps {
  fetch?: typeof fetch;
  /** The Cache API's cache (caches.default in the Worker); none in tests unless given. */
  cache?: Cache | null;
  timeoutMs?: number;
}

/** The 30 UTC days ending with today's (Cloudflare's dates are UTC days). */
export function utcDays(now: number): IsoDate[] {
  const today = new Date(now).toISOString().slice(0, 10);
  return Array.from({ length: DAYS }, (_, i) => addDays(today, i - (DAYS - 1)));
}

/** Cloudflare's rows (one per UTC day) as the "Visits (UTC days)" group. Total: none (Cloudflare keeps a window only). */
export function visitsGroup(rows: VisitsRow[], now: number): Group {
  const days = utcDays(now);
  const index = new Map(days.map((d, i) => [d, i]));
  const visits = new Map<number, number>();
  const views = new Map<number, number>();
  for (const r of rows) {
    const i = index.get(r.dimensions?.date ?? "");
    if (i === undefined) continue;
    visits.set(i, (visits.get(i) ?? 0) + num(r.sum?.visits));
    views.set(i, (views.get(i) ?? 0) + num(r.count));
  }
  const v = figuresOf(visits, { total: false });
  const quiet = v.d30 === 0 ? "No visits in 30 days: check the var CF_SITE_TAG" : "Cloudflare keeps a window, so there's no total";
  return {
    key: "visits",
    label: "Visits (UTC days)",
    day: days[DAYS - 1],
    metrics: [
      { key: "visits", label: "Visits", source: "Cloudflare Web Analytics: sum of visits", note: quiet, ...v },
      { key: "page_views", label: "Page views", source: "Cloudflare Web Analytics: page loads", ...figuresOf(views, { total: false }) },
    ],
  };
}

/**
 * The visits of the last 30 UTC days from Cloudflare's GraphQL API, or null with a reason. A good answer is cached for
 * 10 minutes under a fixed key (nothing about who asked); failures aren't cached. Never throws.
 */
export async function readVisits(env: AdminEnv, now: number, deps: VisitsDeps = {}): Promise<{ group: Group | null; reason?: VisitsReason }> {
  const token = env.CF_ANALYTICS_TOKEN?.trim();
  if (!token) return { group: null, reason: "no_token" };
  if (!env.CF_ACCOUNT_ID || !env.CF_SITE_TAG) return { group: null, reason: "no_site" };
  const cache = deps.cache !== undefined ? deps.cache : typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(`${VISITS_CACHE_KEY}/${encodeURIComponent(env.CF_SITE_TAG)}`);
  try {
    const hit = await cache?.match(key);
    if (hit) {
      const entry = (await hit.json()) as { at: number; rows: VisitsRow[] };
      if (now - entry.at < VISITS_TTL_S * 1000 && now >= entry.at) return { group: visitsGroup(entry.rows, now) };
    }
  } catch {
    // a broken cache entry is fetched again
  }

  const days = utcDays(now);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? VISITS_TIMEOUT_MS);
  try {
    const res = await (deps.fetch ?? fetch)(GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: VISITS_QUERY,
        variables: {
          accountTag: env.CF_ACCOUNT_ID,
          filter: { AND: [{ datetime_geq: `${days[0]}T00:00:00Z`, datetime_leq: new Date(now).toISOString() }, { siteTag: env.CF_SITE_TAG }] },
        },
      }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as {
      data?: { viewer?: { accounts?: { rumPageloadEventsAdaptiveGroups?: VisitsRow[] }[] } };
      errors?: { message?: string }[] | null;
    } | null;
    const rows = body?.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups;
    if (!res.ok || body?.errors?.length || !Array.isArray(rows)) {
      const why = body?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
      console.error(`Admin visits failed: ${why}`);
      return { group: null, reason: "error" };
    }
    if (cache) {
      await cache
        .put(key, new Response(JSON.stringify({ at: now, rows }), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${VISITS_TTL_S}` } }))
        .catch(() => {});
    }
    return { group: visitsGroup(rows, now) };
  } catch (e) {
    if (controller.signal.aborted) return { group: null, reason: "timeout" };
    console.error(`Admin visits failed: ${e instanceof Error ? e.message : e}`);
    return { group: null, reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}

// --- The endpoint -------------------------------------------------------------------------------------------------

/** The same answer as an unknown /api path (worker/index.ts), so the endpoint isn't advertised. */
const notFound = (headers: Record<string, string> = {}) => answer({ detail: "Not found" }, 404, headers);

/**
 * GET /api/admin/stats, and POST /api/admin/bug ({ id, decision: "reward" | "decline", reason }, from this page only):
 * signed in, profile done, id in ADMIN_IDS; anything else 404. ACCOUNT_LIMITER as for the other account calls (counted
 * only for the admin). Never cached.
 */
export async function handleAdmin(request: Request, env: AdminEnv, now = Date.now(), deps: VisitsDeps = {}): Promise<Response> {
  const cfg: AuthConfig | null = authConfig(request, env);
  const path = new URL(request.url).pathname;
  const decide = path === "/api/admin/bug" && request.method === "POST";
  if (!cfg || !(decide || (path === "/api/admin/stats" && request.method === "GET"))) return notFound();
  try {
    const { user, setCookie } = await requireUser(request, cfg, { now });
    const cookie: Record<string, string> = setCookie ? { "Set-Cookie": setCookie } : {};
    if (!adminIds(env.ADMIN_IDS).has(user.id)) return notFound(cookie);
    if (env.ACCOUNT_LIMITER && !(await env.ACCOUNT_LIMITER.limit({ key: user.id })).success) {
      return answer({ detail: "too_many_requests" }, 429, { "Retry-After": "60", ...cookie });
    }
    if (decide) {
      if (!sameOrigin(request)) return answer({ detail: "bad_origin" }, 403, cookie);
      let b: Record<string, unknown>;
      try {
        b = (await request.json()) as Record<string, unknown>;
      } catch {
        return answer({ detail: "bad_json" }, 400, cookie);
      }
      try {
        return answer(await decideBug(cfg.db, Number(b?.id), b?.decision, b?.reason, now), 200, cookie);
      } catch (e) {
        // The admin's own mistakes (no reason, too long, decided already) say what happened; nothing else does.
        if (e instanceof AuthError) return answer({ detail: e.code }, e.status, cookie);
        throw e;
      }
    }
    const production = new URL(request.url).hostname === PRODUCTION_HOST;
    const [body, visits] = await Promise.all([readStats(cfg.db, env.DB, now, production), readVisits(env, now, deps)]);
    body.visits = visits.group;
    if (visits.reason) body.visits_reason = visits.reason;
    else delete body.visits_reason;
    return answer(body, 200, { "Cache-Control": "private, no-store", ...cookie });
  } catch (e) {
    if (e instanceof AuthError) return notFound();
    console.error(`Admin stats failed: ${e instanceof Error ? e.stack : e}`);
    return answer({ detail: "Something went wrong. Please try again." }, 500);
  }
}
