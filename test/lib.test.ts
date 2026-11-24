// The page's pure logic (static/lib.js, a plain browser script).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as social from "../worker/social";

const root = join(import.meta.dirname, "..");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lib = new Function(`${readFileSync(join(root, "static", "lib.js"), "utf8")}; return { sortPlaces, durationText, placeUrl, parsePlaceUrl, parseInvite, inviteTitle, cleanStars, isStarred, toggleStar, starsByArea, starredBuildingsIn, orderBuildingChips, searchPlaces, searchKey, tilesInView, roundToStep, wheelIndex, wheelGlide, calendarMonth, addMonthsTo, studyRoomGroups, keptTypes, equipmentText, hasScreen, barSegments, barNeedle, blocksTitle, reportLevel, reportedLevels, queueLevel, reportedQueues, microwaveName, QUEUE_NAMES, clientIdFrom, reportKey, cleanMyReports, noteMyReport, myReportOf, sliderStart, CLIENT_ID_RE, MY_REPORT_MS, slotOfTime, fullText, eatStatus, placeInitials, microwaveGroups, compareOrder, compareDefault, rankDishes, presetOf, yourMeal, cleanMealPref, presetMatching, mealPrefName, mealPrefText, dishPasses, cardMealOf, nutritionText, dishDesc, matchLevel, placeLabelOrder, microwaveSpots, besideBoxes, MICRO_SPOT_SCALE, MEAL_SORTS, MEAL_SORT_DIRS, sortDir, searchIntents, MEAL_FILTERS, BAR_FROM, BAR_TO, REPORT_LEVELS, WHEEL_STEP_PX, WHEEL_FRICTION, WHEEL_MIN_VELOCITY, WHEEL_MAX_MS, colourContrast, readableBubble, bubbleContrast, bubbleLook, bubbleStyleLevel, BUBBLE_STYLE_LEVELS, BUBBLE_METALS, randomBubble, bubbleBackgrounds, BUBBLE_RANDOM_BACKGROUNDS, BUBBLE_NAVY, hsvToHex, hexToHsv, BUBBLE_TEXTS, MIN_BUBBLE_CONTRAST, usernameProblem, USERNAME_PATTERN, mergeStars, sameStars, sortFriends, friendMatches, foldText, addParam, untilAt, untilClamp, actionSpans, untilHours, checkinWhen, runningCheckin, roomBuilding, clockOf, CHECKIN_MAX_MS, sortFriendCheckins, stackBubbles, levelProgress, nextUnlockText, credWhen, credToastText, parseTourParam, cleanTour, tourMarkDone, tourPlan, tourChapterSpan, tourFirstMensa, TOUR_CHAPTER_CONTEXT, tourStatKey, tourOfferShown, TOUR_STORE, TOUR_JOURNEY_IDS, TOUR_CHAPTER_IDS, TOUR_SKIP, STATS_KEYS };`)() as Record<string, any>;

describe("lib.js", () => {
  it("loads as a plain script", () => {
    expect(lib).toBeTypeOf("object");
  });
});

describe("sortPlaces", () => {
  const items = [
    { id: "a", building: "HG" },
    { id: "b", building: "CAB" },
    { room: "ML E 12", building: "ML" },
    { id: "c", building: "HG" },
    { id: "d", building: "XX" },
  ];
  const ids = (xs: { id?: string; room?: string }[]) => xs.map((x) => x.id ?? x.room);

  it("keeps the server's order without stars or position", () => {
    expect(ids(lib.sortPlaces(items))).toEqual(["a", "b", "ML E 12", "c", "d"]);
  });

  it("puts starred places first, rooms by their path", () => {
    expect(ids(lib.sortPlaces(items, { stars: new Set(["c", "ML E 12"]) }))).toEqual(["ML E 12", "c", "a", "b", "d"]);
  });

  it("sorts by the building's distance when known, stably, unknown buildings last", () => {
    const distances = new Map([["HG", 300], ["CAB", 50], ["ML", 300]]);
    expect(ids(lib.sortPlaces(items, { distances }))).toEqual(["b", "a", "ML E 12", "c", "d"]);
    expect(ids(lib.sortPlaces(items, { distances, stars: new Set(["d"]) }))).toEqual(["d", "b", "a", "ML E 12", "c"]);
  });

  it("puts places in a starred building after starred places and before the rest", () => {
    const starredBuildings = new Set(["HG"]);
    expect(ids(lib.sortPlaces(items, { starredBuildings }))).toEqual(["a", "c", "b", "ML E 12", "d"]);
    expect(ids(lib.sortPlaces(items, { starredBuildings, stars: new Set(["d"]) }))).toEqual(["d", "a", "c", "b", "ML E 12"]);
    const distances = new Map([["HG", 300], ["CAB", 50], ["ML", 10]]);
    expect(ids(lib.sortPlaces(items, { starredBuildings, distances }))).toEqual(["a", "c", "ML E 12", "b", "d"]);
  });

  it("follows the location's mensa order without a position: open first is the caller's, the rest after by name", () => {
    const mensas = [
      { id: "F5", name: "Dozentenfoyer", building: "HG" },
      { id: "X1", name: "Zeta", building: "HG" },
      { id: "UM1", name: "Obere Mensa", building: "MEN" },
      { id: "X2", name: "Alpha", building: "CAB" },
      { id: "MMB79", name: "Mensa Polyterrasse", building: "MM" },
    ];
    const order = ["MMB79", "UM1", "F5"];
    expect(ids(lib.sortPlaces(mensas, { order }))).toEqual(["MMB79", "UM1", "F5", "X2", "X1"]);
    // Stars still go first; a position wins over the order.
    expect(ids(lib.sortPlaces(mensas, { order, stars: new Set(["F5"]) }))).toEqual(["F5", "MMB79", "UM1", "X2", "X1"]);
    const distances = new Map([["HG", 100], ["MM", 300], ["MEN", 500], ["CAB", 50]]);
    expect(ids(lib.sortPlaces(mensas, { order, distances }))).toEqual(["X2", "F5", "X1", "MMB79", "UM1"]);
    // Open first, closed after in the same order (renderEat sorts the two halves apart).
    const open = new Set(["UM1", "X1"]);
    const sorted = (list: typeof mensas) => lib.sortPlaces(list, { order });
    const openFirst = [...sorted(mensas.filter((m) => open.has(m.id))), ...sorted(mensas.filter((m) => !open.has(m.id)))];
    expect(ids(openFirst)).toEqual(["UM1", "X1", "MMB79", "F5", "X2"]);
    expect(ids(lib.sortPlaces(mensas, { order: [] }))).toEqual(ids(mensas));
  });

  it("doesn't change its input", () => {
    const copy = [...items];
    lib.sortPlaces(items, { stars: new Set(["d"]) });
    expect(items).toEqual(copy);
  });
});

describe("durationText", () => {
  it("reads like the filter chips", () => {
    expect([30, 60, 90, 120, 180].map(lib.durationText)).toEqual(["30 min", "1 h", "1 h 30 min", "2 h", "3 h"]);
  });
});

describe("place URLs", () => {
  it("round-trip rooms, spaces and buildings", () => {
    const places = [
      { kind: "room", id: "HG E 33.1", area: "Z" },
      { kind: "room", id: "KOL-F-101", area: "UZ" },
      { kind: "space", id: "MMB79", area: "Z" },
      { kind: "building", id: "HG", area: "Z" },
    ];
    expect(lib.placeUrl(places[0])).toBe("/?room=HG+E+33.1&area=Z");
    for (const p of places) expect(lib.parsePlaceUrl(lib.placeUrl(p).slice(1))).toEqual(p);
  });

  it("reads the forms people type, and nothing else", () => {
    expect(lib.parsePlaceUrl("?room=HG%20E%2033.1")).toEqual({ kind: "room", id: "HG E 33.1", area: null });
    expect(lib.parsePlaceUrl("?building=hg&area=Z")).toEqual({ kind: "building", id: "HG", area: "Z" });
    expect(lib.parsePlaceUrl("?buildings=HG,CAB")).toBeNull();
    expect(lib.parsePlaceUrl("")).toBeNull();
    expect(lib.parsePlaceUrl("?room=")).toBeNull();
  });
});

describe("invites", () => {
  // The same sentences as the Worker's titles (test/worker.test.ts, "invite links").
  const title = (search: string, place: object | null, today = "2026-10-29") => lib.inviteTitle(lib.parseInvite(search), place, today);
  const poly = { name: "Mensa Polyterrasse", category: "mensa", kind: "mensa" };

  it("reads the link", () => {
    expect(lib.parseInvite("room=HG+E+1.1&bg=2&b=HG&area=Z")).toMatchObject({ kind: "room", id: "HG E 1.1", area: "Z", at: null });
    expect(lib.parseInvite("space=MMB79&meal=lunch&t=1215&at=2026-11-05T12:15")).toMatchObject({ kind: "space", id: "MMB79", meal: "lunch", t: "1215", at: "2026-11-05T12:15" });
    expect(lib.parseInvite("space=F2&meal=brunch&at=tomorrow")).toMatchObject({ meal: null, at: null });
    expect(lib.parseInvite("bg=1")).toBeNull();
  });

  it("says what the Worker's title says", () => {
    expect(title("room=HG+E+1.1&bg=2", null)).toBe("I'm in HG E 1.1, come join me!");
    expect(title("space=MMB79&bg=1&mode=mensa", poly)).toBe("Join me at Mensa Polyterrasse!");
    expect(title("space=HGH30.1&bg=1", { name: "HG Library/Info-Center", category: "library", kind: null })).toBe("I'm at HG Library/Info-Center, come join me!");
    expect(title("space=MMB79&meal=lunch&t=1215&bg=1", poly)).toBe("Lunch at Mensa Polyterrasse at 12:15?");
    expect(title("space=F14&meal=dinner&t=now&bg=1", { name: "Alumni quattro", category: "mensa", kind: "mensa" })).toBe("Dinner at Alumni quattro now?");
    expect(title("space=MMB79&meal=lunch&t=1207&bg=1", poly)).toBe("Lunch at Mensa Polyterrasse today?");
    expect(title("space=MMB79&meal=lunch&t=1215&bg=1&at=2026-11-05T12:15", poly, "2026-11-04")).toBe("Lunch at Mensa Polyterrasse tomorrow at 12:15?");
    expect(title("space=MMB79&meal=lunch&t=1215&bg=1&at=2026-11-06T12:15", poly, "2026-11-04")).toBe("Lunch at Mensa Polyterrasse on Friday at 12:15?");
    expect(title("space=MMB79&meal=lunch&bg=1&at=2026-11-05T11:15", poly, "2026-11-04")).toBe("Lunch at Mensa Polyterrasse tomorrow?");
    expect(title("space=F2&meal=lunch&t=1215&bg=1", { name: "CafeBar", category: "mensa", kind: "cafe" })).toBe("Join me at CafeBar!");
  });
});

