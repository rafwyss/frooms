// Room equipment from ETH's room details (`/v2/rooms/<path>`, the same API as the catalogue): presentation monitors,
// projectors, HDMI, wireless presenting, boards. The room prefetch (prefetch.ts) fetches a few rooms per run in the
// quiet hours and keeps everything in one KV key, "equipment"; Meet's "Screen or projector" filter and the room view
// read it. UZH's rooms have none (UZH publishes no equipment we read).

import { EQUIPMENT_TTL_S, MEET_TYPECODES } from "./config";

export interface Equipment {
  screen: boolean; // presentation monitor(s)
  projector: boolean;
  hdmi: boolean;
  wireless: boolean; // wireless presenter (Solstice)
  blackboard: boolean;
  whiteboard: boolean;
  flipchart: boolean;
}

/** The KV value: per room path, when its details were fetched and its flags (null: ETH had no details for it). */
export type EquipmentStore = Record<string, { at: number; flags: Equipment | null }>;

/** Which of ETH's attributes (by name, or by the start of the name) stand for what. */
const RULES: [keyof Equipment, (name: string) => boolean][] = [
  ["screen", (n) => n === "VIS.PROJ.MONITORE"],
  ["projector", (n) => n.startsWith("VIS.PROJ.BEAM")],
  ["hdmi", (n) => n === "AUS.ANSCHL.VID.HDMI"],
  ["wireless", (n) => n === "AUS.WIRELESS"],
  ["blackboard", (n) => n.startsWith("VIS.TAF.BB")],
  ["whiteboard", (n) => n.startsWith("VIS.TAF.WB")],
  ["flipchart", (n) => n === "VIS.TAF.FLIP"],
];

const ABSENT = new Set(["keine", "kein", "nicht vorhanden", "0", ""]);

/** An attribute that says something is there: not a ".NO" attribute ("Dokumentenkamera: keine"), not "keine" or 0. */
function present(name: string, value: unknown): boolean {
  if (name.endsWith(".NO")) return false;
  const v = typeof value === "string" ? value.trim().toLowerCase() : value === null || value === undefined ? "" : String(value);
  return !ABSENT.has(v);
}

/** A room details answer as flags. Every tab is looked through (the names are unique across them). */
export function parseEquipment(raw: unknown): Equipment {
  const flags: Equipment = { screen: false, projector: false, hdmi: false, wireless: false, blackboard: false, whiteboard: false, flipchart: false };
  const tabs = (raw as { tabs?: unknown } | null)?.tabs;
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    const attributes = (tab as { attributes?: unknown } | null)?.attributes;
    for (const a of Array.isArray(attributes) ? attributes : []) {
      const name = typeof a?.name === "string" ? a.name.trim() : "";
      for (const [key, matches] of RULES) if (matches(name) && present(name, a.value)) flags[key] = true;
    }
  }
  return flags;
}

/** Whether a room has something to present on (Meet's "Screen or projector"); null when unknown. */
export const hasScreen = (flags: Equipment | null | undefined): boolean | null => (flags ? flags.screen || flags.projector : null);

/**
 * The rooms to fetch next, at most `n`: those never fetched first (Meet's types before the rest), then those older
 * than EQUIPMENT_TTL_S, oldest first.
 */
export function pickEquipment(rooms: { path: string; typecode: string }[], stored: EquipmentStore, now: number, n: number): string[] {
  const meet = (r: { typecode: string }) => (MEET_TYPECODES.includes(r.typecode) ? 0 : 1);
  const missing = rooms.filter((r) => !stored[r.path]).sort((a, b) => meet(a) - meet(b));
  const old = rooms
    .filter((r) => stored[r.path] && now - stored[r.path].at > EQUIPMENT_TTL_S * 1000)
    .sort((a, b) => stored[a.path].at - stored[b.path].at);
  return [...missing, ...old].slice(0, Math.max(0, n)).map((r) => r.path);
}

const MEMORY_S = 3600;
let memo: { at: number; value: EquipmentStore } | null = null;

export const clearEquipmentMemory = () => {
  memo = null;
};

/** The stored equipment, cached in isolate memory for an hour (it changes at night only). */
export async function readEquipment(kv: KVNamespace | undefined, now = Date.now()): Promise<EquipmentStore> {
  if (memo && now - memo.at < MEMORY_S * 1000) return memo.value;
  const value = (await kv?.get<EquipmentStore>("equipment", { type: "json", cacheTtl: MEMORY_S })) ?? {};
  memo = { at: now, value };
  return value;
}
