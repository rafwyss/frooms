// UZH's menus, from ZFV's food2050 pages (app.food2050.ch), which UZH's mensa site links to. ZFV's own API needs a key
// we don't have; the pages are public and carry the same data. Everything here is pure, so it can be tested on saved
// pages; the fetching is in uzhprefetch.ts (runUzhMenuPrefetch).
//
// A page is a Next.js page: its data sits in `self.__next_f.push([1,"…"])` scripts, which joined make the React
// Server Components payload, one row per line ("14:[…]"). The menu is a GraphQL answer inside one row. An object that
// appears twice (a dish's category, an allergen) is there once, then as a reference to where it was first:
// "$14:props:outlet:…:allergen" (row 14, then the path; "props" is an element's props).
//
// Two kinds of page: a mensa's week for one meal (…/<outlet>/<meal>/menu/weekly?week=46&year=2026), with every
// dish but no prices; and a dish's own page (…/<outlet>/<meal>,menu-1/2026-11-17), with its prices.

import file from "../data/uzh.json";
import { FOOD2050_PHOTO, FOOD2050_PHOTO_URL, FOOD2050_URL } from "./config";
import { type ClimateRating, type Dish, type DishType, lineName, type MealName, type MenuDay, type Nutrition, nutritionOrNull, type Place } from "./menus";
import type { IsoDate } from "./tz";

/** A meal of a UZH mensa (data/uzh.json `mensas`): food2050's slug for it, and its times. */
export interface UzhMeal {
  meal: MealName;
  slug: string;
  from: string;
  to: string;
}

/** One UZH mensa, as data/uzh.json `mensas` has it. */
export interface UzhMensa {
  id: string; // ours: UM1, UM2, …
  facility: number; // its menu_days key, far above Cookpit's ids
  name: string;
  area: string;
  building: string;
  floor: string | null;
  site: string; // food2050's slugs: …/universitat-zurich,<site>/<outlet>
  outlet: string;
  meals: UzhMeal[];
  hours: [string, string]; // Monday to Friday
}

/** A UZH cafeteria or bar without menus (data/uzh.json `cafes`): open by its hours, kept by hand. */
export interface UzhCafe {
  id: string; // ours: UC1, UC2, …
  name: string;
  area: string;
  building: string;
  floor: string | null;
  hours: [string, string]; // Monday to Friday
  url: string; // its zfv.ch page
}

export const UZH_MENSAS = file.mensas as unknown as UzhMensa[];
export const UZH_CAFES = file.cafes as unknown as UzhCafe[];
// The cafés' facility keys: never in menu_days (UZH's mensas count up from 100001, these from 100101).
const CAFE_FACILITY = 100100;

export class Food2050Error extends Error {}

/**
 * UZH's mensas as places with menus (worker/menus.ts Place): open and not serving, they are study spaces (CHOICES.md);
 * then its cafés and bars without menus, open by their hours.
 */
export const uzhMensaPlaces = (mensas: UzhMensa[] = UZH_MENSAS, cafes: UzhCafe[] = UZH_CAFES): Place[] => [
  ...mensas.map((m) => ({
    id: m.id,
    facility: m.facility,
    name: m.name,
    building: m.building,
    floor: m.floor,
    area: m.area,
    kind: "mensa" as const,
    cafeOutsideMeals: false,
    study: true,
    space: null,
    flagship: null, // UZH's lines have no fixed names: the card shows the meal's most expensive dish
  })),
  ...cafes.map((c, i) => ({
    id: c.id,
    facility: CAFE_FACILITY + 1 + i,
    name: c.name,
    building: c.building,
    floor: c.floor,
    area: c.area,
    kind: "cafe" as const,
    cafeOutsideMeals: false,
    space: null,
    flagship: null,
    weekHours: c.hours,
  })),
];

/** The ISO week a day is in: 2026-11-13 is week 46 of 2026. */
export function isoWeek(date: IsoDate): { week: number; year: number } {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  d.setUTCDate(d.getUTCDate() + 3 - day); // the week's Thursday decides its year
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const firstThursday = Date.UTC(year, 0, 4 + 3 - ((jan4.getUTCDay() + 6) % 7));
  return { week: 1 + Math.round((d.getTime() - firstThursday) / (7 * 86400_000)), year };
}

