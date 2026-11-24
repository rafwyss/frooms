// frooms Worker: JSON API under /api (port of app/main.py); everything else is served from static/.

import { type Block, dayBlocks, makeStatus, mergeBlocks, parseAllocations, roomStatus, type Status } from "./availability";
import { areaList, buildingCounts, ethUrl, filterRooms, parseCatalogue, type Room, roomPath, typeCounts } from "./catalogue";
import {
  COOKPIT_CLIENT,
  COOKPIT_URL,
  DEFAULT_AREA,
  DEFAULT_TYPECODES,
  FILTER_DEFAULT_TYPECODES,
  FOOD2050_PHOTO,
  FOOD2050_PHOTO_URL,
  MEET_TYPECODES,
  HISTORY_DAYS,
  HTTP_TIMEOUT_MS,
  MAP_MIN_FREE_MINUTES,
  MAX_BUILDINGS_PER_REQUEST,
  MAX_ROOMS_PER_REQUEST,
  MEAL_IMAGE_CACHE_S,
  MEAL_IMAGE_DAYS,
  MEAL_IMAGE_WIDTH,
  MENU_CACHE_S,
  MENSA_PARTNERS,
  mensaAreas,
  MENU_CRON,
  MONTHS_AHEAD,
  NIGHTLY_MAX_AGE_S,
  OCCUPANCY_MAX_AGE_S,
  PREFETCH_DAYS_AHEAD,
  PREFETCH_MAX_AGE_S,
  REPORT_NOW_MS,
  AREAS,
  UZH_MAX_AGE_S,
  UZH_MENU_CRON,
  userAgent,
} from "./config";
import { hasScreen, readEquipment } from "./equipment";
import { BudgetExhausted, EthClient, ethBackoffUntil, mapLimit, noteBackoff, RateLimited } from "./eth";
import { experimentSummary } from "./experiment";
import { FeedbackError, feedbackEmail, saveFeedback } from "./feedback";
import { buildingDetail, type MapRoom, type MapSpace, summarise } from "./map";
import {
  cardMeal,
  eateryPlaces,
  flagshipDish,
  fullMeals,
  type MealName,
  kindNow,
  mealIntervals,
  mealOf,
  menuHours,
  type MenuDay,
  mondayOf,
  parseFacilities,
  type Place,
  weekdayHours,
} from "./menus";
import microwavesFile from "../data/microwaves.json";
import { MENSA_ORDER, ROOM_MANAGERS } from "./overrides";
import { isQuiet, isRefreshed, prefetchTargets, refreshedTargets, runMenuPrefetch, runPrefetch } from "./prefetch";
import { type Estimate, estimate, locationUrl, parseHours, parseSpaces, type Space, spaceState } from "./spaces";
import {
  type DayRow,
  isMenuImage,
  type MenuTimes,
  type Meta,
  type SpacesLive,
  readCatalogue,
  readDays,
  readEateriesCatalogue,
  readFetches,
  readMenuDate,
  readMenuDates,
  readMenuRange,
  readMenuTimes,
  readMeta,
  readSlots,
  readSpacesCatalogue,
  readSpacesLive,
  readUzhCatalogue,
  readUzhLibraries,
  readUzhMenuState,
  readUzhSpacesLive,
  readUzhState,
  unpack,
} from "./store";
import { isPlaceKind, parseRemoval, parseReport, type PlaceKind, readReport, readReportLog, readReportSummaries, removeReport, ReportError, saveReport } from "./reports";
import { addDays, addMonths, type IsoDate, ONE_MINUTE, parseQueryTime, toZurichIso, weekday, zurichDate, zurichToUtc } from "./tz";
import { isUzhArea, mapBuilding, parseUzhCatalogue, UZH_AREAS, UZH_CAMPUSES, UZH_MAP_BUILDINGS } from "./uzh";
import { uzhMensaPlaces, uzhMensaUrl } from "./uzhmenus";
import { runUzhMenuPrefetch, runUzhPrefetch } from "./uzhprefetch";
import { closureAt, uzhLibraries } from "./uzhspaces";
import { readUsual, slotOf, usualField } from "./usual";
import { authConfig, handleAuth, optionalUser } from "./auth";
import { award, type CredAction, credState, earned, removedReportStatements, type ReportMarks, reportMarks } from "./cred";
import { dishKey, readMealRatings } from "./ratings";
import { handleSocial, type PlaceKind as AccountPlaceKind, SOCIAL_PATHS, type SocialEnv } from "./social";
import { handleStats, type StatsEnv } from "./stats";
import { handleAdmin } from "./admin";
import { BUG_PENDING_MAX, linkBug, pendingBugs } from "./bugs";

/** The accounts' bindings, variables and secrets (ACCOUNTS, EDUID_*, SESSION_KEY, limiters) come from SocialEnv. */
export interface Env extends SocialEnv, StatsEnv {
  /** Comma-separated edu-ID ids that may read GET /api/admin/stats (a secret; empty or unset: nobody). */
  ADMIN_IDS?: string;
  /** The admin page's visits (worker/admin.ts): a read-only token (secret), the account and the Web Analytics site (vars). */
  CF_ANALYTICS_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_SITE_TAG?: string;
  ASSETS: Fetcher;
  ROOMS?: KVNamespace;
  DB: D1Database;
  FROOMS_CONTACT?: string;
  FROOMS_DISABLED?: string;
  RATE_LIMITER?: RateLimit;
  IMAGES?: ImagesBinding; // optional: dish photos are resized when it's configured, passed through otherwise
  FEEDBACK_LIMITER?: RateLimit;
  /** Sends a notification per feedback to FEEDBACK_TO (a secret: a verified Email Routing destination). */
  FEEDBACK_EMAIL?: SendEmail;
  FEEDBACK_TO?: string;
  REPORT_LIMITER?: RateLimit;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...headers },
  });
}

const csv = (value: string | null) => new Set((value ?? "").split(",").map((v) => v.trim()).filter(Boolean));
const iso = (ms: number | null) => (ms === null ? null : toZurichIso(ms));
const minutes = (ms: number | null) => (ms === null ? null : Math.floor(ms / ONE_MINUTE));

function intParam(params: URLSearchParams, name: string): number | null {
  const v = params.get(name);
  if (v === null || v === "") return null;
  if (!/^\d+$/.test(v)) throw new HttpError(400, `${name} must be a whole number`);
  return Number(v);
}

/** ETH's raw catalogue, and every room: ETH's, then UZH's (worker/uzh.ts). */
async function rooms(env: Env) {
  const [raw, uzh] = await Promise.all([readCatalogue(env.ROOMS), readUzhCatalogue(env.ROOMS)]);
  return { raw, rooms: [...parseCatalogue(raw), ...parseUzhCatalogue(uzh.raw)] };
}

/** A room's status from its allocations' blocks. A UZH room's fetched day without any block is free (ETH's always have some). */
function statusOf(room: Room, blocks: Block[], at: number): Status {
  return room.uzh && !blocks.length ? makeStatus({ state: "free" }) : roomStatus(blocks, at);
}

/** Whether `at` is (about) now: reports are only shown then. */
const isNow = (at: number, now: number) => Math.abs(at - now) <= REPORT_NOW_MS;

/** The dates visitors may pick: the history and MONTHS_AHEAD months ahead, within the range ETH has data for. */
async function allowedDates(meta: Meta, client: EthClient, now = Date.now()): Promise<[string, string]> {
  const [lo, hi] = meta.minmax ? [meta.minmax.min, meta.minmax.max] : await client.minMaxDates();
  const today = zurichDate(now);
  const [from, to] = [addDays(today, -HISTORY_DAYS), addMonths(today, MONTHS_AHEAD)];
  return [lo > from ? lo : from, hi < to ? hi : to];
}

/**
 * How old a stored day may be before it counts as missing. A refreshed room's today and tomorrow must be recent
 * during the day; the night and the first hours after it are exempt, since refreshing pauses then.
 */
function maxAgeMs(room: Room, day: string, now: number): number {
  if (day < zurichDate(now)) return Infinity; // history: the last fetch of a past day is final
  const maxAge = room.uzh ? UZH_MAX_AGE_S : PREFETCH_MAX_AGE_S;
  const refreshing = isRefreshed(room) && day <= addDays(zurichDate(now), 1) && !isQuiet(now - maxAge * 1000);
  return (refreshing ? maxAge : NIGHTLY_MAX_AGE_S) * 1000;
}

/**
 * The stored allocations for `day` and the morning after, or null if `day` isn't stored. A day older than maxAgeMs is
 * still returned, as `stale`: the last bookings we have (ETH not answering, say) beat none, and the page says how old.
 */
function prefetched(rows: Map<string, DayRow> | undefined, room: Room, day: string, now: number): Loaded {
  const own = rows?.get(day);
  if (!own) return null;
  const next = rows!.get(addDays(day, 1));
  const at = Math.min(own.at, next?.at ?? own.at);
  const value = unpack([...own.raw, ...(next?.raw ?? [])]) as unknown;
  return now - own.at > maxAgeMs(room, day, now) ? { at, value, stale: own.at } : { at, value };
}