describe("stars", () => {
  const room = { kind: "room", id: "HG E 33.1", area: "Z", name: "HG E 33.1", building: "HG", typecode: "3420" };
  const lib1 = { kind: "space", id: "HGH30.1", area: "Z", name: "HG Library", building: "HG" };
  const kol = { kind: "room", id: "KOL-F-101", area: "UZ", name: "KOL-F-101", building: "KOL" };

  it("star and unstar, newest first", () => {
    let { stars, starred } = lib.toggleStar([], room);
    expect(starred).toBe(true);
    ({ stars } = lib.toggleStar(stars, lib1));
    expect(stars.map((s: { id: string }) => s.id)).toEqual(["HGH30.1", "HG E 33.1"]);
    expect(lib.isStarred(stars, { kind: "room", id: "HG E 33.1", area: "Z" })).toBe(true);
    expect(lib.isStarred(stars, { kind: "room", id: "HG E 33.1", area: "H" })).toBe(false);
    const off = lib.toggleStar(stars, room);
    expect(off.starred).toBe(false);
    expect(off.stars.map((s: { id: string }) => s.id)).toEqual(["HGH30.1"]);
  });

  it("keeps at most 40 and says so", () => {
    let stars: object[] = [];
    for (let i = 0; i < 40; i++) stars = lib.toggleStar(stars, { ...room, id: `HG E ${i}` }).stars;
    expect(stars.length).toBe(40);
    const r = lib.toggleStar(stars, room);
    expect(r).toMatchObject({ starred: false, full: true });
    expect(r.stars.length).toBe(40);
    expect(lib.toggleStar(stars, { ...room, id: "HG E 0" }).stars.length).toBe(39); // unstarring still works
  });

  it("groups by area in the order starred", () => {
    const stars = [kol, room, lib1];
    expect([...lib.starsByArea(stars)].map(([a, l]: [string, { id: string }[]]) => [a, l.map((s) => s.id)])).toEqual([
      ["UZ", ["KOL-F-101"]],
      ["Z", ["HG E 33.1", "HGH30.1"]],
    ]);
  });

  it("reads stored stars defensively", () => {
    expect(lib.cleanStars(null)).toEqual([]);
    expect(lib.cleanStars([room, { kind: "floor", id: "HG E", area: "Z" }, { kind: "room" }, room, { ...lib1, extra: 1 }]))
      .toEqual([room, lib1]);
  });

  it("stars buildings too, within the same limit of 40", () => {
    const hg = { kind: "building", id: "HG", area: "Z", name: "Hauptgebäude" };
    expect(lib.cleanStars([hg, { kind: "building", id: "CAB", area: "Z" }])).toEqual([
      { kind: "building", id: "HG", area: "Z", name: "Hauptgebäude", building: "HG" },
      { kind: "building", id: "CAB", area: "Z", name: "CAB", building: "CAB" },
    ]);
    let stars: object[] = [];
    for (let i = 0; i < 39; i++) stars = lib.toggleStar(stars, { ...room, id: `HG E ${i}` }).stars;
    stars = lib.toggleStar(stars, hg).stars;
    expect(stars.length).toBe(40);
    expect(lib.isStarred(stars, { kind: "building", id: "HG", area: "Z" })).toBe(true);
    expect(lib.toggleStar(stars, { ...hg, id: "CAB" })).toMatchObject({ starred: false, full: true });
  });

  it("knows the starred buildings of the given areas", () => {
    const stars = lib.cleanStars([room, { kind: "building", id: "HG", area: "Z" }, { kind: "building", id: "KOL", area: "UZ" }, { kind: "building", id: "HIL", area: "H" }]);
    expect([...lib.starredBuildingsIn(stars, ["Z"])]).toEqual(["HG"]);
    expect([...lib.starredBuildingsIn(stars, ["UZ", "Z"])]).toEqual(["HG", "KOL"]);
  });

  it("orders the building chips starred first, then alphabetically", () => {
    const chips = lib.orderBuildingChips(new Map([["ML", 4], ["CAB", 2], ["HG", 9], ["CHN", 1]]), new Set(["ML", "CHN"]));
    expect(chips.map((c: { code: string }) => c.code)).toEqual(["CHN", "ML", "CAB", "HG"]);
    expect(chips[0]).toEqual({ code: "CHN", count: 1, starred: true });
    expect(lib.orderBuildingChips([["B", 1], ["A", 2]], null).map((c: { code: string }) => c.code)).toEqual(["A", "B"]);
  });
});

describe("search", () => {
  const index = {
    rooms: [["HG E 33.1", "Z", "3420", 40], ["HG E 33.15", "Z", "3420", 10], ["HG E 3", "Z", "3430", 300], ["HIL E 33", "H", "3420", 20], ["KOL-F-101", "UZ", "3430", 200]],
    spaces: [["MMB79", "Z", "Mensa Polyterrasse", "MM B 79", "mensa"], ["CHND8", "Z", "Grüner Boden", "CHN D 8", "open"], ["HGH30.1", "Z", "HG Library/Info-Center", "HG H 30.1", "library"], ["F14", "H", "Alumni quattro", "HIL D", "mensa"]],
    buildings: [["HG", "Z"], ["HIL", "H"], ["KOL", "UZ"]],
    microwaves: [["MW-MM-1", "Z", "Einstein microwaves", "MM"]],
  };
  const ids = (q: string, opts = {}) => lib.searchPlaces(index, q, { area: "Z", ...opts }).map((r: { id: string }) => r.id);

  it("finds workspaces once, in the current location, and microwave spots", () => {
    const both = { ...index, spaces: [...index.spaces, ["IPZH", "Z", "IPZ Hangar", "Dübendorf", "workspace"], ["IPZH", "H", "IPZ Hangar", "Dübendorf", "workspace"]] };
    const found = lib.searchPlaces(both, "hangar", { area: "H" });
    expect(found).toEqual([expect.objectContaining({ kind: "space", id: "IPZH", area: "H", group: "Workspaces" })]);
    expect(lib.searchPlaces(index, "einstein", { area: "Z" })).toEqual([expect.objectContaining({ kind: "microwave", id: "MW-MM-1", group: "Microwaves" })]);
    expect(lib.parsePlaceUrl("?microwave=MW-MM-1&area=Z")).toEqual({ kind: "microwave", id: "MW-MM-1", area: "Z" });
  });

  it("finds IPZ Hangar and Fabrik by innovation", () => {
    const spaces = [...index.spaces, ["IPZH", "Z", "IPZ Hangar", "ETH Hangar Innovationspark Zürich, Dübendorf", "workspace"],
      ["IPZH", "H", "IPZ Hangar", "ETH Hangar Innovationspark Zürich, Dübendorf", "workspace"], ["FABRIK", "Z", "Fabrik", "LEO B 8.1", "workspace"]];
    for (const q of ["inno", "Innovation", "innov", "inovation", "innovationspark", "Innovation Park"]) {
      const found = lib.searchPlaces({ ...index, spaces }, q, { area: "Z" }).map((r: { id: string }) => r.id);
      expect(found.sort(), q).toEqual(q.toLowerCase().includes("park") ? ["IPZH"] : ["FABRIK", "IPZH"]);
    }
  });

  it("ignores case, spaces, dots and hyphens", () => {
    for (const q of ["hge33", "HG E 33.1", "hg e33.1"]) expect(ids(q)).toContain("HG E 33.1");
    expect(ids("HG E 33.1")[0]).toBe("HG E 33.1"); // the exact code first
    expect(ids("kol f 101")).toEqual(["KOL-F-101"]);
  });

  it("finds names by the start of a word, with or without umlauts", () => {
    expect(ids("poly")).toEqual(["MMB79"]);
    expect(ids("mensa poly")).toEqual(["MMB79"]);
    expect(ids("grün")).toEqual(["CHND8"]);
    expect(ids("grun")).toEqual(["CHND8"]);
    expect(ids("lyterrasse")).toEqual([]); // not inside a word
    expect(ids("info")).toEqual(["HGH30.1"]);
  });

  it("groups buildings, rooms, study spaces and mensas, the current area first, then stars", () => {
    const res = lib.searchPlaces(index, "h", { area: "H" });
    expect(res.map((r: { group: string }) => r.group)).toEqual(["Buildings", "Buildings", "Rooms", "Rooms", "Rooms", "Rooms", "Study spaces", "Mensas & cafeterias"]);
    expect(res[0].id).toBe("HIL"); // on Hönggerberg
    expect(ids("hge33")).toEqual(["HG E 33.1", "HG E 33.15"]);
    expect(ids("hge33", { stars: [{ kind: "room", id: "HG E 33.15", area: "Z" }] })).toEqual(["HG E 33.15", "HG E 33.1"]);
    expect(lib.searchPlaces(index, "  ")).toEqual([]);
  });

  it("keeps at most 30", () => {
    const big = { rooms: Array.from({ length: 50 }, (_, i) => [`HG F ${i}`, "Z", "3420", 10]), spaces: [], buildings: [] };
    expect(lib.searchPlaces(big, "hgf").length).toBe(30);
  });
});

describe("tilesInView", () => {
  const index = () => ({ bounds: [-1000, -1000, 1000, 1000], tile: 500, tiles: ["0_0", "1_0", "2_1", "3_3"] });

  it("lists the existing tiles under a box", () => {
    expect(lib.tilesInView(index(), [-900, -900, -100, -600])).toEqual(["0_0", "1_0"]);
    expect(lib.tilesInView(index(), [0, -400, 100, -300])).toEqual(["2_1"]);
  });

  it("widens the box by the margin", () => {
    expect(lib.tilesInView(index(), [-900, -900, -800, -800])).toEqual(["0_0"]);
    expect(lib.tilesInView(index(), [-900, -900, -800, -800], 400)).toEqual(["0_0", "1_0"]);
  });

  it("stays inside the region", () => {
    expect(lib.tilesInView(index(), [-5000, -5000, 5000, 5000])).toEqual(["0_0", "1_0", "2_1", "3_3"]);
    expect(lib.tilesInView(index(), [2000, 2000, 3000, 3000])).toEqual([]);
  });
});

describe("time wheel", () => {
  it("rounds a time down to the 5-minute step", () => {
    expect(["10:17", "10:15", "10:19", "00:04", "23:59"].map((t) => lib.roundToStep(t))).toEqual(["10:15", "10:15", "10:15", "00:00", "23:55"]);
    expect(lib.roundToStep("10:44", 15)).toBe("10:30");
  });

  it("reads the value in the window from the drum's offset, wrapping both ways", () => {
    const step = lib.WHEEL_STEP_PX;
    expect(lib.wheelIndex(0, step, 24)).toBe(0);
    expect(lib.wheelIndex(10 * step, step, 24)).toBe(10);
    expect(lib.wheelIndex(10 * step + step * 0.4, step, 24)).toBe(10); // nearest
    expect(lib.wheelIndex(10 * step + step * 0.6, step, 24)).toBe(11);
    expect(lib.wheelIndex(24 * step, step, 24)).toBe(0); // 23 -> 00
    expect(lib.wheelIndex(-step, step, 24)).toBe(23); // 00 -> 23
    expect(lib.wheelIndex(-13 * step, step, 12)).toBe(11); // 55 -> 00 on the minutes drum (12 values)
  });

  it("glides further with the square of the release velocity, and not at all when slow", () => {
    const slow = lib.wheelGlide(1);
    const fast = lib.wheelGlide(2);
    expect(fast.distance / slow.distance).toBeCloseTo(4);
    expect(fast.duration / slow.duration).toBeCloseTo(2);
    expect(slow.distance).toBeCloseTo(1 / (2 * lib.WHEEL_FRICTION));
    expect(lib.wheelGlide(-2).distance).toBeCloseTo(-fast.distance); // direction kept
    expect(lib.wheelGlide(lib.WHEEL_MIN_VELOCITY / 2)).toEqual({ distance: 0, duration: 0 });
    expect(lib.wheelGlide(0)).toEqual({ distance: 0, duration: 0 });
  });

  it("moves a hard flick by hours and a drag of half a screen by about twelve", () => {
    // Release at 2.5 px/ms (a hard flick): many steps on the hours drum.
    const hard = lib.wheelGlide(2.5);
    expect(hard.distance / lib.WHEEL_STEP_PX).toBeGreaterThan(20);
    expect(hard.duration).toBeLessThanOrEqual(lib.WHEEL_MAX_MS);
    // The glide never lasts longer than WHEEL_MAX_MS, however wild the flick.
    expect(lib.wheelGlide(50).duration).toBe(lib.WHEEL_MAX_MS);
    // A 420 px drag (half a phone screen) moves the drum by about 12 values, 1:1 with the finger.
    expect(Math.round(420 / lib.WHEEL_STEP_PX)).toBe(12);
  });
});

