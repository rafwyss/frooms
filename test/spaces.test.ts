// Study spaces: parsing ETH's list, opening hours, meal times and the occupancy estimates.
import { describe, expect, it } from "vitest";

import { elsewhereIds, estimate, ownCampuses, parseHours, parseReadings, parseSpaces, type Reading, type Space, spaceState } from "../worker/spaces";
import { toZurichIso, zurichToUtc } from "../worker/tz";
import { readData } from "./helpers";

const spaces = parseSpaces(JSON.parse(readData("samples", "studyspaces_en.json")).data);
const byRoom = (room: string) => spaces.find((s) => s.room === room)!;
// 1 November 2026 is a Sunday, the 2nd a Monday.
const at = (day: number, hour: number, minute = 0) => zurichToUtc(2026, 11, day, hour, minute);
const iso = (ms: number | null) => (ms === null ? null : toZurichIso(ms));
const count = (values: string[]) => Object.fromEntries([...new Set(values)].map((v) => [v, values.filter((x) => x === v).length]));

describe("the list of spaces", () => {
  it("sorts spaces into ETH's categories and our areas", () => {
    // ETH's 61 and our workspaces (data/overrides.json extra_spaces): the two Student Project Houses, Fabrik, and IPZ
    // Hangar once in each ETH location.
    expect(spaces.length).toBe(66);
    expect(count(spaces.map((s) => s.category))).toEqual({ open: 49, library: 6, mensa: 6, workspace: 5 });
    expect(count(spaces.map((s) => s.area))).toEqual({ Z: 48, H: 18 });
  });

  it("adds our own spaces: the Student Project Houses, open around the clock for their projects", () => {
    const sphz = spaces.find((s) => s.id === "SPHZ")!;
    expect(sphz).toMatchObject({ name: "SPH Zentrum", building: "SPHZ", area: "Z", category: "workspace", open_text: "Open for SPH projects" });
    expect(sphz.shown_hours).toEqual(["Makerspace: Mon - Fri 08:00 - 20:00", "SPH projects: open 24/7"]);
    expect(spaces.find((s) => s.id === "SPHH")).toMatchObject({ building: "SPHH", area: "H" });
    for (const t of [at(1, 3), at(2, 12), at(2, 23, 30)]) expect(spaceState(sphz, t, 0).open).toBe(true);
  });

  it("adds Fabrik in LEO, open on weekdays, without an official page", () => {
    const fabrik = spaces.find((s) => s.id === "FABRIK")!;
    expect(fabrik).toMatchObject({ name: "Fabrik", room: "LEO B 8.1", building: "LEO", area: "Z", category: "workspace", info_url: "" });
    expect(fabrik.shown_hours).toEqual(["Mon - Fri 08:00 - 18:00"]);
    expect(spaceState(fabrik, at(2, 12), 0).open).toBe(true);
    expect(spaceState(fabrik, at(2, 19), 0).open).toBe(false);
    expect(spaceState(fabrik, at(1, 12), 0).open).toBe(false); // Sunday
  });

  it("lists IPZ Hangar, outside every campus, in both ETH locations", () => {
    const ipz = spaces.filter((s) => s.id === "IPZH");
    expect(ipz.map((s) => s.area)).toEqual(["Z", "H"]);
    expect(ipz[1]).toMatchObject({ name: "IPZ Hangar", room: "ETH Hangar Innovationspark Zürich, Dübendorf", building: "IPZ", category: "workspace",
      open_text: "Open to projects", notice: "In Dübendorf, not on the map yet.", info_url: "https://www.innovationparkzurich.com/de/discover-stories/eth-hangar-2" });
    expect(ipz[0].shown_hours).toEqual(["Open 24/7 to projects"]);
    expect(spaceState(ipz[0], at(1, 3), 0).open).toBe(true);
  });

  it("leaves out the spaces outside Zentrum and Hönggerberg (CHOICES.md)", () => {
    expect(spaces.find((s) => s.building === "BSS")).toBeUndefined(); // Basel
    const raw = JSON.parse(readData("samples", "studyspaces_en.json")).data;
    expect(ownCampuses(raw).length).toBe(raw.length - 4);
    expect(elsewhereIds(raw)).toEqual(expect.arrayContaining(["BSSD65.3"]));
    expect(elsewhereIds(raw)).not.toContain("HGH30.1");
  });

  it("uses our own names and categories from data/overrides.json", () => {
    expect(byRoom("HG E 30.7")).toMatchObject({ name: "HG Lobby", category: "open" }); // ETH: "Catering", a mensa
    expect(byRoom("HG F 30.1")).toMatchObject({ name: "Rondell HG", category: "open" });
    expect(byRoom("MM B 79").category).toBe("mensa");
  });

  it("folds a space into another one (merge_into): one Clausiusbar with the seats of both rooms", () => {
    expect(spaces.find((s) => s.id === "CLAD1.1")).toBeUndefined();
    expect(byRoom("CLA D 5")).toMatchObject({ name: "Clausiusbar", seats: 156 + 80 });
  });

  it("keeps the name, seats, features, notice and a link to ETH's location page", () => {
    const hg = byRoom("HG H 30.1");
    expect(hg).toMatchObject({ id: "HGH30.1", name: "HG Library/Info-Center", category: "library", building: "HG", seats: 150 });
    expect(hg.info_url).toBe("https://ethz.ch/en/utils/location.html?building=HG&floor=H&room=30.1");
    expect(byRoom("CHN H 43").notice).toMatch(/^Official opening hours/);
    expect(byRoom("CAB F 31").features.map((f) => f.key)).toContain("um.ruhig");
    expect(byRoom("CHN D 8").seats).toBeNull(); // ETH says 0
  });
});