/** The weekly page of one meal, for the week `monday` is in. */
export function weekUrl(m: UzhMensa, meal: UzhMeal, monday: IsoDate): string {
  const { week, year } = isoWeek(monday);
  return `${FOOD2050_URL},${m.site}/${m.outlet}/${meal.slug}/menu/weekly?week=${week}&year=${year}`;
}

/** Only dish pages of our own mensas are fetched (the address comes from a page). */
export const isDishUrl = (url: string) => url.startsWith(`${FOOD2050_URL},`) && /\/\d{4}-\d{2}-\d{2}$/.test(url);

// --- the page's payload ---

const PUSH = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;

/** The payload rows of a page, parsed when asked for, and the references between them resolved. */
class Payload {
  private readonly raw = new Map<string, string>();
  private readonly parsed = new Map<string, unknown>();

  constructor(html: string) {
    let text = "";
    for (const m of html.matchAll(PUSH)) {
      try {
        text += JSON.parse(`"${m[1]}"`) as string;
      } catch {
        throw new Food2050Error("unreadable page script");
      }
    }
    for (const line of text.split(/\n(?=[0-9a-f]+:)/)) {
      const i = line.indexOf(":");
      if (i > 0) this.raw.set(line.slice(0, i), line.slice(i + 1));
    }
  }

  /** The rows that mention `typename`, parsed. */
  rowsWith(typename: string): unknown[] {
    const ids = [...this.raw.keys()].filter((id) => this.raw.get(id)!.includes(`"${typename}"`));
    return ids.map((id) => this.row(id)).filter((r) => r !== null);
  }

  private row(id: string): unknown {
    if (!this.parsed.has(id)) {
      const raw = this.raw.get(id)?.trim() ?? "";
      let value: unknown = null;
      if (raw.startsWith("[") || raw.startsWith("{")) {
        try {
          value = JSON.parse(raw);
        } catch {
          value = null;
        }
      }
      this.parsed.set(id, value);
    }
    return this.parsed.get(id);
  }

  /** A value, or what its reference ("$14:props:outlet:…") points to. */
  resolve(v: unknown): any {
    if (typeof v !== "string") return v;
    const m = /^\$([0-9a-f]+):(.+)$/.exec(v);
    if (!m) return v;
    let cur: any = this.row(m[1]);
    for (const seg of m[2].split(":")) {
      if (Array.isArray(cur) && seg === "props" && cur[0] === "$") cur = cur[3];
      else if (cur && typeof cur === "object") cur = cur[seg];
      else return undefined;
    }
    return cur;
  }
}