describe("calendar", () => {
  it("lays a month out Monday first, with blanks around it", () => {
    const nov = lib.calendarMonth("2026-11"); // 1 November 2026 is a Sunday
    expect(nov.title).toBe("November 2026");
    expect(nov.weeks.length).toBe(6);
    expect(nov.weeks[0]).toEqual([null, null, null, null, null, null, "2026-11-01"]);
    expect(nov.weeks[5]).toEqual(["2026-11-30", null, null, null, null, null, null]);
    const feb = lib.calendarMonth("2027-02"); // starts on a Monday, 28 days: exactly four rows
    expect(feb.weeks.length).toBe(4);
    expect(feb.weeks[0][0]).toBe("2027-02-01");
    expect(feb.weeks[3][6]).toBe("2027-02-28");
  });

  it("steps months across the year", () => {
    expect(lib.addMonthsTo("2026-11", 1)).toBe("2026-12");
    expect(lib.addMonthsTo("2026-12", 1)).toBe("2027-01");
    expect(lib.addMonthsTo("2027-01", -1)).toBe("2026-12");
  });
});

describe("Study's rooms and Meet's types", () => {
  const rooms = [
    { room: "HG E 1", building: "HG", typecode: "3650", status: "free", minutes: null },
    { room: "HG E 2", building: "HG", typecode: "3420", status: "free", minutes: 90 },
    { room: "CAB G 1", building: "CAB", typecode: "3420", status: "free", minutes: 60 },
    { room: "CAB G 2", building: "CAB", typecode: "3420", status: "free", minutes: 45 },
    { room: "ML F 1", building: "ML", typecode: "3430", status: "busy", minutes: 10 },
    { room: "ML F 2", building: "ML", typecode: "3430", status: "pending", minutes: null },
    { room: "ML E 9", building: "ML", typecode: "2110", status: "free", minutes: null },
  ];
  const names = (gs: { typecode: string; rooms: { room: string }[] }[]) => gs.map((g) => [g.typecode, g.rooms.map((r) => r.room)]);

  it("groups the rooms free long enough by type, in the types' order", () => {
    expect(names(lib.studyRoomGroups(rooms, ["3650", "3420", "3430"], 60))).toEqual([
      ["3650", ["HG E 1"]],
      ["3420", ["HG E 2", "CAB G 1"]],
      ["3430", []],
    ]);
  });

  it("filters them to the picked buildings, and copes with no rooms", () => {
    expect(names(lib.studyRoomGroups(rooms, ["3420"], 60, new Set(["CAB"])))).toEqual([["3420", ["CAB G 1"]]]);
    expect(names(lib.studyRoomGroups(null, ["3420"], 60))).toEqual([["3420", []]]);
  });

  it("keeps the offered types of a stored choice, else the defaults", () => {
    const known = new Set(["2110", "3420", "3430"]);
    expect(lib.keptTypes(["3420", "3430", "3650"], known)).toEqual(["3420", "3430"]);
    expect(lib.keptTypes(["3650"], known)).toBeNull(); // computer rooms only: the defaults
    expect(lib.keptTypes([], known)).toEqual([]); // nothing on purpose: every type
    expect(lib.keptTypes(undefined, known)).toBeNull();
  });

  it("names a room's equipment, and nothing when it's unknown", () => {
    expect(lib.equipmentText({ screen: true, projector: false, hdmi: true, wireless: false, blackboard: false, whiteboard: true, flipchart: false }))
      .toBe("Equipment: screen, HDMI, whiteboard");
    expect(lib.equipmentText(null)).toBeNull();
    expect(lib.equipmentText({ screen: false })).toBeNull();
    expect(lib.hasScreen({ projector: true })).toBe(true);
    expect(lib.hasScreen({ screen: false, projector: false })).toBe(false);
    expect(lib.hasScreen(null)).toBeNull();
  });
});

describe("the schedule bar", () => {
  it("shows 07:00 to 22:00", () => {
    expect([lib.BAR_FROM, lib.BAR_TO]).toEqual([420, 1320]);
  });

  it("cuts the blocks to the shown hours and draws closures after bookings", () => {
    const blocks = [[360, 480, "c"], [495, 600, "b"], [1200, 1440, "c"], [0, 300, "b"]];
    const segs = lib.barSegments(blocks).map((s: { left: number; width: number; kind: string }) => [Math.round(s.left * 10) / 10, Math.round(s.width * 10) / 10, s.kind]);
    // 495 is 75 min into the 900 min bar (8.3 %), the morning closure 60 min of it (6.7 %), the evening one 120 min.
    expect(segs).toEqual([[8.3, 11.7, "b"], [0, 6.7, "c"], [86.7, 13.3, "c"]]);
    expect(lib.barSegments(null)).toEqual([]);
  });

  it("puts the needle at the chosen time, and nowhere outside the shown hours", () => {
    expect(lib.barNeedle("07:00")).toBe(0);
    expect(lib.barNeedle("22:00")).toBe(100);
    expect(lib.barNeedle("14:30")).toBeCloseTo(50);
    expect(lib.barNeedle("06:59")).toBeNull();
    expect(lib.barNeedle("23:00")).toBeNull();
  });

  it("lists the blocks for the tooltip, in order", () => {
    expect(lib.blocksTitle([[1200, 1440, "c"], [495, 600, "b"]])).toBe("08:15–10:00 booked, 20:00–24:00 closed");
    expect(lib.blocksTitle([])).toBe("Free all day");
  });
});

describe("reports", () => {
  it("takes the level with the most reports, ties to the fuller one", () => {
    expect(lib.reportLevel({ levels: [3, 1, 0], pct: null, n_pct: 0 })).toBe(0);
    expect(lib.reportLevel({ levels: [1, 2, 2], pct: null, n_pct: 0 })).toBe(2);
    expect(lib.reportLevel({ levels: [0, 0, 1], pct: 10, n_pct: 4 })).toBe(2); // levels win over percentages
  });

  it("reads a level off the percentages when no level was reported: crowded from 60, full from 80", () => {
    expect(lib.reportLevel({ levels: [0, 0, 0], pct: 59, n_pct: 2 })).toBe(0);
    expect(lib.reportLevel({ levels: [0, 0, 0], pct: 60, n_pct: 2 })).toBe(1);
    expect(lib.reportLevel({ levels: [0, 0, 0], pct: 80, n_pct: 1 })).toBe(2);
    expect(lib.reportLevel({ levels: [0, 0, 0], pct: null, n_pct: 0 })).toBeNull();
    expect(lib.reportLevel(null)).toBeNull();
  });

  it("lists the reported levels fullest first, leaving out those without any", () => {
    expect(lib.reportedLevels({ levels: [2, 0, 5] })).toEqual([{ level: 2, count: 5 }, { level: 0, count: 2 }]);
    expect(lib.reportedLevels(null)).toEqual([]);
    expect(lib.REPORT_LEVELS).toEqual(["free", "crowded", "full"]);
  });
});

describe("your own reports", () => {
  const now = Date.parse("2026-11-14T13:00:00Z");
  const min = 60_000;

  it("makes a client id of 32 hex digits from 16 bytes", () => {
    const id = lib.clientIdFrom(new Uint8Array([0, 1, 15, 16, 255, 128, 7, 8, 9, 10, 11, 12, 13, 14, 200, 99]));
    expect(id).toBe("00010f10ff800708090a0b0c0d0ec863");
    expect(lib.CLIENT_ID_RE.test(id)).toBe(true);
    expect(lib.CLIENT_ID_RE.test("abc")).toBe(false);
  });

  it("keys a place by kind, area and id", () => {
    expect(lib.reportKey({ kind: "room", area: "Z", id: "HG E 33.1" })).toBe("room|Z|HG E 33.1");
  });

  it("keeps the past 2 hours' well-formed reports, the newest per place and kind first", () => {
    const list = [
      { place: "room|Z|HG E 33.1", kind: "level", at: now - 30 * min, value: 1 },
      { place: "room|Z|HG E 33.1", kind: "level", at: now - 10 * min, value: 2, extra: "x" },
      { place: "space|Z|HGH30.1", kind: "pct", at: now - 130 * min, value: 70 }, // too old
      { place: "space|Z|HGH30.1", kind: "rating", at: now - 5 * min, value: -2 },
      { place: "space|Z|HGH30.1", kind: "nonsense", at: now, value: 1 },
      { place: 3, kind: "level", at: now, value: 1 },
      null,
    ];
    expect(lib.cleanMyReports(list, now)).toEqual([
      { place: "space|Z|HGH30.1", kind: "rating", at: now - 5 * min, value: -2 },
      { place: "room|Z|HG E 33.1", kind: "level", at: now - 10 * min, value: 2 },
    ]);
    expect(lib.cleanMyReports("junk", now)).toEqual([]);
    expect(lib.cleanMyReports(undefined, now)).toEqual([]);
  });

  it("replaces your earlier report of the same place and kind, and finds it for 2 hours", () => {
    let list = lib.noteMyReport([], { place: "room|Z|HG E 33.1", kind: "level", at: now - 20 * min, value: 2 }, now);
    list = lib.noteMyReport(list, { place: "room|Z|HG E 33.1", kind: "level", at: now, value: 1 }, now);
    expect(list).toHaveLength(1);
    expect(lib.myReportOf(list, "room|Z|HG E 33.1", "level", now)).toEqual({ place: "room|Z|HG E 33.1", kind: "level", at: now, value: 1 });
    expect(lib.myReportOf(list, "room|Z|HG E 33.1", "pct", now)).toBeNull();
    expect(lib.myReportOf(list, "room|Z|HG E 33.1", "level", now + lib.MY_REPORT_MS)).toBeNull();
  });

  it("starts the slider at the estimate in 5 % steps, and writes ratings with a sign", () => {
    expect([0, 62, 63, 100, 120, null].map(lib.sliderStart)).toEqual([0, 60, 65, 100, 100, 50]);
  });
});

describe("usually this full", () => {
  it("finds the quarter hour of a time", () => {
    expect(lib.slotOfTime("00:00")).toBe(0);
    expect(lib.slotOfTime("10:17")).toBe(41);
    expect(lib.slotOfTime("23:59")).toBe(95);
  });

  it("words a percentage as the estimate does", () => {
    expect([0, 55, 100].map(lib.fullText)).toEqual(["almost empty", "about 55 % full", "full"]);
  });
});

