// Study spaces, libraries and mensas from ETH's student-workspace pages: the list, opening hours and occupancy.
// The scheduled prefetch (prefetch.ts) stores both feeds; /api/spaces serves them without asking ETH.

import { CAMPUS_AREAS, OCCUPANCY_MAX_AGE_S, SPACE_CATEGORIES } from "./config";
import { EXTRA_SPACES, SPACE_OVERRIDES } from "./overrides";
import { addDays, type IsoDate, weekday, zurichDate, zurichToUtc, zurichWall } from "./tz";

export type Category = "library" | "mensa" | "open" | "workspace";

/** Minutes since midnight, from (inclusive) to (exclusive). */
type Interval = [number, number];
/** One list of intervals per weekday, Monday first. */
type Week = Interval[][];

export interface Hours {
  open: Week;
  meals: Week;
  card24h: boolean; // open around the clock with an ETH card, outside the regular hours too
  unknown: string[]; // lines the parser doesn't understand
}

export interface Space {
  id: string; // ETH's roomGlobalIdentifier, e.g. 'HGH30.1'
  room: string; // 'HG H 30.1'
  name: string; // 'ETH Library/Info-Center'
  category: Category;
  building: string;
  area: string;
  seats: number | null;
  features: { key: string; label: string }[];
  hours: string[];
  card24h: boolean;
  notice: string | null;
  info_url: string;
  eth: { open: boolean; nextOpen: IsoDate | null }; // ETH's own state when the list was fetched
  shown_hours?: string[]; // the opening-hours lines shown instead of `hours` (our extra spaces)
  open_text?: string; // the status while open, instead of "Open" (our extra spaces: "Open for SPH projects")
}

/** One reading from the occupancy feed. */
export interface Reading {
  people: number | null;
  capacity: number | null;
  pct: number | null;
  status: string | null;
  trend: string | null;
  measured_at: number | null; // ETH's timestamp (epoch ms)
  active: boolean | null;
}

export interface Estimate {
  pct: number;
  status: "green" | "yellow" | "red";
  trend: string | null;
  measured_at: number;
}

export interface SpaceState {
  open: boolean;
  until: number | null; // end of the current open stretch, or of the current meal time
  opens_at: number | null; // next opening, if closed
  meal: boolean; // inside a meal time (mensas)
  card_only: boolean; // outside the regular hours, but open with an ETH card
  open_until: number | null; // end of the current open stretch, also during a meal time (when it's a study space after)
}

const LOCATION_PAGE = "https://ethz.ch/en/utils/location.html";
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_SPEC = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:\s*-\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun))?:\s*(.+)$/;
const RANGE = /^(\d{1,2})[.:](\d{2})\s*-\s*(\d{1,2})[.:](\d{2})$/;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** ETH's location page for a room (or a floor, without `room`). */
export const locationUrl = (building: string, floor: string | null, room = "") =>
  `${LOCATION_PAGE}?${new URLSearchParams({ building, floor: floor ?? "", room })}`;

/** ETH's study-space list (`data`) without the spaces outside our locations (CAMPUS_AREAS). */
export const ownCampuses = (raw: unknown[]) =>
  raw.filter((item) => String((item as { attributes?: { campus?: unknown } } | null)?.attributes?.campus) in CAMPUS_AREAS);

/**
 * The ids of the spaces outside our locations in a study-space list, to leave out their occupancy readings (that feed
 * has no campus; it also has sensors in Zurich that aren't on the list, which are kept).
 */
export const elsewhereIds = (raw: unknown[]) =>
  raw.filter((item) => !ownCampuses([item]).length)
    .map((item) => str((item as { attributes?: { roomGlobalIdentifier?: unknown } } | null)?.attributes?.roomGlobalIdentifier))
    .filter((id): id is string => !!id);

/**
 * The `data` array of ETH's studyspaces.json, as Space records, with our own names and categories applied and the
 * spaces we show as part of another one (merge_into) folded into it: their seats and features added. Our own extra
 * spaces (data/overrides.json extra_spaces, the Student Project Houses) come last.
 */