function roomEntry(room: Room, status: Status, at: number) {
  const entry: Record<string, unknown> = {
    room: roomPath(room),
    building: room.building,
    seats: room.seats,
    type: room.type,
    typecode: room.typecode,
    status: status.state,
    free_until: iso(status.free_until),
    busy_until: iso(status.busy_until),
    current_title: status.current_title,
    current_kind: status.current_kind,
    current_until: iso(status.current_until),
    next_title: status.next_title,
    next_kind: status.next_kind,
    next_gap_minutes: minutes(status.next_gap),
    short_gap: status.short_gap,
    eth_url: ethUrl(room),
  };
  if (status.state === "free") entry.minutes = status.free_until !== null ? minutes(status.free_until - at) : null;
  else if (status.state === "busy") entry.minutes = minutes(status.busy_until! - at);
  // A room a department also books itself (data/overrides.json `rooms`): where ETH lists nothing it isn't free but
  // "managed" (its minutes and free_until still say how long ETH lists nothing). ETH's own bookings stay busy.
  const manager = room.uzh ? undefined : ROOM_MANAGERS[roomPath(room)];
  if (manager) {
    entry.managed_by = manager;
    if (status.state === "free") entry.status = "managed";
  }
  return entry;
}

function sortKey(entry: Record<string, unknown>): [number, number] {
  const m = entry.minutes as number | null | undefined;
  if (entry.status === "free") return [0, -(m ?? 1e9)];
  if (entry.status === "managed") return [1, -(m ?? 1e9)];
  if (entry.status === "busy") return [2, m!];
  return [3, entry.status === "pending" ? 1 : 0];
}

/** A UZH room's day outside what the prefetch stores (no on-demand requests to UZH). */
const NOT_STORED = { at: 0, value: [] as unknown };

// `stale`: when the day was fetched, if that's longer ago than maxAgeMs (it's still shown, marked as such).
type Loaded = { at: number; value: unknown; stale?: number } | null;

/** Where rooms' days come from for one chosen day: D1's prefetched month and history, else ETH on demand. */
interface DaySource {
  day: IsoDate;
  now: number;
  inRange: boolean; // within the prefetched month
  rows: Map<string, Map<string, DayRow>>;
  targets: Set<string>;
  client: EthClient;
}

/** Read the stored rows of `rooms` for `day` (and the morning after) when the day is in the stored range. */
async function daySource(env: Env, raw: unknown[], rooms: Room[], day: IsoDate, client: EthClient): Promise<DaySource> {
  const now = Date.now();
  const today = zurichDate(now);
  const inRange = today <= day && day <= addDays(today, PREFETCH_DAYS_AHEAD);
  const rows = new Map<string, Map<string, DayRow>>();
  if (inRange || (addDays(today, -HISTORY_DAYS) <= day && day < today)) {
    for (const row of await readDays(env.DB, rooms.map(roomPath), [day, addDays(day, 1)])) {
      if (!rows.has(row.path)) rows.set(row.path, new Map());
      rows.get(row.path)!.set(row.day, row);
    }
  }
  return { day, now, inRange, rows, targets: new Set(prefetchTargets(raw)), client };
}

/**
 * One room's allocations, following /api/free's rules: D1 first; within the prefetched range, prefetch targets that
 * aren't stored yet are "pending" (null) rather than fetched, so visitors never multiply the load on ETH; later days,
 * and past days missing from the history, are fetched on demand. UZH rooms are only ever read from D1.
 */
async function loadRoom(r: Room, src: DaySource): Promise<Loaded> {
  const path = roomPath(r);
  const stored = prefetched(src.rows.get(path), r, src.day, src.now);
  if (stored) return stored;
  if (src.inRange && (src.targets.has(path) || r.uzh)) return null;
  if (r.uzh) return NOT_STORED;
  return src.client.allocations(path, src.day);
}

/** A room's /api/free entry from what loadRoom found. */
function entryOf(room: Room, res: PromiseSettledResult<Loaded>, at: number) {
  if (res.status === "fulfilled" && res.value === null) {
    return { ...roomEntry(room, makeStatus({ state: "no_data" }), at), status: "pending" };
  }
  if (res.status === "fulfilled" && res.value === NOT_STORED) return roomEntry(room, makeStatus({ state: "no_data" }), at);
  if (res.status === "rejected") {
    const waiting = res.reason instanceof RateLimited || res.reason instanceof BudgetExhausted;
    if (!waiting) console.warn(`Allocations for ${roomPath(room)} failed: ${res.reason}`);
    return { ...roomEntry(room, makeStatus({ state: "no_data" }), at), status: waiting ? "pending" : "error" };
  }
  const status = statusOf(room, parseAllocations(res.value!.value as unknown[]), at);
  if (status.state === "no_data") console.warn(`No allocation data for ${roomPath(room)} (empty response)`);
  return withStale(roomEntry(room, status, at), res.value);
}

/** A room entry marked with when its data was fetched, if that data is stale. */
function withStale(entry: Record<string, unknown>, loaded: Loaded) {
  if (loaded?.stale !== undefined) entry.stale_since = toZurichIso(loaded.stale);
  return entry;
}

const fetchedAt = (results: PromiseSettledResult<Loaded>[]) =>
  results.flatMap((r) => (r.status === "fulfilled" && r.value && r.value !== NOT_STORED ? [r.value.at] : []));

const anyStale = (results: PromiseSettledResult<Loaded>[]) =>
  results.some((r) => r.status === "fulfilled" && r.value?.stale !== undefined);

const byStatus = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const [ka, kb] = [sortKey(a), sortKey(b)];
  return ka[0] - kb[0] || ka[1] - kb[1];
};

/** The chosen time (`at`, default now), checked against the dates visitors may pick. */
async function chosenTime(params: URLSearchParams, env: Env, client: EthClient) {
  const atParam = params.get("at");
  const at = atParam ? parseQueryTime(atParam) : Date.now();
  if (at === null) throw new HttpError(400, "at must look like 2026-10-29T14:00");
  const meta = await readMeta(env.DB);
  if (meta.backoffUntil > Date.now()) noteBackoff(meta.backoffUntil);
  const [lo, hi] = await allowedDates(meta, client);
  const day = zurichDate(at);
  if (!(lo <= day && day <= hi)) throw new HttpError(400, `Time must be between ${lo} and ${hi}`);
  return { at, day };
}

async function free(params: URLSearchParams, env: Env, client: EthClient) {
  const wanted = csv(params.get("buildings") ?? params.get("building"));
  if (!wanted.size) throw new HttpError(400, "Pick at least one building");
  if (wanted.size > MAX_BUILDINGS_PER_REQUEST) throw new HttpError(400, `Pick at most ${MAX_BUILDINGS_PER_REQUEST} buildings`);
  const { at, day } = await chosenTime(params, env, client);

  const { raw, rooms: all } = await rooms(env);
  const known = new Set(all.map((r) => r.building));
  const unknown = [...wanted].filter((b) => !known.has(b));
  if (unknown.length) throw new HttpError(400, `Unknown building: ${unknown.join(", ")}`);

  const types = csv(params.get("types"));
  const area = params.get("area") || null;
  const selected = filterRooms(all, area, wanted, types.size ? types : new Set(DEFAULT_TYPECODES), intParam(params, "min_seats"));
  if (selected.length > MAX_ROOMS_PER_REQUEST) {
    throw new HttpError(400, `Too many rooms (${selected.length}); ask for fewer buildings or types at once`);
  }

  const src = await daySource(env, raw, selected, day, client);
  const results = await mapLimit(selected, EthClient.concurrency, (r) => loadRoom(r, src));
  const entries = selected.map((room, i) => entryOf(room, results[i], at)).sort(byStatus);
  const fetched = fetchedAt(results);
  return {
    at: toZurichIso(at),
    fetched_at: fetched.length ? toZurichIso(Math.min(...fetched)) : null,
    stale: anyStale(results), // some rooms show data older than it should be (each has `stale_since`)
    rooms: entries,
  };
}