describe("opening hours", () => {
  it("reads every form ETH uses", () => {
    const h = parseHours([
      "Mon - Fri: 07.00 - 20.30",
      "Sat: 08.00 - 12.00",
      "Sun: Closed",
      "Meal times: Mon - Fri: 11.15 - 14.00 and 17.30 - 19.30",
      "24-hour access via ETH card",
      "Learning environment outside meal times",
    ]);
    expect(h.open[0]).toEqual([[420, 1230]]);
    expect(h.open[4]).toEqual([[420, 1230]]);
    expect(h.open[5]).toEqual([[480, 720]]);
    expect(h.open[6]).toEqual([]);
    expect(h.meals[2]).toEqual([[675, 840], [1050, 1170]]);
    expect(h.card24h).toBe(true);
    expect(h.unknown).toEqual([]);
  });

  it("parses the hours of every space in the sample", () => {
    expect(spaces.flatMap((s) => parseHours(s.hours).unknown)).toEqual([]);
  });

  it("collects lines it doesn't understand", () => {
    expect(parseHours(["During the semester only", "Mon - Fri: ab 7 Uhr"]).unknown).toEqual(["During the semester only", "Mon - Fri: ab 7 Uhr"]);
  });
});

describe("open or closed", () => {
  const state = (s: Space, ms: number, listAt = 0) => {
    const st = spaceState(s, ms, listAt);
    return { ...st, until: iso(st.until), opens_at: iso(st.opens_at) };
  };

  it("is open until closing time, and closed until the next opening", () => {
    const hg = byRoom("HG H 30.1");
    expect(state(hg, at(2, 10))).toMatchObject({ open: true, until: "2026-11-02T22:00+01:00" });
    expect(state(hg, at(1, 18))).toMatchObject({ open: false, opens_at: "2026-11-02T08:00+01:00" });
    expect(state(hg, at(2, 7))).toMatchObject({ open: false, opens_at: "2026-11-02T08:00+01:00" });
    expect(state(byRoom("CAB F 31"), at(7, 12))).toMatchObject({ open: false, opens_at: "2026-11-09T06:00+01:00" });
  });

  it("tells meal times apart from the mensa's study hours", () => {
    const mensa = byRoom("MM B 79");
    expect(state(mensa, at(2, 12))).toMatchObject({ open: true, meal: true, until: "2026-11-02T14:00+01:00" });
    expect(iso(spaceState(mensa, at(2, 12), 0).open_until)).toBe("2026-11-02T21:00+01:00"); // a study space after lunch
    expect(state(mensa, at(2, 15))).toMatchObject({ open: true, meal: false, until: "2026-11-02T21:00+01:00" });
    expect(state(mensa, at(2, 18))).toMatchObject({ open: true, meal: true, until: "2026-11-02T19:30+01:00" });
  });

  it("keeps 24-hour spaces open outside the regular hours, with an ETH card", () => {
    const glc = byRoom("GLC E 31");
    expect(state(glc, at(1, 3))).toMatchObject({ open: true, card_only: true, until: null });
    expect(state(glc, at(2, 10))).toMatchObject({ open: true, card_only: false, until: "2026-11-02T20:30+01:00" });
  });

  it("follows ETH when it says a space stays closed today (holidays, closures)", () => {
    const hg = { ...byRoom("HG H 30.1"), eth: { open: false, nextOpen: "2026-11-03" } };
    expect(state(hg, at(2, 10), at(2, 9))).toMatchObject({ open: false, opens_at: "2026-11-03T08:00+01:00" });
    expect(state(hg, at(3, 10), at(2, 9))).toMatchObject({ open: true }); // ETH's word was about the 2nd only
    expect(state(hg, at(2, 10), 0)).toMatchObject({ open: true }); // the bundled snapshot has no say
  });

  it("falls back to ETH's own state for hours it can't read", () => {
    const odd = { ...byRoom("HG H 30.1"), hours: ["By appointment"], eth: { open: true, nextOpen: null } };
    expect(spaceState(odd, at(2, 3), 0).open).toBe(true);
  });
});

