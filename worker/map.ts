// The map view's per-building summary: open study spaces and rooms that stay free long enough to be worth walking to.

import { MAP_MIN_FREE_MINUTES } from "./config";
import { BUILDING_OVERRIDES } from "./overrides";

/** The fields of an /api/free room entry the map needs. */
export interface MapRoom {
  room: string;
  building: string;
  seats: number | null;
  typecode: string;
  status: string; // free | busy | managed (worker/index.ts roomEntry) | no_data | pending | error
  free_until: string | null;
  busy_until?: string | null;
  minutes?: number | null; // free: minutes until free_until (null = free for the rest of the stored window)
}

/** The fields of an /api/spaces entry the map needs. */
export interface MapSpace {
  id: string;
  room: string;
  name: string;
  category: string; // library | open | mensa
  building: string;
  seats: number | null;
  open: boolean;
  until: string | null;
  meal: boolean; // inside one of its meal times
  study?: boolean; // a study space (false: a place with menus only, like Bellavista)
  kind?: string | null; // mensa | cafe (mensas and cafeterias only)
  menu?: boolean; // has a Menu button
  partner?: boolean; // the other Zentrum campus's mensa (config.ts MENSA_PARTNERS), on its own building
  occupancy: { pct: number; status: string } | null;
}

/**
 * A mensa or cafeteria on the map: serving food (inside one of its meal times), a study space between them, open
 * otherwise (a café, or a mensa before lunch) or closed.
 */
export interface MapMensa {
  id: string;
  name: string;
  kind: "mensa" | "cafe";
  study: boolean; // also a study space (its opening hours)
  menu: boolean;
  state: "food" | "study" | "open" | "closed";
  until: string | null;
}

export interface BuildingSummary {
  building: string;
  label: string; // shown on the map: our own name for the building (data/overrides.json) or its code
  place: string | null; // the mensa whose label is the building's own (data/overrides.json; Poly is Mensa Polyterrasse)
  mensa: boolean;
  partner: boolean; // a building of the other Zentrum campus, here only for its mensas
  mensas: MapMensa[];
  study: { open: number; total: number; best: MapSpace | null };
  /** null when the chosen time is outside the stored range. */
  rooms: {
    free: number; // free for at least the asked duration (min_free)
    total: number;
    unknown: number;
    best_seminar: Pick<MapRoom, "room" | "seats" | "free_until"> | null;
    best_hall: Pick<MapRoom, "room" | "seats" | "free_until"> | null;
  } | null;
}

const SEMINAR = "3420";
const HALL = "3430";

/** Free now and for at least `minFree` minutes more (free for the rest of the stored window counts too). */
export const freeLongEnough = (r: MapRoom, minFree = MAP_MIN_FREE_MINUTES) =>
  r.status === "free" && (r.minutes == null || r.minutes >= minFree);

const freeMinutes = (r: MapRoom) => r.minutes ?? Infinity;

/** The room free the longest, ties going to the bigger room. */
function longestFree(rooms: MapRoom[]) {
  const best = [...rooms].sort((a, b) => freeMinutes(b) - freeMinutes(a) || (b.seats ?? 0) - (a.seats ?? 0))[0];
  return best ? { room: best.room, seats: best.seats, free_until: best.free_until } : null;
}

/**
 * The space to suggest: an open library first, then the open space that is least full (if ETH has a reading),
 * then the one with the most seats.
 */
export function bestSpace(spaces: MapSpace[]): MapSpace | null {
  const rank = (s: MapSpace): [number, number] => [
    s.category === "library" ? 0 : s.occupancy ? 1 : 2,
    s.occupancy ? s.occupancy.pct : -(s.seats ?? 0),
  ];
  const open = spaces.filter((s) => s.open);
  open.sort((a, b) => {
    const [ka, kb] = [rank(a), rank(b)];
    return ka[0] - kb[0] || ka[1] - kb[1];
  });
  return open[0] ?? null;
}

/**
 * Serving food only inside a meal time; outside them a place that is a study space counts as one (Einstein &
 * Zweistein has no meal times, so it's a study space whenever it's open), any other place is just open.
 */
