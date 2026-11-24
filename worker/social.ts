// Profile, friends, check-ins and stars for signed-in people (plans/PLAN_ACCOUNTS.md, section 7). Sign-in and
// sessions are in worker/auth.ts. Every answer is `Cache-Control: no-store`; every change needs an Origin header equal
// to the request's own origin (plan 6.3).
//
// Other people are only ever shown as { username, name: "Raffaele W.", initials, bg, fg }: their last name and email
// never leave the Worker (decision 8). People are named by username in requests; the edu-ID `sub` never reaches the page.

import { AuthError, type AuthConfig, type AuthEnv, answer, authConfig, nameKey, requireUser, sameOrigin, sha256Hex } from "./auth";
import {
  CHECKIN_SAME_PLACE_MS,
  INVITE_KINDS,
  award,
  castVote,
  cleanCredStatements,
  credLog,
  credState,
  credSummary,
  deleteCredStatements,
  earned,
  leaderboard,
  levelOf,
  setBoard,
  takeBack,
  TRUSTED_LIKES,
  UNLOCKS,
  type VotedReport,
} from "./cred";
import { REPORT_LOG_MS } from "./config";
import { type LookupDish, rateMeal, unrateMeal } from "./ratings";
import { batchWithBump, bumpFor } from "./stats";

export interface SocialEnv extends AuthEnv {
  ACCOUNT_LIMITER?: RateLimit; // 60 a minute per account, every endpoint here
  SEARCH_LIMITER?: RateLimit; // 20 a minute per account: /api/people and /api/username (decision 8)
}

export type PlaceKind = "room" | "space";

/** A place's name and building from the catalogue (index.ts), or null when it isn't a listed place (decision 11). */
export type LookupPlace = (kind: PlaceKind, place: string, area: string) => Promise<{ name: string; building: string } | null>;

/** A report in `fruum` (index.ts) as a vote needs it, or null when there is none (or it's a rating, which isn't shown). */
export type LookupReport = (id: number) => Promise<VotedReport | null>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export const CHECKIN_DEFAULT_MS = 3 * HOUR_MS; // decision 5
export const CHECKIN_MAX_MS = 12 * HOUR_MS;
export const SEARCH_LIMIT = 10; // decision 8
export const SEARCH_MIN_CHARS = 3;
export const REQUESTS_PER_DAY = 30;
export const MAX_FRIENDS = 300;
export const LINK_KEPT_MS = 365 * DAY_MS; // check-ins linked to the person for 12 months (section 7.3)
export const UNUSED_ACCOUNT_MS = 730 * DAY_MS; // decision 15: 24 months
const CLEANUP_ACCOUNTS_PER_RUN = 50;
const MAX_BODY_BYTES = 32 * 1024;
const SOURCES = new Set(["nearby", "search", "place"]);
export const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
const COLOUR_RE = /^#[0-9a-f]{6}$/;
export const MIN_CONTRAST = 3;

// --- People -----------------------------------------------------------------------------------------------------------

/** Lower-case name particles skipped for the short name's initial ("von Arx" → "A."). */
const PARTICLES = new Set(["von", "van", "de", "der", "den", "di", "da", "du", "del", "della", "des", "dos", "das", "le", "la", "zu", "zur", "ten", "ter", "af", "al", "el"]);

/** The letter that stands for a last name: its first word that isn't a particle ("von Arx" → "A", "de la Cruz" → "C"). */
export function lastInitial(last: string): string {
  const words = last.trim().split(/\s+/).filter(Boolean);
  const word = words.find((w) => !PARTICLES.has(w.toLowerCase())) ?? words[0] ?? "";
  return [...word][0]?.toUpperCase() ?? "";
}

/** "Raffaele W.": the first name and the last name's initial, how frooms shows people (plan 8.5). */
export function shortName(first: string, last: string): string {
  const initial = lastInitial(last);
  return initial ? `${first.trim()} ${initial}.` : first.trim();
}

/** The bubble's letters: first name's and last name's initial ("RW", "RA" for "von Arx"). */
export const initials = (first: string, last: string) => `${[...first.trim()][0]?.toUpperCase() ?? ""}${lastInitial(last)}`;

interface UserRow {
  id: string;
  username: string | null;
  first_name: string;
  last_name: string;
  bg: string | null;
  fg: string | null;
  bg2: string | null;
  fg2: string | null;
  metal: string | null;
}

/** A bubble's look: its two colours, the gradients' second colours and the metal (Street cred, plan 11.2). */
const styleOf = (u: Pick<UserRow, "bg" | "fg" | "bg2" | "fg2" | "metal">) => ({ bg: u.bg, fg: u.fg, bg2: u.bg2, fg2: u.fg2, metal: u.metal });