describe("the Eat tab", () => {
  const at = "2026-11-13T12:30+01:00";
  const mensa = {
    category: "mensa", kind: "mensa", study: true, open: true, meal: true, until: "2026-11-13T14:00+01:00",
    meals_today: [{ meal: "lunch", from: "11:15", to: "14:00" }, { meal: "dinner", from: "17:30", to: "19:30" }],
    meals_next: { date: "2026-11-14", meals: [{ meal: "lunch", from: "11:15", to: "14:00" }] },
  };
  const texts = (s: object, when = at) => lib.eatStatus(s, when).map((l: { text: string; cls: string }) => `${l.text}|${l.cls}`);

  it("words a mensa's status by its meals", () => {
    expect(texts(mensa)).toEqual(["Lunch until 14:00|food"]);
    expect(texts({ ...mensa, meal: false, until: "2026-11-13T21:00+01:00" }, "2026-11-13T15:00+01:00")).toEqual(["Dinner at 17:30|plain", "Study space now, until 17:30|study"]);
    expect(texts({ ...mensa, open: false, meal: false }, "2026-11-13T09:00+01:00")).toEqual(["Lunch at 11:15|plain"]);
    expect(texts({ ...mensa, meal: false, until: "2026-11-13T21:00+01:00" }, "2026-11-13T20:00+01:00")).toEqual(["Open until 21:00|plain", "Study space now, until 21:00|study"]);
    expect(texts({ ...mensa, open: false, meal: false, until: null }, "2026-11-13T22:00+01:00")).toEqual(["Lunch tomorrow at 11:15|closed"]);
    expect(texts({ ...mensa, open: false, meal: false, meals_today: [], meals_next: { date: "2026-11-16", meals: [{ meal: "lunch", from: "11:00", to: "14:00" }] } }, "2026-11-14T12:00+01:00")).toEqual(["Lunch on Mon at 11:00|closed"]);
    expect(texts({ ...mensa, open: false, meal: false, meals_today: [], meals_next: null })).toEqual(["Closed today|closed"]);
    expect(texts({ ...mensa, study: false, meal: false, until: "2026-11-13T21:00+01:00" }, "2026-11-13T15:00+01:00")).toEqual(["Dinner at 17:30|plain"]);
  });

  it("keeps a cafeteria's open and closed words", () => {
    expect(texts({ category: "mensa", kind: "cafe", open: true, until: "2026-11-13T18:30+01:00" })).toEqual(["Open until 18:30|cafe"]);
    expect(texts({ category: "mensa", kind: "cafe", open: false, opens_at: "2026-11-16T07:30+01:00" })).toEqual(["Closed · opens Mon 07:30|closed"]);
    expect(texts({ category: "mensa", kind: null, open: false, opens_at: null })).toEqual(["Closed|closed"]);
  });

  it("makes initials for the photo tile", () => {
    expect(lib.placeInitials("Mensa Polyterrasse")).toBe("P");
    expect(lib.placeInitials("Obere Mensa")).toBe("OM");
    expect(lib.placeInitials("food&lab")).toBe("FL");
    expect(lib.placeInitials("Rice Up!")).toBe("RU");
    expect(lib.placeInitials("Zwei Grad Bistro")).toBe("ZG");
    expect(lib.placeInitials("")).toBe("?");
  });

  it("groups the microwaves by building, nearest first when the position is known", () => {
    const list = [
      { id: "MW-MM-1", building: "MM", name: "Einstein", count: 3 }, { id: "MW-MM-2", building: "MM", name: "Zweistein", count: 3 },
      { id: "MW-CHN-1", building: "CHN", name: "Zwei Grad Bistro", count: 3 }, { id: "MW-CAB-1", building: "CAB", name: "VSETH", count: 5 },
    ];
    expect(lib.microwaveGroups(list).map((g: { building: string; count: number }) => [g.building, g.count])).toEqual([["MM", 6], ["CHN", 3], ["CAB", 5]]);
    const near = lib.microwaveGroups(list, new Map([["CAB", 40], ["MM", 300]]));
    expect(near.map((g: { building: string }) => g.building)).toEqual(["CAB", "MM", "CHN"]);
    expect(near[1].items.map((m: { name: string }) => m.name)).toEqual(["Einstein", "Zweistein"]);
    expect(lib.microwaveGroups([])).toEqual([]);
  });
});

describe("compareOrder", () => {
  const mensas = [
    { id: "u", name: "Untere Mensa", building: "KOL" },
    { id: "a", name: "Archimedes", building: "CLA" },
    { id: "p", name: "Mensa Polyterrasse", building: "MM" },
    { id: "o", name: "Obere Mensa", building: "KOL" },
    { id: "t", name: "Tannenbar", building: "CAB" },
  ];
  const order = ["p", "o", "u"];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

  it("follows the location's order, then the rest alphabetically", () => {
    expect(ids(lib.compareOrder(mensas, { order }))).toEqual(["p", "o", "u", "a", "t"]);
    expect(ids(lib.compareOrder(mensas))).toEqual(["a", "p", "o", "t", "u"]);
  });
  it("puts the starred ones first, in the order they were starred", () => {
    expect(ids(lib.compareOrder(mensas, { order, starred: ["t", "x", "a"] }))).toEqual(["t", "a", "p", "o", "u"]);
  });
  it("sorts the rest by distance with a position, those without one last", () => {
    const distances = new Map([["CAB", 50], ["KOL", 300], ["MM", 120]]);
    expect(ids(lib.compareOrder(mensas, { order, distances, starred: ["u"] }))).toEqual(["u", "t", "p", "o", "a"]);
  });
  it("leaves its input alone", () => {
    const copy = [...mensas];
    lib.compareOrder(mensas, { order });
    expect(mensas).toEqual(copy);
  });
});

describe("compareDefault", () => {
  const mensas = [
    { id: "a", name: "Archimedes" },
    { id: "p", name: "Mensa Polyterrasse" },
    { id: "o", name: "Obere Mensa" },
    { id: "t", name: "Tannenbar" },
  ];
  const order = ["p", "o", "u", "a"];

  it("compares Polymensa and the Obere Mensa without stars", () => {
    expect(lib.compareDefault(mensas, { order })).toEqual(["p", "o"]);
    expect(lib.compareDefault(mensas, { order, starred: ["HGE30.7", "x"] })).toEqual(["p", "o"]); // stars elsewhere
  });
  it("compares a single star with Polymensa, or Polymensa's star with the Obere Mensa", () => {
    expect(lib.compareDefault(mensas, { order, starred: ["t"] })).toEqual(["t", "p"]);
    expect(lib.compareDefault(mensas, { order, starred: ["p"] })).toEqual(["p", "o"]);
  });
  it("compares the starred mensas alone when there are two or more", () => {
    expect(lib.compareDefault(mensas, { order, starred: ["t", "x", "a"] })).toEqual(["t", "a"]);
    expect(lib.compareDefault(mensas, { order, starred: ["t", "a", "o"] })).toEqual(["t", "a", "o"]);
  });
  it("takes the first two chips where the location has no order, and copes with one mensa or none", () => {
    expect(lib.compareDefault(mensas)).toEqual(["a", "p"]);
    expect(lib.compareDefault([mensas[0]], { order })).toEqual(["a"]);
    expect(lib.compareDefault([], { order, starred: ["p"] })).toEqual([]);
  });
});

