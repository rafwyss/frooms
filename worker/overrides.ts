// Our own corrections to ETH's data (data/overrides.json), so places read the way students know them.

import file from "../data/overrides.json";
import type { Category } from "./spaces";

export interface SpaceOverride {
  name?: string;
  category?: Category;
  mergeInto?: string; // shown as part of that space
}

export interface BuildingOverride {
  label?: string;
  place?: string; // a mensa whose label on the map is the building's own (Poly is Mensa Polyterrasse)
}

const CATEGORIES = new Set<string>(["library", "open", "mensa", "workspace"]);

/** The space entries, without the "_about" notes and with only the fields we know. */
function entries(section: Record<string, unknown>): Record<string, SpaceOverride> {
  const out: Record<string, SpaceOverride> = {};
  for (const [id, raw] of Object.entries(section)) {
    if (id.startsWith("_") || !raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    out[id] = {
      ...(typeof o.name === "string" && o.name.trim() ? { name: o.name.trim() } : {}),
      ...(typeof o.category === "string" && CATEGORIES.has(o.category) ? { category: o.category as Category } : {}),
      ...(typeof o.merge_into === "string" && o.merge_into.trim() ? { mergeInto: o.merge_into.trim() } : {}),
    };
  }
  return out;
}

/** By ETH's roomGlobalIdentifier. */
export const SPACE_OVERRIDES = entries(file.spaces);

/** A study space ETH's list doesn't have (data/overrides.json `extra_spaces`): what worker/spaces.ts makes a Space of. */
export interface ExtraSpace {
  id: string;
  name: string;
  room: string;
  building: string;
  area: string;
  alsoIn: string[]; // other locations whose lists have it too (IPZ Hangar, outside every campus: both ETH ones)
  category: Category;
  seats: number | null;
  hours: string[];
  shownHours: string[] | null;
  openText: string | null;
  notice: string | null; // a line under its status ("Not on the map yet.")
  infoUrl: string; // "" without an official page (the view leaves the button out)
}

const lines = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);

