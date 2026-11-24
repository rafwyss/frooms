// Load and filter the room catalogue (/v2/rooms). Port of app/catalogue.py.

import { AREA_LABELS } from "./config";

const ETH_DETAIL_PAGE = "https://ethz.ch/staffnet/en/service/rooms-and-buildings/roominfo/detail.html";

export interface Room {
  area: string;
  region: string;
  building: string;
  floor: string;
  room: string;
  seats: number | null;
  typecode: string;
  type: string;
  // UZH rooms only (worker/uzh.ts): the room's own code ('KOL-F-101'), its page and its calendar ids.
  code?: string;
  url?: string;
  uzh?: { id: number; standort: number };
}

/**
 * Room path: for ETH as the allocations endpoint expects it, e.g. 'ML E 13' (not the padded id); for UZH its code,
 * e.g. 'KOL-F-101'. Also the key in D1 and the name shown, so the two never clash (ETH's have spaces, UZH's dashes).
 */
export const roomPath = (r: Room) => r.code ?? `${r.building} ${r.floor} ${r.room}`;

/** The room's details page (photos, seats, equipment): ETH's, or UniAbility's for UZH. */
export function ethUrl(r: Room): string {
  if (r.url) return r.url;
  const query = new URLSearchParams({ region: r.region, building: r.building, floor: r.floor, room: r.room });
  return `${ETH_DETAIL_PAGE}?${query}`;
}

function seats(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\s*[+-]?\d+\s*$/.test(value)) return parseInt(value, 10);
  return null;
}

type RawRoom = any;

/** Rooms of one area (e.g. "Z"), or of all areas if `area` is null. */
export function parseCatalogue(raw: RawRoom[], area: string | null = null): Room[] {
  return raw
    .filter((r) => r.area && (area === null || r.area === area))
    .map((r) => ({
      area: r.area,
      region: r.region || r.area,
      building: r.building,
      floor: r.floor,
      room: r.room,
      seats: seats(r.seats),
      typecode: r.typecode || "",
      type: r.type || "",
    }));
}

export function filterRooms(
  rooms: Room[],
  area: string | null = null,
  buildings: Set<string> | null = null,
  typecodes: Set<string> | null = null,
  minSeats: number | null = null,
): Room[] {
  return rooms.filter(
    (r) =>
      (!area || r.area === area) &&
      (!buildings?.size || buildings.has(r.building)) &&
      (!typecodes?.size || typecodes.has(r.typecode)) &&
      (!minSeats || (r.seats ?? 0) >= minSeats),
  );
}

function count<K>(keys: K[]): Map<K, number> {
  const counts = new Map<K, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return counts;
}

/** Areas with their display name and room count, largest first. */
export function areaList(raw: RawRoom[]): { area: string; name: string; rooms: number }[] {
  const withArea = raw.filter((r) => r.area);
  const names = new Map<string, string>();
  for (const r of withArea) names.set(r.area, r.location?.areaDesc || r.locationName || r.area);
  return [...count(withArea.map((r) => r.area as string))]
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => ({ area: a, name: AREA_LABELS[a] ?? names.get(a)!, rooms: n }));
}

export function buildingCounts(rooms: Room[]): Record<string, number> {
  return Object.fromEntries([...count(rooms.map((r) => r.building))].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

export function typeCounts(rooms: Room[]): { typecode: string; type: string; count: number }[] {
  const counts = count(rooms.map((r) => `${r.typecode}\u0000${r.type}`));
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => {
      const [typecode, type] = key.split("\u0000");
      return { typecode, type, count: n };
    });
}