describe("Find your meal", () => {
  const mm = { id: "MMB79", name: "Mensa Polyterrasse", building: "MM" };
  const men = { id: "UM1", name: "Obere Mensa", building: "MEN" };
  const cla = { id: "CLAD5", name: "Clausiusbar", building: "CLA" };
  const dish = (name: string, place: object, type: string, student: number | null, protein: number | null, carbs: number | null, allergens: string[] = []) => ({
    name, place, type, allergens,
    price: { student, internal: student == null ? null : student + 2, external: null },
    nutrition: protein == null && carbs == null ? null : { protein, carbs, kcal: 150 },
  });
  const dishes = [
    dish("Burger", mm, "meat", 11.5, 9, 20, ["gluten wheat", "milk, lactose"]),
    dish("Dal", mm, "vegan", 7.5, 6, 14, ["soya"]),
    dish("Pollock", men, "fish", 9.5, 12, 8, ["fish", "wheat"]),
    dish("Risotto", men, "vegetarian", 7.5, null, null, ["milk"]),
    dish("Wok", cla, "meat", null, 12, 25, ["lactose"]),
  ];
  const names = (xs: { name: string }[]) => xs.map((x) => x.name);
  const distances = new Map([["MM", 300], ["MEN", 80], ["CLA", 150]]);

  it("ranks by price, cheapest first, the nearer place on a tie, dishes without a price apart", () => {
    const r = lib.rankDishes(dishes, { sort: "price", distances });
    expect(names(r.ranked)).toEqual(["Risotto", "Dal", "Pollock", "Burger"]);
    expect(names(r.rest)).toEqual(["Wok"]);
    expect(names(lib.rankDishes(dishes, { sort: "price" }).ranked)).toEqual(["Dal", "Risotto", "Pollock", "Burger"]);
    expect(names(lib.rankDishes(dishes, { sort: "price", priceGroup: "external" }).ranked)).toEqual([]);
  });
  it("ranks by protein and carbs per 100 g, highest first, then nearest, dishes without the value apart", () => {
    const p = lib.rankDishes(dishes, { sort: "protein", distances });
    expect(names(p.ranked)).toEqual(["Pollock", "Wok", "Burger", "Dal"]);
    expect(names(p.rest)).toEqual(["Risotto"]);
    expect(names(lib.rankDishes(dishes, { sort: "carbs" }).ranked)).toEqual(["Wok", "Burger", "Dal", "Pollock"]);
  });
  it("sorts nearest by the place's distance, and keeps the given order without a position", () => {
    expect(names(lib.rankDishes(dishes, { sort: "near", distances }).ranked)).toEqual(["Risotto", "Pollock", "Wok", "Dal", "Burger"]);
    const r = lib.rankDishes(dishes, { sort: "near" });
    expect(names(r.ranked)).toEqual(names(dishes));
    expect(r.rest).toEqual([]);
  });
  it("filters: dish types are alternatives, vegetarian includes vegan, the allergen filters each must hold", () => {
    const f = (filters: string[]) => names(lib.rankDishes(dishes, { sort: "near", filters }).ranked);
    expect(f(["vegan"])).toEqual(["Dal"]);
    expect(f(["vegetarian"])).toEqual(["Dal", "Risotto"]);
    expect(f(["vegan", "fish"])).toEqual(["Dal", "Pollock"]);
    expect(f(["glutenfree"])).toEqual(["Dal", "Risotto", "Wok"]);
    expect(f(["lactosefree"])).toEqual(["Dal", "Pollock"]);
    expect(f(["meat", "glutenfree", "lactosefree"])).toEqual([]);
    expect(f(["nonsense"])).toEqual(names(dishes));
    expect(lib.dishPasses({ type: "meat" }, ["glutenfree"])).toBe(true);
  });
  it("ranks by calories and turns any sort around with dir", () => {
    const withKcal = dishes.map((d, i) => ({ ...d, nutrition: d.nutrition ? { ...d.nutrition, kcal: [120, 300, 210, 90, 180][i] } : null }));
    const k = lib.rankDishes(withKcal, { sort: "kcal" });
    const kv = (list: any[]) => list.map((d) => d.nutrition.kcal);
    expect(kv(k.ranked)).toEqual([...kv(k.ranked)].sort((a, b) => b - a));
    expect(kv(lib.rankDishes(withKcal, { sort: "kcal", dir: "asc" }).ranked)).toEqual([...kv(k.ranked)].reverse());
    const price = (list: any[]) => list.map((d) => d.price.student);
    const up = price(lib.rankDishes(dishes, { sort: "price" }).ranked);
    expect(price(lib.rankDishes(dishes, { sort: "price", dir: "desc" }).ranked)).toEqual([...up].sort((a, b) => b - a));
    expect(lib.sortDir("near", "asc")).toBeNull();
    expect(lib.sortDir("price", "x")).toBe("asc");
    expect(lib.sortDir("protein", null)).toBe("desc");
  });
  it("ranks by climate impact (UZH's ratings), lowest first, then nearest, dishes without a rating apart", () => {
    const rated = dishes.map((d, i) => ({ ...d, ...(i === 4 ? {} : { climate: ["high", "low", "medium", "low"][i] }) }));
    const c = lib.rankDishes(rated, { sort: "climate", distances });
    expect(names(c.ranked)).toEqual(["Risotto", "Dal", "Pollock", "Burger"]);
    expect(names(c.rest)).toEqual(["Wok"]);
    expect(names(lib.rankDishes(rated, { sort: "climate", dir: "desc", distances }).ranked)).toEqual(["Burger", "Pollock", "Risotto", "Dal"]);
    expect(lib.rankDishes([{ ...dishes[0], climate: "unknown" }], { sort: "climate" }).rest).toHaveLength(1);
    expect(lib.sortDir("climate", null)).toBe("asc");
    expect(lib.MEAL_SORTS).toContain("climate");
    expect(lib.nutritionText(rated[0], "climate")).toBe("High climate impact");
    expect(lib.nutritionText(rated[4], "climate")).toBe("");
    expect(lib.cleanMealPref({ preset: "custom", sort: "climate", filters: ["vegan"] })).toEqual({ preset: "custom", sort: "climate", filters: ["vegan"] });
    expect(lib.mealPrefText({ sort: "climate", filters: [] })).toBe("Lowest climate impact first, nearest first");
  });
  it("leaves its input alone", () => {
    const copy = [...dishes];
    lib.rankDishes(dishes, { sort: "protein", distances });
    expect(dishes).toEqual(copy);
  });

  it("knows the presets", () => {
    expect(lib.presetOf("budget")).toEqual({ preset: "budget", name: "Budget-maxx", sort: "price", filters: [] });
    expect(lib.presetOf("protein").sort).toBe("protein");
    expect(lib.presetOf("carbs").name).toBe("Carb load");
    expect(lib.presetOf("custom")).toBeNull();
    expect(lib.presetOf("toString")).toBeNull();
    expect(lib.presetMatching("protein", [])).toBe("protein");
    expect(lib.presetMatching("protein", ["vegan"])).toBe("custom");
    expect(lib.presetMatching("near", [])).toBe("custom");
    expect(lib.presetMatching("protein", [], "asc")).toBe("custom");
    expect(lib.presetOf("lowcarb")).toEqual({ preset: "lowcarb", name: "Low carb", sort: "carbs", filters: [], dir: "asc" });
    expect(lib.presetMatching("carbs", [], "asc")).toBe("lowcarb");
    expect(lib.presetMatching("carbs", [], null)).toBe("carbs");
    expect(lib.cleanMealPref({ preset: "lowcarb", sort: "price" })).toEqual({ preset: "lowcarb", sort: "carbs", filters: [], dir: "asc" });
    expect(lib.presetMatching("price", [], "asc")).toBe("budget");
  });
  it("cleans a stored preference", () => {
    expect(lib.cleanMealPref({ preset: "protein", sort: "price", filters: ["vegan"] })).toEqual({ preset: "protein", sort: "protein", filters: [] });
    expect(lib.cleanMealPref({ preset: "custom", sort: "carbs", filters: ["fish", "x", "vegan", "fish"] })).toEqual({ preset: "custom", sort: "carbs", filters: ["vegan", "fish"] });
    expect(lib.cleanMealPref({ preset: "custom", sort: "kcal", filters: [], dir: "asc" })).toEqual({ preset: "custom", sort: "kcal", filters: [], dir: "asc" });
    expect(lib.cleanMealPref({ preset: "custom", sort: "price", filters: [], dir: "asc" })).toEqual({ preset: "custom", sort: "price", filters: [] });
    for (const bad of [null, undefined, "protein", {}, { preset: "custom", sort: "taste" }, { preset: "other", sort: "price" }]) expect(lib.cleanMealPref(bad)).toBeNull();
  });
  it("names and describes a preference", () => {
    expect(lib.mealPrefName({ preset: "budget" })).toBe("Budget-maxx");
    expect(lib.mealPrefName({ preset: "custom" })).toBe("Your selection");
    expect(lib.mealPrefText({ sort: "protein", filters: ["vegetarian"] })).toBe("Protein per 100 g, nearest first · Vegetarian");
    expect(lib.mealPrefText({ sort: "price", filters: [] })).toBe("Cheapest first, nearest first");
    expect(lib.mealPrefText({ sort: "price", filters: [], dir: "desc" })).toBe("Priciest first, nearest first");
    expect(lib.mealPrefText({ sort: "kcal", filters: [], dir: "asc" })).toBe("Fewest calories per 100 g, nearest first");
    expect(lib.mealPrefText({ sort: "near", filters: ["glutenfree", "vegan"] })).toBe("Nearest first · Vegan · Gluten-free");
  });

  it("finds things by their words: tabs, meal types, campuses", () => {
    const areas = [{ area: "Z", name: "ETH Zentrum" }, { area: "H", name: "ETH Hönggerberg" }, { area: "UI", name: "UZH Irchel" }];
    const ids = (q: string) => lib.searchIntents(q, { areas }).map((r: any) => r.id);
    expect(ids("meeting room")).toEqual(["rooms-near", "rooms"]);
    expect(ids("Bibliothek")[0]).toBe("library-near");
    expect(ids("hörsaal")).toEqual(["lecture"]);
    expect(lib.searchIntents("hörsaal")[0].go).toEqual({ tab: "rooms", types: ["3430"] });
    expect(ids("mikrowelle")).toEqual(["microwave-near"]);
    expect(ids("hongg")).toEqual(["area-H"]);
    expect(ids("irchel")).toEqual(["area-UI"]);
    const meal = lib.searchIntents("cheap vegan")[0];
    expect(meal.title).toBe("Cheapest vegan meals");
    expect(meal.go).toEqual({ meal: { sort: "price", filters: ["vegan"] } });
    expect(lib.searchIntents("low calorie")[0].go.meal).toEqual({ sort: "kcal", filters: [], dir: "asc" });
    expect(lib.searchIntents("protein")[0].title).toBe("High-protein meals");
    // Codes and short queries are places, not things.
    expect(ids("HG")).toEqual([]);
    expect(ids("CAB")).toEqual([]);
    expect(lib.searchIntents("library")[0].rank).toBe(0);
  });

  it("finds the tutorial, help and workspaces by their words", () => {
    const ids = (q: string) => lib.searchIntents(q).map((r: any) => r.id);
    for (const q of ["tutorial", "Tour", "Anleitung", "getting started", "how it works"]) expect(ids(q)[0]).toBe("tutorial");
    expect(lib.searchIntents("tutorial")[0].go).toEqual({ tour: true });
    // Help words lead to the tutorial for now (plans/FAQ_NOTES.md), once even when both match.
    for (const q of ["help", "Hilfe", "FAQ", "support"]) expect(ids(q)).toEqual(["help-tutorial"]);
    expect(lib.searchIntents("help tutorial").filter((r: any) => r.title === "Tutorial")).toHaveLength(1);
    expect(lib.searchIntents("add friends")[0].go).toEqual({ tour: "friends" });
    expect(lib.searchIntents("navigation")[0].go).toEqual({ tour: "map" });
    expect(ids("makerspace")[0]).toBe("workspace");
    expect(lib.searchIntents("workspace")[0].go).toEqual({ tab: "study", section: "s-workspace" });
    expect(ids("workspace")[0]).toBe("workspace");
    expect(ids("building")).not.toContain("workspace");
  });

  it("tells a microwave spot's queue from its reports", () => {
    expect(lib.queueLevel(null)).toBeNull();
    expect(lib.queueLevel({ levels: [0, 0, 0] })).toBeNull();
    expect(lib.queueLevel({ queue: [1, 0, 2, 0] })).toBe(2);
    expect(lib.queueLevel({ queue: [1, 1, 0, 0] })).toBe(1); // a tie goes to the longer queue
    expect(lib.reportedQueues({ queue: [1, 0, 2, 0] })).toEqual([{ level: 2, count: 2 }, { level: 0, count: 1 }]);
    expect(lib.QUEUE_NAMES).toHaveLength(4);
    expect(lib.microwaveName({ name: "Einstein" })).toBe("Einstein microwaves");
    expect(lib.microwaveName({ name: "BIN Microwaves" })).toBe("BIN Microwaves");
  });

  it("picks your meal at one mensa", () => {
    const own = dishes.filter((d) => d.place === mm);
    expect(lib.yourMeal(mm, own, { sort: "protein", filters: [] }).name).toBe("Burger");
    expect(lib.yourMeal(mm, own, { sort: "protein", filters: ["vegetarian"] }).name).toBe("Dal");
    expect(lib.yourMeal(mm, own, { sort: "price", filters: [] }).name).toBe("Dal");
    expect(lib.yourMeal(mm, own, { sort: "near", filters: ["meat"] }).name).toBe("Burger");
    expect(lib.yourMeal(mm, own, { sort: "price", filters: ["fish"] })).toBeNull();
    // No nutrition: nothing to rank by, the card keeps its flagship dish.
    expect(lib.yourMeal(men, [dishes[3]], { sort: "protein", filters: [] })).toBeNull();
    expect(lib.yourMeal(cla, [dishes[4]], { sort: "near", filters: [] }).name).toBe("Wok");
    expect(lib.yourMeal(mm, own, null)).toBeNull();
    expect(lib.yourMeal(mm, [], { sort: "price", filters: [] })).toBeNull();
  });
  it("picks the card's meal like the Worker", () => {
    const s = { meals_today: [{ meal: "lunch", from: "11:15", to: "14:00" }, { meal: "dinner", from: "17:30", to: "19:30" }], meals_next: { date: "2026-11-16", meals: [{ meal: "lunch", from: "11:15" }] } };
    expect(lib.cardMealOf(s, "2026-11-13T09:00:00+01:00")).toEqual({ date: "2026-11-13", meal: "lunch" });
    expect(lib.cardMealOf(s, "2026-11-13T13:00:00+01:00")).toEqual({ date: "2026-11-13", meal: "lunch" });
    expect(lib.cardMealOf(s, "2026-11-13T15:00:00+01:00")).toEqual({ date: "2026-11-13", meal: "dinner" });
    expect(lib.cardMealOf(s, "2026-11-13T20:00:00+01:00")).toEqual({ date: "2026-11-16", meal: "lunch" });
    expect(lib.cardMealOf({ meals_today: [], meals_next: null }, "2026-11-13T20:00:00+01:00")).toBeNull();
  });
  it("joins a description's parts and leaves out the part Cookpit cut off", () => {
    expect(lib.dishDesc("Onions | Capers")).toBe("Onions, Capers");
    expect(lib.dishDesc("Capers | Olives | Grated cheese | Pete...")).toBe("Capers, Olives, Grated cheese, …");
    expect(lib.dishDesc("Kapern | Petersi..")).toBe("Kapern, …");
    expect(lib.dishDesc("mit Ananas, Mango\nAdd on: XXL (+1...")).toBe("mit Ananas, Mango Add on: XXL …");
    expect(lib.dishDesc("")).toBe("");
    expect(lib.dishDesc(null)).toBe("");
  });
  it("writes the values per 100 g", () => {
    const d = { nutrition: { protein: 12.04, carbs: 30, kcal: 164.6 } };
    expect(lib.nutritionText(d, "protein")).toBe("12 g protein / 100 g");
    expect(lib.nutritionText(d, "carbs")).toBe("30 g carbs / 100 g");
    expect(lib.nutritionText(d, "price")).toBe("12 g protein · 30 g carbs · 165 kcal / 100 g");
    expect(lib.nutritionText({ nutrition: { protein: null, carbs: 4.5, kcal: null } }, "near")).toBe("4.5 g carbs / 100 g");
    expect(lib.nutritionText({ nutrition: { protein: null, carbs: 4.5 } }, "protein")).toBe("");
    expect(lib.nutritionText({ nutrition: null }, "near")).toBe("");
    expect(lib.nutritionText({}, "protein")).toBe("");
  });
});

