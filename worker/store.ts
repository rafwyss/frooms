// Prefetched data. The scheduled prefetch (prefetch.ts) is the only writer; requests only read (but for the reports
// and the feedback, which POST requests write).
//
// D1 (`DB`, schema in migrations/):
//   allocations - one row per room and day, from HISTORY_DAYS ago to PREFETCH_DAYS_AHEAD days ahead
//   fetch_state - per source (ETH, UZH), one JSON row: each room's first day of its last full fetch, and when it was
//                 last fetched (`fetches`, one row per room, is its predecessor, read only until both rows exist)
//   meta        - "updated", "backoff_until", "minmax", "cleaned" (the day old rows were last deleted),
//                 "occupancy_at" (last occupancy fetch) and "spaces_live" (its readings, see SpacesLive)
//   occupancy   - every occupancy reading of the study spaces, as a history
//   menu_days   - one row per Cookpit facility (or UZH mensa, keys from 100001) and day (MenuDay JSON), from
//                 MENU_HISTORY_DAYS ago to three weeks ahead
//   menu_fetches - per Cookpit facility: the last menu fetch
//   reports     - occupancy reports from the page (worker/reports.ts; the one table requests write)
//   usual       - "usually this full" per sensor space and weekday, rebuilt once a day (worker/usual.ts)
// KV (`ROOMS`):
//   "catalogue" - the /v2/rooms response (Zentrum and Hönggerberg only), refreshed daily
//   "spaces"    - the study spaces (studyspaces.json `data`, Zentrum and Hönggerberg only), refreshed hourly
//   "eateries"  - Cookpit's facility list (`facility-array`), refreshed daily
//   "uzh_catalogue" - UZH's rooms (worker/uzh.ts UzhRoomRaw), each campus refreshed daily
//   "uzh_libraries" - the University Library's location list (trimmed, worker/uzhspaces.ts), refreshed daily
//   "equipment" - ETH's rooms' equipment by path (worker/equipment.ts), a few rooms per night run, each monthly
// UZH's own prefetch state is in meta too: "uzh" (UzhState), "uzh_spaces_live" (the library sensors' readings) and
// "uzh_menus" (UzhMenuState, the menu prefetch's).

import eateriesSnapshotFile from "../data/eateries_snapshot.json";
import snapshotFile from "../data/rooms_snapshot.json";
import spacesSnapshotFile from "../data/spaces_snapshot.json";
import { AREAS } from "./config";
import { clearEquipmentMemory } from "./equipment";
import type { FacilityFetch, MealName, MenuDay, Slot } from "./menus";
import { renameCatalogue } from "./overrides";
import type { Reading } from "./spaces";
import { UZH_SNAPSHOT, type UzhRoomRaw } from "./uzh";
import { LIBRARIES_SNAPSHOT } from "./uzhspaces";
import { addDays, type IsoDate } from "./tz";
import { clearUsualMemory } from "./usual";

/** The subset of an allocation entry that parseAllocations reads. */
export interface SlimAllocation {
  date_from: string;
  date_to: string;
  belegungsserie: {
    belegungstyp?: number;
    veranstaltung: { allocationTitle?: string | null; findetStatt?: number | boolean } | null;
  };
}

/** A SlimAllocation as stored: [date_from, date_to, belegungstyp, allocationTitle, findetStatt], without the
 * last two when there's no veranstaltung. About a quarter the size of the object form. */
export type PackedAllocation =
  | [string, string, number | null]
  | [string, string, number | null, string | null, number | boolean | null];

/** One stored day of one room. */
export interface DayRow {
  path: string;
  day: IsoDate;
  at: number; // when it was fetched from ETH (epoch ms)
  raw: PackedAllocation[];
}

export interface FetchState {
  fullFrom: IsoDate; // first day of the last fetch that covered the whole range (PREFETCH_DAYS_AHEAD)
  at: number; // last fetch of any kind
}

export interface Meta {
  updated: number;
  backoffUntil: number;
  minmax: { at: number; min: IsoDate; max: IsoDate } | null;
  cleaned: IsoDate | "";
  occupancyAt: number;
}

/** The latest occupancy fetch: when it happened and the readings by space id. */
export interface SpacesLive {
  at: number;
  readings: Record<string, Reading>;
}

