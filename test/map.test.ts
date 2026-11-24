// The map's per-building summary (worker/map.ts).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readData } from "./helpers";

import { bestSpace, buildingDetail, freeLongEnough, levelOf, type MapRoom, type MapSpace, mensaOnMap, summarise } from "../worker/map";

const room = (r: Partial<MapRoom>): MapRoom => ({
  room: "HG E 1",
  building: "HG",
  seats: 40,
  typecode: "3420",
  status: "free",
  free_until: null,
  minutes: null,
  ...r,
});

const space = (s: Partial<MapSpace>): MapSpace => ({
  id: "X",
  room: "HG E 1",
  name: "Space",
  category: "open",
  building: "HG",
  seats: 20,
  open: true,
  until: null,
  meal: false,
  occupancy: null,
  ...s,
});

describe("free long enough", () => {
  it("needs two more hours, or the rest of the stored window", () => {
    expect(freeLongEnough(room({ minutes: 120 }))).toBe(true);
    expect(freeLongEnough(room({ minutes: 119 }))).toBe(false);
    expect(freeLongEnough(room({ minutes: null }))).toBe(true);
    expect(freeLongEnough(room({ status: "busy", minutes: 300 }))).toBe(false);
    expect(freeLongEnough(room({ status: "pending", minutes: undefined }))).toBe(false);
  });
});

describe("best space", () => {
  it("prefers an open library, then the least full, then the most seats", () => {
    const quiet = space({ id: "quiet", occupancy: { pct: 20, status: "green" } });
    const busy = space({ id: "busy", occupancy: { pct: 80, status: "red" } });
    const big = space({ id: "big", seats: 200 });
    const library = space({ id: "lib", category: "library", occupancy: { pct: 60, status: "yellow" } });
    const closedLibrary = space({ id: "closed", category: "library", open: false });
    expect(bestSpace([big, busy, quiet, library, closedLibrary])!.id).toBe("lib");
    expect(bestSpace([big, busy, quiet])!.id).toBe("quiet");
    expect(bestSpace([space({ id: "small", seats: 10 }), big])!.id).toBe("big");
    expect(bestSpace([closedLibrary])).toBeNull();
  });
});

describe("summarise", () => {
  it("counts rooms free for two hours and open study spaces per building, without mensas", () => {
    const rooms = [
      room({ room: "HG E 1", minutes: 200, free_until: "2026-11-02T17:00+01:00" }),
      room({ room: "HG E 2", minutes: 90 }),
      room({ room: "HG E 3", typecode: "3430", seats: 300, minutes: null }),
      room({ room: "HG E 4", status: "busy", minutes: 30 }),
      room({ room: "HG E 5", status: "pending", minutes: undefined }),
      room({ room: "CAB G 1", building: "CAB", status: "no_data", minutes: undefined }),
    ];
    const spaces = [
      space({ id: "a" }),
      space({ id: "b", open: false }),
      space({ id: "mensa", building: "MM", category: "mensa", seats: 650 }),
    ];
    const [cab, hg, mm] = summarise(rooms, spaces);
    expect(hg).toEqual({
      building: "HG",
      label: "HG",
      place: null,
      mensa: false,
      partner: false,
      mensas: [],
      study: { open: 1, total: 2, best: spaces[0] },
      rooms: {
        free: 2,
        total: 5,
        unknown: 1,
        best_seminar: { room: "HG E 1", seats: 40, free_until: "2026-11-02T17:00+01:00" },
        best_hall: { room: "HG E 3", seats: 300, free_until: null },
      },
    });
    expect(cab.rooms).toMatchObject({ free: 0, unknown: 1, best_seminar: null, best_hall: null });
    expect(mm).toMatchObject({ building: "MM", mensa: true, study: { open: 0, best: null }, rooms: { free: 0, unknown: 0 } });
    expect(mm.mensas).toEqual([{ id: "mensa", name: "Space", kind: "cafe", study: true, menu: false, state: "study", until: null }]);
  });

  it("marks a building that is only there for the Zentrum partner's mensas", () => {
    const [men, mm] = summarise([], [
      space({ id: "UM1", building: "MEN", category: "mensa", partner: true }),
      space({ id: "MMB79", building: "MM", category: "mensa" }),
    ]);
    expect(men).toMatchObject({ building: "MEN", partner: true, mensa: true, study: { total: 0 } });
    expect(men.mensas.map((m) => m.id)).toEqual(["UM1"]);
    expect(mm.partner).toBe(false);
  });

  it("leaves the rooms out when the time isn't stored", () => {
    const [hg] = summarise(null, [space({})]);
    expect(hg.rooms).toBeNull();
    expect(hg.study.open).toBe(1);
  });

  it("picks the room free the longest, the bigger one on a tie", () => {
    const rooms = [
      room({ room: "A", minutes: 150, seats: 100 }),
      room({ room: "B", minutes: 300, seats: 20 }),
      room({ room: "C", minutes: 300, seats: 30 }),
    ];
    expect(summarise(rooms, [])[0].rooms!.best_seminar!.room).toBe("C");
  });
});