/** Every object of a GraphQL type in a parsed row (not following references). */
function* objectsOf(v: unknown, typename: string, depth = 0): Generator<any> {
  if (depth > 40 || !v || typeof v !== "object") return;
  if (!Array.isArray(v) && (v as any).__typename === typename) yield v;
  for (const child of Array.isArray(v) ? v : Object.values(v)) yield* objectsOf(child, typename, depth + 1);
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const DATE = /^(\d{4}-\d{2}-\d{2})T/;

// --- a week ---

/** One dish of a weekly page. */
export interface Food2050Item {
  id: string; // the menu item's id (its dish page has the same)
  date: IsoDate;
  category: string; // "Menu 1", "garden", "butcher at dinner"
  name: string;
  desc: string;
  vegan: boolean;
  vegetarian: boolean;
  allergens: string[]; // food2050's ids: "cerealsContainingGluten", "milk", …
  climate: ClimateRating | null; // food2050's climate rating (dish.stats.food2050climateImpact.rating)
  url: string | null; // the dish's page
}

const CLIMATE: Record<string, ClimateRating> = { LOW: "low", MEDIUM: "medium", HIGH: "high" };

/** A dish's climate rating from its `stats`, or null (none, or a rating we don't know). */
function climateRating(stats: any, page: Payload): ClimateRating | null {
  const rating = page.resolve(page.resolve(stats)?.food2050climateImpact)?.rating;
  return typeof rating === "string" && Object.hasOwn(CLIMATE, rating) ? CLIMATE[rating] : null;
}

export interface Food2050Week {
  dates: IsoDate[]; // every day the page covers, with dishes or not
  items: Food2050Item[];
}

/** A weekly page's days and dishes. Throws when the page has no week at all (a new format, or an error page). */
export function parseWeek(html: string): Food2050Week {
  const page = new Payload(html);
  for (const row of page.rowsWith("OutletMenuCategoryCalendarRange")) {
    for (const range of objectsOf(row, "OutletMenuCategoryCalendarRange")) {
      if (!Array.isArray(range.daily)) continue;
      const dates: IsoDate[] = [];
      const items: Food2050Item[] = [];
      for (const day of range.daily.map((d: unknown) => page.resolve(d))) {
        const date = DATE.exec(str(page.resolve(day?.from)?.dateLocal))?.[1];
        if (!date) continue;
        dates.push(date);
        for (const item of (Array.isArray(day.menuItems) ? day.menuItems : []).map((i: unknown) => page.resolve(i))) {
          if (item?.__typename !== "OutletMenuItemDish") continue;
          const dish = page.resolve(item.dish);
          const name = str(dish?.name);
          if (!str(item.id) || !name) continue;
          const allergens = (Array.isArray(dish.allergens) ? dish.allergens : [])
            .map((a: unknown) => str(page.resolve(page.resolve(a)?.allergen)?.externalId))
            .filter(Boolean);
          const url = str(item.detailUrl);
          items.push({
            id: str(item.id),
            date,
            category: str(page.resolve(item.category)?.name),
            name,
            desc: str(dish.description),
            vegan: dish.isVegan === true,
            vegetarian: dish.isVegetarian === true || dish.isVegan === true,
            allergens,
            climate: climateRating(dish.stats, page),
            url: isDishUrl(url) ? url : null,
          });
        }
      }
      if (dates.length) return { dates, items };
    }
  }
  throw new Food2050Error("no week on the page");
}

// --- a dish's prices ---

// food2050's price groups (German even on its English pages).
const PRICE_GROUPS: Record<string, keyof Dish["price"]> = {
  studierende: "student",
  students: "student",
  mitarbeitende: "internal",
  staff: "internal",
  employees: "internal",
  externe: "external",
  external: "external",
  guests: "external",
};

/** What a dish's page tells: its prices, its nutrition per 100 g and its photo (null when the page has none). */
export interface DishDetails {
  price: Dish["price"];
  nutrition: Nutrition | null;
  image: string | null; // the photo's object name in food2050's bucket (FOOD2050_PHOTO)
}

/** A dish photo's object name from its address on the page, or null for anything else. */
export function photoName(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith(FOOD2050_PHOTO_URL)) return null;
  let name: string;
  try {
    name = decodeURIComponent(url.slice(FOOD2050_PHOTO_URL.length));
  } catch {
    return null;
  }
  return FOOD2050_PHOTO.test(name) ? name : null;
}

/** food2050's DishStats (`dish.stats`): each value a MeasurementWeightBased with `amountPer100g`. */
const STATS: [keyof Nutrition, string][] = [
  ["kcal", "energy"],
  ["protein", "protein"],
  ["fat", "fat"],
  ["sat_fat", "saturatedFat"],
  ["carbs", "carbohydrates"],
  ["sugar", "sugar"],
  ["salt", "salt"],
];

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

/** A dish's nutrition from its `stats` (energy in kcal; kJ worked out from it), or null. */
function statsNutrition(stats: any, page: Payload): Nutrition | null {
  const n: Nutrition = { kcal: null, kj: null, protein: null, fat: null, sat_fat: null, carbs: null, sugar: null, salt: null };
  if (!stats || typeof stats !== "object") return null;
  for (const [key, name] of STATS) {
    const m = page.resolve(stats[name]);
    const v = m?.amountPer100g;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
    if (key === "kcal" && m.unit && m.unit !== "kcal") continue;
    n[key] = round(v, key === "salt" ? 2 : 1);
  }
  if (n.kcal !== null) n.kj = Math.round(n.kcal * 4.184);
  return nutritionOrNull(n);
}

/** The prices, nutrition and photo on a dish's page, by menu item id. */
export function parseDishPage(html: string): Map<string, DishDetails> {
  const page = new Payload(html);
  const out = new Map<string, DishDetails>();
  for (const row of page.rowsWith("OutletMenuItemPrice")) {
    for (const item of objectsOf(row, "OutletMenuItemDish")) {
      if (!str(item.id) || !Array.isArray(item.prices)) continue;
      const price: Dish["price"] = { student: null, internal: null, external: null };
      for (const p of item.prices.map((x: unknown) => page.resolve(x))) {
        const group = PRICE_GROUPS[str(page.resolve(p?.priceCategory)?.name).toLowerCase()];
        const amount = Number.parseFloat(str(p?.amount));
        // Some dishes have 0 (sold by weight, like the pasta buffet): no price, not free.
        if (group && Number.isFinite(amount) && amount > 0) price[group] = amount;
      }
      const dish = page.resolve(item.dish);
      out.set(str(item.id), { price, nutrition: statsNutrition(page.resolve(dish?.stats), page), image: photoName(dish?.imageUrl) });
    }
  }
  return out;
}