/** A path as visitors type it in links: ETH's "HG E 33.1" (spaces, maybe as "+"), UZH's "KOL-F-101". */
const normalPath = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * One room with its day: the /api/free entry and every booking on the day of `at` (UZH's never have titles). Same
 * rules as /api/free for one room: D1 first, "pending" inside the prefetched range, ETH on demand outside it (never UZH).
 */
async function room(params: URLSearchParams, env: Env, client: EthClient) {
  const path = normalPath(params.get("room") ?? "");
  if (!path) throw new HttpError(400, "Name a room");
  const area = params.get("area") || null;
  const { raw, rooms: all } = await rooms(env);
  const r = all.find((x) => roomPath(x) === path && (!area || x.area === area));
  if (!r) throw new HttpError(404, "Unknown room");
  const { at, day } = await chosenTime(params, env, client);
  const src = await daySource(env, raw, [r], day, client);
  const [res] = await mapLimit([r], 1, (x) => loadRoom(x, src));
  const entry: Record<string, unknown> = entryOf(r, res, at);
  const fetched = fetchedAt([res]);
  const now = Date.now();
  const [equipment, reports] = await Promise.all([
    r.uzh ? null : readEquipment(env.ROOMS, now),
    isNow(at, now) ? readReportSummaries(env.DB, "room", [path], now) : null,
  ]);
  entry.equipment = equipment?.[path]?.flags ?? null;
  entry.reports = reports?.get(path) ?? null;
  entry.blocks = null;
  let bookings: { from: string; to: string; kind: string; title: string | null }[] = [];
  if (res.status === "fulfilled" && res.value && res.value !== NOT_STORED) {
    const [y, m, d] = day.split("-").map(Number);
    const [ny, nm, nd] = addDays(day, 1).split("-").map(Number);
    const from = zurichToUtc(y, m, d);
    const to = zurichToUtc(ny, nm, nd);
    const blocks = parseAllocations(res.value.value as unknown[]);
    entry.blocks = dayBlocks(blocks, day);
    bookings = mergeBlocks(blocks)
      .flatMap((b) => (b.parts.length ? b.parts : [b]))
      .filter((b) => b.end > from && b.start < to)
      .sort((a, b) => a.start - b.start || a.end - b.end)
      .map((b) => ({ from: toZurichIso(b.start), to: toZurichIso(b.end), kind: b.kind, title: r.uzh ? null : b.title }));
  }
  return {
    at: toZurichIso(at),
    fetched_at: fetched.length ? toZurichIso(Math.min(...fetched)) : null,
    stale: anyStale([res]),
    room: entry,
    bookings,
  };
}

// Same order as the page: open spaces with an estimate (least full first), open ones without (most seats first),
// then closed ones (opening soonest first).
function spaceSortKey(s: { open: boolean; occupancy: Estimate | null; seats: number | null; opens_at: number | null }): [number, number] {
  if (s.open && s.occupancy) return [0, s.occupancy.pct];
  if (s.open) return [1, -(s.seats ?? 0)];
  return [2, s.opens_at ?? Infinity];
}

const HHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * The first day after `day` (within the stored week) with meal times, so a mensa can invite for tomorrow's lunch once
 * today's meals are over or it's closed today.
 */
function nextMeals(days: Map<IsoDate, MenuTimes> | undefined, day: IsoDate) {
  for (let i = 1; i < 7; i++) {
    const date = addDays(day, i);
    const meals = days?.get(date)?.meals ?? [];
    if (meals.length) return { date, meals: meals.map(({ meal, from, to }) => ({ meal, from, to })) };
  }
  return null;
}

/** Every place with a menu: ETH's (worker/menus.ts, from the stored lists) and UZH's (worker/uzhmenus.ts). */
async function places(env: Env, now = Date.now()): Promise<{ spaces: Space[]; listAt: number; places: Place[] }> {
  const [list, eateries] = await Promise.all([readSpacesCatalogue(env.ROOMS, now), readEateriesCatalogue(env.ROOMS, now)]);
  const spaces = parseSpaces(list.raw);
  return { spaces, listAt: list.at, places: [...eateryPlaces(parseFacilities(eateries.raw), spaces), ...uzhMensaPlaces()] };
}

/** What the cards and the menu panel need to know about a place. */
function placeInfo(p: Place) {
  return { id: p.id, name: p.name, building: p.building, floor: p.floor, area: p.area, facility: p.facility, kind: p.kind, menu: p.kind === "mensa" };
}

/** What /api/spaces's entries are made from: the places, their meal times for the coming week, ETH's readings. */
interface SpacesContext {
  all: Awaited<ReturnType<typeof places>>;
  times: Map<number, Map<IsoDate, MenuTimes>>;
  day: IsoDate;
  at: number;
  now: number;
  live: SpacesLive | null; // ETH's occupancy readings, for (about) now only
}

async function spacesContext(env: Env, at: number, now: number): Promise<SpacesContext> {
  const day = zurichDate(at);
  const [all, live, times] = await Promise.all([places(env, now), readSpacesLive(env.DB, now), readMenuTimes(env.DB, day, addDays(day, 6))]);
  // Occupancy is a live estimate: only shown for (about) now.
  return { all, times, day, at, now, live: Math.abs(at - now) <= OCCUPANCY_MAX_AGE_S * 1000 ? live : null };
}

const mealsOf = (intervals: [number, number][]) =>
  intervals.map(([f, t]) => ({ meal: mealOf(HHMM(f)) as MealName, from: HHMM(f), to: HHMM(t) }));

/** One of ETH's study spaces (a mensa that is one too: its meal times from its menus, where there are any). */
function studyEntry(s: Space, ctx: SpacesContext) {
  const { all, times, day, at, now } = ctx;
  const place = all.places.find((p) => p.space === s.id);
  const today = place && times.get(place.facility)?.get(day);
  const hours = parseHours(s.hours);
  if (today) hours.meals[weekday(day)] = mealIntervals(today.meals);
  const st = spaceState(s, at, all.listAt, hours);
  const info = place && placeInfo(place);
  return {
    id: s.id,
    room: s.room,
    name: s.name,
    category: s.category,
    building: s.building,
    seats: s.seats,
    features: s.features,
    hours: s.shown_hours ?? s.hours,
    open_text: s.open_text ?? null,
    card24h: s.card24h,
    notice: s.notice,
    info_url: s.info_url,
    kind: place ? kindNow(place, st.meal) : s.category === "mensa" ? "cafe" : null,
    study: true,
    menu: info?.menu ?? false,
    facility: place?.facility ?? null,
    meals_today: today ? today.meals.map(({ meal, from, to }) => ({ meal, from, to })) : mealsOf(hours.meals[weekday(day)]),
    meals_next: place ? nextMeals(times.get(place.facility), day) : null,
    ...st,
    occupancy: st.open ? estimate(ctx.live?.readings[s.id], now) : null,
  };
}

/** A place with menus only (Bellavista, UZH's mensas): open when its menus say so. */
function placeEntry(p: Place, ctx: SpacesContext) {
  const { times, day, at } = ctx;
  const days = times.get(p.facility) ?? new Map<IsoDate, MenuTimes>();
  const today = days.get(day);
  const room = [p.building, p.floor].filter(Boolean).join(" ");
  const info_url = uzhMensaUrl(p.id) ?? locationUrl(p.building, p.floor);
  const space: Space = {
    id: p.id, room, name: p.name, category: "mensa", building: p.building, area: p.area, seats: null, features: [],
    hours: [], card24h: false, notice: null, info_url, eth: { open: false, nextOpen: null },
  };
  const st = spaceState(space, at, 0, p.weekHours ? weekdayHours(p.weekHours) : menuHours(days, day));
  const info = placeInfo(p);
  const hoursToday = p.weekHours
    ? [weekday(day) < 5 ? `Today: ${p.weekHours[0]} - ${p.weekHours[1]}` : "Closed today"]
    : !today ? [] : today.hours.length ? [`Today: ${today.hours.map(([f, t]) => `${f} - ${t}`).join(" and ")}`] : ["Closed today"];
  return {
    id: p.id,
    room,
    name: p.name,
    category: "mensa" as const,
    building: p.building,
    seats: null,
    features: [],
    hours: hoursToday,
    card24h: false,
    notice: null,
    info_url,
    kind: kindNow(p, st.meal),
    study: p.study === true,
    menu: info.menu,
    facility: p.facility,
    meals_today: today ? today.meals.map(({ meal, from, to }) => ({ meal, from, to })) : [],
    meals_next: nextMeals(days, day),
    ...st,
    occupancy: null as Estimate | null,
  };
}

/** The places with menus only of `area`. */
const ownPlaces = (area: string, ctx: SpacesContext) => ctx.all.places.filter((p) => !p.space && p.area === area).map((p) => placeEntry(p, ctx));

/**
 * The Zentrum partner's mensas and cafeterias (MENSA_PARTNERS), for the mensa list and the map: marked `partner`, with
 * their own area (stars and links use it). The page leaves them out of the study tab.
 */
function partnerMensas(area: string, ctx: SpacesContext) {
  const partner = MENSA_PARTNERS[area];
  if (!partner) return [];
  const study = ctx.all.spaces.filter((s) => s.area === partner && s.category === "mensa").map((s) => studyEntry(s, ctx));
  return [...study, ...ownPlaces(partner, ctx)].map((e) => ({ ...e, area: partner, partner: true }));
}

/**
 * Study spaces, libraries and mensas of one area at a time, and the places with menus only, served from the prefetched
 * feeds and menus. A mensa's meal times come from its menus where there are any (else from the study-space feed);
 * a place with menus only is open when its menus say so. In Zentrum, the other university's mensas too.
 */
async function spacesList(params: URLSearchParams, env: Env, extras = true) {
  const atParam = params.get("at");
  const now = Date.now();
  const at = atParam ? parseQueryTime(atParam) : now;
  if (at === null) throw new HttpError(400, "at must look like 2026-10-29T14:00");
  const area = params.get("area") || DEFAULT_AREA;
  let answer: ReturnType<typeof spacesAnswer<SpaceEntry>> & { source?: string };
  if (isUzhArea(area)) answer = await uzhSpacesList(area, at, now, env);
  else {
    const ctx = await spacesContext(env, at, now);
    const study = ctx.all.spaces.filter((s) => s.area === area).map((s) => studyEntry(s, ctx));
    answer = spacesAnswer<SpaceEntry>([...study, ...ownPlaces(area, ctx), ...partnerMensas(area, ctx)], at, ctx.live?.at ?? null, now);
  }
  return extras ? withSpaceExtras(answer, area, at, now, env) : answer;
}

/** The location's mensas in our order (data/overrides.json `mensa_order`; the Zentrum partner shares Zentrum's). */
const mensaOrder = (area: string): string[] => MENSA_ORDER[area] ?? MENSA_ORDER[MENSA_PARTNERS[area] ?? ""] ?? [];

interface Microwave {
  id: string;
  area: string;
  building: string;
  name: string;
  count: number;
  place: string | null;
  floor: string | null; // the level of the building's floor plans they're on
  at: [number, number] | null; // where, in the campus drawing's metres (the floor plans' frame)
  check?: boolean; // a provisional spot, to fix in the map's pin mode
}
const MICROWAVES = microwavesFile.microwaves as Microwave[];

/** A microwave spot's name, as its page and a report's log show it: "Einstein microwaves" ("BIN Microwaves" stays). */
const microwaveName = (m: Microwave) => (/microwave/i.test(m.name) ? m.name : `${m.name} microwaves`);

/** What a /api/spaces entry has that the Eat tab's card needs for its flagship dish. */
interface CardSource {
  id: string;
  menu?: boolean;
  facility?: number | null;
  meals_today?: { meal: MealName; from: string; to: string }[];
  meals_next?: { date: IsoDate; meals: { meal: MealName; from: string; to: string }[] } | null;
}

/** The Eat tab's card line: the flagship line's dish of the current or next meal (worker/menus.ts flagshipDish). */
interface Flagship {
  line: string;
  name: string;
  price: { student: number | null; internal: number | null; external: number | null };
  image: number | string | null; // only while /api/meal-image serves it (today's and tomorrow's dishes)
}

/**
 * Each mensa's flagship dish for the Eat tab's cards, from the stored menus of the day of `at` and of the next day with
 * meals (one D1 read for all of them): null for a place without a menu or without dishes for that meal.
 */
async function flagships(entries: CardSource[], at: number, now: number, env: Env): Promise<Map<string, Flagship | null>> {
  const out = new Map<string, Flagship | null>();
  const mensas = entries.filter((s) => s.menu && s.facility != null);
  if (!mensas.length) return out;
  const day = zurichDate(at);
  const hhmm = toZurichIso(at).slice(11, 16);
  const picks = new Map(mensas.map((s) => [s.id, cardMeal(s.meals_today ?? [], s.meals_next ?? null, day, hhmm)]));
  const dates = [...new Set([...picks.values()].flatMap((p) => (p ? [p.date] : [])))];
  const [{ places: all }, menus] = await Promise.all([
    places(env, now),
    readMenuDates(env.DB, [...new Set(mensas.map((s) => s.facility!))], dates),
  ]);
  const lines = new Map(all.map((p) => [p.facility, p.flagship]));
  const lastPhotoDay = addDays(zurichDate(now), MEAL_IMAGE_DAYS - 1);
  for (const s of mensas) {
    const pick = picks.get(s.id);
    const dishes = pick ? (menus.get(s.facility!)?.get(pick.date)?.meals.find((m) => m.meal === pick.meal)?.dishes ?? []) : [];
    const dish = flagshipDish(dishes, lines.get(s.facility!) ?? null);
    out.set(s.id, dish && pick ? { line: dish.line, name: dish.name, price: dish.price, image: pick.date <= lastPhotoDay ? dish.image : null } : null);
  }
  return out;
}

/**
 * What /api/spaces adds for the page (not for the map's own use of the list): each space's occupancy reports of the
 * past 2 hours (now only, else null), how full it usually is on that weekday (`usual`, spaces with a sensor history),
 * each mensa's `flagship` dish for the Eat tab's card, the microwaves of the location (data/microwaves.json; both
 * Zentrum campuses get Zentrum's) and `order`, the location's mensas in our order (mensaOrder), for the page's lists
 * and the map's labels where no position is known.
 */
async function withSpaceExtras<T extends { spaces: CardSource[] }>(answer: T, area: string, at: number, now: number, env: Env) {
  const ids = answer.spaces.map((s) => s.id);
  const areas = mensaAreas(area);
  const micro = MICROWAVES.filter((m) => areas.includes(m.area));
  const [reports, usual, dishes, queues] = await Promise.all([
    isNow(at, now) ? readReportSummaries(env.DB, "space", ids, now) : null,
    readUsual(env.DB, slotOf(at).weekday, now),
    flagships(answer.spaces, at, now, env),
    isNow(at, now) && micro.length ? readReportSummaries(env.DB, "microwave", micro.map((m) => m.id), now) : null,
  ]);
  return {
    ...answer,
    spaces: answer.spaces.map((s) => ({ ...s, reports: reports?.get(s.id) ?? null, usual: usualField(usual.get(s.id), at), flagship: dishes.get(s.id) ?? null })),
    microwaves: micro.map((m) => ({ ...m, reports: queues?.get(m.id) ?? null })),
    order: mensaOrder(area),
  };
}

type SpaceEntry = { id: string; name: string; open: boolean; seats: number | null; until: number | null; opens_at: number | null; open_until: number | null; occupancy: Estimate | null };

/** /api/spaces's answer: the spaces in the page's order, times as Zurich ISO strings. */
function spacesAnswer<T extends SpaceEntry>(entries: T[], at: number, fetchedAt: number | null, now: number) {
  const spaces = [...entries].sort((a, b) => {
    const [ka, kb] = [spaceSortKey(a), spaceSortKey(b)];
    return ka[0] - kb[0] || ka[1] - kb[1] || a.name.localeCompare(b.name);
  });
  return {
    at: toZurichIso(at),
    fetched_at: iso(fetchedAt),
    spaces: spaces.map(({ until, opens_at, open_until, occupancy, ...s }) => ({
      ...s,
      until: iso(until),
      opens_at: iso(opens_at),
      open_until: iso(open_until),
      occupancy: occupancy && {
        pct: occupancy.pct,
        status: occupancy.status,
        trend: occupancy.trend,
        age_minutes: Math.max(0, Math.floor((now - occupancy.measured_at) / ONE_MINUTE)),
      },
    })),
  };
}

/**
 * UZH's libraries in one area (worker/uzhspaces.ts), with the seat sensors' readings for (about) now. Closed during
 * the library's closures (holidays), with the closure as the notice. Then UZH's mensas there (and on UZH Zentrum, ETH
 * Zentrum's).
 */
async function uzhSpacesList(area: string, at: number, now: number, env: Env) {
  const [list, live, ctx] = await Promise.all([readUzhLibraries(env.ROOMS, now), readUzhSpacesLive(env.DB, now), spacesContext(env, at, now)]);
  const current = Math.abs(at - now) <= OCCUPANCY_MAX_AGE_S * 1000 ? live : null;
  const libraries = uzhLibraries(list.raw)
    .filter((s) => s.area === area)
    .map(({ closures, cardHours, eth, area: _, ...s }) => {
      const closure = closureAt({ ...s, eth, area, closures, cardHours }, at);
      const space = { ...s, eth, area };
      let st = spaceState(space, at, 0);
      // Outside the regular hours but inside the UZH-card ones (UB Sciences after 17:00): open with a UZH card.
      let cardUzh = false;
      if (!st.open && cardHours) {
        const card = spaceState({ ...space, hours: cardHours }, at, 0);
        if (card.open) {
          st = { ...st, open: true, card_only: true, until: card.until, open_until: card.until, opens_at: null };
          cardUzh = true;
        }
      }
      if (closure) {
        const after = spaceState(space, closure[1], 0);
        st = { ...st, open: false, until: null, open_until: null, card_only: false, opens_at: after.open ? closure[1] : after.opens_at };
        cardUzh = false;
      }
      return {
        ...s,
        card_uzh: cardUzh,
        notice: closure ? `Closed${closure[2] ? `: ${closure[2]}` : ""}` : s.notice,
        kind: null,
        study: true,
        menu: false,
        facility: null,
        meals_today: [],
        meals_next: null,
        ...st,
        occupancy: st.open ? estimate(current?.readings[s.id], now) : null,
      };
    });
  const entries = [...libraries, ...ownPlaces(area, ctx), ...partnerMensas(area, ctx)];
  return { ...spacesAnswer<SpaceEntry>(entries, at, current?.at ?? null, now), source: "uzh" };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateParam(params: URLSearchParams, name: string, fallback: IsoDate): IsoDate {
  const v = params.get(name);
  if (!v) return fallback;
  if (!DATE.test(v) || Number.isNaN(Date.parse(v + "T00:00:00Z"))) throw new HttpError(400, `${name} must look like 2026-10-29`);
  return v;
}

/** One place's days from `from` (default today), for the menu panel's day and week views, and its meal stepper. */
async function menu(params: URLSearchParams, env: Env) {
  const now = Date.now();
  const today = zurichDate(now);
  const from = dateParam(params, "from", today);
  const days = intParam(params, "days") ?? 7;
  if (days < 1 || days > 21) throw new HttpError(400, "days must be between 1 and 21");
  const { places: all } = await places(env, now);
  const place = all.find((p) => p.id === params.get("place"));
  if (!place) throw new HttpError(404, "Unknown place");
  const [rows, slots] = await Promise.all([
    readMenuRange(env.DB, place.facility, from, addDays(from, days - 1)),
    readSlots(env.DB, [place.facility], mondayOf(today)),
  ]);
  return {
    place: placeInfo(place),
    today,
    from,
    days: rows.map((r) => ({ date: r.date, ...fullMeals(JSON.parse(r.data) as MenuDay) })),
    slots,
  };
}

/**
 * Every place of an area (and its Zentrum partner) on one day, for the comparison, and the meals any of them has a menu
 * for. Dishes that aren't full meals are left out here and in /api/menu (worker/menus.ts isFullMeal); `order` as in
 * /api/spaces.
 */
async function menus(params: URLSearchParams, env: Env) {
  const now = Date.now();
  const today = zurichDate(now);
  const area = params.get("area") || DEFAULT_AREA;
  const date = dateParam(params, "date", today);
  const { places: all } = await places(env, now);
  const areas = mensaAreas(area);
  const inArea = all.filter((p) => areas.includes(p.area));
  const facilities = [...new Set(inArea.map((p) => p.facility))];
  const [byFacility, slots] = await Promise.all([readMenuDate(env.DB, facilities, date), readSlots(env.DB, facilities, mondayOf(today))]);
  return {
    area,
    date,
    today,
    places: inArea
      .map((p) => { const day = byFacility.get(p.facility); return { ...placeInfo(p), day: day ? fullMeals(day) : null }; })
      .sort((a, b) => a.name.localeCompare(b.name)),
    slots,
    order: mensaOrder(area),
  };
}

/**
 * A dish photo, only for dishes on today's and tomorrow's menus (so this is no open proxy to ETH or food2050), resized
 * when an Images binding is configured. Cached for a day in the colo's cache. `id` is Cookpit's image id (ETH), or the
 * photo's object name in food2050's bucket (UZH, FOOD2050_PHOTO).
 */
async function mealImage(path: string, env: Env, ctx: ExecutionContext): Promise<Response> {
  const today = zurichDate(Date.now());
  let id: string;
  try {
    id = decodeURIComponent(path);
  } catch {
    return json({ detail: "Unknown image" }, 404);
  }
  const cookpit = /^\d{1,10}$/.test(id);
  if ((!cookpit && !FOOD2050_PHOTO.test(id)) || !(await isMenuImage(env.DB, today, addDays(today, MEAL_IMAGE_DAYS - 1), cookpit ? Number(id) : id))) {
    return json({ detail: "Unknown image" }, 404);
  }
  const cacheKey = new Request(`https://cache.frooms.internal/meal-image/${id}`);
  const cache = typeof caches !== "undefined" ? caches.default : undefined;
  const hit = await cache?.match(cacheKey);
  if (hit) return hit;
  if (cookpit && Date.now() < ethBackoffUntil()) return json({ detail: "ETH asked us to wait" }, 503, { "Retry-After": "120" });

  const source = cookpit ? `${COOKPIT_URL}/images/${id}?client-id=${COOKPIT_CLIENT}` : `${FOOD2050_PHOTO_URL}${encodeURIComponent(id)}`;
  const resp = await fetch(source, {
    headers: { "User-Agent": userAgent(env.FROOMS_CONTACT) },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  }).catch(() => null);
  if (cookpit && resp && (resp.status === 429 || resp.status === 503)) noteBackoff(Date.now() + 120_000);
  if (!resp?.ok || !resp.body) return json({ detail: "Photo not available" }, 502);
  let image: Response;
  try {
    image = env.IMAGES
      ? (await env.IMAGES.input(resp.body).transform({ width: MEAL_IMAGE_WIDTH }).output({ format: "image/webp" })).response()
      : new Response(resp.body, { headers: { "Content-Type": resp.headers.get("Content-Type") ?? "image/jpeg" } });
  } catch (e) {
    console.warn(`Resizing meal image ${id} failed: ${e}`);
    return json({ detail: "Photo not available" }, 502);
  }
  const headers = new Headers({ "Content-Type": image.headers.get("Content-Type") ?? "image/jpeg", "Cache-Control": `public, max-age=${MEAL_IMAGE_CACHE_S}`, "X-Content-Type-Options": "nosniff" });
  const out = new Response(image.body, { headers });
  if (cache) ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

/**
 * The map's per-building summary for one area: open study spaces and lecture halls / seminar rooms free for at least
 * `min_free` minutes (default MAP_MIN_FREE_MINUTES), and `order`, the location's mensas in our order (mensaOrder: which
 * place labels win where they crowd). Served from D1 and the prefetched feeds only, never from ETH, so
 * it needs no rate limit and covers the whole area in one request. Rooms not stored yet count as unknown. With
 * `building` (the floor view), the answer also has that building's rooms, spaces and places one by one (`detail`).
 * With `rooms=1` it also lists the area's rooms of `types` (default FILTER_DEFAULT_TYPECODES) with at least
 * `min_seats` seats, as /api/free entries in /api/free's order (null outside the stored range): the Meet list.
 */
async function mapSummary(params: URLSearchParams, env: Env) {
  const now = Date.now();
  const atParam = params.get("at");
  const at = atParam ? parseQueryTime(atParam) : now;
  if (at === null) throw new HttpError(400, "at must look like 2026-10-29T14:00");
  const area = params.get("area") || DEFAULT_AREA;
  const minFree = intParam(params, "min_free") ?? MAP_MIN_FREE_MINUTES;
  if (minFree < 30 || minFree > 240) throw new HttpError(400, "min_free must be between 30 and 240");
  const withRooms = params.get("rooms") === "1";
  const asked = csv(params.get("types"));
  const types = asked.size ? asked : new Set(FILTER_DEFAULT_TYPECODES);
  const minSeats = intParam(params, "min_seats");

  const today = zurichDate(now);
  const day = zurichDate(at);
  const stored = addDays(today, -HISTORY_DAYS) <= day && day <= addDays(today, PREFETCH_DAYS_AHEAD);
  const equip = params.get("equip") || null;
  if (equip !== null && equip !== "screen") throw new HttpError(400, "equip must be screen");
  const [{ rooms: all }, spaces] = await Promise.all([rooms(env), spacesList(params, env, false)]);

  // One D1 read for both: the map's types (lecture halls and seminar rooms) and the list's.
  let summaryRooms: MapRoom[] | null = null;
  let listed: Record<string, unknown>[] | null = null;
  const fetched: number[] = [];
  let stale = false; // some room's data is older than it should be (worker/config.ts PREFETCH_MAX_AGE_S)
  if (stored) {
    const union = new Set([...DEFAULT_TYPECODES, ...(withRooms ? types : [])]);
    const selected = filterRooms(all, area, null, union);
    const rows = new Map<string, Map<string, DayRow>>();
    for (const row of await readDays(env.DB, selected.map(roomPath), [day, addDays(day, 1)])) {
      if (!rows.has(row.path)) rows.set(row.path, new Map());
      rows.get(row.path)!.set(row.day, row);
    }
    const entries = selected.map((room) => {
      const hit = prefetched(rows.get(roomPath(room)), room, day, now);
      if (!hit) return { room, blocks: null, entry: { ...roomEntry(room, makeStatus({ state: "no_data" }), at), status: "pending" } };
      fetched.push(hit.at);
      if (hit.stale !== undefined) stale = true;
      const blocks = parseAllocations(hit.value as unknown[]);
      return { room, blocks, entry: withStale(roomEntry(room, statusOf(room, blocks, at), at), hit) };
    });
    summaryRooms = entries.filter(({ room }) => DEFAULT_TYPECODES.includes(room.typecode)).map(({ entry }) => entry as unknown as MapRoom);
    if (withRooms) {
      // Each listed room with its equipment (null: unknown), its day for the schedule bar and its reports (now only).
      const equipment = await readEquipment(env.ROOMS, now);
      listed = entries
        .filter(({ room }) => types.has(room.typecode) && (!minSeats || (room.seats ?? 0) >= minSeats))
        .map(({ room, blocks, entry }) => ({
          ...entry,
          equipment: room.uzh ? null : (equipment[roomPath(room)]?.flags ?? null),
          blocks: blocks && dayBlocks(blocks, day),
        }))
        .filter((e) => equip !== "screen" || hasScreen(e.equipment) !== false)
        .sort(byStatus);
      const reports = isNow(at, now) ? await readReportSummaries(env.DB, "room", listed.map((e) => e.room as string), now) : null;
      for (const e of listed) e.reports = reports?.get(e.room as string) ?? null;
    }
  }
  // UZH buildings drawn as part of another (KOH in KOL's outline) count there.
  const drawn = <T extends { building: string }>(xs: T[]) => (isUzhArea(area) ? xs.map((x) => ({ ...x, building: mapBuilding(x.building) })) : xs);
  // With `building`: that building's rooms, spaces and places one by one, for its floor plans.
  const building = params.get("building");
  return {
    at: toZurichIso(at),
    fetched_at: fetched.length ? toZurichIso(Math.min(...fetched)) : null,
    stale,
    min_free: minFree,
    order: mensaOrder(area),
    // Buildings drawn as part of another ({ KOH: "KOL" }): the Meet list shows their rooms when that one is picked.
    parts: isUzhArea(area) ? UZH_MAP_BUILDINGS : {},
    buildings: summarise(summaryRooms && drawn(summaryRooms), drawn(spaces.spaces as unknown as MapSpace[]), minFree),
    ...(building ? { detail: buildingDetail(building, summaryRooms, spaces.spaces as unknown as MapSpace[], minFree) } : {}),
    ...(withRooms ? { rooms: listed } : {}),
  };
}

/**
 * Everything search looks through, for all five locations in one small answer (arrays, not objects): rooms as
 * [path, area, typecode, seats]; study spaces, libraries, mensas and cafeterias as [id, area, name, room, category or
 * kind]; buildings as [code, area] (the page names them from its campus drawings).
 */
async function searchIndex(env: Env) {
  const now = Date.now();
  const areas = new Set([...AREAS, ...UZH_AREAS]);
  const [{ rooms: all }, eth, uzh] = await Promise.all([rooms(env), places(env, now), readUzhLibraries(env.ROOMS, now)]);
  const roomRows = all.filter((r) => areas.has(r.area)).map((r) => [roomPath(r), r.area, r.typecode, r.seats]);
  const placeOf = new Map(eth.places.filter((p) => p.space).map((p) => [p.space!, p]));
  const spaces: [string, string, string, string, string][] = [
    ...eth.spaces.filter((s) => areas.has(s.area)).map((s): [string, string, string, string, string] =>
      [s.id, s.area, s.name, s.room, s.category === "mensa" ? (placeOf.get(s.id)?.kind ?? "cafe") : s.category]),
    ...eth.places.filter((p) => !p.space && areas.has(p.area)).map((p): [string, string, string, string, string] =>
      [p.id, p.area, p.name, [p.building, p.floor].filter(Boolean).join(" "), p.kind]),
    ...uzhLibraries(uzh.raw).filter((s) => areas.has(s.area)).map((s): [string, string, string, string, string] =>
      [s.id, s.area, s.name, s.room, s.category]),
  ];
  const buildings = new Map<string, [string, string]>();
  const add = (code: string, area: string) => {
    const b = isUzhArea(area) ? mapBuilding(code) : code;
    if (b) buildings.set(`${area}|${b}`, [b, area]);
  };
  for (const r of all) if (areas.has(r.area)) add(r.building, r.area);
  for (const s of eth.spaces) if (areas.has(s.area)) add(s.building, s.area);
  for (const p of eth.places) if (areas.has(p.area)) add(p.building, p.area);
  for (const s of uzhLibraries(uzh.raw)) if (areas.has(s.area)) add(s.building, s.area);
  // Microwave spots (data/microwaves.json): [id, area, name, building], each opening its own page.
  const microwaves = MICROWAVES.filter((m) => areas.has(m.area)).map((m) => [m.id, m.area, microwaveName(m), m.building]);
  return {
    rooms: roomRows,
    spaces,
    microwaves,
    buildings: [...buildings.values()].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])),
  };
}

