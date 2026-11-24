import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UZH_MENU_REQUESTS_PER_RUN } from "../worker/config";
import type { MenuDay } from "../worker/menus";
import { clearStoreMemory } from "../worker/store";
import { parseNaive } from "../worker/tz";
import {
  Food2050Error,
  isDishUrl,
  isoWeek,
  mergeWeek,
  parseDishPage,
  photoName,
  photoless,
  parseWeek,
  unpriced,
  UZH_MENSAS,
  uzhDish,
  uzhLine,
  uzhMensaPlaces,
  weekUrl,
  withDetails,
} from "../worker/uzhmenus";
import { duePages, menuPages, runUzhMenuPrefetch } from "../worker/uzhprefetch";
import { FakeD1, readData } from "./helpers";

// Real pages (only their data scripts kept): Obere Mensa's lunch in weeks 46 and 47 of 2026, Untere Mensa's dinner in
// week 46, one dish page (Menu 1 on 2026-11-17) and Lichthof's week without dishes (closed for building work).
const WEEK46 = readData("samples", "food2050_week_obere_mensa_w46.html");
const WEEK47 = readData("samples", "food2050_week_obere_mensa_w47.html");
const DINNER46 = readData("samples", "food2050_week_untere_mensa_dinner_w46.html");
const DISH = readData("samples", "food2050_dish_obere_mensa_menu1.html");
const EMPTY = readData("samples", "food2050_week_lichthof_empty.html");
const DISH_ID = "cmufhkn3p05sl0ds611j0lup7";

const byId = new Map(UZH_MENSAS.map((m) => [m.id, m]));
const OBERE = byId.get("UM1")!;
const UNTERE = byId.get("UM2")!;
const lunch = (m = OBERE) => m.meals.find((x) => x.meal === "lunch")!;
const dinner = UNTERE.meals.find((x) => x.meal === "dinner")!;

describe("mensas", () => {
  it("are places with menus, with ids and menu keys of their own", () => {
    const all = uzhMensaPlaces();
    const places = all.filter((p) => p.id.startsWith("UM"));
    expect(places.every((p) => /^UM\d+$/.test(p.id) && p.facility > 100_000 && p.kind === "mensa" && p.study && !p.cafeOutsideMeals && !p.space)).toBe(true);
    // The cafés without menus: open by their own hours, menu keys no mensa has.
    const cafes = all.filter((p) => !p.id.startsWith("UM"));
    expect(cafes.map((p) => [p.id, p.name, p.kind, p.weekHours])).toEqual([
      ["UC1", "The Yard", "cafe", ["09:00", "14:00"]],
      ["UC2", "Irchel Bar", "cafe", ["11:00", "23:00"]],
    ]);
    expect(Math.min(...cafes.map((p) => p.facility))).toBeGreaterThan(Math.max(...places.map((p) => p.facility)));
    expect(new Set(places.map((p) => p.id)).size).toBe(places.length);
    expect(new Set(places.map((p) => p.facility)).size).toBe(places.length);
    expect(new Set(places.map((p) => p.area))).toEqual(new Set(["UZ", "UI", "UO"]));
  });

  it("finds a week's page by its ISO week", () => {
    expect(isoWeek("2026-11-13")).toEqual({ week: 46, year: 2026 });
    expect(isoWeek("2026-11-16")).toEqual({ week: 47, year: 2026 });
    expect(isoWeek("2026-12-28")).toEqual({ week: 53, year: 2026 });
    expect(isoWeek("2027-01-01")).toEqual({ week: 53, year: 2026 });
    expect(isoWeek("2027-01-04")).toEqual({ week: 1, year: 2027 });
    expect(weekUrl(OBERE, lunch(), "2026-11-16")).toBe(
      "https://app.food2050.ch/en/zfv/universitat-zurich,campus-zentrum/obere-mensa/lunch/menu/weekly?week=47&year=2026",
    );
    expect(isDishUrl("https://app.food2050.ch/en/zfv/universitat-zurich,campus-zentrum/obere-mensa/lunch,menu-1/2026-11-17")).toBe(true);
    expect(isDishUrl("https://example.com/2026-11-17")).toBe(false);
  });
});