// --- as our menus ---

// food2050's allergen ids, named as ETH's menus name theirs.
const ALLERGENS: Record<string, string> = {
  cerealsContainingGluten: "gluten",
  wheat: "wheat",
  kamut: "kamut",
  spelt: "spelt",
  rye: "rye",
  barley: "barley",
  oats: "oats",
  eggs: "eggs",
  fish: "fish",
  crustaceans: "crustaceans",
  molluscs: "molluscs",
  milk: "milk, lactose",
  nuts: "nuts",
  almond: "almonds",
  hazelnut: "hazelnuts",
  walnut: "walnuts",
  cashew: "cashews",
  peanuts: "peanuts",
  soybeans: "soya",
  celery: "celery",
  mustard: "mustard",
  sesame: "sesame",
  sulphites: "sulfites",
  lupin: "lupin",
};
const FISH = new Set(["fish", "crustaceans", "molluscs"]);
// Meat in a dish's name or description (food2050 marks only vegan and vegetarian dishes): words that start with these,
// in English and German, and two found inside compounds (Bratwurst, Schweinefleisch). Not "meat" alone ("Vegetarian or
// with meat"), nor "Gulasch" (Apfel-Peperoni Gulasch).
const MEAT = new RegExp(
  "\\b(poulet|chicken|chickne|hähnchen|huhn|truthahn|turkey|ente\\b|duck|pork|schwein|beef|rind|kalb|veal|lamm|lamb|speck|" +
    "bacon|bacoon|schinken|ham\\b|prosciutto|salami|chorizo|sausage|hack|ghackets|gehackt|mince|meatloaf|meatball|frikadelle|" +
    "gyros|kebab|carne|coq au vin|bolognaise|bolognese|ton ?katsu|goulash|gulaschsuppe|spare rib|pulled pork|cervelat|cevapcici|leberkäse)|wurst|fleisch",
  "i",
);
const VEG_NAME = /\b(vegan|vegi|veggie|vegetari|vegetables?\b|gemüse|plant|tofu|seitan|quorn)/i;

/** Whether a dish that is neither vegetarian nor fish names a meat: in its name, or in its description when the name
 * doesn't say it's a vegetable dish ("Vegetables Schnitzel"). */
export const namesMeat = (name: string, desc: string) => MEAT.test(name) || (!VEG_NAME.test(name) && MEAT.test(desc));