/** Another person as the page may see them. */
export function person(u: UserRow) {
  return { username: u.username, name: shortName(u.first_name, u.last_name), initials: initials(u.first_name, u.last_name), ...styleOf(u) };
}

/** A leaderboard row's person: the name as "Raffaele W." and the bubble (its letters and look). */
const bubbleOf = (u: Omit<UserRow, "id" | "username">) => ({
  name: shortName(u.first_name, u.last_name),
  bubble: { initials: initials(u.first_name, u.last_name), ...styleOf(u) },
});

// --- Colours (WCAG contrast; the page's lib.js keeps the same rule) ---------------------------------------------------

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every background stop against every text stop reads (lib.js readableBubble); `bg2`/`fg2` null when flat. */
export function readableStyle(bg: string, fg: string, bg2: string | null, fg2: string | null): boolean {
  const bgs = [bg, bg2].filter((c): c is string => !!c);
  const fgs = [fg, fg2].filter((c): c is string => !!c);
  return bgs.every((b) => fgs.every((f) => contrast(b, f) >= MIN_CONTRAST));
}

// --- Bubble styles (Street cred unlocks, plan 11.2; lib.js BUBBLE_STYLE_LEVELS has the same) --------------------------

export const METALS = ["bronze", "silver", "gold"] as const;

/** The level each style needs, from cred.ts UNLOCKS: bg2 the gradient background, fg2 the gradient text, the metals. */
export const STYLE_LEVELS: Record<string, number> = Object.fromEntries(
  Object.entries(UNLOCKS).map(([level, u]) => [u.key === "gradient-bg" ? "bg2" : u.key === "gradient-text" ? "fg2" : u.key, Number(level)]),
);

type Style = { bg2: string | null; fg2: string | null; metal: string | null };

/** An optional colour of the profile's body: left out keeps `stored`, null or "" clears it. */
function styleColour(v: unknown, stored: string | null): string | null {
  if (v === undefined) return stored;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !COLOUR_RE.test(v.trim().toLowerCase())) throw new AuthError(400, "bad_colour");
  return v.trim().toLowerCase();
}

/**
 * The bubble style POST /api/me/profile stores. Left-out fields keep what is stored (pages from before the unlocks
 * send only bg and fg). A metal clears the gradients and a gradient the metal; both at once is 400 `bad_style`. A style
 * above your level is 403 `locked`, unless it is the one already stored (a style stays when points are taken back).
 */
export function chooseStyle(b: Record<string, unknown>, stored: Style, level: number): Style {
  let bg2 = styleColour(b.bg2, stored.bg2);
  let fg2 = styleColour(b.fg2, stored.fg2);
  let metal = b.metal === undefined ? stored.metal : b.metal === null || b.metal === "" ? null : b.metal;
  if (metal !== null && (typeof metal !== "string" || !(METALS as readonly string[]).includes(metal))) throw new AuthError(400, "bad_style");
  const newGradient = (b.bg2 !== undefined && bg2 !== null) || (b.fg2 !== undefined && fg2 !== null);
  if (b.metal !== undefined && metal !== null) {
    if (newGradient) throw new AuthError(400, "bad_style");
    bg2 = fg2 = null;
  } else if (newGradient) metal = null;
  const out: Style = { bg2, fg2, metal: metal as string | null };
  const checks: [string, string | null, string | null][] = [
    ["bg2", out.bg2, stored.bg2],
    ["fg2", out.fg2, stored.fg2],
    [out.metal ?? "", out.metal, stored.metal],
  ];
  for (const [key, value, was] of checks) {
    if (value !== null && value !== was && STYLE_LEVELS[key] > level) throw new AuthError(403, "locked");
  }
  return out;
}

// --- Stars (the same rules as lib.js cleanStars; test/social.test.ts runs both on the same lists) --------------------

export const MAX_STARS = 40;
const STAR_KINDS = ["room", "space", "building", "microwave"];
const MAX_STAR_TEXT = 200;

export interface Star {
  kind: string;
  id: string;
  area: string;
  name: string;
  building: string;
  typecode?: string;
  category?: string;
}

/**
 * Stars as the page keeps them: known kinds only, no duplicates, only the known fields, at most 40 (newest first).
 * Beyond lib.js, an entry with a text longer than MAX_STAR_TEXT is left out (the account's copy has a size limit).
 */
