// UZH's libraries for the Libraries & study spaces tab: the University Library's location list (hours, buildings,
// seats, closures; fetched daily by worker/uzhprefetch.ts) as Space records, with the seat sensors' readings.
// Only the locations on our three UZH campuses, with seats (data/uzh.json library_campuses).

import file from "../data/uzh.json";
import snapshotFile from "../data/uzh_libraries_snapshot.json";
import type { Space } from "./spaces";
import { addDays, type IsoDate, parseNaive } from "./tz";

const DAY_KEYS = ["mo", "di", "mi", "do", "fr", "sa", "so"];
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LIBRARY_CAMPUSES: Record<string, string> = file.library_campuses;
const NOTES: Record<string, string> = (file as { library_notes?: Record<string, string> }).library_notes ?? {};

export const UZH_LIBRARIES_URL: string = file.libraries_url;
export const LIBRARIES_SNAPSHOT = snapshotFile as unknown[];

/** A seat sensor (data/uzh.json `sensors`): the space it's shown as, and the library location it counts. */
export interface UzhSensor {
  id: string; // our space id: 'UB104', or 'UB4.2' where one location has several sensors
  sensor: string;
  bib: number;
  name: string | null;
}

const sensorsByBib = new Map<number, string[]>();
for (const [sensor, s] of Object.entries(file.sensors)) sensorsByBib.set(s.bib, [...(sensorsByBib.get(s.bib) ?? []), sensor]);

export const UZH_SENSORS: UzhSensor[] = Object.entries(file.sensors).map(([sensor, s]) => ({
  id: (sensorsByBib.get(s.bib)?.length ?? 0) > 1 ? `UB${s.bib}.${sensor}` : `UB${s.bib}`,
  sensor,
  bib: s.bib,
  name: (s as { name?: string }).name ?? null,
}));

// The fields read below; the prefetch stores only these (scripts/uzh_catalogue.py trims the snapshot the same way).
const LIBRARY_FIELDS = [
  "id", "bibname", "bibname_en", "adrzeile5gebbez", "raumbez", "standort", "anzarbeitsplatz", "website", "website_alt",
  "bibstatus", "zuguzhcard",
  ...DAY_KEYS.flatMap((d) => ["von", "bis"].flatMap((k) => ["1", "2"].map((n) => `${d}${k}${n}`))),
  ...DAY_KEYS.flatMap((d) => ["von", "bis"].map((k) => `uzh${d}${k}`)),
];
const CLOSURE_FIELDS = ["schliessungvon", "schliessungbis", "art", "bezeichnung_en"];

const pick = (o: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? null]));

export function trimLibraries(raw: unknown[]): unknown[] {
  return raw.map((b: any) => ({
    ...pick(b, LIBRARY_FIELDS),
    bibSchliessungen: (Array.isArray(b?.bibSchliessungen) ? b.bibSchliessungen : []).map((c: any) => pick(c, CLOSURE_FIELDS)),
  }));
}

/** A closure: [from, to) in epoch ms, and what it's for ('Labour Day'). */
export type Closure = [number, number, string | null];

export interface UzhLibrary extends Space {
  closures: Closure[];
  /** The UZH-card hours where they go beyond the regular ones (open by them with a UZH card), else null. */
  cardHours: string[] | null;
}

const hhmm = (v: unknown) => (typeof v === "string" && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : null);
const dot = (t: string) => t.replace(":", ".");

/** One day's intervals ('09.00 - 17.00'), from the `<day>von1/bis1` fields or, with `card`, `uzh<day>von/bis`. */
function dayIntervals(b: any, d: string, card: boolean): string[] {
  const pairs = card ? [[b[`uzh${d}von`], b[`uzh${d}bis`]]] : ["1", "2"].map((n) => [b[`${d}von${n}`], b[`${d}bis${n}`]]);
  return pairs
    .map(([f, t]) => [hhmm(f), hhmm(t)])
    .filter(([f, t]) => f && t && f !== t)
    .map(([f, t]) => `${dot(f!)} - ${dot(t === "00:00" ? "23:59" : t!)}`);
}

