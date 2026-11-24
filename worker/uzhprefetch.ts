// UZH's scheduled prefetch, on the menu Cron Trigger (MENU_CRON) after the menus: every run fetches a few UZH rooms
// from its booking calendar, one at a time, and stores them in D1 next to ETH's (keyed by their own code, e.g.
// 'KOL-F-101'). Like ETH's: every room once a day for a month (after midnight), the seminar rooms again by day for
// today and tomorrow. Also the University Library's seat sensors. UZH has its own backoff; ETH's doesn't stop it.
// UZH's menus (runUzhMenuPrefetch, at the end) have a Cron Trigger of their own (UZH_MENU_CRON).

import {
  HTTP_TIMEOUT_MS,
  ETH_BACKOFF_MIN_S,
  MEAL_IMAGE_DAYS,
  MENU_INTERVAL_S,
  MENU_NIGHT_INTERVAL_S,
  MENU_QUIET_HOURS,
  MENU_WEEKS,
  PREFETCH_DAYS_AHEAD,
  PREFETCH_RUN_INTERVAL_S,
  UZH_CATALOGUE_TTL_S,
  UZH_GAP_MS,
  UZH_LOGIN_REQUESTS,
  UZH_OCCUPANCY_INTERVAL_S,
  UZH_OCCUPANCY_NIGHT_INTERVAL_S,
  UZH_REFRESH_INTERVAL_S,
  UZH_MENU_GAP_MS,
  UZH_MENU_LATER_INTERVAL_S,
  UZH_MENU_PHOTO_RETRY_S,
  UZH_MENU_PRICE_RETRY_S,
  UZH_MENU_REQUESTS_PER_RUN,
  UZH_REQUESTS_PER_RUN,
} from "./config";
import { roomPath } from "./catalogue";
import { type MenuDay, mondayOf } from "./menus";
import { isQuiet, isRefreshed, pickRooms } from "./prefetch";
import type { Reading } from "./spaces";
import {
  deleteMenuDay,
  putDay,
  putFetches,
  putMenuDay,
  putUzhMenuState,
  putOccupancy,
  putUzhSpacesLive,
  putUzhState,
  readFetches,
  readMenuDaysFrom,
  readUzhMenuState,
  readUzhState,
  splitPacked,
  type Catalogue,
  type UzhCatalogue,
} from "./store";
import { addDays, type IsoDate, zurichDate } from "./tz";
import { parseUzhCatalogue, UZH_AREAS, UZH_SNAPSHOT, UzhClient, UzhRateLimited } from "./uzh";
import { Food2050Error, mergeWeek, parseDishPage, parseWeek, photoless, unpriced, UZH_MENSAS, type UzhMeal, type UzhMensa, weekUrl, withDetails } from "./uzhmenus";
import { trimLibraries, UZH_LIBRARIES_URL, UZH_SENSORS } from "./uzhspaces";

export interface UzhPrefetchEnv {
  ROOMS: KVNamespace;
  DB: D1Database;
}

