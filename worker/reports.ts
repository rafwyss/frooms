// Occupancy reports from the page (POST /api/report): how full a room or study space is right now, as a level
// (free, crowded, full) or, for spaces with frooms' own estimate, a percentage; and a rating of that estimate (-5: the
// place is much emptier than frooms says .. +5: much fuller), stored but never shown. Stored in D1 (migrations/0006_reports.sql) without any address: the
// reporter is the SHA-256 of a random id the browser keeps. A report counts for REPORT_WINDOW_MS, once per browser,
// place and kind: a newer level or percentage replaces the older one, a second rating is ignored. A microwave spot's
// page reports its queue instead (kind "queue": 0 free, 1 about 5 minutes, 2 about 10, 3 15 minutes or more).

import { MAX_REPORTS_PER_DAY, REPORT_LOG_MS, REPORT_WINDOW_MS } from "./config";

export const REPORT_KINDS = ["level", "pct", "rating", "queue"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export type PlaceKind = "room" | "space" | "microwave";
const PLACE_KINDS: PlaceKind[] = ["room", "space", "microwave"];
export const isPlaceKind = (v: unknown): v is PlaceKind => PLACE_KINDS.includes(v as PlaceKind);

/** How many queue lengths a microwave report knows: free, about 5 minutes, about 10, 15 minutes or more. */
export const QUEUE_LEVELS = 4;

/** The values each kind takes, and which places it applies to (percentages and ratings: spaces only). */
const RANGES: Record<ReportKind, { min: number; max: number; places: PlaceKind[] }> = {
  level: { min: 0, max: 2, places: ["room", "space"] },
  pct: { min: 0, max: 100, places: ["space"] },
  rating: { min: -5, max: 5, places: ["space"] },
  queue: { min: 0, max: QUEUE_LEVELS - 1, places: ["microwave"] },
};

export interface Report {
  kind: ReportKind;
  place_kind: PlaceKind;
  place: string;
  area: string;
  value: number;
  client: string;
  estimate: number | null;
}

/**
 * A place's reports of the past 2 hours: counts of free, crowded and full, the average percentage, the newest; a
 * microwave's `queue`, the counts of each queue length.
 */
export interface ReportSummary {
  levels: [number, number, number];
  queue?: number[];
  pct: number | null;
  n_pct: number;
  last: number; // epoch ms
}

export class ReportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** A report from a request body, or a ReportError saying what's wrong with it. Whether the place exists is the caller's. */
export function parseReport(body: unknown): Report {
  if (!body || typeof body !== "object") throw new ReportError(400, "Expected a JSON object");
  const b = body as Record<string, unknown>;
  if (!REPORT_KINDS.includes(b.kind as never)) throw new ReportError(400, "Unknown kind of report");
  const kind = b.kind as ReportKind;
  if (!isPlaceKind(b.place_kind)) throw new ReportError(400, "place_kind must be room, space or microwave");
  const range = RANGES[kind];
  if (!range.places.includes(b.place_kind)) throw new ReportError(400, `A ${kind} report is for ${range.places.map((k) => (k === "space" ? "study spaces" : `${k}s`)).join(" and ")} only`);
  const place = typeof b.place === "string" ? b.place.trim().replace(/\s+/g, " ") : "";
  const area = typeof b.area === "string" ? b.area.trim() : "";
  if (!place || place.length > 40 || !/^[A-Z]{1,3}$/.test(area)) throw new ReportError(400, "Name the place and its area");
  if (!isInt(b.value, range.min, range.max)) throw new ReportError(400, `value must be a whole number from ${range.min} to ${range.max}`);
  if (typeof b.client !== "string" || !/^[A-Za-z0-9_-]{32,64}$/.test(b.client)) throw new ReportError(400, "client must be 32 to 64 letters or digits");
  const estimate = b.estimate === undefined || b.estimate === null ? null : b.estimate;
  if (estimate !== null && !isInt(estimate, 0, 100)) throw new ReportError(400, "estimate must be a whole number from 0 to 100");
  return { kind, place_kind: b.place_kind, place, area, value: b.value, client: b.client, estimate };
}

/** SHA-256 of the client id, as hex: the only trace of the browser that is stored. */
export async function reporterOf(client: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(client));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Stores a report: a new row, or the reporter's own report of the same place and kind from the past 2 hours updated
 * ("replaced"), or for a rating nothing ("kept": the first rating stands). Throws a ReportError over the daily cap.
 * Also returns the row's id (Street cred links a new report to the account that sent it). A replacement with another
 * value or estimate becomes a new row with a new id (`renewed`), so the 👍 and 👎 given to the old reading stay with it
 * instead of moving to one the voters never saw; the same reading again only moves its time and keeps its votes.
 */
export async function saveReport(
  db: D1Database,
  r: Report,
  now = Date.now(),
): Promise<{ stored: "new" | "replaced" | "kept"; id: number; renewed?: boolean; previous?: number }> {
  const reporter = await reporterOf(r.client);
  const own = await db
    .prepare(
      "SELECT id, value, estimate FROM reports WHERE reporter = ? AND place_kind = ? AND place = ? AND kind = ? AND at > ? ORDER BY at DESC LIMIT 1",
    )
    .bind(reporter, r.place_kind, r.place, r.kind, now - REPORT_WINDOW_MS)
    .first<{ id: number; value: number; estimate: number | null }>();
  if (own && r.kind === "rating") return { stored: "kept", id: own.id };
  if (own && own.value === r.value && (own.estimate ?? null) === r.estimate) {
    await db.prepare("UPDATE reports SET at = ? WHERE id = ?").bind(now, own.id).run();
    return { stored: "replaced", id: own.id };
  }
  if (own) {
    const [, res] = await db.batch([
      db.prepare("DELETE FROM reports WHERE id = ?").bind(own.id),
      db
        .prepare("INSERT INTO reports (at, kind, place_kind, place, area, value, reporter, estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(now, r.kind, r.place_kind, r.place, r.area, r.value, reporter, r.estimate),
    ]);
    return { stored: "replaced", id: res.meta.last_row_id, renewed: true, previous: own.id };
  }
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM reports WHERE at > ?").bind(now - 86_400_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_REPORTS_PER_DAY) throw new ReportError(429, "Lots of reports today already. Please try again tomorrow");
  const res = await db
    .prepare("INSERT INTO reports (at, kind, place_kind, place, area, value, reporter, estimate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(now, r.kind, r.place_kind, r.place, r.area, r.value, reporter, r.estimate)
    .run();
  return { stored: "new", id: res.meta.last_row_id };
}

/**
 * Which report to remove (DELETE /api/report): the browser's own report of a place and kind, as parseReport checks
 * them, without a value (a rating of the estimate too: removed, it can be given again).
 */
export function parseRemoval(body: unknown): Omit<Report, "value" | "estimate"> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const r = parseReport({ ...b, value: RANGES[b.kind as ReportKind]?.min ?? 0, estimate: null });
  const { value, estimate, ...rest } = r;
  return rest;
}

/**
 * Deletes the browser's own report of `r`'s place and kind from the past 2 hours (the one the page shows as yours).
 * Answers the deleted row's id, or null when there was none (removed already, or older than 2 hours).
 */
export async function removeReport(db: D1Database, r: Omit<Report, "value" | "estimate">, now = Date.now()): Promise<number | null> {
  const reporter = await reporterOf(r.client);
  const own = await db
    .prepare("SELECT id FROM reports WHERE reporter = ? AND place_kind = ? AND place = ? AND kind = ? AND at > ? ORDER BY at DESC LIMIT 1")
    .bind(reporter, r.place_kind, r.place, r.kind, now - REPORT_WINDOW_MS)
    .first<{ id: number }>();
  if (!own) return null;
  await db.prepare("DELETE FROM reports WHERE id = ?").bind(own.id).run();
  return own.id;
}

// D1 allows at most 100 bound parameters per query.
const PLACES_PER_QUERY = 90;

/**
 * The 2-hour summaries of `places` (ratings aren't shown, so they don't count), by place; places without reports are
 * left out. One query per 90 places.
 */
export async function readReportSummaries(db: D1Database, placeKind: PlaceKind, places: string[], now = Date.now()): Promise<Map<string, ReportSummary>> {
  const out = new Map<string, ReportSummary>();
  for (let i = 0; i < places.length; i += PLACES_PER_QUERY) {
    const chunk = places.slice(i, i + PLACES_PER_QUERY);
    const { results } = await db
      .prepare(
        `SELECT place, kind, value, at FROM reports
         WHERE place_kind = ? AND at > ? AND kind != 'rating' AND place IN (${chunk.map(() => "?").join(", ")})`,
      )
      .bind(placeKind, now - REPORT_WINDOW_MS, ...chunk)
      .all<{ place: string; kind: ReportKind; value: number; at: number }>();
    for (const r of results) {
      const s = out.get(r.place) ?? { levels: [0, 0, 0], pct: null, n_pct: 0, last: 0 };
      if (r.kind === "level") s.levels[r.value] += 1;
      else if (r.kind === "queue") {
        s.queue ??= Array(QUEUE_LEVELS).fill(0);
        s.queue[r.value] += 1;
      } else {
        s.pct = ((s.pct ?? 0) * s.n_pct + r.value) / (s.n_pct + 1);
        s.n_pct += 1;
      }
      s.last = Math.max(s.last, r.at);
      out.set(r.place, s);
    }
  }
  for (const s of out.values()) if (s.pct !== null) s.pct = Math.round(s.pct);
  return out;
}

/**
 * One place's reports of the past 4 hours, newest first, without who sent them (and without ratings). The id is the
 * row's, for the votes (index.ts adds their counts from the accounts database).
 */
export async function readReportLog(db: D1Database, placeKind: PlaceKind, place: string, now = Date.now()) {
  const { results } = await db
    .prepare("SELECT id, at, kind, value FROM reports WHERE place_kind = ? AND place = ? AND at > ? AND kind != 'rating' ORDER BY at DESC LIMIT 200")
    .bind(placeKind, place, now - REPORT_LOG_MS)
    .all<{ id: number; at: number; kind: ReportKind; value: number }>();
  return results;
}

/** A report as a vote on it needs it (or null: none, or a rating, which the log doesn't show). */
export async function readReport(db: D1Database, id: number) {
  return db
    .prepare("SELECT at, place_kind, place, area FROM reports WHERE id = ? AND kind != 'rating'")
    .bind(id)
    .first<{ at: number; place_kind: PlaceKind; place: string; area: string }>();
}