async function status(env: Env) {
  const now = Date.now();
  const [meta, fetches, catalogue, spaces, uzhCatalogue, uzh, uzhLive, uzhMenus] = await Promise.all([
    readMeta(env.DB, now, true),
    readFetches(env.DB),
    readCatalogue(env.ROOMS),
    readSpacesCatalogue(env.ROOMS, now),
    readUzhCatalogue(env.ROOMS, now),
    readUzhState(env.DB),
    readUzhSpacesLive(env.DB, now),
    readUzhMenuState(env.DB),
  ]);
  const uzhTargets = parseUzhCatalogue(uzhCatalogue.raw).map(roomPath);
  const targets = prefetchTargets(catalogue);
  const refreshed = refreshedTargets(catalogue);
  const today = zurichDate(now);
  const current = targets.filter((p) => fetches[p]?.fullFrom === today);
  const ages = current.filter((p) => refreshed.has(p)).map((p) => now - fetches[p].at);
  const backoff = Math.max(meta.backoffUntil, ethBackoffUntil());
  return {
    prefetch_updated: meta.updated ? toZurichIso(meta.updated) : null,
    prefetch_rooms: targets.length,
    days_ahead: PREFETCH_DAYS_AHEAD,
    refreshed_rooms: refreshed.size,
    current_for_today: current.length,
    oldest_refreshed_minutes: ages.length ? Math.floor(Math.max(...ages) / ONE_MINUTE) : null,
    eth_backoff_until: backoff > now ? toZurichIso(backoff) : null,
    spaces_updated: iso(spaces.at || null),
    occupancy_updated: iso(meta.occupancyAt || null),
    uzh: {
      prefetch_updated: iso(uzh.updated || null),
      rooms: uzhTargets.length,
      current_for_today: uzhTargets.filter((p) => fetches[p]?.fullFrom === today).length,
      catalogue_updated: iso(uzhCatalogue.at || null),
      occupancy_updated: iso(uzhLive?.at ?? null),
      sensors_reporting: uzhLive ? Object.keys(uzhLive.readings).length : 0,
      backoff_until: uzh.backoffUntil > now ? toZurichIso(uzh.backoffUntil) : null,
      menus_updated: iso(uzhMenus.updated || null),
      menus_backoff_until: uzhMenus.backoffUntil > now ? toZurichIso(uzhMenus.backoffUntil) : null,
    },
  };
}