export interface Catalogue {
  at: number;
  raw: unknown[];
  elsewhere?: string[]; // study spaces: the ids of those outside our locations, left out of `raw`
  shortSince?: number; // study spaces: since when ETH has answered with a much shorter list (kept out, worker/prefetch.ts)
}

export function pack(raw: any[]): PackedAllocation[] {
  return raw.map((e) => {
    const serie = e.belegungsserie ?? {};
    const event = serie.veranstaltung;
    const typ = serie.belegungstyp ?? null;
    return event
      ? [e.date_from, e.date_to, typ, event.allocationTitle ?? null, event.findetStatt ?? null]
      : [e.date_from, e.date_to, typ];
  });
}

export function unpack(packed: PackedAllocation[]): SlimAllocation[] {
  return packed.map((p) => ({
    date_from: p[0],
    date_to: p[1],
    belegungsserie: {
      belegungstyp: p[2] ?? undefined,
      veranstaltung: p.length > 3 ? { allocationTitle: p[3], findetStatt: p[4] ?? undefined } : null,
    },
  }));
}

/** Split a fetch of `from` to `to` (inclusive) into one entry per day, by the day each booking starts. */
export const splitDays = (raw: any[], from: IsoDate, to: IsoDate) => splitPacked(pack(raw), from, to);

/** splitDays for allocations that are packed already (UZH's, worker/uzh.ts packBlocks). */
export function splitPacked(packed: PackedAllocation[], from: IsoDate, to: IsoDate): { day: IsoDate; raw: PackedAllocation[] }[] {
  const days = new Map<IsoDate, PackedAllocation[]>();
  for (let d = from; d <= to; d = addDays(d, 1)) days.set(d, []);
  for (const p of packed) days.get(p[0].slice(0, 10))?.push(p);
  return [...days].map(([day, raw]) => ({ day, raw }));
}

// D1 allows at most 100 bound parameters per query; leave room for the days.
const PATHS_PER_QUERY = 90;

export async function readDays(db: D1Database, paths: string[], days: IsoDate[]): Promise<DayRow[]> {
  if (!paths.length || !days.length) return [];
  const q = (n: number) => Array(n).fill("?").join(", ");
  const rows: DayRow[] = [];
  for (let i = 0; i < paths.length; i += PATHS_PER_QUERY) {
    const chunk = paths.slice(i, i + PATHS_PER_QUERY);
    const { results } = await db
      .prepare(`SELECT path, day, at, raw FROM allocations WHERE day IN (${q(days.length)}) AND path IN (${q(chunk.length)})`)
      .bind(...days, ...chunk)
      .all<{ path: string; day: string; at: number; raw: string }>();
    rows.push(...results.map((r) => ({ ...r, raw: JSON.parse(r.raw) })));
  }
  return rows;
}

export const putDay = (db: D1Database, row: DayRow) =>
  db
    .prepare("INSERT OR REPLACE INTO allocations (path, day, at, raw) VALUES (?, ?, ?, ?)")
    .bind(row.path, row.day, row.at, JSON.stringify(row.raw));

export const deleteDaysBefore = (db: D1Database, day: IsoDate) =>
  db.prepare("DELETE FROM allocations WHERE day < ?").bind(day);

export type FetchSource = "eth" | "uzh";

/**
 * Every room's FetchState, ETH's and UZH's: one JSON row per source in `fetch_state`, two rows read. While a source has
 * no row yet (before its first run since migration 0007), the old per-room table `fetches` fills in for it.
 */
export async function readFetches(db: D1Database): Promise<Record<string, FetchState>> {
  const { results } = await db.prepare("SELECT source, value FROM fetch_state").all<{ source: string; value: string }>();
  const out: Record<string, FetchState> = {};
  if (results.length < 2) {
    const old = await db.prepare("SELECT path, full_from, at FROM fetches").all<{ path: string; full_from: string; at: number }>();
    for (const r of old.results) out[r.path] = { fullFrom: r.full_from, at: r.at };
  }
  for (const r of results) {
    for (const [path, [fullFrom, at]] of Object.entries(JSON.parse(r.value) as Record<string, [IsoDate, number]>)) {
      out[path] = { fullFrom, at };
    }
  }
  return out;
}

/** One source's FetchState of its `targets` (rooms no longer in its catalogue drop out), as one row. */
export function putFetches(db: D1Database, source: FetchSource, fetches: Record<string, FetchState>, targets: string[]) {
  const value: Record<string, [IsoDate, number]> = {};
  for (const path of targets) if (fetches[path]) value[path] = [fetches[path].fullFrom, fetches[path].at];
  return db.prepare("INSERT OR REPLACE INTO fetch_state (source, value) VALUES (?, ?)").bind(source, JSON.stringify(value));
}