/** "cerealsContainingGluten" -> "gluten"; an unknown id in plain words ("pineNuts" -> "pine nuts"). */
const allergenName = (id: string) => ALLERGENS[id] ?? id.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/** "butcher at dinner" -> "Butcher", "pure asia" -> "Pure Asia", "Menu 1" stays. */
export function uzhLine(category: string): string {
  const s = category.replace(/\s+at\s+(lunch|dinner)$/i, "").replace(/`/g, "'").replace(/\s+/g, " ").trim();
  if (/\p{Lu}/u.test(s)) return lineName(s);
  return s.replace(/(^|[\s&/(-])(\p{L})/gu, (_, before, c) => before + c.toUpperCase());
}

const TAGS: [RegExp, string][] = [[/pasta/i, "pasta"], [/pizza|pinsa/i, "pizza"], [/salat|salad/i, "salad"], [/suppe|soup/i, "soup"]];

/**
 * A food2050 dish as one of ours, with prices and nutrition where we have them (`details`: what its page told; without
 * it the dish has no `nutrition` yet, so the prefetch reads its page).
 */
export function uzhDish(item: Food2050Item, details: Partial<DishDetails> | null = null): Dish {
  const price = details?.price ?? null;
  const type: DishType = item.vegan
    ? "vegan"
    : item.vegetarian
      ? "vegetarian"
      : namesMeat(item.name, item.desc) // food2050 doesn't say which dishes have meat: those that name one; with fish too, meat (as ETH's)
        ? "meat"
        : item.allergens.some((a) => FISH.has(a))
          ? "fish"
          : "other";
  const line = uzhLine(item.category);
  return {
    line,
    name: lineName(item.name),
    desc: item.desc,
    type,
    tags: TAGS.filter(([re]) => re.test(`${line} ${item.name}`)).map(([, tag]) => tag),
    price: price ?? { student: null, internal: null, external: null },
    allergens: item.allergens.map(allergenName),
    ...(item.url ? { src: { id: item.id, url: item.url } } : {}),
    ...(details?.nutrition !== undefined ? { nutrition: details.nutrition } : {}),
    climate: item.climate,
    image: details?.image ?? null,
  };
}

const MEAL_NAMES: Record<MealName, string> = { lunch: "Lunch", dinner: "Dinner" };
const hasPrice = (p: Dish["price"]) => p.student !== null || p.internal !== null || p.external !== null;

/**
 * The days of a weekly page, merged into what's stored (`stored`, by date): the page's meal is replaced, the place's
 * other meals stay (the Untere Mensa's lunch and dinner are two pages). A dish keeps the prices and nutrition it had. A
 * day without any dish is closed: null (delete it).
 */
export function mergeWeek(m: UzhMensa, meal: UzhMeal, week: Food2050Week, stored: Map<IsoDate, MenuDay>): Map<IsoDate, MenuDay | null> {
  const out = new Map<IsoDate, MenuDay | null>();
  for (const date of week.dates) {
    const before = stored.get(date);
    const known = new Map<string, Partial<DishDetails>>();
    for (const x of before?.meals ?? []) {
      for (const d of x.dishes) {
        if (!d.src) continue;
        known.set(d.src.id, {
          ...(hasPrice(d.price) ? { price: d.price } : {}),
          ...(d.nutrition !== undefined ? { nutrition: d.nutrition } : {}),
          ...(typeof d.image === "string" ? { image: d.image } : {}),
        });
      }
    }
    const dishes = week.items.filter((i) => i.date === date).map((i) => uzhDish(i, known.get(i.id) ?? null));
    const meals = [
      ...(before?.meals ?? []).filter((x) => x.meal !== meal.meal),
      ...(dishes.length ? [{ meal: meal.meal, name: MEAL_NAMES[meal.meal], from: meal.from, to: meal.to, dishes }] : []),
    ].sort((a, b) => a.from.localeCompare(b.from));
    out.set(date, meals.length ? { hours: [[m.hours[0], m.hours[1]]], meals } : null);
  }
  return out;
}

/**
 * A day with what dish pages told filled in: their prices (when they have any), their nutrition (null when the
 * page has none, so the page isn't read again for it) and their photo (when they have one). Null if nothing changed.
 */
export function withDetails(day: MenuDay, details: Map<string, DishDetails>): MenuDay | null {
  let changed = false;
  const meals = day.meals.map((meal) => ({
    ...meal,
    dishes: meal.dishes.map((d) => {
      const got = d.src && details.get(d.src.id);
      if (!got) return d;
      const price = hasPrice(got.price) ? got.price : d.price;
      const image = got.image ?? d.image;
      if (JSON.stringify(price) === JSON.stringify(d.price) && JSON.stringify(got.nutrition) === JSON.stringify(d.nutrition) && image === d.image) return d;
      changed = true;
      const { image: _i, nutrition: _n, ...rest } = d;
      return { ...rest, price, nutrition: got.nutrition, image }; // image stays last (worker/store.ts isMenuImage)
    }),
  }));
  return changed ? { ...day, meals } : null;
}

/** The dishes of a day without a photo yet (their page is read again for it on today's and tomorrow's). */
export const photoless = (day: MenuDay) =>
  day.meals.flatMap((meal) => meal.dishes).filter((d): d is Dish & { src: { id: string; url: string } } => !!d.src && d.image === null);

/** The dishes of a day whose page is still to be read: without prices, or without nutrition yet. */
export const unpriced = (day: MenuDay) =>
  day.meals
    .flatMap((meal) => meal.dishes)
    .filter((d): d is Dish & { src: { id: string; url: string } } => !!d.src && (!hasPrice(d.price) || d.nutrition === undefined));

const BY_ID = new Map(UZH_MENSAS.map((m) => [m.id, m]));
const CAFE_BY_ID = new Map(UZH_CAFES.map((c) => [c.id, c]));

/** A UZH mensa's own page on food2050 (its menus and opening hours), a café's on zfv.ch, or null for another place. */
export function uzhMensaUrl(id: string): string | null {
  const m = BY_ID.get(id);
  return m ? `${FOOD2050_URL},${m.site}/${m.outlet}` : (CAFE_BY_ID.get(id)?.url ?? null);
}