export function mensaOnMap(s: MapSpace): MapMensa {
  const study = s.study !== false;
  const state = !s.open ? "closed" : s.meal ? "food" : study ? "study" : "open";
  return { id: s.id, name: s.name, kind: s.kind === "mensa" ? "mensa" : "cafe", study, menu: s.menu === true, state, until: s.until };
}

/**
 * One summary per building that has rooms or study spaces, sorted by building code. Mensas are not counted as study
 * spaces but listed on their own. `rooms` is null when the chosen time is outside the stored range (the map then shows "–").
 */
export function summarise(rooms: MapRoom[] | null, spaces: MapSpace[], minFree = MAP_MIN_FREE_MINUTES): BuildingSummary[] {
  const buildings = new Set([...(rooms ?? []).map((r) => r.building), ...spaces.map((s) => s.building)]);
  return [...buildings].sort().map((building) => {
    const own = spaces.filter((s) => s.building === building);
    const study = own.filter((s) => s.category !== "mensa");
    const mine = rooms?.filter((r) => r.building === building) ?? [];
    const free = mine.filter((r) => freeLongEnough(r, minFree));
    return {
      building,
      label: BUILDING_OVERRIDES[building]?.label ?? building,
      place: BUILDING_OVERRIDES[building]?.place ?? null,
      mensa: own.some((s) => s.category === "mensa"),
      partner: own.length > 0 && own.every((s) => s.partner === true) && !mine.length,
      mensas: own.filter((s) => s.category === "mensa").map(mensaOnMap),
      study: { open: study.filter((s) => s.open).length, total: study.length, best: bestSpace(study) },
      rooms: rooms && {
        free: free.length,
        total: mine.length,
        unknown: mine.filter((r) => !["free", "busy", "managed"].includes(r.status)).length,
        best_seminar: longestFree(free.filter((r) => r.typecode === SEMINAR)),
        best_hall: longestFree(free.filter((r) => r.typecode === HALL)),
      },
    };
  });
}

/** A room, study space or place on a building's floor plan (the floor view, static/map/floors/). */
export interface BuildingDetail {
  rooms: {
    room: string;
    floor: string;
    typecode: string;
    seats: number | null;
    status: string; // free | busy | managed (a department books it too, ETH lists nothing) | no_data | pending | error
    free: boolean; // free for the asked duration (min_free) more: the map's rule for "free"
    until: string | null; // free until (free) or busy until (busy)
  }[];
  spaces: { id: string; floor: string; name: string; seats: number | null; open: boolean; until: string | null; occupancy: number | null }[];
  places: (MapMensa & { floor: string })[];
}

/**
 * The level a room or space is on, from its path or title: 'HG E 3' and 'HG E 20.0029' are on E; a gallery between
 * two levels ('HG EO 27.1') is drawn on the lower one; a place with menus only is 'HG E'.
 */
export const levelOf = (room: string): string => (room.split(" ")[1] ?? "").charAt(0);

/** Everything in one building the floor view colours in, for the same time as the summary. */
export function buildingDetail(building: string, rooms: MapRoom[] | null, spaces: MapSpace[], minFree = MAP_MIN_FREE_MINUTES): BuildingDetail {
  const own = spaces.filter((s) => s.building === building);
  return {
    rooms: (rooms ?? [])
      .filter((r) => r.building === building)
      .map((r) => ({
        room: r.room,
        floor: levelOf(r.room),
        typecode: r.typecode,
        seats: r.seats,
        status: r.status,
        free: freeLongEnough(r, minFree),
        until: r.status === "free" || r.status === "managed" ? r.free_until : r.status === "busy" ? (r.busy_until ?? null) : null,
      })),
    spaces: own
      .filter((s) => s.category !== "mensa")
      .map((s) => ({ id: s.id, floor: levelOf(s.room), name: s.name, seats: s.seats, open: s.open, until: s.until, occupancy: s.occupancy?.pct ?? null })),
    places: own.filter((s) => s.category === "mensa").map((s) => ({ ...mensaOnMap(s), floor: levelOf(s.room) })),
  };
}