export const putOccupancy = (db: D1Database, space: string, at: number, r: Reading) =>
  db
    .prepare(
      "INSERT OR REPLACE INTO occupancy (space, at, measured_at, people, capacity, pct, status, trend, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(space, at, r.measured_at, r.people, r.capacity, r.pct, r.status, r.trend, r.active === null ? null : Number(r.active));

export const putSpacesLive = (db: D1Database, live: SpacesLive) =>
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('spaces_live', ?)").bind(JSON.stringify(live));

const META_MEMORY_S = 60;
const CATALOGUE_MEMORY_S = 3600;
const SPACES_MEMORY_S = 600;
let metaMemo: { at: number; value: Meta } | null = null;
let catalogueMemo: { at: number; value: unknown[] } | null = null;
let spacesMemo: { at: number; value: Catalogue } | null = null;
let liveMemo: { at: number; value: SpacesLive | null } | null = null;
let eateriesMemo: { at: number; value: Catalogue } | null = null;
let uzhCatalogueMemo: { at: number; value: UzhCatalogue } | null = null;
let uzhLiveMemo: { at: number; value: SpacesLive | null } | null = null;
let uzhLibrariesMemo: { at: number; value: Catalogue } | null = null;

export const clearStoreMemory = () => {
  clearEquipmentMemory();
  clearUsualMemory();
  uzhCatalogueMemo = null;
  uzhLiveMemo = null;
  uzhLibrariesMemo = null;
  metaMemo = null;
  catalogueMemo = null;
  spacesMemo = null;
  liveMemo = null;
  eateriesMemo = null;
};

/** The latest occupancy readings, cached in isolate memory for a minute. */
export async function readSpacesLive(db: D1Database, now = Date.now()): Promise<SpacesLive | null> {
  if (liveMemo && now - liveMemo.at < META_MEMORY_S * 1000) return liveMemo.value;
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'spaces_live'").first<{ value: string }>();
  const value = row ? (JSON.parse(row.value) as SpacesLive) : null;
  liveMemo = { at: now, value };
  return value;
}

/** The study spaces from KV with when they were fetched, or the bundled snapshot (at: 0) until the prefetch stores them. */
export async function readSpacesCatalogue(kv: KVNamespace | undefined, now = Date.now()): Promise<Catalogue> {
  if (spacesMemo && now - spacesMemo.at < SPACES_MEMORY_S * 1000) return spacesMemo.value;
  const stored = await kv?.get<Catalogue>("spaces", { type: "json", cacheTtl: SPACES_MEMORY_S });
  const value = stored?.raw?.length ? stored : { at: 0, raw: spacesSnapshotFile as unknown[] };
  spacesMemo = { at: now, value };
  return value;
}

/** The prefetch state, cached in isolate memory for a minute unless `fresh`. */
export async function readMeta(db: D1Database, now = Date.now(), fresh = false): Promise<Meta> {
  if (!fresh && metaMemo && now - metaMemo.at < META_MEMORY_S * 1000) return metaMemo.value;
  const { results } = await db
    .prepare("SELECT key, value FROM meta WHERE key NOT IN ('spaces_live', 'uzh', 'uzh_spaces_live')")
    .all<{ key: string; value: string }>();
  const kv = new Map(results.map((r) => [r.key, r.value]));
  const value: Meta = {
    updated: Number(kv.get("updated") ?? 0),
    backoffUntil: Number(kv.get("backoff_until") ?? 0),
    minmax: kv.has("minmax") ? JSON.parse(kv.get("minmax")!) : null,
    cleaned: kv.get("cleaned") ?? "",
    occupancyAt: Number(kv.get("occupancy_at") ?? 0),
  };
  metaMemo = { at: now, value };
  return value;
}

export function putMeta(db: D1Database, meta: Meta): D1PreparedStatement[] {
  const put = (key: string, value: string) =>
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(key, value);
  const statements = [put("updated", String(meta.updated)), put("backoff_until", String(meta.backoffUntil))];
  if (meta.minmax) statements.push(put("minmax", JSON.stringify(meta.minmax)));
  if (meta.cleaned) statements.push(put("cleaned", meta.cleaned));
  if (meta.occupancyAt) statements.push(put("occupancy_at", String(meta.occupancyAt)));
  return statements;
}

/** ETH's raw room catalogue without the rooms outside our locations (AREAS). */
export const ownAreas = (raw: unknown[]) => raw.filter((r) => AREAS.includes((r as { area?: string } | null)?.area ?? ""));

/**
 * The room catalogue from KV, or the bundled snapshot if the prefetch hasn't stored one yet, with our names
 * (data/overrides.json) and only our locations (a catalogue stored before that rule still has every area).
 */
export async function readCatalogue(kv: KVNamespace | undefined, now = Date.now()): Promise<unknown[]> {
  if (catalogueMemo && now - catalogueMemo.at < CATALOGUE_MEMORY_S * 1000) return catalogueMemo.value;
  const stored = await kv?.get<Catalogue>("catalogue", { type: "json", cacheTtl: CATALOGUE_MEMORY_S });
  const value = renameCatalogue(ownAreas(stored?.raw?.length ? stored.raw : (snapshotFile as unknown[])));
  catalogueMemo = { at: now, value };
  return value;
}

/** Cookpit's facility list from KV with when it was fetched, or the bundled snapshot (at: 0) until the prefetch stores it. */
export async function readEateriesCatalogue(kv: KVNamespace | undefined, now = Date.now()): Promise<Catalogue> {
  if (eateriesMemo && now - eateriesMemo.at < SPACES_MEMORY_S * 1000) return eateriesMemo.value;
  const stored = await kv?.get<Catalogue>("eateries", { type: "json", cacheTtl: SPACES_MEMORY_S });
  const value = stored?.raw?.length ? stored : { at: 0, raw: eateriesSnapshotFile["facility-array"] as unknown[] };
  eateriesMemo = { at: now, value };
  return value;
}

// --- menus ---

/** The stored days of one facility from `from` to `to`, as JSON text (compared before writing, parsed when served). */
export async function readMenuRange(db: D1Database, facility: number, from: IsoDate, to: IsoDate) {
  const { results } = await db
    .prepare("SELECT date, at, data FROM menu_days WHERE facility = ? AND date >= ? AND date <= ? ORDER BY date")
    .bind(facility, from, to)
    .all<{ date: string; at: number; data: string }>();
  return results;
}

/** One day of every facility in `facilities`. */
export async function readMenuDate(db: D1Database, facilities: number[], date: IsoDate): Promise<Map<number, MenuDay>> {
  if (!facilities.length) return new Map();
  const { results } = await db
    .prepare(`SELECT facility, data FROM menu_days WHERE date = ? AND facility IN (${facilities.map(() => "?").join(", ")})`)
    .bind(date, ...facilities)
    .all<{ facility: number; data: string }>();
  return new Map(results.map((r) => [r.facility, JSON.parse(r.data) as MenuDay]));
}

/** Some days of some facilities (the Eat tab's cards: today and the next day with meals), by facility and date. */
export async function readMenuDates(db: D1Database, facilities: number[], dates: IsoDate[]): Promise<Map<number, Map<IsoDate, MenuDay>>> {
  const out = new Map<number, Map<IsoDate, MenuDay>>();
  if (!facilities.length || !dates.length) return out;
  const q = (n: number) => Array(n).fill("?").join(", ");
  const { results } = await db
    .prepare(`SELECT facility, date, data FROM menu_days WHERE date IN (${q(dates.length)}) AND facility IN (${q(facilities.length)})`)
    .bind(...dates, ...facilities)
    .all<{ facility: number; date: IsoDate; data: string }>();
  for (const r of results) {
    if (!out.has(r.facility)) out.set(r.facility, new Map());
    out.get(r.facility)!.set(r.date, JSON.parse(r.data) as MenuDay);
  }
  return out;
}

export interface MenuTimes {
  hours: [string, string][];
  meals: { meal: MealName; from: string; to: string }[];
}

/**
 * Opening hours and meal times only (no dishes) of every facility from `from` to `to`, for the cards' status. SQLite
 * picks them out of the JSON, so the Worker doesn't parse whole menus for it.
 */
export async function readMenuTimes(db: D1Database, from: IsoDate, to: IsoDate): Promise<Map<number, Map<IsoDate, MenuTimes>>> {
  const { results } = await db
    .prepare(
      `SELECT facility, date, json_extract(data, '$.hours') AS hours,
        (SELECT json_group_array(json_object('meal', json_extract(m.value, '$.meal'), 'from', json_extract(m.value, '$.from'), 'to', json_extract(m.value, '$.to')))
         FROM json_each(menu_days.data, '$.meals') AS m) AS meals
       FROM menu_days WHERE date >= ? AND date <= ?`,
    )
    .bind(from, to)
    .all<{ facility: number; date: string; hours: string; meals: string }>();
  const out = new Map<number, Map<IsoDate, MenuTimes>>();
  for (const r of results) {
    if (!out.has(r.facility)) out.set(r.facility, new Map());
    out.get(r.facility)!.set(r.date, { hours: JSON.parse(r.hours), meals: JSON.parse(r.meals) });
  }
  return out;
}

/** The dates and meals from `from` on with dishes at any of `facilities`, and when each ends at the latest. */
export async function readSlots(db: D1Database, facilities: number[], from: IsoDate): Promise<Slot[]> {
  if (!facilities.length) return [];
  const { results } = await db
    .prepare(
      `SELECT d.date AS date, json_extract(m.value, '$.meal') AS meal, MAX(json_extract(m.value, '$.to')) AS "to"
       FROM menu_days AS d, json_each(d.data, '$.meals') AS m
       WHERE d.date >= ? AND d.facility IN (${facilities.map(() => "?").join(", ")})
         AND json_array_length(m.value, '$.dishes') > 0
       GROUP BY d.date, meal ORDER BY d.date, "to"`,
    )
    .bind(from, ...facilities)
    .all<Slot>();
  return results.map((r) => ({ date: r.date, meal: r.meal, to: r.to }));
}

/** Whether `image` belongs to a dish from `from` to `to` (dish photos are served for today's and tomorrow's menus only). */
export async function isMenuImage(db: D1Database, from: IsoDate, to: IsoDate, image: number | string): Promise<boolean> {
  // The image id is the last field of a dish, so it's followed by "}" in the stored JSON (worker/menus.ts Dish).
  const row = await db
    .prepare("SELECT 1 AS hit FROM menu_days WHERE date >= ? AND date <= ? AND instr(data, ?) > 0 LIMIT 1")
    .bind(from, to, `"image":${JSON.stringify(image)}}`)
    .first<{ hit: number }>();
  return row !== null;
}

export const putMenuDay = (db: D1Database, facility: number, date: IsoDate, at: number, data: string) =>
  db.prepare("INSERT OR REPLACE INTO menu_days (facility, date, at, data) VALUES (?, ?, ?, ?)").bind(facility, date, at, data);

export const deleteMenuDay = (db: D1Database, facility: number, date: IsoDate) =>
  db.prepare("DELETE FROM menu_days WHERE facility = ? AND date = ?").bind(facility, date);

export const deleteMenuDaysBefore = (db: D1Database, date: IsoDate) =>
  db.prepare("DELETE FROM menu_days WHERE date < ?").bind(date);

export async function readMenuFetches(db: D1Database): Promise<Record<number, FacilityFetch>> {
  const { results } = await db
    .prepare("SELECT facility, at, ok, lines FROM menu_fetches")
    .all<{ facility: number; at: number; ok: number; lines: number }>();
  return Object.fromEntries(results.map((r) => [r.facility, { at: r.at, ok: r.ok === 1, lines: r.lines === 1 }]));
}

export const putMenuFetch = (db: D1Database, facility: number, f: FacilityFetch) =>
  db
    .prepare("INSERT OR REPLACE INTO menu_fetches (facility, at, ok, lines) VALUES (?, ?, ?, ?)")
    .bind(facility, f.at, Number(f.ok), Number(f.lines));

/** Stored days of some places from `from` on, for the UZH menu prefetch. */
export async function readMenuDaysFrom(db: D1Database, facilities: number[], from: IsoDate): Promise<{ facility: number; date: IsoDate; data: string }[]> {
  if (!facilities.length) return [];
  const { results } = await db
    .prepare(`SELECT facility, date, data FROM menu_days WHERE date >= ? AND facility IN (${facilities.map(() => "?").join(", ")})`)
    .bind(from, ...facilities)
    .all<{ facility: number; date: IsoDate; data: string }>();
  return results;
}

export const putBackoff = (db: D1Database, until: number) =>
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('backoff_until', ?)").bind(String(until));

// --- UZH (worker/uzh.ts) ---

/** UZH's prefetch state, one JSON value in meta ("uzh"). */
export interface UzhState {
  session: string | null; // the calendar's session cookies
  backoffUntil: number; // UZH asked us to slow down until then (epoch ms)
  occupancyAt: number; // last library-sensor fetch
  updated: number; // last run
}

export interface UzhCatalogue {
  at: number; // 0: the bundled snapshot
  areas: Record<string, number>; // when each campus was last fetched
  raw: UzhRoomRaw[];
}

export async function readUzhState(db: D1Database): Promise<UzhState> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'uzh'").first<{ value: string }>();
  const stored = row ? (JSON.parse(row.value) as Partial<UzhState>) : {};
  return { session: stored.session ?? null, backoffUntil: stored.backoffUntil ?? 0, occupancyAt: stored.occupancyAt ?? 0, updated: stored.updated ?? 0 };
}

