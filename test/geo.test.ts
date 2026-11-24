// "Near you" on the map (static/geo.js, a plain browser script).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Pt = [number, number];
type Geo = {
  gpsToMap: (origin: Pt, lat: number, lon: number) => Pt;
  mapToGps: (origin: Pt, x: number, y: number) => Pt;
  distanceToBounds: (bounds: number[], p: Pt) => number;
  distanceText: (m: number) => string;
  nearby: (buildings: object[], anchorOf: (code: string) => Pt | null, here: Pt, opts?: { inside?: string | null; limit?: number }) => {
    study: { code: string; dist: number; space: { id: string } }[];
    rooms: { code: string; dist: number; free: number; room: { room: string } }[];
  };
};

const root = join(import.meta.dirname, "..");
const geo = new Function(`${readFileSync(join(root, "static", "geo.js"), "utf8")}; return { gpsToMap, mapToGps, distanceToBounds, distanceText, nearby };`)() as Geo;
const campus = (area: string) => JSON.parse(readFileSync(join(root, "static", "map", `${area}.json`), "utf8"));

describe("GPS on the campus drawing", () => {
  it("lands a position on its building", () => {
    // HG's main entrance on Rämistrasse, a few tens of metres from the building's label anchor.
    const doc = campus("Z");
    const [x, y] = geo.gpsToMap(doc.origin, 47.37645, 8.54765);
    expect(Math.hypot(x - doc.buildings.HG.x, y - doc.buildings.HG.y)).toBeLessThan(60);
  });

  it("hands a place over from one map to another (ETH Zentrum and UZH Zentrum overlap)", () => {
    const eth = campus("Z");
    const uzh = campus("UZ");
    const [lat, lon] = geo.mapToGps(eth.origin, eth.buildings.HG.x, eth.buildings.HG.y);
    const [x, y] = geo.gpsToMap(eth.origin, lat, lon);
    expect([x, y]).toEqual([expect.closeTo(eth.buildings.HG.x, 6), expect.closeTo(eth.buildings.HG.y, 6)]);
    // KOL, from UZH's map onto ETH's: south of HG, a little east.
    const [kx, ky] = geo.gpsToMap(eth.origin, ...geo.mapToGps(uzh.origin, uzh.buildings.KOL.x, uzh.buildings.KOL.y));
    expect(ky - eth.buildings.HG.y).toBeGreaterThan(150);
    expect(ky - eth.buildings.HG.y).toBeLessThan(260);
    expect(kx - eth.buildings.HG.x).toBeGreaterThan(0);
  });

  it("has an origin in every campus file", () => {
    for (const area of ["Z", "H", "UZ", "UI", "UO"]) {
      const doc = campus(area);
      expect(doc.origin).toHaveLength(2);
      expect(geo.distanceToBounds(doc.bounds, geo.gpsToMap(doc.origin, doc.origin[0], doc.origin[1]))).toBe(0);
    }
  });

  it("has an overview around every campus, in the same frame", () => {
    const ov = JSON.parse(readFileSync(join(root, "static", "map", "overview.json"), "utf8"));
    for (const area of ["Z", "H", "UZ", "UI", "UO"]) {
      const doc = campus(area);
      const [x0, y0, x1, y1] = doc.bounds;
      for (const [x, y] of [[x0, y0], [x1, y1]]) {
        expect(geo.distanceToBounds(ov.bounds, geo.gpsToMap(ov.origin, ...geo.mapToGps(doc.origin, x, y)))).toBe(0);
      }
    }
    // The river is short: most of the Limmat is drawn as water, and the region ends just north of Oerlikon.
    for (const layer of ["green", "water", "major", "rail"]) expect(ov.layers[layer].length).toBeGreaterThan(1000);
    expect(ov.layers.river.length).toBeGreaterThan(300);
  });

  it("has the region's tiles under every campus, in the overview's frame", () => {
    const region = JSON.parse(readFileSync(join(root, "static", "map", "region", "index.json"), "utf8"));
    const ov = JSON.parse(readFileSync(join(root, "static", "map", "overview.json"), "utf8"));
    expect(region.origin).toEqual(ov.origin);
    expect(region.bounds).toEqual(ov.bounds);
    for (const area of ["Z", "H", "UZ", "UI", "UO"]) {
      const doc = campus(area);
      const [x, y] = geo.gpsToMap(region.origin, doc.origin[0], doc.origin[1]);
      expect(geo.distanceToBounds(region.bounds, [x, y])).toBe(0);
      const tile = `${Math.floor((x - region.bounds[0]) / region.tile)}_${Math.floor((y - region.bounds[1]) / region.tile)}`;
      expect(region.tiles).toContain(tile);
      expect(existsSync(join(root, "static", "map", "region", `${tile}.json`))).toBe(true);
    }
  });

  it("measures how far outside the drawn area a point is", () => {
    expect(geo.distanceToBounds([-100, -100, 100, 100], [0, 0])).toBe(0);
    expect(geo.distanceToBounds([-100, -100, 100, 100], [400, 0])).toBe(300);
    expect(geo.distanceToBounds([-100, -100, 100, 100], [130, -140])).toBe(50);
  });
});