/** The extra spaces, without the "_about" note; an entry without a name, building, area or hours is left out. */
export function parseExtraSpaces(section: Record<string, unknown>): ExtraSpace[] {
  const out: ExtraSpace[] = [];
  for (const [id, raw] of Object.entries(section ?? {})) {
    if (id.startsWith("_") || !raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const building = typeof o.building === "string" ? o.building.trim() : "";
    const area = typeof o.area === "string" ? o.area.trim() : "";
    const hours = lines(o.hours);
    if (!name || !building || !area || !hours.length) continue;
    const shown = lines(o.shown_hours);
    out.push({
      id,
      name,
      room: typeof o.room === "string" && o.room.trim() ? o.room.trim() : building,
      building,
      area,
      alsoIn: lines(o.also_in).map((a) => a.trim()).filter((a) => a !== area),
      category: typeof o.category === "string" && CATEGORIES.has(o.category) ? (o.category as Category) : "open",
      seats: Number.isInteger(o.seats) && (o.seats as number) > 0 ? (o.seats as number) : null,
      hours,
      shownHours: shown.length ? shown : null,
      openText: typeof o.open_text === "string" && o.open_text.trim() ? o.open_text.trim() : null,
      notice: typeof o.notice === "string" && o.notice.trim() ? o.notice.trim() : null,
      infoUrl: typeof o.info_url === "string" && o.info_url.trim() ? o.info_url.trim() : "",
    });
  }
  return out;
}

export const EXTRA_SPACES = parseExtraSpaces((file as { extra_spaces?: Record<string, unknown> }).extra_spaces ?? {});

export type EateryKind = "mensa" | "cafe";

export interface EateryOverride {
  space?: string; // a study space's id: that space's card gets the menu
  name?: string;
  building?: string;
  floor?: string;
  area?: string;
  kind?: EateryKind;
  hidden?: boolean; // left out entirely (CHOICES.md)
  mergeInto?: number; // shown as part of that facility's place, so not a place of its own (Kiosk CLA in Clausiusbar)
  cafeOutsideMeals?: boolean; // a mensa in its meal times, a cafeteria the rest of the day (Tannenbar)
  flagship?: string; // the mensa's signature line ("Street"): the Eat tab's card shows its dish
}

const KINDS = new Set<string>(["mensa", "cafe"]);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The eatery entries by Cookpit facility id, without the "_about" notes and with only the fields we know. */
export function parseEateries(section: Record<string, unknown>): Record<number, EateryOverride> {
  const out: Record<number, EateryOverride> = {};
  for (const [id, raw] of Object.entries(section)) {
    if (!/^\d+$/.test(id) || !raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const entry: EateryOverride = {
      space: text(o.space),
      name: text(o.name),
      building: text(o.building),
      floor: text(o.floor),
      area: text(o.area),
      kind: typeof o.kind === "string" && KINDS.has(o.kind) ? (o.kind as EateryKind) : undefined,
      hidden: o.hidden === true || undefined,
      cafeOutsideMeals: o.cafe_outside_meals === true || undefined,
      flagship: text(o.flagship),
      mergeInto: typeof o.merge_into === "number" || /^\d+$/.test(String(o.merge_into ?? "")) ? Number(o.merge_into) : undefined,
    };
    out[Number(id)] = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
  }
  return out;
}

/** By Cookpit's facility id. */
export const EATERY_OVERRIDES = parseEateries(file.eateries);

/** Whether a facility is a place of its own: not hidden and not merged into another one. */
export const isOwnPlace = (o: EateryOverride) => !o.hidden && o.mergeInto === undefined;

/** By ETH's building code. */
export const BUILDING_OVERRIDES: Record<string, BuildingOverride> = Object.fromEntries(
  Object.entries(file.buildings as Record<string, unknown>)
    .filter(([code, raw]) => !code.startsWith("_") && raw && typeof raw === "object")
    .map(([code, raw]) => {
      const o = raw as Record<string, unknown>;
      return [code, { ...(text(o.label) ? { label: text(o.label) } : {}), ...(text(o.place) ? { place: text(o.place) } : {}) }];
    }),
);

/** A location's mensas in our order (place ids), from `mensa_order`: only string ids, once each. */
export function parseMensaOrder(section: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [area, ids] of Object.entries(section)) {
    if (area.startsWith("_") || !Array.isArray(ids)) continue;
    out[area] = [...new Set(ids.filter((id): id is string => typeof id === "string" && !!id.trim()).map((id) => id.trim()))];
  }
  return out;
}

/**
 * By area: the order of its mensas where no position is known (the Eat list, the comparison's chips and its default
 * pick, the map's labels). The Zentrum partner (config.ts MENSA_PARTNERS) uses Zentrum's list unless it has its own.
 */
export const MENSA_ORDER = parseMensaOrder(file.mensa_order as Record<string, unknown>);

/** The "name" field of each entry in a section keyed by code (room types). */
function names(section: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, raw] of Object.entries(section)) {
    if (code.startsWith("_") || !raw || typeof raw !== "object") continue;
    const name = (raw as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) out[code] = name.trim();
  }
  return out;
}

/** Our English names for ETH's room types, by typecode (ETH: 'Hörsaal'; ours: 'Lecture hall'). */
export const ROOM_TYPE_NAMES = names(file.room_types);

/**
 * ETH's raw room catalogue with our names for room types put in place of ETH's. Applied where the catalogue is read,
 * so the catalogue functions stay identical to the Python app's (test/parity.test.ts). The areas are named in
 * worker/config.ts (AREA_LABELS).
 */
export function renameCatalogue(raw: unknown[]): unknown[] {
  return raw.map((r: any) => {
    const type = r && typeof r === "object" ? ROOM_TYPE_NAMES[r.typecode] : undefined;
    return type ? { ...r, type } : r;
  });
}

/** The department that also books an ETH room itself (data/overrides.json `rooms` `managed_by`), by room path. */
function managers(section: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, raw] of Object.entries(section ?? {})) {
    if (path.startsWith("_") || !raw || typeof raw !== "object") continue;
    const by = (raw as Record<string, unknown>).managed_by;
    if (typeof by === "string" && by.trim()) out[path] = by.trim();
  }
  return out;
}

/** Rooms a department also books in a system of its own: ETH's empty times there aren't free ('HG G 19.1': 'D-MATH'). */
export const ROOM_MANAGERS = managers(file.rooms);