// Invite links (/share?room=HG+E+7&bg=1&... or /share?space=MMB79&...) open the normal app, but carry their own
// preview card: WhatsApp and other link unfurlers read the og: tags without running JavaScript.
// scripts/make_share_images.py pre-renders the images (static/og/<bg>/<slug>.jpg), since drawing them here would not
// fit the Workers Free CPU limit.
// ETH's 'HG E 7' or UZH's 'KOL-F-101' (worker/uzh.ts).
const SHARE_ROOM = /^(?:[A-Z0-9]{1,6} [A-Z0-9]{1,4} [A-Z0-9.]{1,10}|[A-Z][A-Z0-9]{2}-[A-Za-z0-9]{1,2}-[A-Za-z0-9./]{1,12})$/;
const SHARE_SPACE = /^[A-Z0-9.]{2,20}$/;
// A meal invite's time: a quarter hour, as HHMM (make_share_images.py renders those).
const SHARE_TIME = /^([01]\d|2[0-3])(00|15|30|45)$/;
const SHARE_FALLBACK_IMAGE = "/og/0/_any.jpg";
// Same as static/_headers, which doesn't apply to pages the Worker builds.
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cache-Control": "public, max-age=3600",
};

/** File name of a room's preview image, e.g. 'HG E 1.1' -> 'HG-E-1-1'. Must match share_slug in make_share_images.py. */
export const shareSlug = (room: string) => room.replace(/[^A-Za-z0-9]+/g, "-");
/** File name of a study space's preview image, e.g. 'HGH30.1' -> 'space-HGH30-1'. Must match make_share_images.py. */
export const spaceSlug = (id: string) => `space-${shareSlug(id)}`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The invite's title and the file name of its pre-rendered image (in static/og/<bg>/), or null for a plain link. */
/**
 * What an invite link is for: its title and preview images (the first that exists is used). A meal invite
 * (&meal=lunch&t=1215, or t=now, or no time) has its own images per mensa, meal and time or day
 * (static/og/meal/<bg>/…), falling back to the image for its day without a time.
 */