export function parseSpaces(raw: unknown[]): Space[] {
  const spaces: Space[] = [];
  for (const item of raw as { attributes?: Record<string, any> }[]) {
    const a = item?.attributes;
    const id = str(a?.roomGlobalIdentifier);
    const room = str(a?.title);
    if (!a || !id || !room || !(a.campus in CAMPUS_AREAS)) continue;
    const [building, floor, ...rest] = room.split(" ");
    const code = String(a.roomType?.code ?? "");
    const own = SPACE_OVERRIDES[id];
    spaces.push({
      id,
      room,
      name: own?.name ?? str(a.description) ?? room,
      category: own?.category ?? SPACE_CATEGORIES[code] ?? "open",
      building: str(a.building) ?? building,
      area: CAMPUS_AREAS[a.campus],
      seats: Number.isInteger(a.seats) && a.seats > 0 ? a.seats : null,
      features: Array.isArray(a.features) ? a.features.map((f: any) => ({ key: String(f.key), label: String(f.label) })) : [],
      hours: Array.isArray(a.hours) ? a.hours.map(String) : [],
      card24h: a.has24HourAccess === true,
      notice: str(a.occupancy?.en),
      info_url: locationUrl(building, floor, rest.join(" ")),
      eth: { open: a.isOpen === true, nextOpen: str(a.nextOpenDate) },
    });
  }
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const merged = spaces.filter((s) => {
    const into = byId.get(SPACE_OVERRIDES[s.id]?.mergeInto ?? "");
    if (!into || into === s) return true;
    if (s.seats !== null) into.seats = (into.seats ?? 0) + s.seats;
    const keys = new Set(into.features.map((f) => f.key));
    into.features.push(...s.features.filter((f) => !keys.has(f.key)));
    return false;
  });
  // Ours (data/overrides.json extra_spaces), unless ETH's list has the id after all; one entry per location that
  // lists it (its own area and `also_in`).
  for (const x of EXTRA_SPACES) {
    if (byId.has(x.id)) continue;
    for (const area of [x.area, ...x.alsoIn]) {
      merged.push({
        id: x.id, room: x.room, name: x.name, category: x.category, building: x.building, area, seats: x.seats,
        features: [], hours: x.hours, card24h: false, notice: x.notice, info_url: x.infoUrl, eth: { open: false, nextOpen: null },
        ...(x.shownHours ? { shown_hours: x.shownHours } : {}),
        ...(x.openText ? { open_text: x.openText } : {}),
      });
    }
  }
  return merged;
}

/** Add "Mon - Fri: 07.00 - 19.00 and 17.30 - 19.30" (or "Sun: Closed") to `week`; false if it doesn't parse. */
function addDaySpec(text: string, week: Week): boolean {
  const m = DAY_SPEC.exec(text.trim());
  if (!m) return false;
  const from = DAYS.indexOf(m[1]);
  const to = m[2] ? DAYS.indexOf(m[2]) : from;
  const intervals: Interval[] = [];
  if (!/^closed$/i.test(m[3].trim())) {
    for (const part of m[3].split(/\s+and\s+/)) {
      const r = RANGE.exec(part.trim());
      if (!r) return false;
      const end = Number(r[3]) * 60 + Number(r[4]);
      intervals.push([Number(r[1]) * 60 + Number(r[2]), end === 23 * 60 + 59 ? 24 * 60 : end]);
    }
  }
  for (let d = from; d <= to; d++) week[d].push(...intervals);
  return true;
}

/** ETH's opening-hours lines, as a weekly schedule. */
export function parseHours(lines: string[]): Hours {
  const week = (): Week => Array.from({ length: 7 }, () => []);
  const hours: Hours = { open: week(), meals: week(), card24h: false, unknown: [] };
  for (const line of lines) {
    const meal = /^Meal times?:\s*(.+)$/i.exec(line.trim());
    if (meal ? addDaySpec(meal[1], hours.meals) : addDaySpec(line, hours.open)) continue;
    if (/24-hour access/i.test(line)) hours.card24h = true;
    else if (!/^Learning environment outside meal times?$/i.test(line.trim())) hours.unknown.push(line);
  }
  return hours;
}

