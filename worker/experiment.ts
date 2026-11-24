// Experiment until EXPERIMENT_UNTIL: how often do bookings change during the day, especially for the rooms
// that are only fetched once a night? Each daytime prefetch run also re-fetches a few of those rooms
// ("check") and compares today's and tomorrow's bookings with what was stored. The regular refresh of
// seminar and meeting rooms is compared the same way ("refresh"), as a baseline. /api/experiment and
// static/experiment.html summarise the log.

import { type Block, parseAllocations } from "./availability";
import { parseCatalogue, typeCounts } from "./catalogue";
import { EXPERIMENT_UNTIL } from "./config";
import { type FetchState, type PackedAllocation, unpack } from "./store";
import { type IsoDate, toZurichIso, zurichDate } from "./tz";

export type Source = "check" | "refresh";

export const experimentActive = (now: number) => zurichDate(now) < EXPERIMENT_UNTIL;

/** Rooms to check: not refreshed, already fetched for today, least recently fetched first. */
export function pickChecks(
  targets: string[],
  fetches: Record<string, FetchState>,
  today: IsoDate,
  n: number,
  refreshed: { has(path: string): boolean },
  exclude: Set<string>,
): string[] {
  return targets
    .filter((p) => !refreshed.has(p) && !exclude.has(p) && fetches[p]?.fullFrom === today)
    .sort((a, b) => fetches[a].at - fetches[b].at)
    .slice(0, Math.max(0, n));
}

const key = (b: Block) => `${b.start}|${b.end}|${b.title ?? ""}`;

/** Bookings that make the room busy (as parseAllocations sees them) present in only one of the two versions. */
export function diffBookings(before: PackedAllocation[], after: PackedAllocation[]): { added: Block[]; removed: Block[] } {
  const was = new Map(parseAllocations(unpack(before)).map((b) => [key(b), b]));
  const is = new Map(parseAllocations(unpack(after)).map((b) => [key(b), b]));
  return {
    added: [...is].filter(([k]) => !was.has(k)).map(([, b]) => b),
    removed: [...was].filter(([k]) => !is.has(k)).map(([, b]) => b),
  };
}

export interface Comparison {
  path: string;
  typecode: string;
  source: Source;
  today: IsoDate;
  now: number;
  prevAt: number;
  before: PackedAllocation[];
  after: PackedAllocation[];
}

/** Statements that log one re-fetch: a count per day, type and source, and one row per changed booking. */
export function logComparison(db: D1Database, c: Comparison): D1PreparedStatement[] {
  const { added, removed } = diffBookings(c.before, c.after);
  const changes = [...added.map((b) => ["added", b] as const), ...removed.map((b) => ["removed", b] as const)];
  const hours = (c.now - c.prevAt) / 3_600_000;
  const statements = [
    db
      .prepare(
        `INSERT INTO exp_checks (day, typecode, source, checks, changed, hours) VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT (day, typecode, source) DO UPDATE SET
           checks = checks + 1, changed = changed + excluded.changed, hours = hours + excluded.hours`,
      )
      .bind(c.today, c.typecode, c.source, changes.length ? 1 : 0, hours),
  ];
  for (const [kind, b] of changes) {
    statements.push(
      db
        .prepare(
          `INSERT INTO exp_changes (detected_at, prev_at, path, typecode, source, kind, day, date_from, date_to, title, upcoming)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(c.now, c.prevAt, c.path, c.typecode, c.source, kind, zurichDate(b.start), toZurichIso(b.start), toZurichIso(b.end), b.title, b.end > c.now ? 1 : 0),
    );
  }
  return statements;
}

interface TypeRow {
  typecode: string;
  source: Source;
  checks: number;
  changed: number;
  hours: number;
}

interface ChangeCount {
  typecode: string;
  source: Source;
  kind: "added" | "removed";
  upcoming: number;
  n: number;
}

/** Everything the summary page shows. */
export async function experimentSummary(db: D1Database, rawCatalogue: unknown[], now = Date.now()) {
  const [types, changes, changedRooms, days, recent] = await db.batch([
    db.prepare(
      `SELECT typecode, source, SUM(checks) AS checks, SUM(changed) AS changed, SUM(hours) AS hours
       FROM exp_checks GROUP BY typecode, source`,
    ),
    db.prepare(
      `SELECT typecode, source, kind, upcoming, COUNT(*) AS n FROM exp_changes GROUP BY typecode, source, kind, upcoming`,
    ),
    db.prepare(`SELECT typecode, source, COUNT(DISTINCT path) AS rooms FROM exp_changes GROUP BY typecode, source`),
    db.prepare(
      `SELECT day, source, SUM(checks) AS checks, SUM(changed) AS changed FROM exp_checks GROUP BY day, source ORDER BY day`,
    ),
    db.prepare(
      `SELECT detected_at, prev_at, path, typecode, source, kind, day, date_from, date_to, title, upcoming
       FROM exp_changes ORDER BY detected_at DESC LIMIT 200`,
    ),
  ]);

  const rooms = parseCatalogue(rawCatalogue);
  const names = new Map(typeCounts(rooms).map((t) => [t.typecode, t]));
  const counts = changes.results as unknown as ChangeCount[];
  const count = (t: TypeRow, kind: string, upcoming: boolean) =>
    counts.find((c) => c.typecode === t.typecode && c.source === t.source && c.kind === kind && !!c.upcoming === upcoming)?.n ?? 0;
  const roomsChanged = (t: TypeRow) =>
    (changedRooms.results as { typecode: string; source: string; rooms: number }[]).find(
      (r) => r.typecode === t.typecode && r.source === t.source,
    )?.rooms ?? 0;
  const dayList = (days.results as unknown as { day: string }[]).map((d) => d.day);

  return {
    until: EXPERIMENT_UNTIL,
    active: experimentActive(now),
    first_day: dayList[0] ?? null,
    last_day: dayList.at(-1) ?? null,
    refreshed_types: ["3420", "2110"], // during the experiment
    types: (types.results as unknown as TypeRow[])
      .map((t) => ({
        typecode: t.typecode,
        type: names.get(t.typecode)?.type ?? t.typecode,
        rooms: names.get(t.typecode)?.count ?? 0,
        source: t.source,
        checks: t.checks,
        changed: t.changed,
        hours: Math.round(t.hours * 10) / 10,
        added: count(t, "added", false) + count(t, "added", true),
        added_upcoming: count(t, "added", true),
        removed: count(t, "removed", false) + count(t, "removed", true),
        removed_upcoming: count(t, "removed", true),
        rooms_changed: roomsChanged(t),
      }))
      .sort((a, b) => a.source.localeCompare(b.source) || b.checks - a.checks),
    days: days.results,
    recent: (recent.results as Record<string, unknown>[]).map((r) => ({
      ...r,
      type: names.get(r.typecode as string)?.type ?? r.typecode,
      detected_at: toZurichIso(r.detected_at as number),
      prev_at: toZurichIso(r.prev_at as number),
      upcoming: !!r.upcoming,
    })),
  };
}