async function inviteTarget(url: URL, env: Env): Promise<{ title: string; images: string[] } | null> {
  const bg = url.searchParams.get("bg") ?? "";
  const ok = /^\d{1,2}$/.test(bg);
  const room = url.searchParams.get("room") ?? "";
  // Each background's own general image comes next (UZH's says "at UZH"), for a place without one of its own.
  if (SHARE_ROOM.test(room)) return { title: `I'm in ${room}, come join me!`, images: ok ? [`/og/${bg}/${shareSlug(room)}.jpg`, `/og/${bg}/_any.jpg`] : [] };
  const id = url.searchParams.get("space") ?? "";
  if (!SHARE_SPACE.test(id)) return null;
  const all = await places(env);
  const space =
    all.spaces.find((s) => s.id === id) ??
    all.places.find((p) => p.id === id && !p.space) ??
    uzhLibraries((await readUzhLibraries(env.ROOMS)).raw).find((s) => s.id === id);
  if (!space) return null;
  const meal = url.searchParams.get("meal") ?? "";
  const place = all.places.find((p) => p.id === id);
  if ((meal === "lunch" || meal === "dinner") && place?.kind === "mensa") {
    const t = url.searchParams.get("t") ?? "";
    // The link's day (its `at`, else today), so the title and the image both say it.
    const date = (url.searchParams.get("at") ?? "").slice(0, 10);
    const today = zurichDate(Date.now());
    const other = /^\d{4}-\d{2}-\d{2}$/.test(date) && date !== today ? date : null;
    const weekday = other ? new Date(`${other}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }) : "";
    const day = !other ? "today" : other === addDays(today, 1) ? "tomorrow" : weekday.toLowerCase();
    const onDay = day === "today" ? "" : day === "tomorrow" ? " tomorrow" : ` on ${weekday}`;
    // Images: a time ("at 12:15?", or "now?"), else the day ("today?", "tomorrow?", "on Friday?"); see make_share_images.py.
    const when = t === "now" ? "now" : SHARE_TIME.test(t) ? t : day;
    const question = when === "now" ? " now?" : SHARE_TIME.test(t) ? `${onDay} at ${t.slice(0, 2)}:${t.slice(2)}?` : day === "today" ? " today?" : `${onDay}?`;
    const base = `/og/meal/${bg}/${spaceSlug(id)}-${meal}`;
    return {
      title: `${meal === "lunch" ? "Lunch" : "Dinner"} at ${space.name}${question}`,
      images: ok ? [`${base}-${when}.jpg`, `${base}-${day}.jpg`, `/og/${bg}/${spaceSlug(id)}.jpg`] : [],
    };
  }

  const title = !("category" in space) || space.category === "mensa" ? `Join me at ${space.name}!` : `I'm at ${space.name}, come join me!`;
  return { title, images: ok ? [`/og/${bg}/${spaceSlug(id)}.jpg`, `/og/${bg}/_any.jpg`] : [] };
}

async function sharePage(url: URL, env: Env): Promise<Response> {
  const target = await inviteTarget(url, env);
  let image = SHARE_FALLBACK_IMAGE;
  for (const own of target?.images ?? []) {
    if ((await env.ASSETS.fetch(new Request(new URL(own, url), { method: "HEAD" }))).ok) {
      image = own;
      break;
    }
  }
  const tags: Record<string, string> = { "og:url": url.href, "og:image": new URL(image, url).href };
  if (target) tags["og:title"] = target.title;
  let html = await (await env.ASSETS.fetch(new Request(new URL("/", url)))).text();
  for (const [property, content] of Object.entries(tags)) {
    html = html.replace(new RegExp(`(<meta property="${property}" content=")[^"]*`), `$1${escapeHtml(content)}`);
  }
  if (target) html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(target.title)}</title>`);
  return new Response(html, { headers: PAGE_HEADERS });
}

async function api(url: URL, env: Env, client: EthClient): Promise<unknown> {
  const p = url.searchParams;
  switch (url.pathname) {
    case "/api/status":
      return status(env);
    case "/api/areas": {
      const { raw, rooms: all } = await rooms(env);
      const eth = areaList(raw).map((a) => ({ ...a, university: "ETH" }));
      const uzh = UZH_AREAS.map((area) => ({ area, name: UZH_CAMPUSES[area].label, rooms: all.filter((r) => r.area === area).length, university: "UZH" }));
      return { default: DEFAULT_AREA, primary: [...AREAS, ...UZH_AREAS], areas: [...eth, ...uzh] };
    }
    case "/api/buildings": {
      const types = csv(p.get("types"));
      const { rooms: all } = await rooms(env);
      const counts = buildingCounts(filterRooms(all, p.get("area") || DEFAULT_AREA, null, types.size ? types : new Set(DEFAULT_TYPECODES)));
      return Object.entries(counts).map(([building, n]) => ({ building, rooms: n }));
    }
    case "/api/types": {
      const { rooms: all } = await rooms(env);
      // Only Meet's three types, in MEET_TYPECODES' order (the rest crowd the filters and nobody meets in them).
      const types = typeCounts(filterRooms(all, p.get("area") || DEFAULT_AREA, null, new Set(MEET_TYPECODES)))
        .sort((a, b) => MEET_TYPECODES.indexOf(a.typecode) - MEET_TYPECODES.indexOf(b.typecode));
      return { default: FILTER_DEFAULT_TYPECODES, types };
    }
    case "/api/dates": {
      const [min, max] = await allowedDates(await readMeta(env.DB), client);
      return { min, max };
    }
    case "/api/free":
      return free(p, env, client);
    case "/api/spaces":
      return spacesList(p, env);
    case "/api/map":
      return mapSummary(p, env);
    case "/api/room":
      return room(p, env, client);
    case "/api/index":
      return searchIndex(env);
    case "/api/menu":
      return menu(p, env);
    case "/api/menus":
      return menus(p, env);
    case "/api/experiment":
      return experimentSummary(env.DB, await readCatalogue(env.ROOMS));
  }
  throw new HttpError(404, "Not found");
}

/**
 * A place's name and building, when it exists: a room of the catalogues, or a study space, library, mensa or cafeteria,
 * in `area`. UZH's buildings are given as the map draws them (mapBuilding), so friends' bubbles land on the map.
 */
async function lookupPlace(env: Env, kind: PlaceKind | AccountPlaceKind, place: string, area: string): Promise<{ name: string; building: string } | null> {
  const drawn = (code: string) => (isUzhArea(area) ? mapBuilding(code) : code);
  if (kind === "room") {
    const r = (await rooms(env)).rooms.find((r) => roomPath(r) === place && r.area === area);
    return r ? { name: roomPath(r), building: drawn(r.building) } : null;
  }
  if (kind === "microwave") {
    const m = MICROWAVES.find((m) => m.id === place && m.area === area);
    return m ? { name: microwaveName(m), building: drawn(m.building) } : null;
  }
  const all = await places(env);
  const s = all.spaces.find((s) => s.id === place && s.area === area);
  if (s) return { name: s.name, building: drawn(s.building) };
  const p = all.places.find((p) => p.id === place && p.area === area);
  if (p) return { name: p.name, building: drawn(p.building) };
  const lib = uzhLibraries((await readUzhLibraries(env.ROOMS)).raw).find((s) => s.id === place && s.area === area);
  return lib ? { name: lib.name, building: drawn(lib.building) } : null;
}

/**
 * Street cred for a report or feedback sent signed in (plans/PLAN_STREET_CRED.md, 8.2): runs `extra` and the award in
 * one batch of the accounts database and answers `cred` for the page. Never fails the request: the report or feedback
 * is stored already, so a failure here only costs the points (logged).
 */
async function credFor(
  signed: Awaited<ReturnType<typeof optionalUser>>,
  action: CredAction | null,
  ref: string | null,
  now: number,
  detail: string | null = null,
  extra: (db: D1Database, userId: string) => D1PreparedStatement[] = () => [],
) {
  if (!signed) return null;
  try {
    const { db, user } = signed;
    const earn = action ? await award(db, user.id, action, ref, now, detail) : [];
    const statements = [...extra(db, user.id), ...earn];
    if (statements.length) await db.batch(statements);
    return await credState(db, user.id, action ? earned(action, earn) : 0);
  } catch (e) {
    console.error(`Street cred failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** The renewed session cookie optionalUser may hand back, as answer headers. */
const cookieHeaders = (signed: Awaited<ReturnType<typeof optionalUser>>): Record<string, string> =>
  signed?.setCookie ? { "Set-Cookie": signed.setCookie } : {};

/**
 * POST /api/report: an occupancy report from a room's or space's view (worker/reports.ts), always about now. Answers
 * with the place's fresh 2-hour summary, so the page updates at once.
 */
async function report(request: Request, url: URL, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ detail: "Forbidden" }, 403);
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json")) return json({ detail: "Expected JSON" }, 415);
  if (env.FROOMS_DISABLED === "1") return json({ detail: "frooms is paused for now" }, 503);
  if (env.REPORT_LIMITER) {
    const { success } = await env.REPORT_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
    if (!success) return json({ detail: "Too many reports right now, try again in a minute" }, 429, { "Retry-After": "60" });
  }
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ detail: "Expected JSON" }, 400);
  }
  try {
    const r = parseReport(body);
    const found = await lookupPlace(env, r.place_kind, r.place, r.area);
    if (!found) return json({ detail: "Unknown place" }, 404);
    const now = Date.now();
    const { stored, id, renewed, previous } = await saveReport(env.DB, r, now);
    const summary = (await readReportSummaries(env.DB, r.place_kind, [r.place], now)).get(r.place) ?? null;
    // Signed in (optional): a new report is linked to the account (report_owners, for the votes) and earns street cred;
    // a replaced reading with a new id (renewed) is linked again but earns nothing more.
    const signed = await optionalUser(request, env, now);
    const fresh = stored === "new";
    // A renewed report's +3 moves to its new id, so removing it later takes the +3 back.
    const cred = await credFor(signed, fresh ? "report" : null, String(id), now, found.name, (db, userId) => [
      ...(fresh || renewed ? [db.prepare("INSERT OR IGNORE INTO report_owners (report_id, user_id, at) VALUES (?, ?, ?)").bind(id, userId, now)] : []),
      ...(renewed && previous ? [db.prepare("UPDATE cred SET ref = ? WHERE user_id = ? AND action = 'report' AND ref = ?").bind(String(id), userId, String(previous))] : []),
    ]);
    return json({ ok: true, stored, summary, ...(cred ? { cred } : {}) }, 200, cookieHeaders(signed));
  } catch (e) {
    if (e instanceof ReportError) return json({ detail: e.message }, e.status);
    console.error(`Saving a report failed: ${e instanceof Error ? e.stack : e}`);
    return json({ detail: "Could not save your report right now" }, 500);
  }
}