export interface UzhPrefetchResult {
  requests: number; // to the calendar, logins included
  fetched: number; // rooms stored
  failed: number;
  sensors: number; // library readings stored
  skipped?: "backoff";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The request budget ran out mid-way (a login, usually); the rest waits for the next run. */
class OutOfBudget extends Error {}

/** Refreshes per run that cover `rooms` once per UZH_REFRESH_INTERVAL_S. */
export const uzhRefreshesPerRun = (rooms: number) => Math.ceil((rooms * PREFETCH_RUN_INTERVAL_S) / UZH_REFRESH_INTERVAL_S);

/** The campus whose rooms are the most out of date, if any is due. */
export function dueCampus(catalogue: UzhCatalogue | null, now: number): string | null {
  const due = UZH_AREAS.filter((a) => now - (catalogue?.areas?.[a] ?? 0) > UZH_CATALOGUE_TTL_S * 1000);
  return due.sort((a, b) => (catalogue?.areas?.[a] ?? 0) - (catalogue?.areas?.[b] ?? 0))[0] ?? null;
}

export async function runUzhPrefetch(
  env: UzhPrefetchEnv,
  userAgent: string,
  now = Date.now(),
  gapMs = UZH_GAP_MS,
): Promise<UzhPrefetchResult> {
  const state = await readUzhState(env.DB);
  if (now < state.backoffUntil) {
    console.log(`UZH prefetch skipped: backoff until ${new Date(state.backoffUntil).toISOString()}`);
    return { requests: 0, fetched: 0, failed: 0, sensors: 0, skipped: "backoff" };
  }

  let requests = 0;
  const client = new UzhClient(userAgent, state.session, async () => {
    if (requests >= UZH_REQUESTS_PER_RUN) throw new OutOfBudget();
    if (requests > 0) await sleep(gapMs);
    requests++;
  });
  let fetched = 0;
  let failed = 0;
  let limited: UzhRateLimited | null = null;
  let stop = false;
  const statements: D1PreparedStatement[] = [];

  /** Run one step; a rate limit or an exhausted budget ends the run's calendar requests. */
  async function step<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (stop) return undefined;
    // Not enough left for a login: wait for the next run rather than leave one half done.
    if (!client.session && UZH_REQUESTS_PER_RUN - requests < UZH_LOGIN_REQUESTS) return undefined;
    try {
      return await fn();
    } catch (e) {
      if (e instanceof OutOfBudget) stop = true;
      else if (e instanceof UzhRateLimited) {
        limited = e;
        stop = true;
      } else {
        failed++;
        console.warn(`UZH prefetch request failed: ${e}`);
      }
      return undefined;
    }
  }

  // Catalogue: one campus per run, each once a day.
  const today = zurichDate(now);
  let catalogue = await env.ROOMS.get<UzhCatalogue>("uzh_catalogue", "json");
  const campus = dueCampus(catalogue, now);
  if (campus) {
    const rooms = await step(() => client.campus(campus));
    if (rooms) {
      const others = (catalogue?.raw?.length ? catalogue.raw : UZH_SNAPSHOT).filter((r) => r.area !== campus);
      catalogue = { at: now, areas: { ...catalogue?.areas, [campus]: now }, raw: [...others, ...rooms] };
      await env.ROOMS.put("uzh_catalogue", JSON.stringify(catalogue));
    }
  }

  // Rooms: the most out-of-date first, as ETH's (worker/prefetch.ts pickRooms).
  const rooms = parseUzhCatalogue(catalogue?.raw?.length ? catalogue.raw : UZH_SNAPSHOT);
  const byPath = new Map(rooms.map((r) => [roomPath(r), r]));
  const targets = [...byPath.keys()];
  const refreshed = new Set(rooms.filter(isRefreshed).map(roomPath));
  const fetches = await readFetches(env.DB);
  const tomorrow = addDays(today, 1);
  const picked = pickRooms(targets, fetches, today, UZH_REQUESTS_PER_RUN, {
    quiet: isQuiet(now),
    refreshed,
    refreshBefore: now - (UZH_REFRESH_INTERVAL_S - PREFETCH_RUN_INTERVAL_S) * 1000,
    maxRefresh: uzhRefreshesPerRun(refreshed.size),
  });
  for (const path of picked) {
    const room = byPath.get(path)!;
    const full = fetches[path]?.fullFrom !== today;
    const to = full ? addDays(today, PREFETCH_DAYS_AHEAD + 1) : tomorrow;
    const packed = await step(() => client.room(room.uzh!, today, to));
    if (!packed) continue;
    const at = Date.now();
    for (const d of splitPacked(packed, today, to)) statements.push(putDay(env.DB, { path, at, ...d }));
    fetches[path] = { fullFrom: full ? today : fetches[path].fullFrom, at };
    fetched++;
  }
  if (fetched) statements.push(putFetches(env.DB, "uzh", fetches, targets));