export const putUzhState = (db: D1Database, state: UzhState) =>
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('uzh', ?)").bind(JSON.stringify(state));

/** UZH's menu prefetch (worker/uzhprefetch.ts runUzhMenuPrefetch), one JSON value in meta ("uzh_menus"). */
export interface UzhMenuState {
  backoffUntil: number; // food2050 asked us to slow down until then (epoch ms)
  pages: Record<string, number>; // weekly page ("UM1|lunch|2026-11-09") -> last fetch
  priced: Record<string, number>; // dish page (menu item id) -> last fetch that gave no prices
  photos: Record<string, number>; // dish page -> last fetch for a photo it didn't have (today's and tomorrow's dishes)
  updated: number; // last run
}

export async function readUzhMenuState(db: D1Database): Promise<UzhMenuState> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'uzh_menus'").first<{ value: string }>();
  const stored = row ? (JSON.parse(row.value) as Partial<UzhMenuState>) : {};
  return { backoffUntil: stored.backoffUntil ?? 0, pages: stored.pages ?? {}, priced: stored.priced ?? {}, photos: stored.photos ?? {}, updated: stored.updated ?? 0 };
}

export const putUzhMenuState = (db: D1Database, state: UzhMenuState) =>
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('uzh_menus', ?)").bind(JSON.stringify(state));