/**
 * DELETE /api/report: the browser removes its own report of a place and kind (the one its controls show as yours),
 * with the street cred it earned (cred.ts removedReportStatements). Answers the place's fresh 2-hour summary; removing
 * one that's gone already is fine (`removed` false).
 */
async function unreport(request: Request, url: URL, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ detail: "Forbidden" }, 403);
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json")) return json({ detail: "Expected JSON" }, 415);
  if (env.FROOMS_DISABLED === "1") return json({ detail: "frooms is paused for now" }, 503);
  if (env.REPORT_LIMITER) {
    const { success } = await env.REPORT_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
    if (!success) return json({ detail: "Too many reports right now, try again in a minute" }, 429, { "Retry-After": "60" });
  }
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ detail: "Expected JSON" }, 400);
  }
  try {
    const r = parseRemoval(body);
    const now = Date.now();
    const id = await removeReport(env.DB, r, now);
    const accounts = authConfig(request, env)?.db;
    if (id !== null && accounts) {
      try {
        const statements = await removedReportStatements(accounts, id);
        if (statements.length) await accounts.batch(statements);
      } catch (e) {
        console.error(`Taking back a removed report's street cred failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    const summary = (await readReportSummaries(env.DB, r.place_kind, [r.place], now)).get(r.place) ?? null;
    return json({ ok: true, removed: id !== null, summary });
  } catch (e) {
    if (e instanceof ReportError) return json({ detail: e.message }, e.status);
    console.error(`Removing a report failed: ${e instanceof Error ? e.stack : e}`);
    return json({ detail: "Could not remove your report right now" }, 500);
  }
}

/**
 * GET /api/reports: one place's reports of the past 4 hours (newest first, no reporter) and its 2-hour summary. Where
 * sign-in is on, each entry also has its 👍 and 👎 counts and `trusted` (plan section 9), and signed in `mine` and your
 * `vote`; never who sent or voted. Signed-out answers are cached a minute (Vary: Cookie, so the browser asks again once signed in); signed-in ones are
 * personal and never are.
 */
async function reportLog(request: Request, params: URLSearchParams, env: Env): Promise<Response> {
  const kind = params.get("place_kind");
  if (!isPlaceKind(kind)) throw new HttpError(400, "place_kind must be room, space or microwave");
  const place = normalPath(params.get("place") ?? "");
  if (!place || place.length > 40) throw new HttpError(400, "Name a place");
  const now = Date.now();
  const [reports, summaries] = await Promise.all([readReportLog(env.DB, kind, place, now), readReportSummaries(env.DB, kind, [place], now)]);
  const signed = await optionalUser(request, env, now);
  const accounts = signed?.db ?? authConfig(request, env)?.db;
  let marks: Map<number, ReportMarks> | null = null;
  if (accounts && reports.length) {
    try {
      marks = await reportMarks(accounts, reports.map((r) => r.id), signed?.user.id ?? null);
    } catch (e) {
      console.error(`Report votes failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  const body = {
    at: toZurichIso(now),
    place_kind: kind,
    place,
    reports: reports.map((r) => ({ ...r, ...(marks?.get(r.id) ?? {}) })),
    summary: summaries.get(place) ?? null,
  };
  return json(body, 200, signed ? { "Cache-Control": "private, no-store", ...cookieHeaders(signed) } : { "Cache-Control": "public, max-age=60", Vary: "Cookie" });
}

/** A report for a vote (social.ts): when it was sent and its place's name, for the owner's log. */
async function lookupReport(env: Env, id: number) {
  const r = await readReport(env.DB, id);
  if (!r) return null;
  const found = await lookupPlace(env, r.place_kind, r.place, r.area);
  return { at: r.at, name: found?.name ?? r.place };
}

/**
 * GET /api/meal-ratings?place=&date=: the ratings of a place's dishes on a date (worker/ratings.ts), by dish key. Where
 * sign-in is on only (the ratings are in the accounts database); elsewhere 404 `sign_in_off`, and the page shows none.
 * Signed out the answer is cached a minute; signed in it has your own values and never is.
 */
async function mealRatings(request: Request, params: URLSearchParams, env: Env): Promise<Response> {
  const place = params.get("place") ?? "";
  if (!place || place.length > 40) throw new HttpError(400, "Name a place");
  if (!params.get("date")) throw new HttpError(400, "Name a date");
  const date = dateParam(params, "date", "");
  const now = Date.now();
  const signed = await optionalUser(request, env, now);
  const accounts = signed?.db ?? authConfig(request, env)?.db;
  if (!accounts) return json({ detail: "sign_in_off" }, 404, { "Cache-Control": "no-store" });
  let dishes = {};
  try {
    dishes = await readMealRatings(accounts, place, date, signed?.user.id ?? null);
  } catch (e) {
    console.error(`Meal ratings failed: ${e instanceof Error ? e.message : e}`);
    return json({ dishes }, 200, { "Cache-Control": "no-store" });
  }
  return json({ place, date, dishes }, 200, signed ? { "Cache-Control": "private, no-store", ...cookieHeaders(signed) } : { "Cache-Control": "public, max-age=60", Vary: "Cookie" });
}

/**
 * The dish a rating names (social.ts PUT /api/meal-ratings): on the stored menu of the place's facility that day, in
 * that meal, with that line and name (the name compared as the key does). Its key and the menu's own name, or null.
 */
async function lookupDish(env: Env, placeId: string, date: string, meal: string, line: string, name: string) {
  const place = (await places(env)).places.find((p) => p.id === placeId);
  if (!place) return null;
  const day = (await readMenuDate(env.DB, [place.facility], date)).get(place.facility);
  const key = dishKey(place.facility, date, meal, line, name);
  const dish = day?.meals.find((m) => m.meal === meal)?.dishes.find((d) => dishKey(place.facility, date, meal, d.line, d.name) === key);
  return dish ? { key, name: dish.name } : null;
}

/** Street cred per feedback category: "Report a problem" sends broken or wrong-info. */
const FEEDBACK_CRED: Record<string, CredAction> = { broken: "problem", "wrong-info": "problem", idea: "feedback", other: "feedback" };

/**
 * POST /api/feedback: JSON from the footer's feedback form, stored in D1 and emailed to FEEDBACK_TO. With `bug: true`
 * ("Report a bug", worker/bugs.ts) and signed in, it's a bug report: category "broken", no instant street cred, linked
 * to the account as pending (409 `bugs_pending` while BUG_PENDING_MAX of yours wait), and the answer says `bug: "pending"`.
 * Signed out, `bug` is plain feedback.
 */
async function feedback(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Only the page itself: a JSON body can't be sent cross-site without CORS, and the Origin check covers old browsers.
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ detail: "Forbidden" }, 403);
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json")) {
    return json({ detail: "Expected JSON" }, 415);
  }
  if (env.FEEDBACK_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.FEEDBACK_LIMITER.limit({ key: ip });
    if (!success) return json({ detail: "That's a lot of feedback at once. Please wait a minute" }, 429, { "Retry-After": "60" });
  }
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ detail: "Expected JSON" }, 400);
  }
  try {
    const now = Date.now();
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const wantsBug = b?.bug === true && b.category === "broken";
    const signed = await optionalUser(request, env, now);
    const bugger = wantsBug && signed ? signed : null;
    if (bugger && (await pendingBugs(bugger.db, bugger.user.id)) >= BUG_PENDING_MAX) {
      return json({ detail: `You have ${BUG_PENDING_MAX} bug reports waiting already. Send the next one once we've checked one`, code: "bugs_pending" }, 409, cookieHeaders(signed));
    }
    const saved = await saveFeedback(env.DB, body, now);
    let bug: "pending" | null = null;
    if (saved && bugger) {
      try {
        await linkBug(bugger.db, saved.id, bugger.user.id, now, saved.message);
        bug = "pending";
      } catch (e) {
        // The feedback is stored; without the link it is plain feedback (and the email doesn't promise a reward).
        console.error(`Linking a bug report failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (saved && env.FEEDBACK_EMAIL && env.FEEDBACK_TO) {
      // In the background: the feedback is already stored, so a failed email only costs the notification.
      const send = env.FEEDBACK_EMAIL.send(feedbackEmail(saved, env.FEEDBACK_TO, bug ? bugger!.user.username : null));
      ctx.waitUntil(send.catch((e) => console.error(`Feedback email failed: ${e instanceof Error ? e.message : e}`)));
    }
    // Signed in (optional): street cred by category; reporting a person earns nothing, a bug report only once it's
    // rewarded. The stored feedback has no user.
    const action = saved && !bug ? FEEDBACK_CRED[saved.category] ?? null : null;
    const cred = saved ? await credFor(signed, action, null, now) : null;
    return json({ ok: true, ...(cred ? { cred } : {}), ...(bug ? { bug } : {}) }, 201, cookieHeaders(signed));
  } catch (e) {
    if (e instanceof FeedbackError) return json({ detail: e.message }, e.status);
    console.error(`Saving feedback failed: ${e instanceof Error ? e.stack : e}`);
    return json({ detail: "Could not save your feedback right now. Please try again later" }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/share" && request.method === "GET") return sharePage(url, env);
    // Sign-in, sessions and the account (worker/auth.ts): never cached, and only on frooms.ch and the accounts preview.
    if (url.pathname.startsWith("/auth/")) return handleAuth(request, url, env);
    // The account endpoints (worker/social.ts): profile, friends, check-ins, stars. Never cached.
    if (SOCIAL_PATHS.has(url.pathname)) {
      return handleSocial(request, url, env, (kind, place, area) => lookupPlace(env, kind, place, area), Date.now(), (id) => lookupReport(env, id));
    }
    // Rating a dish needs the session like the account endpoints; reading the ratings (GET) is public, below.
    if (url.pathname === "/api/meal-ratings" && request.method !== "GET") {
      return handleSocial(request, url, env, (kind, place, area) => lookupPlace(env, kind, place, area), Date.now(), (id) => lookupReport(env, id),
        (place, date, meal, line, name) => lookupDish(env, place, date, meal, line, name));
    }
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/feedback" && request.method === "POST") return feedback(request, url, env, ctx);
    if (url.pathname === "/api/report" && request.method === "POST") return report(request, url, env);
    if (url.pathname === "/api/report" && request.method === "DELETE") return unreport(request, url, env);
    // The page's usage counts (worker/stats.ts): daily totals in the accounts database, never cached.
    if (url.pathname === "/api/stats") return handleStats(request, env);
    // The admin page's numbers (worker/admin.ts): admins only, 404 for everyone else. Never cached.
    if (url.pathname === "/api/admin/stats" || url.pathname === "/api/admin/bug") return handleAdmin(request, env);

    if (request.method !== "GET") return json({ detail: "Method not allowed" }, 405);
    if (env.FROOMS_DISABLED === "1") {
      return json({ detail: "frooms is paused for now. Please check ETH's room info pages directly." }, 503);
    }
    if ((url.pathname === "/api/free" || url.pathname === "/api/room") && env.RATE_LIMITER) {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ detail: "Too many requests, try again in a minute" }, 429, { "Retry-After": "60" });
    }

    const client = new EthClient(userAgent(env.FROOMS_CONTACT), ctx);
    try {
      if (url.pathname.startsWith("/api/meal-image/")) return await mealImage(url.pathname.slice(16), env, ctx);
      if (url.pathname === "/api/reports") return await reportLog(request, url.searchParams, env);
      if (url.pathname === "/api/meal-ratings") return await mealRatings(request, url.searchParams, env);
      const body = await api(url, env, client);
      const live = ["/api/free", "/api/room", "/api/status", "/api/spaces", "/api/map", "/api/reports"].includes(url.pathname);
      const menus = ["/api/menu", "/api/menus"].includes(url.pathname);
      const maxAge = live ? 60 : menus ? MENU_CACHE_S : url.pathname === "/api/experiment" ? 300 : 3600;
      return json(body, 200, { "Cache-Control": `public, max-age=${maxAge}` });
    } catch (e) {
      if (e instanceof HttpError) return json({ detail: e.message }, e.status);
      console.error(`Unhandled error for ${url.pathname}${url.search}: ${e instanceof Error ? e.stack : e}`);
      return json({ detail: "ETH's room info is not responding right now" }, 502);
    }
  },

  // Two Cron Triggers, each with its own CPU budget: the rooms and study spaces, and (a minute later) the menus.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.FROOMS_DISABLED === "1" || !env.ROOMS) return;
    const client = new EthClient(userAgent(env.FROOMS_CONTACT), ctx, false);
    if (controller.cron === UZH_MENU_CRON) {
      await runUzhMenuPrefetch({ DB: env.DB }, userAgent(env.FROOMS_CONTACT));
      return;
    }
    if (controller.cron === MENU_CRON) {
      try {
        await runMenuPrefetch({ ROOMS: env.ROOMS, DB: env.DB }, client);
      } finally {
        // UZH's rooms and libraries share the menus' trigger (and its CPU budget), with their own backoff.
        await runUzhPrefetch({ ROOMS: env.ROOMS, DB: env.DB }, userAgent(env.FROOMS_CONTACT));
      }
    } else await runPrefetch({ ROOMS: env.ROOMS, DB: env.DB, ACCOUNTS: env.ACCOUNTS }, client);
  },
} satisfies ExportedHandler<Env>;