describe("distance text", () => {
  it("rounds so it doesn't look more exact than it is", () => {
    expect(geo.distanceText(8)).toBe("here");
    expect(geo.distanceText(44)).toBe("40 m");
    expect(geo.distanceText(347)).toBe("350 m");
    expect(geo.distanceText(1240)).toBe("1.2 km");
    expect(geo.distanceText(12400)).toBe("12 km");
  });
});

describe("nearby", () => {
  const study = (open: number, id = "S") => ({ open, total: 2, best: open ? { id } : null });
  const rooms = (free: number, seminar: string | null, hall: string | null = null, hallUntil: string | null = "2026-11-02T18:00+01:00") => ({
    free, total: 5, unknown: 0,
    best_seminar: seminar ? { room: seminar, seats: 20, free_until: "2026-11-02T16:00+01:00" } : null,
    best_hall: hall ? { room: hall, seats: 200, free_until: hallUntil } : null,
  });
  const at: Record<string, Pt> = { A: [0, 0], B: [100, 0], C: [300, 0], D: [50, 0] };
  const anchorOf = (code: string) => at[code] ?? null;

  it("lists open study spaces and free rooms nearest first", () => {
    const buildings = [
      { building: "A", study: study(0), rooms: rooms(2, "A 1") },
      { building: "B", study: study(1, "b"), rooms: rooms(0, null) },
      { building: "C", study: study(3, "c"), rooms: rooms(1, "C 1") },
      { building: "D", study: study(1, "d"), rooms: null },
      { building: "X", study: study(1, "x"), rooms: rooms(1, "X 1") }, // not on the map
    ];
    const near = geo.nearby(buildings, anchorOf, [90, 0]);
    expect(near.study.map((s) => [s.code, s.space.id, Math.round(s.dist)])).toEqual([["B", "b", 10], ["D", "d", 40], ["C", "c", 210]]);
    expect(near.rooms.map((r) => [r.code, r.room.room, r.free])).toEqual([["A", "A 1", 2], ["C", "C 1", 1]]);
  });

  it("counts the building the person is in as distance 0, and keeps to the limit", () => {
    const buildings = ["A", "B", "C", "D"].map((b) => ({ building: b, study: study(1, b), rooms: rooms(1, `${b} 1`) }));
    const near = geo.nearby(buildings, anchorOf, [0, 0], { inside: "C", limit: 2 });
    expect(near.study.map((s) => [s.code, s.dist])).toEqual([["C", 0], ["A", 0]]);
    expect(near.rooms).toHaveLength(2);
  });

  it("suggests the room free the longest, a room free for the rest of the day first", () => {
    const one = (r: object) => geo.nearby([{ building: "A", study: study(0), rooms: r }], anchorOf, [0, 0]).rooms[0].room.room;
    expect(one(rooms(2, "A 1", "A 2"))).toBe("A 2");
    expect(one(rooms(2, "A 1", "A 2", "2026-11-02T15:00+01:00"))).toBe("A 1");
    expect(one(rooms(2, "A 1", "A 2", null))).toBe("A 2");
  });
});
