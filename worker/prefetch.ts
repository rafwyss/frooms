// Scheduled prefetch: every run fetches a few rooms from ETH, one at a time, and stores them in D1.
// ETH sees a small, steady load regardless of how many people use frooms.

import { cleanAccounts } from "./social";
import {
  CATALOGUE_TTL_S,
  COOKPIT_CLIENT,
  EQUIPMENT_PER_RUN,
  EQUIPMENT_TTL_S,
  COOKPIT_URL,
  EXPERIMENT_CHECKS_PER_RUN,
  HISTORY_DAYS,
  MENU_FACILITIES_TTL_S,
  MENU_HISTORY_DAYS,
  MENU_WEEKS,
  MIN_MAX_TTL_S,
  OCCUPANCY_INTERVAL_S,
  OCCUPANCY_NIGHT_INTERVAL_S,
  OCCUPANCY_URL,
  PREFETCH_DAYS_AHEAD,
  PREFETCH_GAP_MS,
  PREFETCH_QUIET_HOURS,
  PREFETCH_REFRESH_INTERVALS_S,
  PREFETCH_ROOMS_PER_RUN,
  PREFETCH_RUN_INTERVAL_S,
  SPACES_CATALOGUE_TTL_S,
  SPACES_MIN_SHARE,
  SPACES_SHORT_ACCEPT_S,
  STUDYSPACES_URL,
  UZH_REFRESH_INTERVAL_S,
  UZH_REFRESH_TYPECODES,
} from "./config";
import { parseCatalogue, type Room, roomPath } from "./catalogue";
import { type EquipmentStore, parseEquipment, pickEquipment } from "./equipment";
import { EthClient, EthError, RateLimited } from "./eth";
import { experimentActive, logComparison, pickChecks } from "./experiment";
import { hasLines, mondayOf, normalizeRotas, parseFacilities, pickFacility } from "./menus";
import { EATERY_OVERRIDES, isOwnPlace } from "./overrides";
import { elsewhereIds, ownCampuses, parseReadings } from "./spaces";
import {
  type Catalogue,
  deleteDaysBefore,
  deleteMenuDay,
  deleteMenuDaysBefore,
  type FetchState,
  ownAreas,
  type PackedAllocation,
  putDay,
  putBackoff,
  putFetch,
  putMenuDay,
  putMenuFetch,
  putMeta,
  putOccupancy,
  putSpacesLive,
  readCatalogue,
  readDays,
  readFetches,
  readMenuFetches,
  readMenuRange,
  readMeta,
  splitDays,
} from "./store";
import { addDays, zurichDate, zurichWall } from "./tz";
import { rebuildUsual } from "./usual";

export interface PrefetchEnv {
  ROOMS: KVNamespace;
  DB: D1Database;
  /** frooms.ch's accounts, cleaned once a day (worker/social.ts cleanAccounts). Never ACCOUNTS_DEV: previews run no cron. */
  ACCOUNTS?: D1Database;
}

export interface PrefetchResult {
  fetched: number;
  failed: number;
  checked: number;
  equipment?: number; // rooms whose equipment was fetched
  skipped?: "backoff";
  backoffUntil: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The `data` array of one of ETH's study-space feeds. */
function feedData(body: unknown): unknown[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || !data.length) throw new EthError("unexpected study-space response");
  return data;
}

/** Paths of the rooms the prefetch keeps up to date: every room in the catalogue. */
export function prefetchTargets(rawCatalogue: unknown[]): string[] {
  return parseCatalogue(rawCatalogue).map(roomPath);
}

/** How often a room is refreshed during the day (seconds), or null if it's fetched once a day. */
export function refreshInterval(room: Room): number | null {
  if (room.uzh) return UZH_REFRESH_TYPECODES.includes(room.typecode) ? UZH_REFRESH_INTERVAL_S : null;
  return PREFETCH_REFRESH_INTERVALS_S[room.typecode] ?? null;
}

/** Whether a room is refreshed during the day, rather than fetched once a day. */
export const isRefreshed = (room: Room) => refreshInterval(room) !== null;

/** The rooms that are refreshed during the day, by path, with how often (seconds). */
export function refreshedTargets(rawCatalogue: unknown[]): Map<string, number> {
  return new Map(parseCatalogue(rawCatalogue).flatMap((r) => (isRefreshed(r) ? [[roomPath(r), refreshInterval(r)!]] : [])));
}