  // The library's server (not counted against the calendar's budget): its location list once a day, and every seat
  // sensor every few minutes.
  let sensors = 0;
  let tried = 0;
  const ub = new UzhClient(userAgent, null, async () => {
    if (tried++ > 0) await sleep(gapMs);
  });
  const libraries = await env.ROOMS.get<Catalogue>("uzh_libraries", "json");
  if (!libraries || now - libraries.at > UZH_CATALOGUE_TTL_S * 1000) {
    try {
      const raw = await ub.json(UZH_LIBRARIES_URL);
      if (!Array.isArray(raw) || !raw.length) throw new Error("unexpected answer");
      await env.ROOMS.put("uzh_libraries", JSON.stringify({ at: now, raw: trimLibraries(raw) } satisfies Catalogue));
    } catch (e) {
      console.warn(`UB location list failed: ${e}`);
    }
  }
  const interval = isQuiet(now) ? UZH_OCCUPANCY_NIGHT_INTERVAL_S : UZH_OCCUPANCY_INTERVAL_S;
  if (now - state.occupancyAt >= interval * 1000 && UZH_SENSORS.length) {
    const readings: Record<string, Reading> = {};
    for (const lib of UZH_SENSORS) {
      try {
        const r = await ub.sensor(lib.sensor);
        if (r === "closed") continue; // outside the library's hours
        if (r) {
          sensors++;
          readings[lib.id] = r;
          statements.push(putOccupancy(env.DB, lib.id, r.measured_at!, r));
        } else console.warn(`UB sensor ${lib.sensor}: no reading in the widget`);
      } catch (e) {
        console.warn(`UB sensor ${lib.sensor} failed: ${e}`);
        if (e instanceof UzhRateLimited) break;
      }
    }
    statements.push(putUzhSpacesLive(env.DB, { at: Date.now(), readings }));
    state.occupancyAt = now;
  }

  if (limited) {
    state.backoffUntil = (limited as UzhRateLimited).until;
    console.warn(`UZH prefetch hit a rate limit; pausing until ${new Date(state.backoffUntil).toISOString()}`);
  }
  state.session = client.session;
  state.updated = now;
  statements.push(putUzhState(env.DB, state));
  await env.DB.batch(statements);

  const fresh = targets.filter((p) => fetches[p]?.fullFrom === today).length;
  console.log(`UZH prefetch: ${requests} requests, ${fetched} rooms ok, ${failed} failed, ${sensors} sensors, ${fresh}/${targets.length} rooms fetched for ${today}`);
  return { requests, fetched, failed, sensors };
}

// --- UZH's menus (worker/uzhmenus.ts), on their own Cron Trigger (UZH_MENU_CRON) ---

/** food2050 asked us to slow down (429/503). */
export class Food2050RateLimited extends Error {
  constructor(readonly until: number) {
    super(`food2050 rate limit, backing off until ${new Date(until).toISOString()}`);
  }
}

/** One weekly page: a mensa's meal in one week (`week` 0 is this one). */
export interface MenuPage {
  key: string; // "UM1|lunch|2026-11-09"
  mensa: UzhMensa;
  meal: UzhMeal;
  monday: IsoDate;
  week: number;
}

/** Every weekly page to keep: each mensa's meals for MENU_WEEKS weeks from this one. */
export function menuPages(today: IsoDate, mensas: UzhMensa[] = UZH_MENSAS): MenuPage[] {
  const out: MenuPage[] = [];
  for (let week = 0; week < MENU_WEEKS; week++) {
    const monday = addDays(mondayOf(today), 7 * week);
    for (const mensa of mensas) for (const meal of mensa.meals) out.push({ key: `${mensa.id}|${meal.meal}|${monday}`, mensa, meal, monday, week });
  }
  return out;
}

/**
 * The pages due, the least recently fetched first (never fetched first, this week's before later ones): this week's
 * every MENU_INTERVAL_S by day and MENU_NIGHT_INTERVAL_S at night, later weeks' every UZH_MENU_LATER_INTERVAL_S.
 */
