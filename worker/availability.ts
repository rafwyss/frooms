// Pure availability logic: turn raw ETH allocations into a free/busy status. No I/O.
// Port of app/availability.py; instants are epoch milliseconds.

import { SHORT_GAP_MINUTES } from "./config";
import { addDays, type IsoDate, ONE_MINUTE, parseNaive, zurichToUtc, zurichWall } from "./tz";

// belegungstyp values seen in a survey of all Zentrum rooms (week of 26.10.2026)
const BOOKING_TYPES = new Set([
  2, // booking: lecture, meeting, exam …
  5, // blocked / renovation ("Umbau")
  11, // lecture (seen only with findetStatt 1)
]);
const CANCELLED = 13; // cancelled lecture, always with findetStatt 0
const CLOSED = 8; // building closed, no veranstaltung

export type Kind = "booking" | "closed";

/** A busy interval. A merged block keeps its parts so the status can name whatever is running at a given moment. */
export interface Block {
  start: number;
  end: number;
  kind: Kind;
  title: string | null;
  parts: Block[];
}

export interface Status {
  state: "free" | "busy" | "no_data";
  // free: when the room stops being free (null = rest of the fetched window)
  free_until: number | null;
  // busy: when the room becomes free again (end of the merged busy block)
  busy_until: number | null;
  // busy: what is running now and until when
  current_title: string | null;
  current_kind: Kind | null;
  current_until: number | null;
  // free: what comes next; busy: length of the free gap after busy_until (ms)
  next_title: string | null;
  next_kind: Kind | null;
  next_gap: number | null;
  short_gap: boolean;
}

export function makeStatus(fields: Partial<Status> & Pick<Status, "state">): Status {
  return {
    free_until: null,
    busy_until: null,
    current_title: null,
    current_kind: null,
    current_until: null,
    next_title: null,
    next_kind: null,
    next_gap: null,
    short_gap: false,
    ...fields,
  };
}

function block(start: number, end: number, kind: Kind, title: string | null, parts: Block[] = []): Block {
  return { start, end, kind, title, parts };
}

const first = (b: Block) => (b.parts.length ? b.parts[0] : b);

function partAt(b: Block, at: number): Block {
  for (const part of b.parts.length ? b.parts : [b]) {
    if (part.start <= at && at < part.end) return part;
  }
  return b;
}

function parseTime(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T23:59(?::00)?$/.exec(value);
  if (m) {
    // 23:59 means end of day, i.e. next day 00:00
    const next = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
    return parseNaive(next.toISOString().slice(0, 10) + "T00:00:00")!;
  }
  const ms = parseNaive(value);
  if (ms === null) throw new Error(`Unparseable time ${JSON.stringify(value)}`);
  return ms;
}

type RawAllocation = any;

/** Convert raw allocation entries into blocks. Cancelled bookings are dropped. */
export function parseAllocations(raw: RawAllocation[]): Block[] {
  const blocks: Block[] = [];
  for (const entry of raw) {
    const serie = entry.belegungsserie ?? {};
    const typ = serie.belegungstyp;
    const event = serie.veranstaltung ?? {};
    const start = parseTime(entry.date_from);
    const end = parseTime(entry.date_to);

    if (typ === CLOSED) {
      blocks.push(block(start, end, "closed", null));
      continue;
    }
    if (typ === CANCELLED || event.findetStatt === 0 || event.findetStatt === false) {
      console.info(`Dropping cancelled booking ${JSON.stringify(event.allocationTitle ?? null)} at ${entry.date_from}`);
      continue;
    }
    let title: string | null = event.allocationTitle || null;
    if (!BOOKING_TYPES.has(typ)) {
      console.warn(`Unknown belegungstyp ${typ ?? "None"} at ${entry.date_from}, treating as busy`);
      title = title || `Booked (type ${typ ?? "None"})`;
    }
    blocks.push(block(start, end, "booking", (title ?? "").trim() || null));
  }
  return blocks;
}

/** Sort and merge overlapping or touching blocks. */
export function mergeBlocks(blocks: Block[]): Block[] {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || a.end - b.end);
  const groups: Block[][] = [];
  for (const b of sorted) {
    const last = groups.at(-1);
    if (last && b.start <= Math.max(...last.map((p) => p.end))) last.push(b);
    else groups.push([b]);
  }
  return groups.map((parts) =>
    block(
      parts[0].start,
      Math.max(...parts.map((p) => p.end)),
      parts.every((p) => p.kind === "closed") ? "closed" : "booking",
      parts[0].title,
      parts,
    ),
  );
}

const isShort = (gap: number | null) => gap !== null && gap < SHORT_GAP_MINUTES * ONE_MINUTE;

/** Status of a room at `at`, given its (unmerged or merged) blocks. */
export function roomStatus(blocks: Block[], at: number): Status {
  if (!blocks.length) return makeStatus({ state: "no_data" });

  const merged = mergeBlocks(blocks);
  for (let i = 0; i < merged.length; i++) {
    const b = merged[i];
    if (b.end <= at) continue;
    const nxt = merged[i + 1] ?? null;

    if (b.start <= at) {
      const current = partAt(b, at);
      const gap = nxt ? nxt.start - b.end : null;
      return makeStatus({
        state: "busy",
        busy_until: b.end,
        current_title: current.title,
        current_kind: current.kind,
        current_until: current.end,
        next_title: nxt ? first(nxt).title : null,
        next_kind: nxt ? first(nxt).kind : null,
        next_gap: gap,
        short_gap: isShort(gap),
      });
    }

    return makeStatus({
      state: "free",
      free_until: b.start,
      next_title: first(b).title,
      next_kind: first(b).kind,
      short_gap: isShort(b.start - at),
    });
  }

  return makeStatus({ state: "free" });
}

/** A day's busy time for the schedule bar: [from, to, kind] in minutes since midnight (Zurich), "b" booking, "c" closed. */
export type DayBlock = [number, number, "b" | "c"];

/**
 * The blocks of `day` for the schedule bar, from parseAllocations': bookings merged with bookings and closures with closures (as mergeBlocks
 * does, but kept apart, so a closed evening next to a lecture stays grey), cut to the day; a block running past
 * midnight ends at 1440.
 */
export function dayBlocks(blocks: Block[], day: IsoDate): DayBlock[] {
  const [y, m, d] = day.split("-").map(Number);
  const [ny, nm, nd] = addDays(day, 1).split("-").map(Number);
  const [start, end] = [zurichToUtc(y, m, d), zurichToUtc(ny, nm, nd)];
  const wall = (t: number) => {
    if (t <= start) return 0;
    if (t >= end) return 1440;
    const w = zurichWall(t);
    return w.hour * 60 + w.minute;
  };
  const out: DayBlock[] = [];
  for (const kind of ["booking", "closed"] as const) {
    for (const b of mergeBlocks(blocks.filter((x) => x.kind === kind))) {
      if (b.end <= start || b.start >= end) continue;
      const [from, to] = [wall(b.start), wall(b.end)];
      if (to > from) out.push([from, to, kind === "booking" ? "b" : "c"]);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