/**
 * The study-space list to store after ETH answered `raw`: the new one, unless it has much fewer of our spaces than the
 * stored one (a partial answer: SPACES_MIN_SHARE). Then the stored list stays, tried again in an hour, until ETH has
 * sent short lists for SPACES_SHORT_ACCEPT_S (spaces really gone).
 */
export function acceptSpaces(stored: Catalogue | null, raw: unknown[], now: number): Catalogue {
  const own = ownCampuses(raw);
  const kept = stored?.raw?.length ?? 0;
  if (stored && own.length < kept * SPACES_MIN_SHARE) {
    const shortSince = stored.shortSince ?? now;
    if (now - shortSince < SPACES_SHORT_ACCEPT_S * 1000) {
      console.warn(`Study-space list kept: ETH sent ${own.length} of our spaces, ${kept} stored`);
      return { ...stored, at: now, shortSince };
    }
  }
  return { at: now, raw: own, elsewhere: elsewhereIds(raw) };
}

/** Whether `now` (Zurich) is in the quiet hours: the room prefetch's by default, or the menus' (MENU_QUIET_HOURS). */
export function isQuiet(now: number, hours = PREFETCH_QUIET_HOURS): boolean {
  const { hour } = zurichWall(now);
  return hour >= hours.from || hour < hours.to;
}

export interface PickOptions {
  quiet?: boolean;
  refreshed?: { has(path: string): boolean }; // rooms refreshed during the day (default: all)
  // Only refresh rooms last fetched before this (epoch ms), the same for every room or each room's own.
  refreshBefore?: number | ((path: string) => number);
  maxRefresh?: number; // at most this many refreshes per run, so they spread evenly over the interval
}

/**
 * Up to `n` rooms without today's month fetch (never fetched first, then the oldest), then the least recently
 * fetched of the `refreshed` rooms that are due. Other rooms are fetched once a day; in quiet hours, so is every room.
 */
export function pickRooms(
  targets: string[],
  fetches: Record<string, FetchState>,
  today: string,
  n: number,
  { quiet = false, refreshed = new Set(targets), refreshBefore = Infinity, maxRefresh = Infinity }: PickOptions = {},
): string[] {
  const byAge = (a: string, b: string) => (fetches[a]?.at ?? 0) - (fetches[b]?.at ?? 0);
  const missing = targets.filter((p) => fetches[p]?.fullFrom !== today);
  const fresh = missing.filter((p) => !fetches[p]).concat(missing.filter((p) => fetches[p]).sort(byAge));
  const before = typeof refreshBefore === "number" ? () => refreshBefore : refreshBefore;
  const due = quiet
    ? []
    : targets.filter((p) => fetches[p]?.fullFrom === today && refreshed.has(p) && fetches[p].at < before(p)).sort(byAge);
  const picked = fresh.slice(0, Math.max(0, n));
  return picked.concat(due.slice(0, Math.max(0, Math.min(maxRefresh, n - picked.length))));
}

/** Refreshes per run that cover each room once per its interval (seconds, one per room). */
export const refreshesPerRun = (intervalsS: Iterable<number>) =>
  Math.ceil([...intervalsS].reduce((sum, s) => sum + PREFETCH_RUN_INTERVAL_S / s, 0) - 1e-9);