export function duePages(pages: MenuPage[], fetched: Record<string, number>, now: number): MenuPage[] {
  const thisWeek = (isQuiet(now, MENU_QUIET_HOURS) ? MENU_NIGHT_INTERVAL_S : MENU_INTERVAL_S) * 1000;
  const due = pages.filter((p) => now - (fetched[p.key] ?? 0) >= (p.week === 0 ? thisWeek : UZH_MENU_LATER_INTERVAL_S * 1000));
  return due.sort((a, b) => (fetched[a.key] ?? 0) - (fetched[b.key] ?? 0) || a.week - b.week);
}

export interface UzhMenuPrefetchResult {
  requests: number;
  pages: number; // weekly pages read
  priced: number; // dish pages read
  failed: number;
  written: number;
  deleted: number;
  skipped?: "backoff";
}

type Job = { page: MenuPage } | { dish: { facility: number; date: IsoDate; id: string; url: string } };

/**
 * One run: at most UZH_MENU_REQUESTS_PER_RUN pages, one at a time. The most overdue weekly page first, then the
 * prices of dishes that have none yet (the soonest first; only one while more weekly pages are due), then more weekly
 * pages. Stored like ETH's menus (menu_days).
 * A page that can't be read keeps what's stored; it's tried again on its next turn.
 */
