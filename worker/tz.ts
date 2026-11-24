// Europe/Zurich wall-clock <-> UTC conversion via Intl, matching Python's zoneinfo (fold=0).
// Instants are epoch milliseconds throughout the Worker.

import { TZ } from "./config";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export interface Wall {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zurichWall(ms: number): Wall {
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

/** Offset of Zurich from UTC at instant `ms`, in milliseconds. */
export function offsetAt(ms: number): number {
  const w = zurichWall(ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Instant of a Zurich wall-clock time. Ambiguous times take the first occurrence, gap times the pre-transition offset. */
export function zurichToUtc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const before = offsetAt(wall - 6 * HOUR);
  if (offsetAt(wall - before) === before) return wall - before;
  const after = offsetAt(wall + 6 * HOUR);
  if (offsetAt(wall - after) === after) return wall - after;
  return wall - before; // inside the spring-forward gap
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/** Parse a naive ISO time ("2026-10-29T13:00:00") as Zurich local time, or null if malformed. */
export function parseNaive(value: string): number | null {
  const m = NAIVE.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0));
  return zurichToUtc(y, mo, d, h, mi, s);
}

/** Parse a query-string time: naive = Zurich local, or with Z/offset as an absolute instant. */
export function parseQueryTime(value: string): number | null {
  const naive = parseNaive(value);
  if (naive !== null) return naive;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Like Python's isoformat(timespec="minutes") in Zurich time: "2026-10-29T13:00+01:00". */
export function toZurichIso(ms: number): string {
  const w = zurichWall(ms);
  const off = Math.round(offsetAt(ms) / MINUTE);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** A plain calendar date ("2026-10-29"), handled as UTC midnight for arithmetic. */
export type IsoDate = string;

export function zurichDate(ms: number): IsoDate {
  const w = zurichWall(ms);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

export function addDays(day: IsoDate, n: number): IsoDate {
  return new Date(Date.parse(day + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
}

/** The same day `n` months later, or the month's last day if it's shorter (Jan 31 + 1 month = Feb 28). */
export function addMonths(day: IsoDate, n: number): IsoDate {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/** Monday = 0 … Sunday = 6, like Python's date.weekday(). */
export function weekday(day: IsoDate): number {
  return (new Date(day + "T00:00:00Z").getUTCDay() + 6) % 7;
}

export const ONE_MINUTE = MINUTE;
