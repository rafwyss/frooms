// "Usually this full": how full a study space or library usually is on a weekday at a quarter hour, from the
// occupancy history (migrations/0003_occupancy.sql). Rebuilt once a day by the room prefetch (prefetch.ts), in SQL
// (D1 does the work: a day's run reads the past two months once, and writes one row per space and weekday into
// `usual`, migrations/0006_reports.sql). /api/spaces reads one weekday's rows and blends them here.
//
// The model (Raffaele's): half the average over the past 2 months on that weekday and quarter hour, half the average
// over the past 7 days (that weekday's one day), so a trend shows within a week. When the past week has no readings
// for the slot (a holiday, a sensor that was off), the 2-month average alone. Fewer than USUAL_MIN_READINGS over the two
// months: none.

import { USUAL_LONG_DAYS, USUAL_MIN_READINGS, USUAL_SHORT_DAYS } from "./config";
import { offsetAt, weekday, zurichDate, zurichWall } from "./tz";

/** One quarter hour of one space and weekday: [pct_2m, n_2m, pct_7d, n_7d]. */
export type SlotStats = [number | null, number, number | null, number];

/** One stored row: a space's weekday, its slots by quarter hour ("0".."95"). */
export interface UsualRow {
  weekday: number; // 0 Monday .. 6 Sunday
  slots: Record<string, SlotStats>;
}

export const SLOTS = 96;

/** The quarter hour of the day (Zurich) an instant is in, 0..95, and its weekday (Monday 0). */
export function slotOf(ms: number): { weekday: number; slot: number } {
  const w = zurichWall(ms);
  return { weekday: weekday(zurichDate(ms)), slot: w.hour * 4 + Math.floor(w.minute / 15) };
}

/**
 * The blended value of one slot's stats: half each when the past week has a reading for the slot, else the 2 months
 * alone; null with fewer than USUAL_MIN_READINGS readings over the 2 months.
 */
export function blend(s: SlotStats | undefined): { pct: number; n: number } | null {
  if (!s || s[0] === null || s[1] < USUAL_MIN_READINGS) return null;
  const pct = s[2] !== null && s[3] > 0 ? 0.5 * s[0] + 0.5 * s[2] : s[0];
  return { pct, n: s[1] };
}

/** How full a space usually is on `weekday` at `slot`, from its rows; null when there are too few readings. */
export function usualAt(rows: UsualRow[], day: number, slot: number): { pct: number; n: number } | null {
  return blend(rows.find((r) => r.weekday === day)?.slots[String(slot)]);
}

/** A weekday's 96 quarter hours, rounded to whole percent (null where unknown). */
export function usualCurve(slots: Record<string, SlotStats>): (number | null)[] {
  return Array.from({ length: SLOTS }, (_, i) => {
    const v = blend(slots[String(i)]);
    return v === null ? null : Math.round(v.pct);
  });
}

/** /api/spaces's `usual` for a space at `at`: the value for its quarter hour and the day's curve. */
export function usualField(slots: Record<string, SlotStats> | undefined, at: number): { pct: number | null; curve: (number | null)[] } | null {
  if (!slots) return null;
  const curve = usualCurve(slots);
  return { pct: curve[slotOf(at).slot], curve };
}

/**
 * Zurich's offset from UTC over [from, to]: the offset at the start, at the end, and the instant it changes (a window
 * of two months has at most one change; with none, `change` is `to`).
 */
export function offsets(from: number, to: number): { before: number; after: number; change: number } {
  const before = offsetAt(from);
  const after = offsetAt(to);
  if (before === after) return { before, after, change: to };
  let [lo, hi] = [from, to];
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(mid) === before) lo = mid;
    else hi = mid;
  }
  return { before, after, change: hi };
}

// D1 allows at most 100 bound parameters per query; 8 are the window's.
const SPACES_PER_QUERY = 80;

/**
 * The statements that rebuild `usual` from the occupancy history of `spaces` (the sensors that report), as of `now`.
 * Readings are taken at ETH's own time (`measured_at`) when there is one; a frozen sensor's repeats of one reading
 * count once. Slots and weekdays are Zurich time, across a change to or from summer time.
 */
export function rebuildUsual(db: D1Database, spaces: string[], now: number): D1PreparedStatement[] {
  const longFrom = now - USUAL_LONG_DAYS * 86400_000;
  const shortFrom = now - USUAL_SHORT_DAYS * 86400_000;
  const { before, after, change } = offsets(longFrom, now);
  const statements = [db.prepare("DELETE FROM usual")];
  for (let i = 0; i < spaces.length; i += SPACES_PER_QUERY) {
    const chunk = spaces.slice(i, i + SPACES_PER_QUERY);
    statements.push(
      db
        .prepare(
          `INSERT INTO usual (space, weekday, slots)
           SELECT space, wd, json_group_object(CAST(slot AS TEXT), json_array(round(p2, 1), n2, round(p7, 1), n7))
           FROM (
             SELECT space, wd, slot, AVG(pct) AS p2, COUNT(*) AS n2,
                    AVG(CASE WHEN t >= ? THEN pct END) AS p7, SUM(CASE WHEN t >= ? THEN 1 ELSE 0 END) AS n7
             FROM (
               SELECT space, t, pct, (lt / 86400000 + 3) % 7 AS wd, (lt / 900000) % 96 AS slot
               FROM (
                 SELECT space, COALESCE(measured_at, at) AS t, MAX(pct) AS pct,
                        CAST(COALESCE(measured_at, at) + CASE WHEN COALESCE(measured_at, at) >= ? THEN ? ELSE ? END AS INTEGER) AS lt
                 FROM occupancy
                 WHERE space IN (${chunk.map(() => "?").join(", ")}) AND at >= ? AND pct IS NOT NULL
                 GROUP BY space, COALESCE(measured_at, at)
               )
               WHERE t >= ? AND t <= ?
             )
             GROUP BY space, wd, slot
           )
           GROUP BY space, wd`,
        )
        .bind(shortFrom, shortFrom, change, after, before, ...chunk, longFrom, longFrom, now),
    );
  }
  return statements;
}

const MEMORY_S = 600;
const memo = new Map<number, { at: number; value: Map<string, Record<string, SlotStats>> }>();

export const clearUsualMemory = () => memo.clear();

/** Every space's slots for one weekday, cached in isolate memory for 10 minutes (the table changes once a day). */
export async function readUsual(db: D1Database, day: number, now = Date.now()): Promise<Map<string, Record<string, SlotStats>>> {
  const hit = memo.get(day);
  if (hit && now - hit.at < MEMORY_S * 1000) return hit.value;
  const { results } = await db.prepare("SELECT space, slots FROM usual WHERE weekday = ?").bind(day).all<{ space: string; slots: string }>();
  const value = new Map(results.map((r) => [r.space, JSON.parse(r.slots) as Record<string, SlotStats>]));
  memo.set(day, { at: now, value });
  return value;
}