describe("pages", () => {
  it("reads a week's days and dishes, following the references to repeated objects", () => {
    const week = parseWeek(WEEK46);
    expect(week.dates).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
    expect(week.items).toHaveLength(20);
    expect(week.items.filter((i) => i.date === "2026-11-14")).toEqual([]);
    expect(week.items[0]).toMatchObject({
      date: "2026-11-09",
      category: "Menu 1",
      name: "SCHUPF NOODLES",
      vegetarian: true,
      vegan: false,
      allergens: ["cerealsContainingGluten", "eggs", "milk", "sulphites"],
      url: "https://app.food2050.ch/en/zfv/universitat-zurich,campus-zentrum/obere-mensa/lunch,menu-1/2026-11-09",
    });
    // The category and allergens only as references to the first dish's.
    expect(week.items.find((i) => i.id === "cmuds59t303h40ds6m5kfa3qw")).toMatchObject({ category: "Menu 2", allergens: ["milk", "sulphites"] });
    expect(week.items.every((i) => i.category && i.name)).toBe(true);
    // food2050's climate rating, on every dish of the week.
    expect(week.items.map((i) => i.climate).filter((c) => c === "high")).toHaveLength(1);
    expect(new Set(week.items.map((i) => i.climate))).toEqual(new Set(["low", "medium", "high"]));
    expect(parseWeek(WEEK46.replace('rating\\":\\"LOW', 'rating\\":\\"EXTREME')).items[0].climate).toBeNull();
  });

  it("reads the next week's page, and a week without dishes", () => {
    const next = parseWeek(WEEK47);
    expect(next.dates[0]).toBe("2026-11-16");
    expect(next.items.length).toBeGreaterThan(0);
    expect(parseWeek(EMPTY)).toMatchObject({ items: [] });
    expect(parseWeek(EMPTY).dates).toHaveLength(7);
  });

  it("fails loudly on a page without a week", () => {
    expect(() => parseWeek("<html><body>Not found</body></html>")).toThrow(Food2050Error);
    expect(() => parseWeek(DISH)).toThrow(Food2050Error);
  });

  it("reads a dish page's prices by group and its nutrition per 100 g", () => {
    const nutrition = { kcal: 222.3, kj: 930, protein: 4.3, fat: 17.3, sat_fat: 3.6, carbs: 11.2, sugar: 3.6, salt: 0.89 };
    expect(parseDishPage(DISH)).toEqual(new Map([[DISH_ID, { price: { student: 7.5, internal: 10.5, external: 15 }, nutrition, image: null }]]));
    expect(parseDishPage(WEEK46).size).toBe(0);
    // A dish without a price says 0: no price.
    const free = parseDishPage(DISH.replace('"amount\\":\\"7.5\\"', '"amount\\":\\"0\\"'));
    expect(free.get(DISH_ID)!.price).toEqual({ student: null, internal: 10.5, external: 15 });
    // A dish without values: null.
    const none = parseDishPage(DISH.replaceAll("amountPer100g", "amountPerSomething"));
    expect(none.get(DISH_ID)!.nutrition).toBeNull();
    // A photo: its object name in food2050's bucket; nothing else is taken.
    const name = "dish-media/zfv/9bf4ca97-93ec-465d-b28d-23331d945e5c/2026-11-16-mittagsverpflegung-one/1794824450945-u5ohdidc3v";
    const url = `https://storage.googleapis.com/dish-images-prod/${encodeURIComponent(name)}`;
    expect(parseDishPage(DISH.replace('imageUrl\\":null', `imageUrl\\":\\"${url}\\"`)).get(DISH_ID)!.image).toBe(name);
    expect(photoName(url)).toBe(name);
    expect(photoName("https://example.com/dish-images-prod/x.jpg")).toBeNull();
    expect(photoName("https://storage.googleapis.com/dish-images-prod/..%2F..%2Fother-bucket%2Fx")).toBeNull();
  });
});