export async function runPrefetch(
  env: PrefetchEnv,
  client: EthClient,
  now = Date.now(),
  gapMs = PREFETCH_GAP_MS,
): Promise<PrefetchResult> {
  const meta = await readMeta(env.DB, now, true);
  if (now < meta.backoffUntil) {
    console.log(`Prefetch skipped: ETH backoff until ${new Date(meta.backoffUntil).toISOString()}`);
    return { fetched: 0, failed: 0, checked: 0, skipped: "backoff", backoffUntil: meta.backoffUntil };
  }

  let budget = PREFETCH_ROOMS_PER_RUN;
  let fetched = 0;
  let failed = 0;
  let limited: RateLimited | null = null;

  async function polite<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (limited || budget <= 0) return undefined;
    if (fetched + failed > 0) await sleep(gapMs);
    budget--;
    try {
      const value = await fn();
      fetched++;
      return value;
    } catch (e) {
      failed++;
      if (e instanceof RateLimited) limited = e;
      else console.warn(`Prefetch request failed: ${e}`);
      return undefined;
    }
  }

  // Catalogue: once a day.
  const stored = await env.ROOMS.get<Catalogue>("catalogue", "json");
  if (!stored || now - stored.at > CATALOGUE_TTL_S * 1000) {
    const raw = await polite(async () => {
      const data = await client.get("/v2/rooms", { lang: "de" });
      if (!Array.isArray(data) || !data.length) throw new EthError("unexpected catalogue response");
      return data;
    });
    if (raw) await env.ROOMS.put("catalogue", JSON.stringify({ at: now, raw: ownAreas(raw) } satisfies Catalogue));
  }
  const catalogue = await readCatalogue(env.ROOMS, now);

  // Allowed date range: once a day.
  if (!meta.minmax || now - meta.minmax.at > MIN_MAX_TTL_S * 1000) {
    const data = (await polite(() => client.get("/min-max-allocation-date"))) as
      | { minDateLoad: string; maxDateLoad: string }
      | undefined;
    if (data) meta.minmax = { at: now, min: data.minDateLoad.slice(0, 10), max: data.maxDateLoad.slice(0, 10) };
  }

  // Study spaces: the list hourly; the occupancy every few minutes, with every reading kept as history.
  const statements: D1PreparedStatement[] = [];
  let spaces = await env.ROOMS.get<Catalogue>("spaces", "json");
  if (!spaces || now - spaces.at > SPACES_CATALOGUE_TTL_S * 1000) {
    const raw = await polite(async () => feedData(await client.getUrl(STUDYSPACES_URL)));
    if (raw) {
      spaces = acceptSpaces(spaces, raw, now);
      await env.ROOMS.put("spaces", JSON.stringify(spaces satisfies Catalogue));
    }
  }
  const occupancyInterval = isQuiet(now) ? OCCUPANCY_NIGHT_INTERVAL_S : OCCUPANCY_INTERVAL_S;
  if (now - meta.occupancyAt >= occupancyInterval * 1000) {
    const raw = await polite(async () => feedData(await client.getUrl(OCCUPANCY_URL)));
    if (raw) {
      const at = Date.now();
      // Not the spaces outside our locations (the feed has every campus; a list stored before this rule has them in `raw`).
      const elsewhere = new Set([...(spaces?.elsewhere ?? []), ...elsewhereIds(spaces?.raw ?? [])]);
      const readings = Object.fromEntries(Object.entries(parseReadings(raw)).filter(([space]) => !elsewhere.has(space)));
      for (const [space, r] of Object.entries(readings)) statements.push(putOccupancy(env.DB, space, at, r));
      statements.push(putSpacesLive(env.DB, { at, readings }));
      meta.occupancyAt = now;
    }
  }

  // Rooms: the most out-of-date first. A room's first fetch of the day covers the whole month (and the morning
  // after it); later fetches cover today and tomorrow.
  const today = zurichDate(now);
  const tomorrow = addDays(today, 1);
  const rooms = parseCatalogue(catalogue);
  const typecodes = new Map(rooms.map((r) => [roomPath(r), r.typecode]));
  const targets = rooms.map(roomPath);
  const refreshed = refreshedTargets(catalogue);
  const fetches = await readFetches(env.DB);
  const quiet = isQuiet(now);
  const picked = pickRooms(targets, fetches, today, budget, {
    quiet,
    refreshed,
    // A little slack, so a room fetched just after a run's start isn't skipped for a whole extra run.
    refreshBefore: (p) => now - (refreshed.get(p)! - PREFETCH_RUN_INTERVAL_S) * 1000,
    maxRefresh: refreshesPerRun(refreshed.values()),
  });

  // Experiment: a few extra re-fetches of rooms that aren't refreshed, and a comparison of every re-fetch.
  const experiment = experimentActive(now) && !quiet;
  const checks = experiment ? pickChecks(targets, fetches, today, EXPERIMENT_CHECKS_PER_RUN, refreshed, new Set(picked)) : [];
  budget += checks.length;
  const compared = experiment ? [...picked.filter((p) => fetches[p]?.fullFrom === today), ...checks] : [];
  const before = new Map<string, { at: number; raw: PackedAllocation[] }>();
  for (const row of await readDays(env.DB, compared, [today, tomorrow])) {
    const b = before.get(row.path);
    before.set(row.path, { at: Math.min(b?.at ?? row.at, row.at), raw: [...(b?.raw ?? []), ...row.raw] });
  }

  const daily = meta.cleaned !== today;
  if (daily) {
    statements.push(deleteDaysBefore(env.DB, addDays(today, -HISTORY_DAYS)));
    meta.cleaned = today;
  }
  let checked = 0;
  for (const path of [...picked, ...checks]) {
    const full = fetches[path]?.fullFrom !== today;
    const to = full ? addDays(today, PREFETCH_DAYS_AHEAD + 1) : tomorrow;
    const raw = await polite(() => client.get(`/rooms/${path}/allocations`, { from: today, to }));
    if (!Array.isArray(raw)) continue;
    const at = Date.now();
    const days = splitDays(raw, today, to);
    for (const d of days) statements.push(putDay(env.DB, { path, at, ...d }));
    fetches[path] = { fullFrom: full ? today : fetches[path].fullFrom, at };
    statements.push(putFetch(env.DB, path, fetches[path]));

    const prev = before.get(path);
    if (prev && !full) {
      const source = checks.includes(path) ? "check" : "refresh";
      if (source === "check") checked++;
      const after = days.flatMap((d) => d.raw);
      statements.push(
        ...logComparison(env.DB, { path, typecode: typecodes.get(path) ?? "", source, today, now: at, prevAt: prev.at, before: prev.raw, after }),
      );
    }
  }

  // Equipment: in the quiet hours, after the rooms, the details of a few rooms per run (worker/equipment.ts).
  let equipment = 0;
  if (quiet && !limited) {
    const stored = (await env.ROOMS.get<EquipmentStore>("equipment", "json")) ?? {};
    const due = pickEquipment(rooms.map((r) => ({ path: roomPath(r), typecode: r.typecode })), stored, now, EQUIPMENT_PER_RUN);
    for (const path of due) {
      if (fetched + failed + equipment > 0) await sleep(gapMs);
      try {
        stored[path] = { at: Date.now(), flags: parseEquipment(await client.get(`/v2/rooms/${path}`, { lang: "de" })) };
      } catch (e) {
        if (e instanceof RateLimited) {
          limited = e;
          break;
        }
        console.warn(`Equipment of ${path} failed: ${e}`);
        // Tried again in a day; what it had stays.
        stored[path] = { at: Date.now() - EQUIPMENT_TTL_S * 1000 + 86400_000, flags: stored[path]?.flags ?? null };
      }
      equipment++;
    }
    if (equipment) await env.ROOMS.put("equipment", JSON.stringify(stored));
  }

  if (limited) {
    meta.backoffUntil = (limited as RateLimited).until;
    console.warn(`Prefetch hit ETH's rate limit; pausing until ${new Date(meta.backoffUntil).toISOString()}`);
  }
  meta.updated = now;
  await env.DB.batch([...statements, ...putMeta(env.DB, meta)]);

  // Once a day, "usually this full" from the occupancy history (worker/usual.ts). A batch of its own: if it fails,
  // the rooms are stored anyway, and it is tried again tomorrow.
  if (daily) {
    try {
      const live = await env.DB
        .prepare("SELECT value FROM meta WHERE key IN ('spaces_live', 'uzh_spaces_live')")
        .all<{ value: string }>();
      const sensors = live.results.flatMap((r) => Object.keys((JSON.parse(r.value) as { readings?: object }).readings ?? {}));
      if (sensors.length) await env.DB.batch(rebuildUsual(env.DB, sensors, now));
    } catch (e) {
      console.error(`Rebuilding usual failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Once a day, the accounts' clean-up: expired sessions, check-ins older than 12 months lose their person, accounts
  // unused for 24 months are deleted (plans/PLAN_ACCOUNTS.md, 7.3 and decision 15). Its own try, like `usual`.
  if (daily && env.ACCOUNTS) {
    try {
      const c = await cleanAccounts(env.ACCOUNTS, now);
      console.log(`Accounts clean-up: ${c.sessions} sessions, ${c.unlinked} check-ins unlinked, ${c.accounts} accounts deleted`);
    } catch (e) {
      console.error(`Accounts clean-up failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const fresh = targets.filter((p) => fetches[p]?.fullFrom === today).length;
  console.log(`Prefetch: ${fetched} ok, ${failed} failed, ${checked} checked, ${equipment} equipment, ${fresh}/${targets.length} rooms fetched for ${today}`);
  return { fetched, failed, checked, equipment, backoffUntil: meta.backoffUntil };
}

export interface MenuPrefetchResult {
  facility: number | null; // the facility fetched, if any was due
  written: number; // days written (changed or new)
  deleted: number; // days Cookpit no longer has
  skipped?: "backoff";
}

const cookpit = (path: string, params: Record<string, string | number>) =>
  `${COOKPIT_URL}${path}?${new URLSearchParams({ "client-id": COOKPIT_CLIENT, lang: "en", ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) })}`;

/**
 * The menu prefetch, on its own Cron Trigger (MENU_CRON): Cookpit's facility list once a day, then one facility per
 * run, three weeks from this Monday in one request. Only the days whose menu changed are written, and days Cookpit no
 * longer has in that window are deleted. Shares ETH's backoff with the room prefetch.
 */
export async function runMenuPrefetch(env: PrefetchEnv, client: EthClient, now = Date.now()): Promise<MenuPrefetchResult> {
  const meta = await readMeta(env.DB, now, true);
  if (now < meta.backoffUntil) {
    console.log(`Menu prefetch skipped: ETH backoff until ${new Date(meta.backoffUntil).toISOString()}`);
    return { facility: null, written: 0, deleted: 0, skipped: "backoff" };
  }
  const statements: D1PreparedStatement[] = [];
  const today = zurichDate(now);
  let limited: RateLimited | null = null;
  const fail = (e: unknown) => {
    if (e instanceof RateLimited) limited = e;
    else console.warn(`Menu prefetch request failed: ${e}`);
    return undefined;
  };

  // Facilities: once a day, and the old days with them.
  let stored = await env.ROOMS.get<Catalogue>("eateries", "json");
  if (!stored || now - stored.at > MENU_FACILITIES_TTL_S * 1000) {
    const raw = await client
      .getUrl(cookpit("/facilities", { "rs-first": 0, "rs-size": 50 }))
      .then((body) => {
        const list = (body as { "facility-array"?: unknown } | null)?.["facility-array"];
        if (!Array.isArray(list) || !list.length) throw new EthError("unexpected Cookpit facilities response");
        return list;
      })
      .catch(fail);
    if (raw) {
      stored = { at: now, raw };
      await env.ROOMS.put("eateries", JSON.stringify(stored));
      statements.push(deleteMenuDaysBefore(env.DB, addDays(today, -MENU_HISTORY_DAYS)));
    }
  }

  // Our places that Cookpit still lists (all of ours until the list is stored).
  const listed = stored ? new Set(parseFacilities(stored.raw).map((f) => f.id)) : null;
  const ids = Object.entries(EATERY_OVERRIDES)
    .filter(([id, o]) => isOwnPlace(o) && (!listed || listed.has(Number(id))))
    .map(([id]) => Number(id));
  const fetches = await readMenuFetches(env.DB);
  const facility = limited ? null : pickFacility(ids, fetches, now);
  let written = 0;
  let deleted = 0;
  if (facility !== null) {
    const from = mondayOf(today);
    const to = addDays(from, MENU_WEEKS * 7 - 1);
    const url = cookpit("/weeklyrotas", { facility, "valid-after": from, "valid-before": to, "rs-first": 0, "rs-size": 50 });
    const raw = await client.getUrl(url).catch(fail);
    const ok = !!raw && Array.isArray((raw as any)["weekly-rota-array"]);
    const at = Date.now();
    if (ok) {
      const before = new Map((await readMenuRange(env.DB, facility, from, to)).map((r) => [r.date, r.data]));
      const days = normalizeRotas(raw, from, to).filter((r) => r.facility === facility);
      for (const { date, day } of days) {
        const data = JSON.stringify(day);
        if (before.get(date) !== data) {
          statements.push(putMenuDay(env.DB, facility, date, at, data));
          written++;
        }
        before.delete(date);
      }
      for (const date of before.keys()) {
        statements.push(deleteMenuDay(env.DB, facility, date));
        deleted++;
      }
    } else if (raw) console.warn(`Menu prefetch: unexpected Cookpit answer for facility ${facility}`);
    // A failed fetch waits for its next turn too, so one broken place doesn't take every run.
    statements.push(putMenuFetch(env.DB, facility, { at, ok, lines: ok ? hasLines(raw) : (fetches[facility]?.lines ?? false) }));
  }

  if (limited) {
    statements.push(putBackoff(env.DB, (limited as RateLimited).until));
    console.warn(`Menu prefetch hit ETH's rate limit; pausing until ${new Date((limited as RateLimited).until).toISOString()}`);
  }
  if (statements.length) await env.DB.batch(statements);
  console.log(`Menu prefetch: facility ${facility ?? "none due"}, ${written} days written, ${deleted} deleted`);
  return { facility, written, deleted };
}
