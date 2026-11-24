// Menus from Cookpit (worker/menus.ts): normalizing ETH's rotas, the places, and which facility to fetch next.
import { describe, expect, it } from "vitest";

import {
  cardMeal,
  type Dish,
  eateryPlaces,
  flagshipDish,
  fullMeals,
  isFullMeal,
  lineName,
  mealOf,
  menuHours,
  mondayOf,
  normalizeRotas,
  parseFacilities,
  pickFacility,
  hasLines,
  kindNow,
} from "../worker/menus";
import { EATERY_OVERRIDES, MENSA_ORDER, parseEateries, parseMensaOrder } from "../worker/overrides";
import { uzhMensaPlaces } from "../worker/uzhmenus";
import { parseSpaces } from "../worker/spaces";
import { readData } from "./helpers";

const rotas = (facility: number) => JSON.parse(readData("samples", `cookpit_rotas_f${facility}.json`));
const facilities = parseFacilities(JSON.parse(readData("samples", "cookpit_facilities.json"))["facility-array"]);
const spaces = parseSpaces(JSON.parse(readData("spaces_snapshot.json")));
const MONDAY = "2026-11-09"; // the samples (data/samples/cookpit_rotas_f*.json) start on this week
const zurich = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour - 1, minute); // November: UTC+1