describe("mensas on the map", () => {
  const mensa = (s: Partial<MapSpace>) => mensaOnMap(space({ category: "mensa", ...s }));

  it("serves food in its meal times and is a study space outside them", () => {
    expect(mensa({ meal: true, until: "2026-11-02T13:30+01:00" })).toMatchObject({ state: "food", until: "2026-11-02T13:30+01:00" });
    expect(mensa({ meal: false })).toMatchObject({ state: "study" });
    expect(mensa({ open: false })).toMatchObject({ state: "closed" });
  });

  it("serves food only in its meal times, and is just open otherwise if it isn't a study space (CHOICES.md)", () => {
    expect(mensa({ study: false, meal: true })).toMatchObject({ state: "food", study: false });
    expect(mensa({ study: false, meal: false })).toMatchObject({ state: "open" }); // bQm in the evening: no amber Poly
    expect(mensa({ study: false, open: false })).toMatchObject({ state: "closed" });
  });

  it("tells mensas and cafeterias apart, and which have a menu", () => {
    expect(mensa({ kind: "mensa", menu: true })).toMatchObject({ kind: "mensa", menu: true });
    expect(mensa({ kind: "cafe" })).toMatchObject({ kind: "cafe", menu: false });
  });

  it("labels buildings with our own names, and Poly's label is Mensa Polyterrasse's", () => {
    const [mm] = summarise(null, [space({ building: "MM", category: "mensa" })]);
    expect(mm).toMatchObject({ label: "Poly", place: "MMB79" });
  });
});

describe("pins", () => {
  const pins = JSON.parse(readData("..", "static", "map", "pins.json"));

  it("pin only buildings on their campus's map, inside its drawing", () => {
    for (const [area, { buildings = {} }] of Object.entries<{ buildings?: Record<string, [number, number] | null> }>(pins)) {
      if (area.startsWith("_")) continue;
      const doc = JSON.parse(readData("..", "static", "map", `${area}.json`));
      const [x0, y0, x1, y1] = doc.bounds;
      for (const [code, at] of Object.entries(buildings)) {
        expect(code in doc.buildings, `${area} ${code}`).toBe(true);
        if (!at) continue; // null: back on its building
        expect(at[0] >= x0 && at[0] <= x1 && at[1] >= y0 && at[1] <= y1, `${area} ${code} inside`).toBe(true);
      }
    }
  });
});

describe("building detail (floor view)", () => {
  it("reads the level from a room path or a space's title", () => {
    expect(levelOf("HG E 3")).toBe("E");
    expect(levelOf("HG E 20.0029")).toBe("E");
    expect(levelOf("HG EO 27.1")).toBe("E"); // a gallery is drawn on the lower level
    expect(levelOf("HG K")).toBe("K"); // a place with menus only
  });

  it("lists one building's rooms, study spaces and places with their level", () => {
    const rooms = [
      room({ room: "HG E 3", typecode: "3430", minutes: 200, free_until: "2026-11-02T17:00+01:00" }),
      room({ room: "HG F 1", status: "busy", busy_until: "2026-11-02T12:00+01:00", minutes: 30 }),
      room({ room: "HG D 1.1", minutes: 60, free_until: "2026-11-02T13:00+01:00" }),
      room({ room: "CAB G 11", building: "CAB" }),
    ];
    const spaces = [
      space({ id: "HGE30.7", room: "HG E 30.7", name: "HG Lobby", occupancy: { pct: 62, status: "yellow" } }),
      space({ id: "F2", room: "HG E", name: "CafeBar", category: "mensa", kind: "cafe", study: false }),
      space({ id: "CABF31", room: "CAB F 31", building: "CAB" }),
    ];
    const d = buildingDetail("HG", rooms, spaces);
    expect(d.rooms.map((r) => [r.room, r.floor, r.free, r.until])).toEqual([
      ["HG E 3", "E", true, "2026-11-02T17:00+01:00"],
      ["HG F 1", "F", false, "2026-11-02T12:00+01:00"],
      ["HG D 1.1", "D", false, "2026-11-02T13:00+01:00"], // free, but not for two hours
    ]);
    expect(d.spaces).toEqual([{ id: "HGE30.7", floor: "E", name: "HG Lobby", seats: 20, open: true, until: null, occupancy: 62 }]);
    expect(d.places.map((p) => [p.id, p.floor, p.state])).toEqual([["F2", "E", "open"]]);
  });

  it("is empty for an unknown building, and has no rooms outside the stored range", () => {
    expect(buildingDetail("XYZ", [room({})], [space({})])).toEqual({ rooms: [], spaces: [], places: [] });
    expect(buildingDetail("HG", null, []).rooms).toEqual([]);
  });
});