describe("as our menus", () => {
  it("names the lines as ETH's are named", () => {
    expect(uzhLine("Menu 1")).toBe("Menu 1");
    expect(uzhLine("butcher at dinner")).toBe("Butcher");
    expect(uzhLine("pure asia")).toBe("Pure Asia");
    expect(uzhLine("Yin `n` Yang     Bar")).toBe("Yin 'n' Yang Bar");
  });

  it("makes dishes of ETH's shape, meat only when a dish names one", () => {
    const [first] = parseWeek(WEEK46).items;
    const dish = uzhDish(first);
    expect(dish).toMatchObject({ line: "Menu 1", name: "Schupf Noodles", type: "vegetarian", tags: [], image: null });
    expect(dish.allergens).toEqual(["gluten", "eggs", "milk, lactose", "sulfites"]);
    expect(dish.src).toEqual({ id: first.id, url: first.url });
    expect(Object.keys(dish).at(-1)).toBe("image"); // isMenuImage relies on it
    expect(dish.climate).toBe(first.climate);
    expect(uzhDish({ ...first, climate: null }).climate).toBeNull();
    const fish = uzhDish({ ...first, vegetarian: false, allergens: ["fish"] });
    expect(fish.type).toBe("fish");
    expect(uzhDish({ ...first, vegetarian: false, allergens: [] }).type).toBe("other");
    const typed = (name: string, desc = "", allergens: string[] = []) => uzhDish({ ...first, vegetarian: false, name, desc, allergens }).type;
    expect(typed("Breaded Pork Schnitzel", "French fries")).toBe("meat");
    expect(typed("Gnocchi", "grapes, sage, bacon, walnuts")).toBe("meat");
    expect(typed("Bratwurst / Currywurst")).toBe("meat");
    expect(typed("Ghackets Rindfleisch mit viel Gemüse")).toBe("meat");
    expect(typed("Burger Rind Beef Brioche Bun", "Cocktailsauce", ["fish", "eggs"])).toBe("meat"); // meat and fish: meat
    expect(typed("Vegetables Schnitzel", "Cocktailsauce, French fries, mixed vegetables")).toBe("other");
    expect(typed("Pasta", "A new creation every day, Vegetarian or with meat")).toBe("other");
    expect(typed("Apfel-Peperoni Gulasch", "Tagesbeilage")).toBe("other");
    expect(typed("Curry Sauce Thai rot vegan", "Schwein Geschnetzeltes")).toBe("other");
    expect(uzhDish({ ...first, category: "Tagessuppe" }).tags).toEqual(["soup"]);
  });

  it("merges a meal's week into the stored days, keeping the other meal and known prices", () => {
    const lunchDay: MenuDay = {
      hours: [["10:00", "19:30"]],
      meals: [{ meal: "lunch", name: "Lunch", from: "11:00", to: "14:30", dishes: [] }],
    };
    const dinnerWeek = parseWeek(DINNER46);
    const first = mergeWeek(UNTERE, dinner, dinnerWeek, new Map([["2026-11-09", lunchDay]]));
    const monday = first.get("2026-11-09")!;
    expect(monday.meals.map((m) => m.meal)).toEqual(["lunch", "dinner"]);
    expect(monday.meals[1]).toMatchObject({ name: "Dinner", from: "17:00", to: "19:00" });
    expect(monday.meals[1].dishes.map((d) => d.line)).toEqual(["Garden", "Butcher"]);
    expect(monday.hours).toEqual([["10:00", "19:30"]]);
    expect(first.get("2026-11-14")).toBeNull(); // Saturday: closed

    // Prices and nutrition found later stay when the week is read again.
    const nutrition = { kcal: 150, kj: 628, protein: 8, fat: 5, sat_fat: 1, carbs: 20, sugar: 2, salt: 0.5 };
    const id = monday.meals[1].dishes[0].src!.id;
    const priced = withDetails(monday, new Map([[id, { price: { student: 7, internal: 9, external: 12 }, nutrition, image: null }]]))!;
    expect(priced.meals[1].dishes[0]).toMatchObject({ price: { student: 7, internal: 9, external: 12 }, nutrition });
    expect(Object.keys(priced.meals[1].dishes[0]).at(-1)).toBe("image");
    expect(unpriced(priced)).toHaveLength(1);
    expect(withDetails(priced, new Map())).toBeNull();
    const again = mergeWeek(UNTERE, dinner, dinnerWeek, new Map([["2026-11-09", priced]]));
    expect(again.get("2026-11-09")!.meals[1].dishes[0]).toMatchObject({ price: { student: 7 }, nutrition });
    expect(Object.keys(again.get("2026-11-09")!.meals[1].dishes[0]).at(-1)).toBe("image");
    // A priced dish without nutrition yet has its page read once; a page without values settles it as null.
    const second = monday.meals[1].dishes[1].src!.id;
    const settled = withDetails(priced, new Map([[second, { price: { student: 8, internal: null, external: null }, nutrition: null, image: null }]]))!;
    expect(settled.meals[1].dishes[1].nutrition).toBeNull();
    expect(unpriced(settled)).toHaveLength(0);
    // A photo found later is kept last, also when the week is read again; dishes without one are still to be read for it.
    expect(photoless(settled).map((d) => d.src.id)).toEqual([id, second]);
    const photo = "dish-media/zfv/a/2026-11-09-abendverpflegung-garden/1-x";
    const shown = withDetails(settled, new Map([[id, { price: { student: 7, internal: 9, external: 12 }, nutrition, image: photo }]]))!;
    expect(shown.meals[1].dishes[0].image).toBe(photo);
    expect(Object.keys(shown.meals[1].dishes[0]).at(-1)).toBe("image");
    expect(photoless(shown).map((d) => d.src.id)).toEqual([second]);
    expect(mergeWeek(UNTERE, dinner, dinnerWeek, new Map([["2026-11-09", shown]])).get("2026-11-09")!.meals[1].dishes[0].image).toBe(photo);
  });
});