describe("normalizing rotas", () => {
  it("turns a week into one record per day, with lunch and dinner, prices and meal types", () => {
    const rows = normalizeRotas(rotas(9), MONDAY, "2026-11-15");
    expect(rows.map((r) => r.date)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
    const monday = rows[0].day;
    expect(monday.hours).toEqual([["11:15", "19:30"]]);
    expect(monday.meals.map((m) => [m.meal, m.from, m.to])).toEqual([["lunch", "11:15", "14:00"], ["dinner", "17:30", "19:30"]]);
    const street = monday.meals[0].dishes[0];
    expect(street).toEqual({
      line: "Street", // Cookpit: STREET
      name: "Chicken Cordon Bleu",
      desc: "Tartar sauce | Lemon wedge | Herbed potatoes | Cole slaw | Onion rings",
      type: "meat",
      tags: [],
      price: { student: 10.5, internal: 12.5, external: 16.5 },
      allergens: ["gluten wheat", "eggs", "milk, lactose", "mustard", "sulfites"],
      // Per 100 g; Cookpit's `energy` is kJ, `energy-outdated` kcal.
      nutrition: { kcal: 155, kj: 649, protein: 5.5, fat: 8.9, sat_fat: 1.6, carbs: 14, sugar: 1.7, salt: 0.93 },
      image: 78456,
    });
    expect(Object.keys(street).at(-1)).toBe("image"); // isMenuImage relies on it
    expect(monday.meals[0].dishes.map((d) => d.type)).toEqual(expect.arrayContaining(["vegan", "meat"]));
    expect(monday.meals[1].dishes.find((d) => d.name === "Poly-Bowls")).toMatchObject({ line: "Poly-Bowls", type: "other", tags: ["salad"] });
    // A dish without values (Cookpit leaves the fields out) has none.
    const all = rows.flatMap((r) => r.day.meals.flatMap((m) => m.dishes));
    expect(all.some((d) => d.nutrition === null)).toBe(true);
    expect(all.every((d) => d.nutrition === null || typeof d.nutrition!.carbs === "number" || d.nutrition!.carbs === null)).toBe(true);
    // Weekends: no opening hours, closed.
    expect(rows[5].day).toEqual({ hours: [], meals: [] });
  });

  it("keeps meal times whose menus aren't published yet, without dishes", () => {
    const raw = {
      "weekly-rota-array": [{
        "facility-id": 9,
        "valid-from": MONDAY,
        "valid-to": MONDAY,
        "day-of-week-array": [{
          "day-of-week-code": 1,
          "opening-hour-array": [{
            "time-from": "11:15",
            "time-to": "19:30",
            "meal-time-array": [
              { name: "Lunch", "time-from": "11:15", "time-to": "14:00", "line-array": [] },
              { name: "Dinner", "time-from": "17:30", "time-to": "19:30" },
            ],
          }],
        }],
      }],
    };
    const next = normalizeRotas(raw, MONDAY, MONDAY);
    expect(next[0].day.meals.map((m) => [m.meal, m.from, m.dishes.length])).toEqual([["lunch", "11:15", 0], ["dinner", "17:30", 0]]);
  });

  it("covers three weeks from one answer, and tells lunch from dinner by the time, not the name", () => {
    const rows = normalizeRotas(rotas(14), MONDAY, "2026-11-29");
    expect(rows.length).toBe(21);
    expect(new Set(rows.map((r) => r.facility))).toEqual(new Set([14]));
    const wednesday = rows.find((r) => r.date === "2026-11-11")!.day;
    expect(wednesday.meals.map((m) => [m.meal, m.from, m.to])).toEqual([["lunch", "11:00", "16:00"], ["dinner", "16:00", "22:00"]]);
    expect(mealOf("14:59")).toBe("lunch");
    expect(mealOf("15:00")).toBe("dinner");
  });

  it("spreads a rota that runs for a year over every week of the window", () => {
    const rows = normalizeRotas(rotas(22), MONDAY, "2026-11-29");
    expect(rows.length).toBe(21);
    const mondays = rows.filter((r) => ["2026-11-09", "2026-11-16", "2026-11-23"].includes(r.date)).map((r) => r.day);
    expect(mondays[1]).toEqual(mondays[0]);
    expect(mondays[2]).toEqual(mondays[0]);
    expect(mondays[0].meals[0].dishes.map((d) => d.line)).toContain("Tofu Cashew Bowl"); // Cookpit: " Tofu Cashew Bowl"
  });

  it("prefers the rota that starts later where two overlap, and stays inside the window", () => {
    const day = (name: string) => ({
      "day-of-week-code": 1,
      "opening-hour-array": [{ "time-from": "11:00", "time-to": "14:00", "meal-time-array": [{ name, "time-from": "11:00", "time-to": "14:00", "line-array": [] }] }],
    });
    const raw = {
      "weekly-rota-array": [
        { "facility-id": 2, "valid-from": "2026-09-14", "valid-to": "2026-12-20", "day-of-week-array": [day("long")] },
        { "facility-id": 2, "valid-from": "2026-11-09", "valid-to": "2026-11-15", "day-of-week-array": [day("special")] },
      ],
    };
    const rows = normalizeRotas(raw, "2026-11-02", "2026-11-16");
    expect(rows.filter((r) => r.date.endsWith("-02") || r.date.endsWith("-09") || r.date.endsWith("-16")).map((r) => r.day.meals[0].name))
      .toEqual(["long", "special", "long"]);
    expect(rows.at(-1)!.date).toBe("2026-11-16");
  });

  it("reads meal types, tags and the shared prices of some places", () => {
    const meal = (classes: number[], prices: [number, number][]) => ({
      name: "LOCAL",
      meal: {
        name: "Dish",
        description: "",
        "meal-class-array": classes.map((code) => ({ code })),
        "meal-price-array": prices.map(([code, price]) => ({ "customer-group-code": code, price })),
      },
    });
    const raw = {
      "weekly-rota-array": [{
        "facility-id": 23,
        "valid-from": MONDAY,
        "valid-to": MONDAY,
        "day-of-week-array": [{
          "day-of-week-code": 1,
          "opening-hour-array": [{
            "time-from": "11:30",
            "time-to": "13:30",
            "meal-time-array": [{
              name: "Mittag",
              "time-from": "11:30",
              "time-to": "13:30",
              "line-array": [
                meal([16, 17], [[12, 9.5], [13, 12]]),
                meal([11, 10, 12], [[14, 15]]),
                meal([10, 15], []),
                meal([17, 13], []),
                meal([], []),
                { name: "EMPTY" },
              ],
            }],
          }],
        }],
      }],
    };
    const dishes = normalizeRotas(raw, MONDAY, MONDAY)[0].day.meals[0].dishes;
    expect(dishes.map((d) => [d.type, d.tags])).toEqual([
      ["vegan", []],
      ["meat", ["pasta"]],
      ["fish", ["soup"]],
      ["vegetarian", ["pizza"]],
      ["other", []],
    ]);
    expect(dishes[0].price).toEqual({ student: 9.5, internal: 9.5, external: 12 });
    expect(dishes[1].price).toEqual({ student: 15, internal: 15, external: 15 });
    expect(dishes[0].line).toBe("Local");
    expect(dishes[0].image).toBeNull();
  });

  it("title-cases only names in capitals", () => {
    expect(lineName("HOME")).toBe("Home");
    expect(lineName("SALAT & ANTIPASTI")).toBe("Salat & Antipasti");
    expect(lineName("POLY-BOWLS")).toBe("Poly-Bowls");
    expect(lineName("The Chef")).toBe("The Chef");
    expect(lineName("Hot & Cold 100g")).toBe("Hot & Cold 100g");
    expect(lineName("5uppe")).toBe("5uppe");
  });

  it("tells places with menu lines from those without", () => {
    expect(hasLines(rotas(9))).toBe(true);
    expect(hasLines({ "weekly-rota-array": [{ "day-of-week-array": [{ "opening-hour-array": [{ "time-from": "07:00", "time-to": "18:30" }] }] }] })).toBe(false);
    expect(hasLines(null)).toBe(false);
  });

  it("gives Monday of a date's week", () => {
    expect(mondayOf("2026-11-11")).toBe(MONDAY);
    expect(mondayOf("2026-11-15")).toBe(MONDAY);
    expect(mondayOf(MONDAY)).toBe(MONDAY);
  });
});

describe("the Eat tab's card", () => {
  const meals = [{ meal: "lunch" as const, from: "11:15", to: "14:00" }, { meal: "dinner" as const, from: "17:30", to: "19:30" }];
  const next = { date: "2026-11-16", meals: [{ meal: "lunch" as const, from: "11:15" }] };
  const dish = (line: string, student: number | null, name = line): Dish =>
    ({ line, name, desc: "", type: "other", tags: [], price: { student, internal: null, external: null }, allergens: [], nutrition: null, image: null });

  it("is about the meal now, else the next one today, else the next day's first", () => {
    expect(cardMeal(meals, next, "2026-11-13", "12:30")).toEqual({ date: "2026-11-13", meal: "lunch" });
    expect(cardMeal(meals, next, "2026-11-13", "15:00")).toEqual({ date: "2026-11-13", meal: "dinner" });
    expect(cardMeal(meals, next, "2026-11-13", "10:00")).toEqual({ date: "2026-11-13", meal: "lunch" });
    expect(cardMeal(meals, next, "2026-11-13", "19:30")).toEqual({ date: "2026-11-16", meal: "lunch" });
    expect(cardMeal([], next, "2026-11-14", "12:00")).toEqual({ date: "2026-11-16", meal: "lunch" });
    expect(cardMeal([], null, "2026-11-14", "12:00")).toBeNull();
  });

  it("shows the flagship line's dish (its evening line too), else the meal's most expensive one", () => {
    const dishes = [dish("Garden", 7), dish("Street", 11.5, "Nippon Burger"), dish("Local", 12), dish("Street", 9, "Fries")];
    expect(flagshipDish(dishes, "Street")!.name).toBe("Nippon Burger");
    expect(flagshipDish(dishes, "street")!.name).toBe("Nippon Burger");
    expect(flagshipDish(dishes, "Wok Street")!.line).toBe("Local");
    expect(flagshipDish(dishes, null)!.line).toBe("Local");
    expect(flagshipDish([dish("Street Abend", 9.9), dish("Poly-Bowls", 9.5)], "Street")!.line).toBe("Street Abend");
    expect(flagshipDish([dish("Buffet", null), dish("Soup", 5.9)], null)!.line).toBe("Soup");
    expect(flagshipDish([], "Street")).toBeNull();
  });

  it("is never a dish under CHF 5, even on the flagship line", () => {
    expect(flagshipDish([dish("Street", 4.8, "Kabeljau loins"), dish("Garden", 7)], "Street")!.line).toBe("Garden");
    expect(flagshipDish([dish("Salad", 2.5)], null)).toBeNull();
  });
});

describe("full meals only", () => {
  const dish = (name: string, student: number | null, internal: number | null = null, external: number | null = null): Dish =>
    ({ line: "Line", name, desc: "", type: "other", tags: [], price: { student, internal, external }, allergens: [], nutrition: null, image: null });
  const salad = dish("Salad per 100 g", 2.5, 2.5, 2.5);
  const fish = dish("Kabeljau loins", 4.8, 6.2, 7.5); // the lowest price counts
  const menu = dish("Nippon Burger", 7.5, 10.5, 13.5);

  it("leaves out dishes whose lowest price is under CHF 5, and keeps those without a price", () => {
    expect(isFullMeal(salad)).toBe(false);
    expect(isFullMeal(fish)).toBe(false);
    expect(isFullMeal(menu)).toBe(true);
    expect(isFullMeal(dish("Daily special", 5))).toBe(true);
    expect(isFullMeal(dish("Buffet", null))).toBe(true);
    expect(isFullMeal(dish("Staff only", null, 4.5))).toBe(false);
  });

  it("filters a stored day's meals without changing it", () => {
    const day = { hours: [["11:00", "14:00"]] as [string, string][], meals: [{ meal: "lunch" as const, name: "Lunch", from: "11:00", to: "14:00", dishes: [salad, menu, fish] }] };
    expect(fullMeals(day).meals[0].dishes.map((d) => d.name)).toEqual(["Nippon Burger"]);
    expect(fullMeals(day).hours).toEqual(day.hours);
    expect(day.meals[0].dishes).toHaveLength(3);
  });
});

describe("picking the facility to fetch", () => {
  const ids = [9, 14, 22];

  it("fetches each facility hourly by day, least recently fetched first", () => {
    const noon = zurich(4, 12);
    expect(pickFacility(ids, {}, noon)).toBe(9); // never fetched: by id
    const f = { 9: { at: noon - 30 * 60_000 }, 14: { at: noon - 61 * 60_000 }, 22: { at: noon - 90 * 60_000 } };
    expect(pickFacility(ids, f, noon)).toBe(22);
    expect(pickFacility([9, 14], f, noon)).toBe(14);
    expect(pickFacility([9], f, noon)).toBeNull(); // fetched half an hour ago
  });

  it("fetches every 6 hours at night", () => {
    const night = zurich(4, 23);
    const f = { 9: { at: night - 2 * 3600_000 }, 14: { at: night - 7 * 3600_000 } };
    expect(pickFacility([9, 14], f, night)).toBe(14);
    expect(pickFacility([9], f, night)).toBeNull();
    expect(pickFacility([9], f, zurich(5, 6))).toBe(9); // 06:00: day again
  });
});

describe("places", () => {
  it("reads our eatery overrides", () => {
    expect(EATERY_OVERRIDES[9]).toEqual({ space: "MMB79", area: "Z", kind: "mensa", flagship: "Street" });
    expect(EATERY_OVERRIDES[2]).toEqual({ area: "Z", kind: "cafe" });
    expect(EATERY_OVERRIDES[14]).toEqual({ name: "Alumni quattro", area: "H", kind: "mensa", flagship: "World Pot" });
    expect(EATERY_OVERRIDES[4]).toEqual({ mergeInto: 3 }); // Kiosk CLA, part of Clausiusbar
    expect(EATERY_OVERRIDES[23]).toEqual({ hidden: true }); // Octavo (CHOICES.md)
    const odd = parseEateries({ _about: "x", "1": { kind: "bar", hidden: true, name: " " }, abc: { area: "Z" }, "2": null, "3": { merge_into: "x" } });
    expect(odd).toEqual({ 1: { hidden: true }, 3: {} });
  });

  it("links study spaces that serve food and adds the places with menus only", () => {
    const places = eateryPlaces(facilities, spaces);
    const poly = places.find((p) => p.facility === 9)!;
    expect(poly).toMatchObject({ id: "MMB79", name: "Mensa Polyterrasse", building: "MM", floor: "B", area: "Z", space: "MMB79" });
    const bellavista = places.find((p) => p.facility === 15)!;
    expect(bellavista).toEqual({ id: "F15", facility: 15, name: "Bellavista", building: "HGP", floor: "E", area: "H", kind: "cafe", cafeOutsideMeals: false, space: null, flagship: null });
    expect(places.find((p) => p.facility === 14)!.name).toBe("Alumni quattro");
    expect(places.find((p) => p.facility === 6)).toMatchObject({ id: "MMC81", kind: "cafe" });
    expect(places.find((p) => p.facility === 3)!.id).toBe("CLAD5"); // CLAD1.1 is merged into it
    // Every entry but Octavo (hidden) and Kiosk CLA (merged into Clausiusbar).
    expect(places.length).toBe(Object.keys(EATERY_OVERRIDES).length - 2);
    expect(places.find((p) => p.facility === 23 || p.facility === 4)).toBeUndefined();
  });

  it("leaves out hidden and merged places and those it can't place", () => {
    const overrides = { 15: { area: "H", hidden: true }, 4: { area: "Z", mergeInto: 3 }, 23: {}, 99: { area: "Z" }, 9: { space: "NOPE" }, 16: { area: "H", building: "HXX" } };
    expect(eateryPlaces(facilities, spaces, overrides).map((p) => [p.id, p.building])).toEqual([["F16", "HXX"]]);
  });

  it("makes a place a bar outside its meal times only if we say so; Tannenbar is a mensa all day (CHOICES.md)", () => {
    const tannenbar = eateryPlaces(facilities, spaces).find((p) => p.facility === 11)!;
    expect(tannenbar).toMatchObject({ kind: "mensa", cafeOutsideMeals: false });
    expect(kindNow(tannenbar, false)).toBe("mensa");
    const bar = eateryPlaces(facilities, spaces, { 11: { area: "Z", kind: "mensa", cafeOutsideMeals: true } })[0];
    expect(kindNow(bar, true)).toBe("mensa");
    expect(kindNow(bar, false)).toBe("cafe");
    const poly = eateryPlaces(facilities, spaces).find((p) => p.facility === 9)!;
    expect(kindNow(poly, false)).toBe("mensa");
    const uzh = new Map(uzhMensaPlaces().map((p) => [p.id, p]));
    expect([uzh.get("UM2")!.cafeOutsideMeals, uzh.get("UM3")!.cafeOutsideMeals]).toEqual([false, false]); // Untere Mensa, Rämi 59
  });

  it("keeps Mensa Polyterrasse when ETH's live list has lost its study space", () => {
    const without = spaces.filter((s) => s.id !== "MMB79");
    const poly = eateryPlaces(facilities, without).find((p) => p.facility === 9)!;
    expect(poly).toEqual({ id: "MMB79", facility: 9, name: "Mensa Polyterrasse", building: "MM", floor: "B", area: "Z", kind: "mensa", cafeOutsideMeals: false, space: null, flagship: "Street" });
    // Without Cookpit's record its building is the one whose label it is (data/overrides.json buildings.MM.place).
    const noRecord = eateryPlaces(facilities.filter((f) => f.id !== 9), without, { 9: { space: "MMB79", area: "Z", kind: "mensa", name: "Poly" } });
    expect(noRecord).toMatchObject([{ id: "MMB79", building: "MM", floor: null }]);
  });

  it("orders each location's mensas by places that exist (data/overrides.json mensa_order)", () => {
    const ids = new Set([...eateryPlaces(facilities, spaces), ...uzhMensaPlaces()].filter((p) => p.kind === "mensa").map((p) => p.id));
    expect(MENSA_ORDER.Z).toEqual(["MMB79", "UM1", "UM2", "CLAD5", "F8", "UM4", "CABH41", "UM3", "F10", "F11", "UM5", "F5"]);
    for (const list of Object.values(MENSA_ORDER)) for (const id of list) expect(ids).toContain(id);
    expect(parseMensaOrder({ _about: "x", Z: ["A", "A", 3, " B "], H: "nope" })).toEqual({ Z: ["A", "B"] });
  });

  it("is a mensa only if we say so (CHOICES.md); everything else is a cafeteria", () => {
    const places = eateryPlaces(facilities, spaces);
    const mensas = places.filter((p) => p.kind === "mensa").map((p) => p.name).sort();
    expect(mensas).toEqual(["Alumni quattro", "Archimedes", "Clausiusbar", "Dozentenfoyer", "FUSION meal", "Mendokoro", "Mensa Polyterrasse", "Polysnack", "Rice Up!", "Tannenbar", "food market", "food&lab"].sort());
    expect(eateryPlaces(facilities, spaces, { 15: { area: "H" } })[0].kind).toBe("cafe");
  });

  it("builds opening hours from Cookpit's days, with late dinners counted as open", () => {
    const days = new Map(normalizeRotas(rotas(14), MONDAY, "2026-11-15").map((r) => [r.date, r.day]));
    const h = menuHours(days, "2026-11-11"); // Wednesday
    expect(h.open[2]).toEqual([[480, 1320]]); // 08:00-20:00, dinner until 22:00
    expect(h.meals[2]).toEqual([[660, 960], [960, 1320]]);
    expect(h.open[5]).toEqual([]); // Saturday
    expect(h.open[0]).toEqual([]); // Monday the 16th isn't in `days`: closed
  });
});