describe("matchLevel", () => {
  const levels = {
    HG: { ground: "E", order: ["B", "C", "D", "E", "F", "G", "H", "J", "K"] },
    CAB: { ground: "E", order: ["F", "G", "H"] },
    MM: { ground: "C", order: ["B", "C"] },
    ML: { ground: "E", order: ["D", "E", "F", "G", "H", "J"] },
    LEE: { ground: "E", order: ["C", "D", "E", "F"] },
  };

  it("keeps the offset from street level", () => {
    expect(lib.matchLevel("HG", "F", "LEE", levels)).toBe("F");
    expect(lib.matchLevel("HG", "D", "MM", levels)).toBe("B");
    expect(lib.matchLevel("MM", "C", "HG", levels)).toBe("E");
    expect(lib.matchLevel("HG", "G", "CAB", levels)).toBe("G");
  });

  it("clamps to the lowest or highest level", () => {
    expect(lib.matchLevel("HG", "E", "CAB", levels)).toBe("F"); // CAB's plans start one floor up
    expect(lib.matchLevel("HG", "B", "CAB", levels)).toBe("F");
    expect(lib.matchLevel("HG", "K", "MM", levels)).toBe("C");
    expect(lib.matchLevel("HG", "B", "LEE", levels)).toBe("C");
  });

  it("takes the nearest level with plans, the lower on a tie", () => {
    expect(lib.matchLevel("HG", "G", "ML", levels, ["D", "E", "F", "H", "J"])).toBe("F");
    expect(lib.matchLevel("HG", "H", "ML", levels, ["D", "E", "F", "H", "J"])).toBe("H");
  });

  it("falls back to the same level without an entry", () => {
    expect(lib.matchLevel("HG", "E", "XX", levels)).toBe("E");
    expect(lib.matchLevel("HG", "E", "XX", levels, ["C", "D"])).toBe("C");
    expect(lib.matchLevel("XX", "Q", "HG", levels)).toBe("E"); // unknown start: street level
  });

  it("takes the choices stored by the live version (before this revamp) without anything new", () => {
    // static/app.js savePrefs on main: no stars, no mealPref, no client or reports; types may hold computer rooms.
    const old = JSON.parse(
      '{"mode":"rooms","area":"Z","spaceBuildings":{"study":["HG"],"mensa":["MM"]},"buildings":["CAB"],"types":["3650","3430"],' +
        '"minSeats":"20","kinds":["library","open"],"priceGroup":"student","diet":"all","compare":{"Z":["MMB79"]},"mapLayers":["study","mensa"]}',
    );
    expect(lib.cleanStars(old.stars)).toEqual([]);
    expect(lib.cleanMealPref(old.mealPref)).toBeNull();
    expect(lib.cleanMyReports(old.reports, Date.now())).toEqual([]);
    expect(lib.CLIENT_ID_RE.test(String(old.client))).toBe(false);
    expect(lib.keptTypes(old.types, new Set(["3410", "3420", "3430"]))).toEqual(["3430"]);
  });
});

describe("the map's labels", () => {
  const order = ["MMB79", "UM1", "UM2", "CLAD5", "F8", "UM4", "CABH41", "UM3", "F10", "F11", "UM5", "F5"];

  it("places the ranked mensas first, in our order, then the rest as they came", () => {
    const ids = ["F5", "F10", "F2", "MMB79", "F1", "UM2", "UM1"];
    expect(lib.placeLabelOrder(ids, order).map((i: number) => ids[i])).toEqual(["MMB79", "UM1", "UM2", "F10", "F5", "F2", "F1"]);
    expect(lib.placeLabelOrder(["b", "a"], [])).toEqual([0, 1]);
    expect(lib.placeLabelOrder(["b", "a"], null)).toEqual([0, 1]);
  });

  it("puts a marker beside the label it would cover, where that's clear", () => {
    const label = [100, 100, 160, 120];
    expect(lib.besideBoxes(50, 50, 20, 20, [label])).toEqual([50, 50]);
    expect(lib.besideBoxes(120, 110, 20, 20, [label])).toEqual([171, 110]); // right of it
    expect(lib.besideBoxes(120, 110, 20, 20, [label, [160, 90, 200, 130]])).toEqual([89, 110]); // left
    expect(lib.besideBoxes(120, 110, 20, 20, [label, [160, 90, 200, 130], [60, 90, 100, 130]])).toEqual([120, 131]); // below
    const ring = [label, [160, 0, 400, 300], [0, 0, 100, 300], [100, 120, 160, 300], [100, 0, 160, 100]];
    expect(lib.besideBoxes(120, 110, 20, 20, ring)).toEqual([120, 110]); // nowhere clear: where it is
  });

  it("draws a building's microwaves one by one only zoomed in so far that they're apart", () => {
    const list = [
      { building: "MM", at: [-115.4, 189.5] }, { building: "MM", at: [-109.8, 207.9] }, { building: "MM", at: [-112.6, 198.7] },
      { building: "CHN", at: [50.1, -114.5] }, { building: "CAB", at: null },
    ];
    // MM's closest two are 9.6 m apart: one by one from 2.5 px per metre on (24 px).
    expect([...lib.microwaveSpots(list, 1)]).toEqual(["CHN"]);
    expect([...lib.microwaveSpots(list, 2.5)].sort()).toEqual(["CHN", "MM"]);
    expect([...lib.microwaveSpots(list, lib.MICRO_SPOT_SCALE - 0.01)]).toEqual([]);
    expect(lib.microwaveSpots([], 3).size).toBe(0);
  });
});

