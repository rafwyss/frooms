// The TS port must produce exactly what the Python implementation does (golden files from scripts/golden.py).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAllocations, roomStatus, type Status } from "../worker/availability";
import { areaList, buildingCounts, ethUrl, filterRooms, parseCatalogue, roomPath, typeCounts } from "../worker/catalogue";
import { DEFAULT_TYPECODES } from "../worker/config";
import { parseQueryTime, toZurichIso } from "../worker/tz";

const read = (rel: string) => JSON.parse(readFileSync(join(import.meta.dirname, rel), "utf8"));
const iso = (ms: number | null) => (ms === null ? null : toZurichIso(ms));

function serialize(s: Status) {
  return {
    state: s.state,
    free_until: iso(s.free_until),
    busy_until: iso(s.busy_until),
    current_title: s.current_title,
    current_kind: s.current_kind,
    current_until: iso(s.current_until),
    next_title: s.next_title,
    next_kind: s.next_kind,
    next_gap_minutes: s.next_gap === null ? null : Math.floor(s.next_gap / 60_000),
    short_gap: s.short_gap,
  };
}

describe("room statuses match Python", () => {
  const golden: Record<string, ({ at: string } & ReturnType<typeof serialize>)[]> = read("./golden/statuses.json");
  for (const [name, rows] of Object.entries(golden)) {
    it(name, () => {
      const blocks = parseAllocations(read(`../data/samples/${name}`));
      const actual = rows.map((row) => ({ at: row.at, ...serialize(roomStatus(blocks, parseQueryTime(row.at)!)) }));
      expect(actual).toEqual(rows);
    });
  }
});

it("catalogue helpers match Python", () => {
  const golden = read("./golden/catalogue.json");
  const raw = read("../data/rooms_snapshot.json");
  const rooms = parseCatalogue(raw);
  const defaults = new Set(DEFAULT_TYPECODES);

  expect(areaList(raw)).toEqual(golden.areas);
  expect(buildingCounts(filterRooms(rooms, "Z", null, defaults))).toEqual(golden.buildings_Z_default);
  expect(typeCounts(filterRooms(rooms, "Z"))).toEqual(golden.types_Z);
  expect(
    filterRooms(rooms, "Z", new Set(["HG"]), defaults).map((r) => ({ path: roomPath(r), seats: r.seats, eth_url: ethUrl(r) })),
  ).toEqual(golden.hg_default);
  expect(filterRooms(rooms, "Z", null, defaults, 100).map(roomPath)).toEqual(golden.min_seats_100_Z);
});