const instant = (day: IsoDate, minutes: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return zurichToUtc(y, m, d, Math.floor(minutes / 60), minutes % 60);
};

/**
 * Whether `space` is open at `at`, from its opening hours. `listAt` is when ETH's list was fetched: if ETH said then
 * that the space stays closed until a later day, it's closed for the rest of that day (holidays, closures).
 * `hours` replaces the space's own (mensas whose meal times come from their menus, places with menus only).
 */
export function spaceState(space: Space, at: number, listAt: number, hours = parseHours(space.hours)): SpaceState {
  const day = zurichDate(at);
  const { hour, minute } = zurichWall(at);
  const now = hour * 60 + minute;
  const closedToday =
    listAt > 0 && zurichDate(listAt) === day && !space.eth.open && space.eth.nextOpen !== null && space.eth.nextOpen > day;
  const state: SpaceState = { open: false, until: null, opens_at: null, meal: false, card_only: false, open_until: null };

  if (!hours.open.some((d) => d.length) && !hours.card24h) {
    state.open = space.eth.open; // hours ETH didn't give in a form we know: its own snapshot is all there is
    return state;
  }
  const current = closedToday ? undefined : hours.open[weekday(day)].find(([f, t]) => f <= now && now < t);
  if (current) {
    state.open = true;
    state.until = state.open_until = instant(day, current[1]);
    const meal = hours.meals[weekday(day)].find(([f, t]) => f <= now && now < t);
    if (meal) {
      state.meal = true;
      state.until = instant(day, meal[1]);
    }
    return state;
  }
  if (hours.card24h) {
    state.open = true;
    state.card_only = true;
    return state;
  }
  for (let i = 0; i <= 7; i++) {
    const d = addDays(day, i);
    if (i === 0 && closedToday) continue;
    const next = hours.open[weekday(d)].filter(([f]) => i > 0 || f > now).sort((a, b) => a[0] - b[0])[0];
    if (next) {
      state.opens_at = instant(d, next[0]);
      break;
    }
  }
  return state;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** ETH timestamps carry microseconds ("…15:40:20.16219+01:00"); keep milliseconds so Date.parse reads them. */
const parseTimestamp = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  const ms = Date.parse(s.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(ms) ? null : ms;
};

/** The occupancy feed's `data` array, as readings by space id. Entries without a timestamp carry no reading. */
export function parseReadings(raw: unknown[]): Record<string, Reading> {
  const readings: Record<string, Reading> = {};
  for (const item of raw as { attributes?: Record<string, any> }[]) {
    const a = item?.attributes;
    const id = str(a?.roomGlobalIdentifier);
    const measured = parseTimestamp(a?.timestamp);
    if (!a || !id || measured === null) continue;
    readings[id] = {
      people: num(a.occupancy),
      capacity: num(a.maxPeople),
      pct: num(a.occupancyPercentage),
      status: str(a.status),
      trend: str(a.trend),
      measured_at: measured,
      active: typeof a.activeFlag === "boolean" ? a.activeFlag : null,
    };
  }
  return readings;
}

/** The estimate to show for a reading, or null if there's none or it's older than OCCUPANCY_MAX_AGE_S. */
export function estimate(r: Reading | undefined, now: number): Estimate | null {
  if (!r || r.measured_at === null || r.people === null) return null;
  if (now - r.measured_at > OCCUPANCY_MAX_AGE_S * 1000) return null;
  // ETH's page falls back to the head count in 20 % steps when the percentage is missing.
  const pct = r.pct ?? (r.capacity ? Math.min(100, 20 * Math.round((r.people / r.capacity) * 5)) : null);
  if (pct === null) return null;
  // Our own traffic light from the percentage: ETH's status sometimes says green at 60 % (it's kept in the history).
  const status = pct >= 80 ? "red" : pct >= 60 ? "yellow" : "green";
  return { pct, status, trend: r.trend, measured_at: r.measured_at };
}