describe("bubbles: colours and contrast (plan 8.4)", () => {
  it("works out WCAG contrast like the Worker", () => {
    const pairs = [["#ffffff", "#000000"], ["#010057", "#ffffff"], ["#f6c945", "#1c1f23"], ["#777777", "#888888"], ["#da291c", "#ffffff"]];
    for (const [a, b] of pairs) expect(lib.colourContrast(a, b)).toBeCloseTo(social.contrast(a, b), 10);
    expect(lib.colourContrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(lib.colourContrast("#123456", "#123456")).toBe(1);
    expect(lib.MIN_BUBBLE_CONTRAST).toBe(social.MIN_CONTRAST);
  });

  it("refuses pairs below 3:1 and anything that isn't #rrggbb", () => {
    expect(lib.readableBubble("#010057", "#ffffff")).toBe(true);
    expect(lib.readableBubble("#777777", "#888888")).toBe(false);
    expect(lib.readableBubble("#fff", "#000000")).toBe(false);
    expect(lib.readableBubble("#FFFFFF", "#000000")).toBe(false); // the page sends lower case
    expect(lib.readableBubble(null, "#000000")).toBe(false);
  });

  it("offers a readable text colour for every background swatch, and picks readable random pairs", () => {
    for (const dark of [false, true]) {
      for (const bg of lib.bubbleBackgrounds(dark)) expect(lib.BUBBLE_TEXTS.some((fg: string) => lib.readableBubble(bg, fg))).toBe(true);
    }
    expect(lib.bubbleBackgrounds(false)).toEqual(["#ffffff", lib.BUBBLE_NAVY]);
    expect(lib.bubbleBackgrounds(true)).toEqual(["#000000", lib.BUBBLE_NAVY]);
    for (let i = 0; i < lib.BUBBLE_RANDOM_BACKGROUNDS.length; i++) {
      const pair = lib.randomBubble(() => (i + 0.5) / lib.BUBBLE_RANDOM_BACKGROUNDS.length);
      expect(pair.bg).toBe(lib.BUBBLE_RANDOM_BACKGROUNDS[i]);
      expect(lib.readableBubble(pair.bg, pair.fg)).toBe(true);
    }
    expect(lib.readableBubble(lib.randomBubble(() => 0.9999999).bg, lib.randomBubble(() => 0.9999999).fg)).toBe(true);
  });

  it("turns the colour wheel's HSV into #rrggbb and back", () => {
    expect(lib.hsvToHex(0, 1, 1)).toBe("#ff0000");
    expect(lib.hsvToHex(120, 1, 1)).toBe("#00ff00");
    expect(lib.hsvToHex(240, 1, 0.5)).toBe("#000080");
    expect(lib.hsvToHex(77, 0, 1)).toBe("#ffffff");
    expect(lib.hsvToHex(200, 0.8, 0)).toBe("#000000");
    for (const hex of ["#010057", "#da291c", "#9fd3c7", "#f6c945", "#1c1f23", "#ffffff"]) {
      const { h, s, v } = lib.hexToHsv(hex);
      expect(lib.hsvToHex(h, s, v)).toBe(hex);
    }
    expect(lib.hexToHsv("#808080")).toMatchObject({ h: 0, s: 0 });
  });

  it("checks gradients stop against stop, as the Worker does", () => {
    // White on navy reads; a pale second background stop under white text doesn't.
    expect(lib.readableBubble("#010057", "#ffffff", "#215caf")).toBe(true);
    expect(lib.readableBubble("#010057", "#ffffff", "#e3e5e8")).toBe(false);
    expect(lib.readableBubble("#010057", "#ffffff", null, "#f6c945")).toBe(true);
    expect(lib.readableBubble("#010057", "#ffffff", null, "#215caf")).toBe(false);
    expect(lib.readableBubble("#010057", "#ffffff", "#FFF")).toBe(false);
    expect(lib.bubbleContrast(["#010057", "#e3e5e8"], ["#ffffff"])).toBeCloseTo(lib.colourContrast("#e3e5e8", "#ffffff"), 10);
    const cases: [string, string, string | null, string | null][] = [
      ["#010057", "#ffffff", "#215caf", null], ["#010057", "#ffffff", "#e3e5e8", null], ["#1c1f23", "#f6c945", "#5b3fa8", "#ffffff"],
      ["#f6c945", "#1c1f23", "#9fd3c7", "#010057"], ["#da291c", "#ffffff", null, "#fff4d6"],
    ];
    for (const [bg, fg, bg2, fg2] of cases) expect(lib.readableBubble(bg, fg, bg2, fg2)).toBe(social.readableStyle(bg, fg, bg2, fg2));
  });

  it("designs every metal to read: each background stop against each letter stop", () => {
    expect(Object.keys(lib.BUBBLE_METALS)).toEqual([...social.METALS]);
    for (const m of Object.values(lib.BUBBLE_METALS) as { bg: string[]; fg: string[] }[]) {
      expect(lib.bubbleContrast(m.bg, m.fg)).toBeGreaterThanOrEqual(lib.MIN_BUBBLE_CONTRAST);
      for (const c of [...m.bg, ...m.fg]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("unlocks the styles at the Worker's levels", () => {
    expect(lib.BUBBLE_STYLE_LEVELS).toEqual(social.STYLE_LEVELS);
    expect(lib.bubbleStyleLevel({ bg: "#010057", fg: "#ffffff" })).toBe(1);
    expect(lib.bubbleStyleLevel({ bg: "#010057", fg: "#ffffff", bg2: "#215caf" })).toBe(2);
    expect(lib.bubbleStyleLevel({ bg: "#010057", fg: "#ffffff", bg2: "#215caf", fg2: "#f6c945" })).toBe(3);
    expect(lib.bubbleStyleLevel({ metal: "gold" })).toBe(6);
    expect(lib.bubbleStyleLevel(null)).toBe(1);
  });

  it("paints a bubble: flat, gradients, metal (which wins), or the default", () => {
    expect(lib.bubbleLook({ bg: "#010057", fg: "#ffffff" })).toEqual({ background: "#010057", color: "#ffffff", text: null, metal: null });
    expect(lib.bubbleLook({ bg: "#010057", fg: "#ffffff", bg2: "#215caf", fg2: "#f6c945" })).toEqual({
      background: "linear-gradient(135deg, #010057, #215caf)", color: "#ffffff", text: "linear-gradient(135deg, #ffffff, #f6c945)", metal: null,
    });
    const gold = lib.bubbleLook({ bg: "#010057", fg: "#ffffff", bg2: "#215caf", metal: "gold" });
    expect(gold.metal).toBe("gold");
    expect(gold.background).toBe(`linear-gradient(135deg, ${lib.BUBBLE_METALS.gold.bg.join(", ")})`);
    expect(gold.color).toBe(lib.BUBBLE_METALS.gold.fg[0]);
    expect(lib.bubbleLook({ initials: "RW" })).toBeNull();
    expect(lib.bubbleLook({ bg: "#010057", fg: "#ffffff", metal: "platinum" })?.metal).toBeNull();
  });
});

describe("usernames", () => {
  it("says what's wrong with a typed username, like the Worker's rule", () => {
    expect(lib.usernameProblem("")).toBe("Pick a username.");
    expect(lib.usernameProblem("ab")).toBe("At least 3 characters.");
    expect(lib.usernameProblem("a".repeat(21))).toBe("At most 20 characters.");
    expect(lib.usernameProblem("raffi w")).toMatch(/Only letters/);
    expect(lib.usernameProblem("räffi")).toMatch(/Only letters/);
    expect(lib.usernameProblem("Raffi.W_1")).toBeNull(); // sent lower case
    expect(lib.USERNAME_PATTERN.source).toBe(social.USERNAME_RE.source);
  });
});

describe("mergeStars (plan 7.4)", () => {
  const star = (id: string, area = "Z") => ({ kind: "room", id, area, name: id, building: id.split(" ")[0] });

  it("keeps the account's stars first, then the browser's that aren't in it", () => {
    const account = [star("HG E 1"), star("CAB G 11")];
    const browser = [star("ML D 28"), star("HG E 1"), star("HG E 1", "H")];
    expect(lib.mergeStars(account, browser).map((s: { id: string; area: string }) => `${s.area}:${s.id}`)).toEqual(["Z:HG E 1", "Z:CAB G 11", "Z:ML D 28", "H:HG E 1"]);
  });

  it("cuts the result to 40 and cleans both lists", () => {
    const account = Array.from({ length: 30 }, (_, i) => star(`HG A ${i}`));
    const browser = [...Array.from({ length: 30 }, (_, i) => star(`ML B ${i}`)), { kind: "nonsense", id: "x", area: "Z" }];
    const merged = lib.mergeStars(account, browser);
    expect(merged).toHaveLength(40);
    expect(merged[29].id).toBe("HG A 29");
    expect(merged[30].id).toBe("ML B 0");
    expect(lib.mergeStars(null, undefined)).toEqual([]);
  });

  it("tells whether two lists are the same", () => {
    expect(lib.sameStars([star("HG E 1")], [{ ...star("HG E 1"), extra: 1 }])).toBe(true);
    expect(lib.sameStars([star("HG E 1"), star("ML D 28")], [star("ML D 28"), star("HG E 1")])).toBe(false);
  });
});

describe("friends (plan 8.5)", () => {
  const people = [
    { username: "zoe.m", name: "Zoë M." },
    { username: "anna_k", name: "Anna-Lena K." },
    { username: "raffi", name: "Raffaele W." },
    { username: "bvarx", name: "Beat A." },
  ];

  it("sorts friends by username", () => {
    expect(lib.sortFriends(people).map((p: { username: string }) => p.username)).toEqual(["anna_k", "bvarx", "raffi", "zoe.m"]);
    expect(lib.sortFriends(null)).toEqual([]);
  });

  it("filters by username start and name word start, without accents or case", () => {
    const hits = (q: string) => people.filter((p) => lib.friendMatches(p, q)).map((p) => p.username);
    expect(hits("")).toEqual(["zoe.m", "anna_k", "raffi", "bvarx"]);
    expect(hits("raf")).toEqual(["raffi"]);
    expect(hits("@zoe")).toEqual(["zoe.m"]);
    expect(hits("ZOE")).toEqual(["zoe.m"]);
    expect(hits("lena")).toEqual(["anna_k"]);
    expect(hits("raffaele w")).toEqual(["raffi"]);
    expect(hits("affi")).toEqual([]);
    expect(hits("w.")).toEqual([]);
  });

  it("reads an add-a-friend link", () => {
    expect(lib.addParam("?add=Raffi")).toBe("raffi");
    expect(lib.addParam("?room=HG+E+1&add=anna_k")).toBe("anna_k");
    expect(lib.addParam("?add=a b")).toBeNull();
    expect(lib.addParam("?add=")).toBeNull();
    expect(lib.addParam("")).toBeNull();
  });
});

describe("check-in times (plan 8.6)", () => {
  // Local time, as the page shows it: 14:05 on a Tuesday.
  const now = new Date(2026, 10, 17, 14, 5, 0).getTime();
  const at = (h: number, m: number, plusDays = 0) => new Date(2026, 10, 17 + plusDays, h, m, 0).getTime();

  it("turns a typed time into an end today, or tomorrow when it has passed, within 12 hours", () => {
    expect(lib.untilAt("16:00", now)).toBe(at(16, 0));
    expect(lib.untilAt("9:30", now)).toBeNull(); // tomorrow 09:30 is more than 12 hours ahead
    expect(lib.untilAt("01:30", now)).toBe(at(1, 30, 1));
    expect(lib.untilAt("02:05", now)).toBe(at(2, 5, 1)); // exactly 12 hours
    expect(lib.untilAt("14:05", now)).toBeNull(); // now: tomorrow, too far
    expect(lib.untilAt("25:00", now)).toBeNull();
    expect(lib.untilAt("", now)).toBeNull();
    expect(lib.untilAt("abc", now)).toBeNull();
  });

  it("keeps the time wheel's end within the next 12 hours, at least a minute ahead", () => {
    expect(lib.untilClamp("16:00", now)).toBe("16:00");
    expect(lib.untilClamp("01:30", now)).toBe("01:30"); // tomorrow, within 12 hours
    expect(lib.untilClamp("02:05", now)).toBe("02:05"); // exactly 12 hours
    expect(lib.untilClamp("14:05", now)).toBe("14:10"); // now: the next step
    expect(lib.untilClamp("14:00", now)).toBe("14:10"); // just passed: back to the first end
    expect(lib.untilClamp("13:00", now)).toBe("14:10");
    expect(lib.untilClamp("03:00", now)).toBe("02:05"); // just beyond 12 hours: the last end
    expect(lib.untilClamp("08:00", now)).toBe("02:05"); // 5 h 55 beyond the last end, 6 h 05 behind now
    expect(lib.untilClamp("9:30", now)).toBe("14:10"); // 4 h 35 behind now: nearer now
    expect(lib.untilClamp("11:00", now)).toBe("14:10"); // nearer now (behind it) than the last end
    expect(lib.untilClamp("", now)).toBe("14:10");
    const late = at(14, 9) + 30_000; // 14:10 is less than a minute away: the next step after it
    expect(lib.untilClamp("14:10", late)).toBe("14:15");
    // Every answer is a possible end, and lies on the wheel's steps.
    for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m += 5) {
      const hhmm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const out = lib.untilClamp(hhmm, now);
      const t = lib.untilAt(out, now);
      expect(t).not.toBeNull();
      expect(t - now).toBeGreaterThanOrEqual(60_000);
      expect(Number(out.slice(3)) % 5).toBe(0);
    }
  });

  it("shares a row of place actions out over twelve columns, Check out narrow", () => {
    expect(lib.actionSpans(1)).toEqual([12]);
    expect(lib.actionSpans(2)).toEqual([6, 6]);
    expect(lib.actionSpans(3)).toEqual([4, 4, 4]);
    expect(lib.actionSpans(4, 2)).toEqual([3, 3, 4, 2]); // Star, Invite, Checked in, Check out
    expect(lib.actionSpans(3, 1)).toEqual([5, 5, 2]);
    expect(lib.actionSpans(2, 0)).toEqual([10, 2]);
    for (const [n, i] of [[4, 2], [3, 1], [2, 0], [3, -1]]) expect(lib.actionSpans(n, i).reduce((a: number, b: number) => a + b, 0)).toBe(12);
  });

  it("knows which hour choice an end time is", () => {
    expect(lib.untilHours(now + 3 * 3600_000, now)).toBe(3);
    expect(lib.untilHours(now + 3600_000 + 30_000, now)).toBe(1);
    expect(lib.untilHours(at(16, 0), now)).toBeNull();
  });

  it("says since when and until when", () => {
    expect(lib.checkinWhen({ since: now, until: at(16, 0) })).toBe("since 14:05 · until 16:00");
    expect(lib.checkinWhen({ since: at(22, 0), until: at(1, 0, 1) }, at(22, 0))).toBe("since 22:00 · until 01:00 tomorrow");
  });

  it("tells running check-ins from those that ran out", () => {
    expect(lib.runningCheckin({ until: now + 1 }, now)).toBe(true);
    expect(lib.runningCheckin({ until: now }, now)).toBe(false);
    expect(lib.runningCheckin(null, now)).toBe(false);
  });

  it("finds a room's building in its code", () => {
    expect(lib.roomBuilding("HG E 33.1")).toBe("HG");
    expect(lib.roomBuilding("KOL-F-101")).toBe("KOL");
  });
});

describe("friends' check-ins in the You tab (plan 8.7)", () => {
  const c = (user: string, area: string, since: number, building = "HG") => ({ person: { username: user }, area, since, building });
  const users = (xs: { person: { username: string } }[]) => xs.map((x) => x.person.username);
  const list = [c("a", "H", 100), c("b", "Z", 50), c("c", "Z", 200), c("d", "UZ", 300)];

  it("puts this campus first, then the latest check-in, without a position", () => {
    expect(users(lib.sortFriendCheckins(list, { area: "Z" }))).toEqual(["c", "b", "d", "a"]);
    expect(users(lib.sortFriendCheckins(list))).toEqual(["d", "c", "a", "b"]);
  });

  it("sorts by distance when it's known, unknown ones last", () => {
    const dist: Record<string, number | null> = { a: null, b: 300, c: 40, d: null };
    expect(users(lib.sortFriendCheckins(list, { area: "Z", distance: (x: { person: { username: string } }) => dist[x.person.username] }))).toEqual(["c", "b", "d", "a"]);
  });

  it("copes with nothing", () => {
    expect(lib.sortFriendCheckins(null)).toEqual([]);
  });
});

describe("stackBubbles (plan 8.8)", () => {
  it("keeps bubbles apart when they don't overlap", () => {
    const out = lib.stackBubbles([{ key: "HG", x: 0, y: 0, n: 1 }, { key: "CAB", x: 100, y: 0, n: 2 }], 34);
    expect(out).toEqual([{ keys: ["HG"], x: 0, y: 0, n: 1 }, { keys: ["CAB"], x: 100, y: 0, n: 2 }]);
  });

  it("merges overlapping bubbles into one with the total, between them by their people", () => {
    const out = lib.stackBubbles([{ key: "HG", x: 0, y: 0, n: 1 }, { key: "ML", x: 30, y: 0, n: 2 }], 34);
    expect(out).toHaveLength(1);
    expect(out[0].keys).toEqual(["HG", "ML"]);
    expect(out[0].n).toBe(3);
    expect(out[0].x).toBeCloseTo(20);
    expect(out[0].y).toBe(0);
  });

  it("merges again when the merged bubble lands on a third one, closest pair first", () => {
    const out = lib.stackBubbles([{ key: "A", x: 0, y: 0, n: 1 }, { key: "B", x: 20, y: 0, n: 1 }, { key: "C", x: 42, y: 0, n: 1 }, { key: "D", x: 300, y: 0, n: 1 }], 34);
    expect(out.map((g: { keys: string[] }) => g.keys)).toEqual([["A", "B", "C"], ["D"]]);
    expect(out[0].n).toBe(3);
    expect(out[0].x).toBeCloseTo(62 / 3); // A and B (20 apart) first, then C joins (32 from them)
  });

  it("separates them again zoomed in (the same buildings further apart)", () => {
    const at = (scale: number) => lib.stackBubbles([{ key: "HG", x: 0, y: 0, n: 1 }, { key: "ML", x: 25 * scale, y: 10 * scale, n: 1 }], 34);
    expect(at(1)).toHaveLength(1);
    expect(at(2)).toHaveLength(2);
  });

  it("copes with nothing", () => {
    expect(lib.stackBubbles([], 34)).toEqual([]);
    expect(lib.stackBubbles(null, 34)).toEqual([]);
  });
});

describe("Street cred view (plans/PLAN_STREET_CRED.md, 11.1)", () => {
  it("levelProgress: the level, its range, what's missing and how far along", () => {
    expect(lib.levelProgress(0)).toEqual({ level: 1, from: 0, to: 100, toGo: 100, fraction: 0, top: false });
    // Level 20 is the top: a full bar, nothing to go.
    expect(lib.levelProgress(10_449)).toMatchObject({ level: 19, to: 10_450, toGo: 1, top: false });
    expect(lib.levelProgress(12_000)).toEqual({ level: 20, from: 10_450, to: null, toGo: 0, fraction: 1, top: true });
    expect(lib.levelProgress(520)).toMatchObject({ level: 4, from: 450, to: 700, toGo: 180 });
    expect(lib.levelProgress(520).fraction).toBeCloseTo(0.28);
    expect(lib.levelProgress(700)).toMatchObject({ level: 5, toGo: 300, fraction: 0 });
    expect(lib.levelProgress(-3)).toMatchObject({ level: 1, toGo: 100 });
  });

  it("nextUnlockText: up to gold, then none", () => {
    expect(lib.nextUnlockText(1)).toBe("Level 2: gradient background");
    expect(lib.nextUnlockText(4)).toBe("Level 5: silver bubble");
    expect(lib.nextUnlockText(6)).toBeNull();
    expect(lib.nextUnlockText(9)).toBeNull();
  });

  it("credWhen: today and yesterday with the time, this year with the weekday, else the year", () => {
    const now = new Date(2026, 10, 18, 15, 0).getTime();
    expect(lib.credWhen(new Date(2026, 10, 18, 14, 5).getTime(), now)).toBe("Today 14:05");
    expect(lib.credWhen(new Date(2026, 10, 17, 23, 59).getTime(), now)).toBe("Yesterday 23:59");
    expect(lib.credWhen(new Date(2026, 10, 16, 9, 0).getTime(), now)).toBe("Mon 16 Nov");
    expect(lib.credWhen(new Date(2025, 11, 31, 9, 0).getTime(), now)).toBe("31 Dec 2025");
  });

  it("credToastText: the points, a level-up with its unlock, nothing for 0", () => {
    expect(lib.credToastText({ points: 5, total: 105, level: 2 }, 2)).toBe("+5 street cred");
    expect(lib.credToastText({ points: 25, total: 260, level: 3 }, 2)).toBe("+25 street cred · Level 3! Gradient text unlocked");
    expect(lib.credToastText({ points: 3, total: 1351, level: 7 }, 6)).toBe("+3 street cred · Level 7!");
    expect(lib.credToastText({ points: 3, total: 103, level: 2 }, null)).toBe("+3 street cred");
    expect(lib.credToastText({ points: 0, total: 100, level: 2 }, 1)).toBeNull();
    expect(lib.credToastText(undefined, 1)).toBeNull();
  });
});

describe("the tutorial (plans/PLAN_TUTORIAL.md)", () => {
  it("parseTourParam: the welcome screen, a journey, a step to resume at", () => {
    expect(lib.parseTourParam("")).toBeNull();
    expect(lib.parseTourParam("?room=HG+E+33")).toBeNull();
    expect(lib.parseTourParam("?tutorial")).toEqual({ journey: null, step: null });
    expect(lib.parseTourParam("?tutorial=")).toEqual({ journey: null, step: null });
    expect(lib.parseTourParam("?tutorial=food")).toEqual({ journey: "food", step: null });
    expect(lib.parseTourParam("?tutorial=Friends&step=4")).toEqual({ journey: "friends", step: 4 });
    expect(lib.parseTourParam("?step=4&tutorial=meet")).toEqual({ journey: "meet", step: 4 });
    expect(lib.parseTourParam("?tutorial=pizza")).toEqual({ journey: null, step: null });
    // A step without a journey, or one that isn't a small whole number, is ignored.
    expect(lib.parseTourParam("?tutorial&step=3")).toEqual({ journey: null, step: null });
    for (const bad of ["-1", "1.5", "x", "9999", "200"]) expect(lib.parseTourParam(`?tutorial=study&step=${bad}`)).toEqual({ journey: "study", step: null });
  });

  it("parseTourParam: chapters on their own (the debug value chapter:<ids>[:<journey>])", () => {
    expect(lib.parseTourParam("?tutorial=chapter:D")).toEqual({ journey: "study", step: null, chapters: ["D"] });
    expect(lib.parseTourParam("?tutorial=chapter:c")).toEqual({ journey: "meet", step: null, chapters: ["C"] });
    expect(lib.parseTourParam("?tutorial=chapter:B,D,b:food")).toEqual({ journey: "food", step: null, chapters: ["B", "D"] });
    expect(lib.parseTourParam("?tutorial=chapter:G:pizza")).toEqual({ journey: "friends", step: null, chapters: ["G"] });
    expect(lib.parseTourParam("?tutorial=chapter:E,Q&step=2")).toEqual({ journey: "study", step: null, chapters: ["E"] });
    // No known chapter: the welcome screen.
    for (const v of ["chapter:", "chapter:Q", "chapter::food"]) expect(lib.parseTourParam(`?tutorial=${v}`)).toEqual({ journey: null, step: null });
    expect(lib.TOUR_CHAPTER_IDS.every((c: string) => lib.TOUR_JOURNEY_IDS.includes(lib.TOUR_CHAPTER_CONTEXT[c]))).toBe(true);
  });

  it("tourChapterSpan finds the run of a chapter's steps around a step", () => {
    const chapters = { A: ["a1", "a2"], B: ["b1", "b2", "b3"] };
    const plan = lib.tourPlan(["A", { id: "own" }, "B", "B"], chapters, []);
    expect(lib.tourChapterSpan(plan, 0)).toEqual([0, 2]);
    expect(lib.tourChapterSpan(plan, 1)).toEqual([0, 2]);
    expect(lib.tourChapterSpan(plan, 2)).toBeNull();
    expect(lib.tourChapterSpan(plan, 4)).toEqual([3, 6]);
    // The same chapter twice in a row: two runs.
    expect(lib.tourChapterSpan(plan, 6)).toEqual([6, 9]);
    expect(lib.tourChapterSpan(plan, 99)).toBeNull();
  });

  it("tourFirstMensa: serving first, then open or a meal still to come, else none", () => {
    expect(lib.tourFirstMensa(["closed", "plain", "food", "food"])).toBe(2);
    expect(lib.tourFirstMensa(["closed", "plain", "cafe"])).toBe(1);
    expect(lib.tourFirstMensa(["closed", "cafe"])).toBe(-1);
    expect(lib.tourFirstMensa([])).toBe(-1);
  });

  it("cleanTour keeps known ids once, in their own order, and a true seenOffer", () => {
    const empty = { done: { chapters: [], journeys: [] }, seenOffer: false };
    for (const raw of [null, undefined, "x", 3, [], {}, { done: "x" }, { done: { chapters: "A" } }]) expect(lib.cleanTour(raw)).toEqual(empty);
    expect(lib.cleanTour({ done: { chapters: ["F", "A", "Z", "A", 1], journeys: ["food", "pizza", "friends"] }, seenOffer: true, extra: 1 }))
      .toEqual({ done: { chapters: ["A", "F"], journeys: ["friends", "food"] }, seenOffer: true });
    expect(lib.cleanTour({ seenOffer: "yes" }).seenOffer).toBe(false);
  });

  it("tourMarkDone adds a chapter or a journey once, without changing what it was given", () => {
    const t = lib.cleanTour(null);
    const a = lib.tourMarkDone(t, { chapter: "B" });
    expect(a.done.chapters).toEqual(["B"]);
    expect(t.done.chapters).toEqual([]);
    const b = lib.tourMarkDone(lib.tourMarkDone(a, { chapter: "A", journey: "food" }), { chapter: "B" });
    expect(b.done).toEqual({ chapters: ["A", "B"], journeys: ["food"] });
    expect(lib.tourMarkDone(b, { chapter: "Q", journey: "x" })).toEqual(b);
  });

  it("tourPlan lays out a journey's steps and marks the chapters seen before", () => {
    const chapters = { A: ["a1", "a2"], B: ["b1"], C: ["c1", "c2"] };
    const own = { id: "own" };
    const fresh = lib.tourPlan(["A", own, "B", "C"], chapters, []);
    expect(fresh.map((s: any) => s.step)).toEqual(["a1", "a2", own, "b1", "c1", "c2"]);
    expect(fresh.map((s: any) => s.chapter)).toEqual(["A", "A", null, "B", "C", "C"]);
    expect(fresh.map((s: any) => s.first)).toEqual([true, false, false, true, true, false]);
    expect(fresh.every((s: any) => s.skip === null)).toBe(true);
    // A seen: left out without asking; B seen: offered; C always runs. The indices stay the same.
    const seen = lib.tourPlan(["A", own, "B", "C"], chapters, ["A", "B", "C"]);
    expect(seen.map((s: any) => s.skip)).toEqual(["auto", "auto", null, "offer", null, null]);
    expect(seen.map((s: any) => s.step)).toEqual(fresh.map((s: any) => s.step));
    // A chapter without steps adds nothing.
    expect(lib.tourPlan(["G", own], chapters, [])).toEqual([{ step: own, chapter: null, first: false, skip: null }]);
  });

  it("which chapters are skipped how", () => {
    expect(lib.TOUR_SKIP).toEqual({ A: "auto", B: "offer", D: "offer", E: "offer", F: "offer" });
    expect(Object.keys(lib.TOUR_SKIP).every((c) => lib.TOUR_CHAPTER_IDS.includes(c))).toBe(true);
  });

  it("tourStatKey names the 13 counters, all of them in STATS_KEYS", () => {
    expect(lib.tourStatKey("open")).toBe("tutorial_open");
    expect(lib.tourStatKey("start", "food")).toBe("tutorial_start_food");
    expect(lib.tourStatKey("done", "friends")).toBe("tutorial_done_friends");
    expect(lib.tourStatKey("done", "pizza")).toBeNull();
    expect(lib.tourStatKey("finish", "food")).toBeNull();
    const keys = ["tutorial_open", ...lib.TOUR_JOURNEY_IDS.flatMap((j: string) => [lib.tourStatKey("start", j), lib.tourStatKey("done", j)])];
    expect(keys.length).toBe(13);
    expect(lib.tourStatKey("start", "map")).toBe("tutorial_start_map");
    expect(lib.STATS_KEYS.filter((k: string) => k.startsWith("tutorial_")).sort()).toEqual([...keys].sort());
  });

  it("tourOfferShown: the first-visit line on a plain first load only", () => {
    expect(lib.TOUR_STORE).toBe("frooms.tour");
    expect(lib.tourOfferShown({})).toBe(true);
    expect(lib.tourOfferShown({ prefs: null, tour: null, path: "/", search: "" })).toBe(true);
    // Not seen yet, but stored progress without seenOffer still shows it.
    expect(lib.tourOfferShown({ tour: { done: { chapters: ["A"] } } })).toBe(true);
    expect(lib.tourOfferShown({ tour: { seenOffer: true } })).toBe(false);
    expect(lib.tourOfferShown({ tour: { seenOffer: "yes" } })).toBe(true);
    // Stored choices: not the first visit (an empty object too: it was written).
    expect(lib.tourOfferShown({ prefs: "{}" })).toBe(false);
    expect(lib.tourOfferShown({ prefs: "" })).toBe(false);
    // Opened for something: an invite, a place's address, a friend link, the tour itself, ?edit, ?pins.
    expect(lib.tourOfferShown({ path: "/share", search: "?room=HG+E+33.1" })).toBe(false);
    for (const q of ["?room=HG+E+33.1&area=Z", "?add=raffi", "?tutorial", "?edit", "?pins", "?buildings=HG"]) {
      expect(lib.tourOfferShown({ search: q })).toBe(false);
    }
    expect(lib.tourOfferShown({ path: "/privacy" })).toBe(false);
  });
});