/** The week as opening-hours lines in the form worker/spaces.ts parseHours reads: 'Mon - Fri: 09.00 - 17.00'. */
export function hoursLines(b: unknown, card = false): string[] {
  const days = DAY_KEYS.map((d) => dayIntervals(b, d, card).join(" and "));
  if (!days.some(Boolean)) return [];
  const lines: string[] = [];
  for (let i = 0; i < 7; ) {
    let j = i;
    while (j + 1 < 7 && days[j + 1] === days[i]) j++;
    const span = i === j ? DAY_NAMES[i] : `${DAY_NAMES[i]} - ${DAY_NAMES[j]}`;
    lines.push(`${span}: ${days[i] || "Closed"}`);
    i = j + 1;
  }
  return lines;
}

/** '2026-05-13 16:00:00' to '2026-05-14 00:00:00': from 16:00 on the 13th to the end of the 14th (a date alone is the whole day). */
export function parseClosure(c: any): Closure | null {
  const from = typeof c?.schliessungvon === "string" ? c.schliessungvon : null;
  const to = typeof c?.schliessungbis === "string" ? c.schliessungbis : null;
  if (!from || !to) return null;
  const start = parseNaive(from.replace(" ", "T"));
  const endDay: IsoDate = to.slice(0, 10);
  const end = to.slice(11, 16) === "00:00" || to.length <= 10 ? parseNaive(`${addDays(endDay, 1)}T00:00:00`) : parseNaive(to.replace(" ", "T"));
  if (start === null || end === null || end <= start) return null;
  return [start, end, typeof c.bezeichnung_en === "string" && c.bezeichnung_en.trim() ? c.bezeichnung_en.trim() : null];
}

/**
 * The library list as spaces: the active locations on our campuses with seats and published hours, one per sensor
 * where a location has several. Open by the regular hours; where a location has none (open to UZH members only), by its UZH-card hours,
 * with a note. Card hours beyond the regular ones are shown as a line of their own and kept as `cardHours`: outside the
 * regular hours but inside those, the list shows it open with a UZH card (worker/index.ts uzhSpacesList).
 */
export function uzhLibraries(raw: unknown[]): UzhLibrary[] {
  const out: UzhLibrary[] = [];
  for (const b of raw as any[]) {
    const area = LIBRARY_CAMPUSES[b?.standort];
    const seats = Number.isInteger(b?.anzarbeitsplatz) && b.anzarbeitsplatz > 0 ? b.anzarbeitsplatz : null;
    const building = typeof b?.adrzeile5gebbez === "string" ? b.adrzeile5gebbez.trim() : "";
    if (!area || b?.bibstatus !== "Aktiv" || !building || (seats === null && !sensorsByBib.has(b.id))) continue;
    const regular = hoursLines(b);
    const card = hoursLines(b, true);
    // Without any hours we couldn't tell when it's open: left out rather than shown as always closed.
    if (!regular.length && !card.length) continue;
    const cardOnly = !regular.length && card.length > 0;
    const hours = cardOnly ? card : regular;
    const cardHours = !cardOnly && card.length && card.join() !== regular.join() ? card : null;
    if (cardHours) hours.push(`With a UZH card: ${card.join(", ")}`);
    const room = typeof b.raumbez === "string" && b.raumbez.trim() ? b.raumbez.trim() : building;
    const base = {
      room,
      category: "library" as const,
      building,
      area,
      features: [],
      hours,
      card24h: false,
      notice: cardOnly ? (NOTES[String(b.id)] ?? "UZH members only (UZH card)") : null,
      info_url: b.website_alt || b.website || "https://www.ub.uzh.ch/en/ub-besuchen/standorte.html",
      eth: { open: false, nextOpen: null },
      cardHours,
      closures: (Array.isArray(b.bibSchliessungen) ? b.bibSchliessungen : []).map(parseClosure).filter((c: Closure | null): c is Closure => !!c),
    };
    const name = String(b.bibname_en || b.bibname || building).trim();
    const sensors = UZH_SENSORS.filter((s) => s.bib === b.id);
    if (sensors.length > 1) for (const s of sensors) out.push({ ...base, id: s.id, name: s.name ?? name, seats: null });
    else out.push({ ...base, id: `UB${b.id}`, name, seats });
  }
  return out;
}

/** The closure in effect at `at`, if any. */
export const closureAt = (lib: UzhLibrary, at: number) => lib.closures.find(([f, t]) => f <= at && at < t) ?? null;