describe("prefetch", () => {
  const UA = "frooms-test";
  const WED = parseNaive("2026-11-11T11:00")!; // Wednesday of week 46, in Zurich
  let db: FakeD1;
  let calls: string[];
  const days = (facility: number) =>
    db.rows(`SELECT date, data FROM menu_days WHERE facility = ${facility} ORDER BY date`).map((r) => ({ date: r.date as string, day: JSON.parse(r.data as string) as MenuDay }));
  const state = () => JSON.parse(db.rows("SELECT value FROM meta WHERE key = 'uzh_menus'")[0].value as string);

  /** food2050 as far as the samples go: Obere Mensa's weeks 46 and 47 for every lunch, Untere Mensa's dinner, and dish pages. */
  function fake({ busy = false, broken = false } = {}) {
    return async (url: string) => {
      calls.push(url);
      if (busy) return new Response("slow down", { status: 429, headers: { "Retry-After": "600" } });
      if (broken) return new Response("<html>maintenance</html>");
      if (url.includes("/menu/weekly")) {
        if (url.includes("abendverpflegung")) return new Response(url.includes("week=46") ? DINNER46 : EMPTY);
        return new Response(url.includes("week=46") ? WEEK46 : url.includes("week=47") ? WEEK47 : EMPTY);
      }
      // A dish page: the sample's, with the asked dish's id.
      const item = [...parseWeek(WEEK46).items, ...parseWeek(WEEK47).items].find((i) => i.url === url);
      return new Response(item ? DISH.replaceAll(DISH_ID, item.id) : "<html></html>");
    };
  }

  beforeEach(() => {
    clearStoreMemory();
    db = new FakeD1();
    calls = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const run = (now = WED) => runUzhMenuPrefetch({ DB: db.asD1() }, UA, now, 0);

  it("keeps three weeks of every meal, this week's most often", () => {
    const pages = menuPages("2026-11-11");
    expect(pages.length).toBe(3 * UZH_MENSAS.reduce((n, m) => n + m.meals.length, 0));
    expect(pages[0]).toMatchObject({ key: "UM1|lunch|2026-11-09", week: 0 });
    const fetched = Object.fromEntries(pages.map((p) => [p.key, WED - 2 * 3600_000]));
    // Two hours ago: this week's are due again (hourly by day), the later weeks' not yet (every 6 hours).
    expect(duePages(pages, fetched, WED).every((p) => p.week === 0)).toBe(true);
    expect(duePages(pages, {}, WED)[0].key).toBe("UM1|lunch|2026-11-09");
  });

  it("reads a few pages a run and stores their days like ETH's menus", async () => {
    vi.stubGlobal("fetch", fake());
    const first = await run();
    expect(first).toMatchObject({ requests: UZH_MENU_REQUESTS_PER_RUN, pages: UZH_MENU_REQUESTS_PER_RUN, failed: 0 });
    expect(calls[0]).toContain("obere-mensa/lunch/menu/weekly?week=46&year=2026");
    expect(calls.every((c) => c.startsWith("https://app.food2050.ch/en/zfv/universitat-zurich,"))).toBe(true);
    const obere = days(OBERE.facility);
    expect(obere.map((d) => d.date)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(obere[2].day).toMatchObject({ hours: [["11:00", "15:00"]], meals: [{ meal: "lunch", from: "11:00", to: "14:30" }] });
    expect(obere[2].day.meals[0].dishes).toHaveLength(4);
    expect(Object.keys(state().pages)).toHaveLength(UZH_MENU_REQUESTS_PER_RUN);

    // The next run: a weekly page, one of today's dishes' prices (more pages are due), then the next page.
    calls.length = 0;
    const second = await run(WED + 240_000);
    expect(second).toMatchObject({ requests: UZH_MENU_REQUESTS_PER_RUN, pages: UZH_MENU_REQUESTS_PER_RUN - 1, priced: 1, failed: 0 });
    expect(calls[1]).toMatch(/lunch,menu-\d\/2026-11-11$/);
    const today = days(OBERE.facility).find((d) => d.date === "2026-11-11")!.day;
    expect(today.meals[0].dishes.filter((d) => d.price.student === 7.5)).toHaveLength(1);
    expect(unpriced(today)).toHaveLength(3);

    // Once no more than one weekly page is due, the rest of a run goes to prices.
    const fetched = Object.fromEntries(menuPages("2026-11-11").map((p) => [p.key, WED]));
    db.db.prepare("UPDATE meta SET value = ? WHERE key = 'uzh_menus'").run(JSON.stringify({ ...state(), pages: fetched }));
    const third = await run(WED + 480_000);
    expect(third).toMatchObject({ pages: 0, priced: UZH_MENU_REQUESTS_PER_RUN });
  });

  it("reads today's and tomorrow's dishes without a photo again every 6 hours, until they have one", async () => {
    vi.stubGlobal("fetch", fake());
    await run();
    const fetched = Object.fromEntries(menuPages("2026-11-11").map((p) => [p.key, WED + 3 * 3600_000]));
    const settle = (at: number) => db.db.prepare("UPDATE meta SET value = ? WHERE key = 'uzh_menus'").run(JSON.stringify({ ...state(), pages: fetched, updated: at }));
    settle(WED);
    // Every dish page read once (prices, nutrition; the sample has no photo).
    for (let i = 1; i <= 20; i++) await run(WED + i * 240_000);
    const todays = () => days(OBERE.facility).find((d) => d.date === "2026-11-11")!.day.meals[0].dishes;
    expect(todays().every((d) => d.nutrition !== undefined && d.image === null)).toBe(true);
    calls.length = 0;
    await run(WED + 2 * 3600_000);
    expect(calls).toEqual([]); // not again within 6 hours
    // Later the page has a photo: today's and tomorrow's dishes are read again, Friday's aren't.
    const name = "dish-media/zfv/a/2026-11-11-lunch-menu-1/1-x";
    const url = `https://storage.googleapis.com/dish-images-prod/${encodeURIComponent(name)}`;
    const base = fake();
    vi.stubGlobal("fetch", async (u: string) => {
      const resp = await base(u);
      return u.includes("/menu/weekly") ? resp : new Response((await resp.text()).replace('imageUrl\\":null', `imageUrl\\":\\"${url}\\"`));
    });
    const later = WED + 7 * 3600_000; // more than 6 hours after the last reads
    db.db.prepare("UPDATE meta SET value = ? WHERE key = 'uzh_menus'").run(JSON.stringify({ ...state(), pages: Object.fromEntries(Object.keys(fetched).map((k) => [k, later])) }));
    calls.length = 0;
    await run(later);
    expect(calls).toHaveLength(UZH_MENU_REQUESTS_PER_RUN);
    expect(calls.every((c) => /\/2026-11-1[12]$/.test(c))).toBe(true);
    expect(todays().filter((d) => d.image === name).length).toBeGreaterThan(0);
  });

  it("keeps the stored days when a page can't be read", async () => {
    vi.stubGlobal("fetch", fake());
    await run();
    const before = days(OBERE.facility);
    vi.stubGlobal("fetch", fake({ broken: true }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const later = WED + 2 * 3600_000; // this week's pages are due again
    const res = await run(later);
    // The weekly pages fail; the dish page just has no prices (tried again a day later).
    expect(res).toMatchObject({ failed: UZH_MENU_REQUESTS_PER_RUN - 1, pages: 0, priced: 1 });
    expect(days(OBERE.facility)).toEqual(before);
    expect(Object.keys(state().priced)).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("UZH menu parse failed"));
  });

  it("backs off when food2050 says it's busy, and skips runs until then", async () => {
    vi.stubGlobal("fetch", fake({ busy: true }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await run();
    expect(res).toMatchObject({ requests: 1, pages: 0 });
    expect(state().backoffUntil).toBeGreaterThanOrEqual(WED + 599_000);
    expect(await run(WED + 240_000)).toMatchObject({ skipped: "backoff", requests: 0 });
  });
});