export async function runUzhMenuPrefetch(
  env: Pick<UzhPrefetchEnv, "DB">,
  userAgent: string,
  now = Date.now(),
  gapMs = UZH_MENU_GAP_MS,
): Promise<UzhMenuPrefetchResult> {
  const result: UzhMenuPrefetchResult = { requests: 0, pages: 0, priced: 0, failed: 0, written: 0, deleted: 0 };
  const state = await readUzhMenuState(env.DB);
  if (now < state.backoffUntil) {
    console.log(`UZH menu prefetch skipped: backoff until ${new Date(state.backoffUntil).toISOString()}`);
    return { ...result, skipped: "backoff" };
  }
  const today = zurichDate(now);
  const byFacility = new Map(UZH_MENSAS.map((m) => [m.facility, m]));
  const stored = new Map<number, Map<IsoDate, MenuDay>>();
  for (const r of await readMenuDaysFrom(env.DB, [...byFacility.keys()], mondayOf(today))) {
    if (!stored.has(r.facility)) stored.set(r.facility, new Map());
    stored.get(r.facility)!.set(r.date, JSON.parse(r.data) as MenuDay);
  }
  const changed = new Map<string, { facility: number; date: IsoDate; day: MenuDay | null }>();
  const save = (facility: number, date: IsoDate, day: MenuDay | null) => {
    const days = stored.get(facility) ?? new Map<IsoDate, MenuDay>();
    stored.set(facility, days);
    if (day) days.set(date, day);
    else if (!days.delete(date)) return; // nothing stored, nothing to delete
    changed.set(`${facility}|${date}`, { facility, date, day });
  };

  const get = async (url: string): Promise<string> => {
    if (result.requests > 0) await sleep(gapMs);
    result.requests++;
    const resp = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "text/html" }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (resp.status === 429 || resp.status === 503) {
      const retryAfter = Number(resp.headers.get("retry-after"));
      throw new Food2050RateLimited(Date.now() + Math.max(ETH_BACKOFF_MIN_S, Number.isFinite(retryAfter) ? retryAfter : 0) * 1000);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return resp.text();
  };

  const pages = menuPages(today);
  const keys = new Set(pages.map((p) => p.key));
  for (const key of Object.keys(state.pages)) if (!keys.has(key)) delete state.pages[key];
  const retryBefore = now - UZH_MENU_PRICE_RETRY_S * 1000;
  for (const [id, at] of Object.entries(state.priced)) if (at < now - MENU_WEEKS * 7 * 86400_000) delete state.priced[id];
  const photoBefore = now - UZH_MENU_PHOTO_RETRY_S * 1000;
  for (const [id, at] of Object.entries(state.photos)) if (at < now - MEAL_IMAGE_DAYS * 86400_000) delete state.photos[id];
  const lastPhotoDay = addDays(today, MEAL_IMAGE_DAYS - 1);
  const due = duePages(pages, state.pages, now);
  const dishes: Job[] = [];
  for (const [facility, days] of stored) {
    for (const [date, day] of days) {
      if (date < today) continue;
      // Pages still to be read for prices or nutrition, and today's and tomorrow's without a photo yet, read again for one.
      const pending = new Map<string, { id: string; url: string }>();
      for (const d of unpriced(day)) if ((state.priced[d.src.id] ?? 0) < retryBefore) pending.set(d.src.id, d.src);
      if (date <= lastPhotoDay) for (const d of photoless(day)) if ((state.photos[d.src.id] ?? 0) < photoBefore) pending.set(d.src.id, d.src);
      for (const src of pending.values()) dishes.push({ dish: { facility, date, ...src } });
    }
  }
  dishes.sort((a, b) => ("dish" in a && "dish" in b ? a.dish.date.localeCompare(b.dish.date) : 0));
  // While weekly pages are waiting, one dish page a run; otherwise as many as fit.
  const priceJobs = due.length > 1 ? dishes.slice(0, 1) : dishes;
  const jobs: Job[] = [...due.slice(0, 1).map((page) => ({ page })), ...priceJobs, ...due.slice(1).map((page) => ({ page }))];

  for (const job of jobs.slice(0, UZH_MENU_REQUESTS_PER_RUN)) {
    try {
      if ("page" in job) {
        const { key, mensa, meal, monday } = job.page;
        state.pages[key] = now;
        const week = parseWeek(await get(weekUrl(mensa, meal, monday)));
        // Only the asked week's days (a page that ignored the week asked for would otherwise overwrite another's).
        const inWeek = { ...week, dates: week.dates.filter((d) => d >= monday && d <= addDays(monday, 6)) };
        if (!inWeek.dates.length) throw new Food2050Error(`no day of the week of ${monday}`);
        for (const [date, day] of mergeWeek(mensa, meal, inWeek, stored.get(mensa.facility) ?? new Map())) {
          if (JSON.stringify(day) !== JSON.stringify(stored.get(mensa.facility)?.get(date) ?? null)) save(mensa.facility, date, day);
        }
        result.pages++;
      } else {
        const { facility, date, id, url } = job.dish;
        state.priced[id] = now; // cleared below if it gave prices
        state.photos[id] = now; // the same for a photo
        const details = parseDishPage(await get(url));
        const day = stored.get(facility)?.get(date);
        const filled = day && withDetails(day, details);
        if (filled) save(facility, date, filled);
        const got = details.get(id)?.price;
        if (got && (got.student !== null || got.internal !== null || got.external !== null)) delete state.priced[id];
        if (details.get(id)?.image) delete state.photos[id];
        result.priced++;
      }
    } catch (e) {
      if (e instanceof Food2050RateLimited) {
        state.backoffUntil = e.until;
        console.warn(`UZH menu prefetch hit a rate limit; pausing until ${new Date(e.until).toISOString()}`);
        break;
      }
      result.failed++;
      console.warn(e instanceof Food2050Error ? `UZH menu parse failed: ${e.message}` : `UZH menu request failed: ${e}`);
    }
  }

  const at = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const { facility, date, day } of changed.values()) {
    if (day) {
      statements.push(putMenuDay(env.DB, facility, date, at, JSON.stringify(day)));
      result.written++;
    } else {
      statements.push(deleteMenuDay(env.DB, facility, date));
      result.deleted++;
    }
  }
  state.updated = now;
  statements.push(putUzhMenuState(env.DB, state));
  await env.DB.batch(statements);
  console.log(`UZH menu prefetch: ${result.requests} requests, ${result.pages} weeks, ${result.priced} dish pages, ${result.failed} failed, ${result.written} days written, ${result.deleted} deleted`);
  return result;
}