describe("occupancy", () => {
  const readings = parseReadings(JSON.parse(readData("samples", "studyspaces_availability.json")).data);
  const measured = Date.parse("2026-11-01T15:40:20.469+01:00");

  it("reads the timestamped entries, including sensors that aren't in the list of spaces", () => {
    expect(readings["HGH30.1"]).toEqual({
      people: 98, capacity: 150, pct: 60, status: "yellow", trend: "steady", measured_at: measured, active: true,
    });
    expect(readings["MLH37.1"]).toBeDefined();
    expect(readings["BSSE12"]).toBeUndefined(); // status "unknown", no reading
  });

  it("shows readings up to 15 minutes old", () => {
    expect(estimate(readings["HGH30.1"], measured + 14 * 60_000)).toEqual({ pct: 60, status: "yellow", trend: "steady", measured_at: measured });
    expect(estimate(readings["HGH30.1"], measured + 16 * 60_000)).toBeNull();
    expect(estimate(readings["HCIG5.1"], measured)).toBeNull(); // stuck since 15 October, no count
  });

  it("derives the step like ETH's page when it's missing", () => {
    const r: Reading = { people: 130, capacity: 150, pct: null, status: "unknown", trend: null, measured_at: 0, active: true };
    expect(estimate(r, 0)).toMatchObject({ pct: 80, status: "red" });
  });

  it("colours by the percentage: green below 60 %, yellow at 60 %, red from 80 %", () => {
    const at = (pct: number, status = "green"): Reading => ({ people: 1, capacity: 100, pct, status, trend: null, measured_at: 0, active: true });
    expect([0, 40, 60, 80, 100].map((pct) => estimate(at(pct), 0)!.status)).toEqual(["green", "green", "yellow", "red", "red"]);
    expect(estimate(at(20, "red"), 0)!.status).toBe("green"); // ETH's own status doesn't decide
  });
});