describe("floor plans", () => {
  const { levels, ...index } = JSON.parse(readData("..", "static", "map", "floors", "index.json")) as
    Record<string, string[]> & { levels: Record<string, { ground: string; order: string[] }> };
  const snapshot = JSON.parse(readData("rooms_snapshot.json")) as { building: string; floor: string; room: string; typecode: string }[];

  it("cover every lecture hall and seminar room of their buildings, on the right level", () => {
    for (const [area, buildings] of Object.entries(index)) {
      for (const b of buildings) {
        const doc = JSON.parse(readData("..", "static", "map", "floors", `${b}.json`));
        expect(doc.area).toBe(area);
        const drawn = new Set(doc.levels.flatMap((l: { level: string; rooms: object }) => Object.keys(l.rooms).map((r) => `${l.level}|${r}`)));
        for (const r of snapshot.filter((r) => r.building === b && ["3430", "3420"].includes(r.typecode))) {
          expect(drawn.has(`${r.floor}|${b} ${r.floor} ${r.room}`), `${b} ${r.floor} ${r.room}`).toBe(true);
        }
      }
    }
  });

  it("give every building its ground level and level order, with each drawn level in it", () => {
    const table = JSON.parse(readData("floors", "levels.json")) as { ground: Record<string, string>; order: Record<string, string[]> };
    for (const b of Object.values(index).flat()) {
      expect(levels[b], b).toEqual({ ground: table.ground[b], order: table.order[b] });
      expect(levels[b].ground, b).toMatch(/^[A-HJ-Z]$/);
      const doc = JSON.parse(readData("..", "static", "map", "floors", `${b}.json`));
      for (const l of doc.levels) expect(levels[b].order, `${b} ${l.level}`).toContain(l.level);
    }
  });
});

describe("microwaves", () => {
  type Microwave = { id: string; area: string; building: string; floor: string | null; at: [number, number] | null };
  const { microwaves } = JSON.parse(readData("microwaves.json")) as { microwaves: Microwave[] };
  const pins = JSON.parse(readData("..", "static", "map", "pins.json")) as Record<string, { microwaves?: Record<string, [number, number] | null> }>;

  it("sit inside their campus's drawing, on a level their building's floor plans have", () => {
    for (const m of microwaves) {
      const doc = JSON.parse(readData("..", "static", "map", `${m.area}.json`));
      expect(m.building in doc.buildings, m.id).toBe(true);
      const [x0, y0, x1, y1] = doc.bounds;
      if (m.at) expect(m.at[0] >= x0 && m.at[0] <= x1 && m.at[1] >= y0 && m.at[1] <= y1, `${m.id} inside`).toBe(true);
      // Without the building's plans (main, until ETH agrees: static/map/floors/ holds only an empty index) no level check.
      if (!m.floor || !existsSync(join(import.meta.dirname, "..", "static", "map", "floors", `${m.building}.json`))) continue;
      const plans = JSON.parse(readData("..", "static", "map", "floors", `${m.building}.json`));
      expect(plans.levels.map((l: { level: string }) => l.level), m.id).toContain(m.floor);
    }
  });

  it("are pinned only by their own ids", () => {
    const ids = new Set(microwaves.map((m) => m.id));
    for (const [area, { microwaves: pinned = {} }] of Object.entries(pins)) {
      if (area.startsWith("_")) continue;
      for (const id of Object.keys(pinned)) expect(ids.has(id), `${area} ${id}`).toBe(true);
    }
  });
});