export function cleanStars(raw: unknown): Star[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Star[] = [];
  const long = (v: unknown) => typeof v === "string" && v.length > MAX_STAR_TEXT;
  for (const s of raw as Record<string, unknown>[]) {
    if (!s || !STAR_KINDS.includes(s.kind as string) || typeof s.id !== "string" || typeof s.area !== "string") continue;
    if ([s.id, s.area, s.name, s.building, s.typecode, s.category].some(long)) continue;
    const key = `${s.kind}|${s.area}|${s.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const building = s.kind === "building" ? s.id : typeof s.building === "string" ? s.building : "";
    const star: Star = { kind: s.kind as string, id: s.id, area: s.area, name: typeof s.name === "string" ? s.name : s.id, building };
    if (typeof s.typecode === "string") star.typecode = s.typecode;
    if (typeof s.category === "string") star.category = s.category;
    out.push(star);
    if (out.length === MAX_STARS) break;
  }
  return out;
}

// --- Check-ins --------------------------------------------------------------------------------------------------------

interface CheckinRow {
  kind: string;
  place: string;
  area: string;
  building: string;
  name: string;
  started_at: number;
  until: number;
}

const checkinOf = (c: CheckinRow) => ({
  kind: c.kind,
  place: c.place,
  area: c.area,
  building: c.building,
  name: c.name,
  since: c.started_at,
  until: c.until,
});

/** The person's running check-in (`ended_at IS NULL AND until > now`), or null. */
async function runningCheckin(db: D1Database, userId: string, now: number) {
  const row = await db
    .prepare("SELECT kind, place, area, building, name, started_at, until FROM checkins WHERE user_id = ? AND ended_at IS NULL AND until > ?")
    .bind(userId, now)
    .first<CheckinRow>();
  return row ? checkinOf(row) : null;
}

/** Closes a check-in that ran out (ended_at = until, ended_by NULL), so the open-check-in index is free again. */
const closeRanOut = (db: D1Database, userId: string, now: number) =>
  db.prepare("UPDATE checkins SET ended_at = until WHERE user_id = ? AND ended_at IS NULL AND until <= ?").bind(userId, now);

/** The end time a check-in asks for: within (now, now + 12 h], 3 hours when missing (decision 5). */
function untilOf(value: unknown, now: number): number {
  if (value === undefined || value === null) return now + CHECKIN_DEFAULT_MS;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new AuthError(400, "bad_until");
  if (value <= now || value > now + CHECKIN_MAX_MS) throw new AuthError(400, "bad_until");
  return Math.round(value);
}

// --- Deleting accounts (DELETE /api/me and the clean-up of decision 15) ----------------------------------------------

/** Everything of a person, gone; their check-ins stay as usage data without them (section 7.3). */
export async function deleteAccountStatements(db: D1Database, id: string, now: number): Promise<D1PreparedStatement[]> {
  return [
    db.prepare("UPDATE checkins SET ended_at = until WHERE user_id = ?1 AND ended_at IS NULL AND until <= ?2").bind(id, now),
    db.prepare("UPDATE checkins SET ended_at = ?2, ended_by = 'user' WHERE user_id = ?1 AND ended_at IS NULL").bind(id, now),
    db.prepare("UPDATE checkins SET user_id = NULL WHERE user_id = ?").bind(id),
    db.prepare("DELETE FROM friends WHERE user_id = ?1 OR friend_id = ?1").bind(id),
    db.prepare("DELETE FROM friend_requests WHERE from_id = ?1 OR to_id = ?1").bind(id),
    db.prepare("DELETE FROM blocks WHERE user_id = ?1 OR blocked_id = ?1").bind(id),
    db.prepare("DELETE FROM stars WHERE user_id = ?").bind(id),
    ...(await deleteCredStatements(db, id)), // votes go with the voter; the owners keep the points they earned
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
    db.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ];
}

/**
 * The daily clean-up (from the prefetch's daily run, production only: previews run no Cron Trigger): expired sessions,
 * the person removed from check-ins that ended more than 12 months ago, accounts unused for 24 months, and Street
 * cred's old rows (cred.ts cleanCredStatements: log rows after 12 months except friends', report links and votes after
 * 2 days, meal ratings after 60).
 */
export async function cleanAccounts(db: D1Database, now = Date.now()): Promise<{ sessions: number; unlinked: number; accounts: number }> {
  const before = now - LINK_KEPT_MS;
  const unused = await db
    .prepare("SELECT id FROM users WHERE last_seen_at < ? LIMIT ?")
    .bind(now - UNUSED_ACCOUNT_MS, CLEANUP_ACCOUNTS_PER_RUN)
    .all<{ id: string }>();
  // Two batches (D1 counts each as one query): the routine clean-up doesn't roll back with an account deletion that fails.
  const results = await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    db.prepare("UPDATE checkins SET user_id = NULL WHERE user_id IS NOT NULL AND COALESCE(ended_at, until) < ?").bind(before),
    ...cleanCredStatements(db, now),
  ]);
  const deletions = (await Promise.all(unused.results.map((u) => deleteAccountStatements(db, u.id, now)))).flat();
  if (deletions.length) await batchWithBump(db, deletions, bumpFor(db, now, { account_expired: unused.results.length }));
  const changes = (i: number) => (results[i] as D1Result | undefined)?.meta?.changes ?? 0;
  return { sessions: changes(0), unlinked: changes(1), accounts: unused.results.length };
}

// --- Requests ---------------------------------------------------------------------------------------------------------

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json")) throw new AuthError(415, "expected_json");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new AuthError(413, "too_large");
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AuthError(400, "expected_json");
  }
}

const str = (v: unknown, code: string) => {
  if (typeof v !== "string" || !v.trim()) throw new AuthError(400, code);
  return v.trim();
};

async function limit(limiter: RateLimit | undefined, key: string) {
  if (limiter && !(await limiter.limit({ key })).success) throw new AuthError(429, "too_many_requests");
}

/** The person named by `username`, unless it is you or one of you blocked the other (then: as if they didn't exist). */
async function other(db: D1Database, me: string, username: unknown): Promise<UserRow> {
  if (typeof username !== "string") throw new AuthError(400, "bad_user");
  const u = await db
    .prepare(
      `SELECT id, username, first_name, last_name, bg, fg, bg2, fg2, metal FROM users u WHERE username = ?1 AND id != ?2
       AND NOT EXISTS (SELECT 1 FROM blocks WHERE (user_id = ?2 AND blocked_id = u.id) OR (user_id = u.id AND blocked_id = ?2))`,
    )
    .bind(username.trim().toLowerCase(), me)
    .first<UserRow>();
  if (!u) throw new AuthError(404, "no_such_person");
  return u;
}

const friendCount = async (db: D1Database, id: string) =>
  (await db.prepare("SELECT count(*) AS n FROM friends WHERE user_id = ?").bind(id).first<{ n: number }>())?.n ?? 0;

/**
 * Makes two people friends (both rows), removes the requests between them and gives both 25 street cred (once while
 * they're friends: unfriend takes it back). Answers `a`'s Street cred (a is the one asking).
 */
async function befriend(db: D1Database, a: string, b: string, now: number) {
  if ((await friendCount(db, a)) >= MAX_FRIENDS || (await friendCount(db, b)) >= MAX_FRIENDS) throw new AuthError(409, "too_many_friends");
  const [forA, forB] = await Promise.all([award(db, a, "friend", b, now), award(db, b, "friend", a, now)]);
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO friends (user_id, friend_id, since) VALUES (?1, ?2, ?3), (?2, ?1, ?3)").bind(a, b, now),
    db.prepare("DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)").bind(a, b),
    ...forA,
    ...forB,
  ]);
  return credState(db, a, earned("friend", forA));
}

/**
 * Ends a friendship (both rows) and takes back the 25 street cred it gave each of them; nothing to take when they
 * weren't friends, so removing someone who isn't a friend costs nothing. Becoming friends again pays again.
 */
async function unfriend(db: D1Database, a: string, b: string): Promise<D1PreparedStatement[]> {
  const were = await db.prepare("SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?").bind(a, b).first();
  return [
    db.prepare("DELETE FROM friends WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)").bind(a, b),
    ...(were ? [...(await takeBack(db, a, "friend", b)), ...(await takeBack(db, b, "friend", a))] : []),
  ];
}

const USER_COLS = "u.id, u.username, u.first_name, u.last_name, u.bg, u.fg, u.bg2, u.fg2, u.metal";

/** Escapes LIKE's wildcards (usernames may contain "_"). */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** GET /api/people?q= (decision 8): exact email, or username prefix and name word start from 3 letters; 10 at most. */
async function people(db: D1Database, me: string, q: string) {
  const query = q.trim();
  const notBlocked = `NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id = ?1 AND b.blocked_id = u.id) OR (b.user_id = u.id AND b.blocked_id = ?1))`;
  let rows: UserRow[];
  if (query.includes("@")) {
    rows = (await db
      .prepare(`SELECT ${USER_COLS} FROM users u WHERE u.email_hash = ?2 AND u.id != ?1 AND u.username IS NOT NULL AND ${notBlocked} LIMIT ?3`)
      .bind(me, await sha256Hex(query.toLowerCase()), SEARCH_LIMIT)
      .all<UserRow>()).results;
  } else {
    const key = nameKey(query, "");
    const user = query.toLowerCase();
    if (key.length < SEARCH_MIN_CHARS && user.length < SEARCH_MIN_CHARS) return [];
    rows = (await db
      .prepare(
        `SELECT ${USER_COLS} FROM users u WHERE u.id != ?1 AND u.username IS NOT NULL AND ${notBlocked}
         AND (u.username LIKE ?2 ESCAPE '\\' OR u.name_key LIKE ?3 ESCAPE '\\' OR u.name_key LIKE ?4 ESCAPE '\\')
         ORDER BY (u.username = ?5) DESC, u.username LIMIT ?6`,
      )
      .bind(me, `${likeEscape(user)}%`, `${likeEscape(key)}%`, `% ${likeEscape(key)}%`, user, SEARCH_LIMIT)
      .all<UserRow>()).results;
  }
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const friends = new Set((await db.prepare(`SELECT friend_id AS id FROM friends WHERE user_id = ? AND friend_id IN (${marks})`).bind(me, ...ids).all<{ id: string }>()).results.map((r) => r.id));
  const out = new Set((await db.prepare(`SELECT to_id AS id FROM friend_requests WHERE from_id = ? AND to_id IN (${marks})`).bind(me, ...ids).all<{ id: string }>()).results.map((r) => r.id));
  const inc = new Set((await db.prepare(`SELECT from_id AS id FROM friend_requests WHERE to_id = ? AND from_id IN (${marks})`).bind(me, ...ids).all<{ id: string }>()).results.map((r) => r.id));
  return rows.map((r) => ({
    ...person(r),
    friend: friends.has(r.id),
    request: out.has(r.id) ? "sent" : inc.has(r.id) ? "received" : null,
  }));
}

async function friendsList(db: D1Database, me: string) {
  const list = async (sql: string) => (await db.prepare(sql).bind(me).all<UserRow & { at: number }>()).results;
  const [friends, incoming, outgoing] = await Promise.all([
    list(`SELECT ${USER_COLS}, f.since AS at FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ? ORDER BY u.username`),
    list(`SELECT ${USER_COLS}, r.at FROM friend_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ? ORDER BY r.at DESC`),
    list(`SELECT ${USER_COLS}, r.at FROM friend_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ? ORDER BY r.at DESC`),
  ]);
  return {
    friends: friends.map((u) => ({ ...person(u), since: u.at })),
    incoming: incoming.map((u) => ({ ...person(u), at: u.at })),
    outgoing: outgoing.map((u) => ({ ...person(u), at: u.at })),
  };
}

async function friendsCheckins(db: D1Database, me: string, now: number) {
  const rows = (await db
    .prepare(
      `SELECT ${USER_COLS}, c.kind, c.place, c.area, c.building, c.name, c.started_at, c.until
       FROM friends f JOIN checkins c ON c.user_id = f.friend_id JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ? AND c.ended_at IS NULL AND c.until > ? ORDER BY c.started_at DESC`,
    )
    .bind(me, now)
    .all<UserRow & CheckinRow>()).results;
  return rows.map((r) => ({ person: person(r), ...checkinOf(r) }));
}

async function readStars(db: D1Database, me: string): Promise<Star[]> {
  const row = await db.prepare("SELECT list FROM stars WHERE user_id = ?").bind(me).first<{ list: string }>();
  try {
    return row ? cleanStars(JSON.parse(row.list)) : [];
  } catch {
    return [];
  }
}

/** The paths this module answers (index.ts sends them here). */
export const SOCIAL_PATHS = new Set([
  "/api/me",
  "/api/me/profile",
  "/api/me/stars",
  "/api/username",
  "/api/people",
  "/api/friends",
  "/api/friends/requests",
  "/api/friends/requests/accept",
  "/api/friends/checkins",
  "/api/blocks",
  "/api/checkin",
  "/api/cred",
  "/api/cred/log",
  "/api/cred/board",
  "/api/cred/invite",
  "/api/reports/vote",
]);

/** Allowed while the first sign-in's profile step isn't done: the step itself, its username check, and leaving. */
const WITHOUT_PROFILE = new Set(["GET /api/me", "POST /api/me/profile", "GET /api/username", "DELETE /api/me"]);

const clearSession = "__Host-frooms_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";

async function route(
  request: Request,
  url: URL,
  cfg: AuthConfig,
  env: SocialEnv,
  lookup: LookupPlace,
  now: number,
  lookupReport: LookupReport,
  lookupDish: LookupDish,
): Promise<Response> {
  const key = `${request.method} ${url.pathname}`;
  const db = cfg.db;
  if (request.method !== "GET" && !sameOrigin(request)) throw new AuthError(403, "bad_origin");
  const { user, setCookie } = await requireUser(request, cfg, { allowNoProfile: WITHOUT_PROFILE.has(key), now });
  await limit(env.ACCOUNT_LIMITER, user.id);
  const ok = (data: unknown, status = 200) => answer(data, status, setCookie ? { "Set-Cookie": setCookie } : {});
  const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store", ...(setCookie ? { "Set-Cookie": setCookie } : {}) } });
  const params = url.searchParams;

  switch (key) {
    case "GET /api/me": {
      const [checkin, requests, stars, cred] = await Promise.all([
        runningCheckin(db, user.id, now),
        db.prepare("SELECT count(*) AS n FROM friend_requests WHERE to_id = ?").bind(user.id).first<{ n: number }>(),
        readStars(db, user.id),
        db.prepare("SELECT cred_total, likes_received FROM users WHERE id = ?").bind(user.id).first<{ cred_total: number; likes_received: number }>(),
      ]);
      return ok({
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        name: shortName(user.first_name, user.last_name),
        initials: initials(user.first_name, user.last_name),
        ...styleOf(user),
        uni: user.uni,
        profile_needed: !user.username,
        checkin,
        requests: requests?.n ?? 0,
        stars,
        // Street cred (plan 11.1): the level for the menu's badge, the total for the toast's level-up, trusted for its note.
        cred: { total: cred?.cred_total ?? 0, level: levelOf(cred?.cred_total ?? 0), trusted: (cred?.likes_received ?? 0) >= TRUSTED_LIKES },
      });
    }

    case "POST /api/me/profile": {
      const b = await body(request);
      const username = str(b.username, "bad_username").toLowerCase();
      if (!USERNAME_RE.test(username)) throw new AuthError(400, "bad_username");
      const bg = str(b.bg, "bad_colour").toLowerCase();
      const fg = str(b.fg, "bad_colour").toLowerCase();
      if (!COLOUR_RE.test(bg) || !COLOUR_RE.test(fg)) throw new AuthError(400, "bad_colour");
      const total = await db.prepare("SELECT cred_total FROM users WHERE id = ?").bind(user.id).first<{ cred_total: number }>();
      const style = chooseStyle(b, user, levelOf(total?.cred_total ?? 0));
      // A metal paints its own colours; bg and fg stay the bubble's colours underneath (and for pages without metals).
      if (!readableStyle(bg, fg, style.metal ? null : style.bg2, style.metal ? null : style.fg2)) throw new AuthError(400, "low_contrast");
      const taken = await db.prepare("SELECT 1 FROM users WHERE username = ? AND id != ?").bind(username, user.id).first();
      if (taken) throw new AuthError(409, "username_taken");
      try {
        await db
          .prepare("UPDATE users SET username = ?, bg = ?, fg = ?, bg2 = ?, fg2 = ?, metal = ? WHERE id = ?")
          .bind(username, bg, fg, style.bg2, style.fg2, style.metal, user.id)
          .run();
        // "Show me on the leaderboards", ticked at the profile step: joins them (never leaves; that's on Street cred).
        if (b.board === true) await setBoard(db, user.id, true, now);
      } catch (e) {
        if (String(e).includes("UNIQUE")) throw new AuthError(409, "username_taken");
        throw e;
      }
      return ok({ username, bg, fg, ...style, ...(b.board === true ? { board: true } : {}) });
    }

    case "GET /api/username": {
      await limit(env.SEARCH_LIMITER, user.id);
      const u = (params.get("u") ?? "").trim().toLowerCase();
      if (!USERNAME_RE.test(u)) return ok({ valid: false, available: false });
      const taken = await db.prepare("SELECT 1 FROM users WHERE username = ? AND id != ?").bind(u, user.id).first();
      return ok({ valid: true, available: !taken });
    }

    case "DELETE /api/me": {
      await batchWithBump(db, await deleteAccountStatements(db, user.id, now), bumpFor(db, now, { account_deleted: 1 }));
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "Set-Cookie": clearSession } });
    }

    case "GET /api/me/stars":
      return ok({ stars: await readStars(db, user.id) });

    case "PUT /api/me/stars": {
      const stars = cleanStars((await body(request)).stars);
      await db
        .prepare("INSERT INTO stars (user_id, list, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (user_id) DO UPDATE SET list = ?2, updated_at = ?3")
        .bind(user.id, JSON.stringify(stars), now)
        .run();
      return ok({ stars });
    }

    case "GET /api/people": {
      await limit(env.SEARCH_LIMITER, user.id);
      return ok({ people: await people(db, user.id, params.get("q") ?? "") });
    }

    case "GET /api/friends":
      return ok(await friendsList(db, user.id));

    case "POST /api/friends/requests": {
      const them = await other(db, user.id, (await body(request)).user);
      if (await db.prepare("SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?").bind(user.id, them.id).first()) {
        return ok({ status: "friends" });
      }
      if (await db.prepare("SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(them.id, user.id).first()) {
        const cred = await befriend(db, user.id, them.id, now); // they had asked already
        return ok({ status: "friends", cred });
      }
      const sent = await db
        .prepare("SELECT count(*) AS n FROM friend_requests WHERE from_id = ? AND at > ?")
        .bind(user.id, now - DAY_MS)
        .first<{ n: number }>();
      if ((sent?.n ?? 0) >= REQUESTS_PER_DAY) throw new AuthError(429, "too_many_friend_requests");
      if ((await friendCount(db, user.id)) >= MAX_FRIENDS) throw new AuthError(409, "too_many_friends");
      // Counted once per request: asking again while it waits writes nothing new (usage counters, stats.ts).
      const waiting = await db.prepare("SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(user.id, them.id).first();
      await batchWithBump(db, [
        db.prepare("INSERT OR IGNORE INTO friend_requests (from_id, to_id, at) VALUES (?, ?, ?)").bind(user.id, them.id, now),
      ], bumpFor(db, now, { friend_request: waiting ? 0 : 1 }));
      return ok({ status: "requested" });
    }

    case "POST /api/friends/requests/accept": {
      const them = await other(db, user.id, (await body(request)).user);
      if (!(await db.prepare("SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?").bind(them.id, user.id).first())) {
        throw new AuthError(404, "no_such_request");
      }
      const cred = await befriend(db, user.id, them.id, now);
      return ok({ status: "friends", cred });
    }

    case "DELETE /api/friends/requests": {
      // Declines a received request or withdraws a sent one. A blocked person's requests are gone already.
      const id = (await db.prepare("SELECT id FROM users WHERE username = ?").bind((params.get("user") ?? "").toLowerCase()).first<{ id: string }>())?.id;
      if (id) await db.prepare("DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)").bind(user.id, id).run();
      return done();
    }

    case "DELETE /api/friends": {
      const id = (await db.prepare("SELECT id FROM users WHERE username = ?").bind((params.get("user") ?? "").toLowerCase()).first<{ id: string }>())?.id;
      if (id) await db.batch(await unfriend(db, user.id, id));
      return done();
    }

    case "POST /api/blocks": {
      const username = (await body(request)).user;
      const id = typeof username === "string"
        ? (await db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").bind(username.trim().toLowerCase(), user.id).first<{ id: string }>())?.id
        : undefined;
      if (!id) throw new AuthError(404, "no_such_person");
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO blocks (user_id, blocked_id, at) VALUES (?, ?, ?)").bind(user.id, id, now),
        ...(await unfriend(db, user.id, id)),
        db.prepare("DELETE FROM friend_requests WHERE (from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1)").bind(user.id, id),
      ]);
      return done();
    }

    case "POST /api/checkin": {
      const b = await body(request);
      const kind = b.kind;
      if (kind !== "room" && kind !== "space") throw new AuthError(400, "bad_kind"); // decision 11: never a building
      const place = str(b.place, "bad_place");
      const area = str(b.area, "bad_place");
      const source = typeof b.source === "string" && SOURCES.has(b.source) ? b.source : null;
      if (!source) throw new AuthError(400, "bad_source");
      const until = untilOf(b.until, now);
      const found = await lookup(kind, place, area);
      if (!found) throw new AuthError(404, "unknown_place");
      // Street cred: 5, at most 4 a day, and not again within 2 hours of a check-in at the same place that earned (cred.ts).
      const again = await db
        .prepare(
          `SELECT 1 FROM checkins k JOIN cred c ON c.user_id = k.user_id AND c.action = 'checkin' AND c.ref = CAST(k.id AS TEXT)
           WHERE k.user_id = ? AND k.kind = ? AND k.place = ? AND k.area = ? AND k.started_at > ?`,
        )
        .bind(user.id, kind, place, area, now - CHECKIN_SAME_PLACE_MS)
        .first();
      const results = await batchWithBump(db, [
        closeRanOut(db, user.id, now),
        db.prepare("UPDATE checkins SET ended_at = ?, ended_by = 'moved' WHERE user_id = ? AND ended_at IS NULL").bind(now, user.id),
        db.prepare(
          `INSERT INTO checkins (user_id, kind, place, area, building, name, started_at, until, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(user.id, kind, place, area, found.building, found.name, now, until, source),
      ], bumpFor(db, now, { checkin: 1 }));
      const id = (results[2] as D1Result | undefined)?.meta?.last_row_id;
      const earn = again || !id ? [] : await award(db, user.id, "checkin", String(id), now, found.name);
      if (earn.length) await db.batch(earn);
      const cred = await credState(db, user.id, earned("checkin", earn));
      return ok({ checkin: { kind, place, area, building: found.building, name: found.name, since: now, until }, cred }, 201);
    }

    case "PATCH /api/checkin": {
      const until = untilOf((await body(request)).until, now);
      const running = await runningCheckin(db, user.id, now);
      if (!running) throw new AuthError(404, "no_checkin");
      await db.prepare("UPDATE checkins SET until = ? WHERE user_id = ? AND ended_at IS NULL AND until > ?").bind(until, user.id, now).run();
      return ok({ checkin: { ...running, until } });
    }

    case "DELETE /api/checkin": {
      await db.batch([
        closeRanOut(db, user.id, now),
        db.prepare("UPDATE checkins SET ended_at = ?, ended_by = 'user' WHERE user_id = ? AND ended_at IS NULL").bind(now, user.id),
      ]);
      return done();
    }

    case "GET /api/friends/checkins":
      return ok({ checkins: await friendsCheckins(db, user.id, now) });

    // --- Street cred (cred.ts) ---

    case "GET /api/cred":
      return ok(await credSummary(db, user.id, now));

    case "GET /api/cred/log":
      return ok(await credLog(db, user.id, { day: params.get("day"), before: params.get("before") }));

    case "PUT /api/cred/board": {
      const on = (await body(request)).on;
      if (typeof on !== "boolean") throw new AuthError(400, "bad_on");
      return ok(await setBoard(db, user.id, on, now));
    }

    case "GET /api/cred/board":
      return ok(await leaderboard(db, user.id, params.get("range"), now, (u) => ({ username: u.username, ...bubbleOf(u) }), params.get("after")));

    case "POST /api/cred/invite": {
      const kind = (await body(request)).kind;
      if (typeof kind !== "string" || !INVITE_KINDS.has(kind)) throw new AuthError(400, "bad_kind");
      const earn = await award(db, user.id, "invite", null, now);
      if (earn.length) await db.batch(earn);
      return ok({ cred: await credState(db, user.id, earned("invite", earn)) });
    }

    // --- Report votes (plan section 9): 👍, 👎 or none on someone else's report of the past 4 hours ---

    case "POST /api/reports/vote": {
      const b = await body(request);
      const id = b.id;
      if (!Number.isInteger(id) || (id as number) < 1 || !(b.up === true || b.up === false || b.up === null)) throw new AuthError(400, "bad_vote");
      const report = await lookupReport(id as number);
      return ok(await castVote(db, user.id, id as number, b.up as boolean | null, report, REPORT_LOG_MS, now));
    }

    // --- Meal ratings (plan section 10, ratings.ts): GET /api/meal-ratings is public and answered by index.ts ---

    case "PUT /api/meal-ratings":
      return ok(await rateMeal(db, user.id, await body(request), lookupDish, now));
    case "DELETE /api/meal-ratings":
      return ok(await unrateMeal(db, user.id, await body(request), lookupDish, now));
  }
  return answer({ detail: "Method not allowed" }, 405);
}

/** The account endpoints (plan 7.1). Hosts without sign-in answer 404 `sign_in_off`, like /auth/*. */
export async function handleSocial(
  request: Request,
  url: URL,
  env: SocialEnv,
  lookup: LookupPlace,
  now = Date.now(),
  lookupReport: LookupReport = async () => null,
  lookupDish: LookupDish = async () => null,
): Promise<Response> {
  const cfg = authConfig(request, env);
  if (!cfg) return answer({ detail: "sign_in_off" }, 404);
  try {
    return await route(request, url, cfg, env, lookup, now, lookupReport, lookupDish);
  } catch (e) {
    if (e instanceof AuthError) {
      return answer({ detail: e.code }, e.status, e.status === 429 ? { "Retry-After": "60" } : {});
    }
    console.error(`Account request ${request.method} ${url.pathname} failed: ${e instanceof Error ? e.stack : e}`);
    return answer({ detail: "Something went wrong. Please try again." }, 500);
  }
}