/** The library sensors' latest readings, cached in isolate memory for a minute. */
export async function readUzhSpacesLive(db: D1Database, now = Date.now()): Promise<SpacesLive | null> {
  if (uzhLiveMemo && now - uzhLiveMemo.at < META_MEMORY_S * 1000) return uzhLiveMemo.value;
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'uzh_spaces_live'").first<{ value: string }>();
  const value = row ? (JSON.parse(row.value) as SpacesLive) : null;
  uzhLiveMemo = { at: now, value };
  return value;
}

export const putUzhSpacesLive = (db: D1Database, live: SpacesLive) =>
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('uzh_spaces_live', ?)").bind(JSON.stringify(live));

/** UZH's rooms from KV, or the bundled snapshot (at: 0) until the prefetch stores them. */
export async function readUzhCatalogue(kv: KVNamespace | undefined, now = Date.now()): Promise<UzhCatalogue> {
  if (uzhCatalogueMemo && now - uzhCatalogueMemo.at < CATALOGUE_MEMORY_S * 1000) return uzhCatalogueMemo.value;
  const stored = await kv?.get<UzhCatalogue>("uzh_catalogue", { type: "json", cacheTtl: CATALOGUE_MEMORY_S });
  const value = stored?.raw?.length ? stored : { at: 0, areas: {}, raw: UZH_SNAPSHOT };
  uzhCatalogueMemo = { at: now, value };
  return value;
}

/** The University Library's location list from KV, or the bundled snapshot (at: 0) until the prefetch stores it. */
export async function readUzhLibraries(kv: KVNamespace | undefined, now = Date.now()): Promise<Catalogue> {
  if (uzhLibrariesMemo && now - uzhLibrariesMemo.at < SPACES_MEMORY_S * 1000) return uzhLibrariesMemo.value;
  const stored = await kv?.get<Catalogue>("uzh_libraries", { type: "json", cacheTtl: SPACES_MEMORY_S });
  const value = stored?.raw?.length ? stored : { at: 0, raw: LIBRARIES_SNAPSHOT };
  uzhLibrariesMemo = { at: now, value };
  return value;
}
