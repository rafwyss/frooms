// Menus from ETH's gastronomy system, Cookpit (the source of ETH's own menu pages): which places serve what, when.
// The menu prefetch (prefetch.ts, runMenuPrefetch) stores one record per place and day in D1 (menu_days); the API
// serves them without asking ETH. Everything here is pure, so it can be tested on Cookpit's own answers.
//
// A "place" is a card in the Mensas tab: a study space that also serves food (data/overrides.json `eateries` with a
// `space`), or a place with menus only, mostly on Hönggerberg (Bellavista, Octavo, …).

import { MENU_INTERVAL_S, MENU_NIGHT_INTERVAL_S, MENU_QUIET_HOURS, MIN_MEAL_PRICE } from "./config";
import { BUILDING_OVERRIDES, EATERY_OVERRIDES, type EateryKind, type EateryOverride, isOwnPlace } from "./overrides";
import { isQuiet } from "./prefetch";
import type { Hours, Space } from "./spaces";
import { addDays, type IsoDate, weekday } from "./tz";

export type MealName = "lunch" | "dinner";
export type DishType = "vegan" | "vegetarian" | "fish" | "meat" | "other";

export interface Dish {
  line: string; // the mensa's own name for the counter ("Street", "Garden", "The Chef")
  name: string;
  desc: string;
  type: DishType;
  tags: string[]; // pasta, pizza, salad, soup
  price: { student: number | null; internal: number | null; external: number | null };
  allergens: string[];
  // UZH's dishes (worker/uzhmenus.ts): food2050's menu item id and the dish's own page, which has its prices.
  src?: { id: string; url: string };
  // Per 100 g; null when the source has none. Missing only on a UZH dish whose page hasn't been read yet.
  nutrition?: Nutrition | null;
  // UZH's dishes only: food2050's climate rating (from Eaternity's CO₂ data), null when a dish has none.
  climate?: ClimateRating | null;
  // Last: isMenuImage (worker/store.ts) finds a photo's id by the "}" after it in the stored JSON.
  // Cookpit's image id, or food2050's photo (its object name, FOOD2050_PHOTO), served by /api/meal-image/<id> (today's and
  // tomorrow's dishes only).
  image: number | string | null;
}

/** food2050's climate rating of a dish: how much it contributes to global warming. */
export type ClimateRating = "low" | "medium" | "high";

/** Nutritional values per 100 g (energy in kcal and kJ, the rest in grams); null where the source has none. */
export interface Nutrition {
  kcal: number | null;
  kj: number | null;
  protein: number | null;
  fat: number | null;
  sat_fat: number | null;
  carbs: number | null;
  sugar: number | null;
  salt: number | null;
}

/** A Nutrition with every value null is no nutrition at all. */
export const nutritionOrNull = (n: Nutrition): Nutrition | null => (Object.values(n).some((v) => v !== null) ? n : null);

export interface Meal {
  meal: MealName;
  name: string; // Cookpit's own name for the meal time ("Lunch", "Mittag", …)
  from: string; // "11:15"
  to: string;
  dishes: Dish[]; // empty: the meal time is known, the menu not published yet
}

/** One place on one day. No opening hours means closed that day. */
export interface MenuDay {
  hours: [string, string][];
  meals: Meal[];
}

export interface MenuDayRow {
  facility: number;
  date: IsoDate;
  day: MenuDay;
}

/** One of Cookpit's facilities, as much of it as we use. */
export interface Facility {
  id: number;
  name: string;
  building: string | null;
  floor: string | null;
}

/** A card in the Mensas tab with a menu. */
export interface Place {
  id: string; // the study space's id, or "F<facility>" for a place with menus only
  facility: number;
  name: string;
  building: string;
  floor: string | null;
  area: string;
  kind: EateryKind; // ours (data/overrides.json); a place without one is a café
  cafeOutsideMeals: boolean; // a mensa in its meal times, a cafeteria the rest of the day (Tannenbar)
  space: string | null; // the linked study space
  flagship: string | null; // the mensa's signature line (data/overrides.json `flagship`), whose dish the Eat tab's card shows
  study?: boolean; // a study space while open and not serving (UZH's mensas, CHOICES.md)
  weekHours?: [string, string]; // Monday to Friday, for a place without menus (UZH's cafés): its hours don't come from menus
}

// Cookpit's meal classes: what kind of dish it is, in this order (a dish with meat and fish counts as meat), and the
// extra tags.
const TYPE_CODES: [number, DishType][] = [[11, "meat"], [10, "fish"], [16, "vegan"], [17, "vegetarian"]];
const TAG_CODES: Record<number, string> = { 12: "pasta", 13: "pizza", 14: "salad", 15: "soup" };
// Cookpit's customer groups. Some places have one price for students and staff (12) or for everyone (14).
const PRICE_GROUPS: Record<number, (keyof Dish["price"])[]> = {
  10: ["student"],
  11: ["internal"],
  12: ["student", "internal"],
  13: ["external"],
  14: ["student", "internal", "external"],
};
// Meal times starting before this are lunch (Cookpit's names vary: Mittag, Mittagessen, Pranzo, Abend, …).
const DINNER_FROM = "15:00";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const TIME = /^\d{2}:\d{2}$/;

/** "HOME" -> "Home", "SALAT & ANTIPASTI" -> "Salat & Antipasti"; names with lower case letters stay as they are. */
export function lineName(name: string): string {
  const s = name.trim().replace(/\s+/g, " ");
  if (/\p{Ll}/u.test(s) || !/\p{Lu}/u.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s&/(-])(\p{L})/gu, (_, before, c) => before + c.toUpperCase());
}

export const mealOf = (from: string): MealName => (from < DINNER_FROM ? "lunch" : "dinner");

/** The numeric id at the end of Cookpit's image-url ("…/v1/images/77912"). */
function imageId(url: unknown): number | null {
  const m = /\/images\/(\d+)\/?$/.exec(str(url));
  return m ? Number(m[1]) : null;
}

/** One of Cookpit's nutrition strings ("4.5", per 100 g) as a number; missing, empty or odd: null. */
function amount(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : str(v);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** A Cookpit meal's nutrition (`energy` is kJ, `energy-outdated` kcal), or null when it has none. */
function cookpitNutrition(m: any): Nutrition | null {
  return nutritionOrNull({
    kcal: amount(m["energy-outdated"]),
    kj: amount(m.energy),
    protein: amount(m.protein),
    fat: amount(m.fat),
    sat_fat: amount(m["saturated-fatty-acids"]),
    carbs: amount(m.carbohydrates),
    sugar: amount(m.sugar),
    salt: amount(m.salt),
  });
}

/** One line of a meal time, or null if it has no dish (yet). */
function dish(line: any): Dish | null {
  const m = line?.meal;
  if (!m || typeof m !== "object" || !str(m.name)) return null;
  const classes = new Set(arr(m["meal-class-array"]).map((c) => Number(c?.code)));
  const price: Dish["price"] = { student: null, internal: null, external: null };
  for (const p of arr(m["meal-price-array"])) {
    if (typeof p?.price !== "number") continue;
    for (const group of PRICE_GROUPS[Number(p["customer-group-code"])] ?? []) price[group] = p.price;
  }
  return {
    line: lineName(str(line.name)),
    name: str(m.name),
    desc: str(m.description),
    type: TYPE_CODES.find(([code]) => classes.has(code))?.[1] ?? "other",
    tags: Object.entries(TAG_CODES).filter(([code]) => classes.has(Number(code))).map(([, tag]) => tag),
    price,
    allergens: arr(m["allergen-array"]).map((a) => str(a?.desc)).filter(Boolean),
    nutrition: cookpitNutrition(m),
    image: imageId(m["image-url"]),
  };
}

/** One day of a rota (Cookpit's day-of-week entry) as a MenuDay. */
function menuDay(entry: any): MenuDay {
  const day: MenuDay = { hours: [], meals: [] };
  for (const oh of arr(entry?.["opening-hour-array"])) {
    const [from, to] = [str(oh?.["time-from"]), str(oh?.["time-to"])];
    if (TIME.test(from) && TIME.test(to)) day.hours.push([from, to]);
    for (const mt of arr(oh?.["meal-time-array"])) {
      const [mFrom, mTo] = [str(mt?.["time-from"]), str(mt?.["time-to"])];
      if (!TIME.test(mFrom) || !TIME.test(mTo)) continue;
      const dishes = arr(mt["line-array"]).map(dish).filter((d): d is Dish => d !== null);
      day.meals.push({ meal: mealOf(mFrom), name: str(mt.name), from: mFrom, to: mTo, dishes });
    }
  }
  day.hours.sort((a, b) => a[0].localeCompare(b[0]));
  day.meals.sort((a, b) => a.from.localeCompare(b.from));
  return day;
}

/** Whether a Cookpit answer has any menu lines at all (dishes or not): mensas do, cafés don't. */
export function hasLines(raw: unknown): boolean {
  return arr((raw as any)?.["weekly-rota-array"]).some((rota) =>
    arr(rota?.["day-of-week-array"]).some((d) =>
      arr(d?.["opening-hour-array"]).some((oh) => arr(oh?.["meal-time-array"]).some((mt) => arr(mt?.["line-array"]).length > 0)),
    ),
  );
}

/**
 * Cookpit's `weekly-rota-array` as one record per facility and date from `from` to `to` (inclusive). A rota covers
 * a week or longer (some run for months, like Rice Up!'s); it repeats on every week it covers, by day of the week.
 * Where two rotas cover the same date, the one starting later wins (it's the more specific one).
 */
export function normalizeRotas(raw: unknown, from: IsoDate, to: IsoDate): MenuDayRow[] {
  const best = new Map<string, { start: string; end: string; row: MenuDayRow }>();
  for (const rota of arr((raw as any)?.["weekly-rota-array"])) {
    const facility = Number(rota?.["facility-id"]);
    const [start, end] = [str(rota?.["valid-from"]), str(rota?.["valid-to"])];
    if (!Number.isInteger(facility) || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) continue;
    const days = new Map(arr(rota["day-of-week-array"]).map((d) => [Number(d?.["day-of-week-code"]), d]));
    for (let date = start > from ? start : from; date <= end && date <= to; date = addDays(date, 1)) {
      const key = `${facility}|${date}`;
      const other = best.get(key);
      if (other && (other.start > start || (other.start === start && other.end <= end))) continue;
      const entry = days.get(weekday(date) + 1); // Cookpit: 1 = Monday
      best.set(key, { start, end, row: { facility, date, day: menuDay(entry) } });
    }
  }
  return [...best.values()].map((b) => b.row).sort((a, b) => a.facility - b.facility || a.date.localeCompare(b.date));
}

/** Cookpit's facility list (`facility-array`). */
export function parseFacilities(raw: unknown[]): Facility[] {
  return raw.flatMap((f: any) => {
    const id = Number(f?.["facility-id"]);
    if (!Number.isInteger(id)) return [];
    return [{ id, name: str(f["facility-name"]), building: str(f.building) || null, floor: str(f.floor) || null }];
  });
}

/** The building whose map label is this place's (data/overrides.json `buildings.<code>.place`: MM for MMB79). */
const buildingOfPlace = (id: string) => Object.entries(BUILDING_OVERRIDES).find(([, b]) => b.place === id)?.[0];

/**
 * Every place with a menu: the study spaces that serve food, and the places with menus only, from our overrides
 * (data/overrides.json `eateries`) and Cookpit's facility records. Hidden places and those we can't place are left out.
 * A study space missing from ETH's live list (Mensa Polyterrasse has gone missing from it) is still a place, with the
 * space's id and Cookpit's name, building and floor, but no linked space: its hours then come from its menus, like a
 * place with menus only. It needs its `area` in the overrides for that.
 */
export function eateryPlaces(
  facilities: Facility[],
  spaces: Space[],
  overrides: Record<number, EateryOverride> = EATERY_OVERRIDES,
): Place[] {
  const byId = new Map(facilities.map((f) => [f.id, f]));
  const spaceById = new Map(spaces.map((s) => [s.id, s]));
  const places: Place[] = [];
  for (const [key, o] of Object.entries(overrides)) {
    const facility = Number(key);
    if (!isOwnPlace(o)) continue;
    const kind = o.kind ?? "cafe";
    const s = o.space ? spaceById.get(o.space) : undefined;
    if (s) {
      const floor = s.room.split(" ")[1] ?? null;
      places.push({ id: s.id, facility, name: s.name, building: s.building, floor, area: s.area, kind, cafeOutsideMeals: !!o.cafeOutsideMeals, space: s.id, flagship: o.flagship ?? null });
      continue;
    }
    const f = byId.get(facility);
    const building = o.building ?? f?.building ?? (o.space ? buildingOfPlace(o.space) : undefined);
    const name = o.name ?? f?.name;
    if (!building || !name || !o.area) continue;
    places.push({ id: o.space ?? `F${facility}`, facility, name, building, floor: o.floor ?? f?.floor ?? null, area: o.area, kind, cafeOutsideMeals: !!o.cafeOutsideMeals, space: null, flagship: o.flagship ?? null });
  }
  return places;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Overlapping or touching intervals joined. */
function merge(intervals: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [f, t] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && f <= last[1]) last[1] = Math.max(last[1], t);
    else out.push([f, t]);
  }
  return out;
}

/** Meal times as intervals in minutes. */
export const mealIntervals = (meals: Pick<Meal, "from" | "to">[]): [number, number][] =>
  meals.map((m) => [minutes(m.from), minutes(m.to)]);

/**
 * Opening hours for spaceState from Cookpit's days: `days` by date, from `day` on. The week repeats, so only the
 * coming seven days count; a day without a record is closed.
 */
export function menuHours(days: Map<IsoDate, { hours: [string, string][]; meals: Pick<Meal, "from" | "to">[] }>, day: IsoDate): Hours {
  const week = () => Array.from({ length: 7 }, () => [] as [number, number][]);
  const hours: Hours = { open: week(), meals: week(), card24h: false, unknown: [] };
  for (let i = 0; i < 7; i++) {
    const d = addDays(day, i);
    const rec = days.get(d);
    if (!rec) continue;
    hours.meals[weekday(d)] = mealIntervals(rec.meals);
    // Some places serve dinner past their opening hours (Alumni quattro: open until 20:00, dinner until 22:00).
    hours.open[weekday(d)] = merge([...rec.hours.map(([f, t]) => [minutes(f), minutes(t)] as [number, number]), ...hours.meals[weekday(d)]]);
  }
  return hours;
}

/** Opening hours for spaceState of a place without menus: the same hours Monday to Friday, no meals. */
export function weekdayHours([from, to]: [string, string]): Hours {
  const week = () => Array.from({ length: 7 }, () => [] as [number, number][]);
  const hours: Hours = { open: week(), meals: week(), card24h: false, unknown: [] };
  for (let d = 0; d < 5; d++) hours.open[d] = [[minutes(from), minutes(to)]];
  return hours;
}

/** What a place is right now: a mensa that is a cafeteria outside its meal times is one then. */
export const kindNow = (p: Pick<Place, "kind" | "cafeOutsideMeals">, meal: boolean): EateryKind =>
  p.kind === "mensa" && p.cafeOutsideMeals && !meal ? "cafe" : p.kind;

/** The Monday of `day`'s week. */
export const mondayOf = (day: IsoDate) => addDays(day, -weekday(day));

// --- the Eat tab's card: the meal it is about, and the mensa's flagship dish ---

/**
 * The meal a mensa's card is about at `hhmm` on `day`: the meal time it falls in, else the next one that day, else the
 * first meal of the next day with meals (`next`, as /api/spaces' `meals_next`); null when none is known.
 */
export function cardMeal(
  today: Pick<Meal, "meal" | "from" | "to">[],
  next: { date: IsoDate; meals: Pick<Meal, "meal" | "from">[] } | null,
  day: IsoDate,
  hhmm: string,
): { date: IsoDate; meal: MealName } | null {
  const now = today.find((m) => m.from <= hhmm && hhmm < m.to) ?? today.find((m) => m.from > hhmm);
  if (now) return { date: day, meal: now.meal };
  const first = next?.meals[0];
  return first ? { date: next!.date, meal: first.meal } : null;
}

// --- full meals only: dishes under MIN_MEAL_PRICE (a salad by the 100 g, a side) aren't served by the API ---

/**
 * Whether a dish is a full meal: false when it has a price and its lowest one (of the students', staff's and everyone's)
 * is below MIN_MEAL_PRICE; a dish without any price stays.
 */
export function isFullMeal(d: Pick<Dish, "price">): boolean {
  const prices = [d.price.student, d.price.internal, d.price.external].filter((p): p is number => typeof p === "number");
  return !prices.length || Math.min(...prices) >= MIN_MEAL_PRICE;
}

/** A stored day with the dishes that aren't full meals left out (isFullMeal); the stored data keeps them. */
export const fullMeals = <T extends Pick<MenuDay, "meals">>(day: T): T => ({ ...day, meals: day.meals.map((m) => ({ ...m, dishes: m.dishes.filter(isFullMeal) })) });

/** A dish's price for ranking: the students', else the staff's, else everyone's; nothing known counts lowest. */
const rankPrice = (d: Dish) => d.price.student ?? d.price.internal ?? d.price.external ?? -1;

/**
 * The dish a mensa's card shows for a meal: the most expensive dish of its flagship line (`line`, matched by name
 * without regard to case; the evening's "Street Abend" counts as "Street"), or, without that line in the meal, the
 * most expensive dish of the meal; null without dishes. Only full meals count (isFullMeal).
 */
export function flagshipDish(all: Dish[], line: string | null): Dish | null {
  const dishes = all.filter(isFullMeal);
  const wanted = line?.toLowerCase();
  const own = wanted ? dishes.filter((d) => d.line.toLowerCase() === wanted || d.line.toLowerCase().startsWith(`${wanted} `)) : [];
  const pool = own.length ? own : dishes;
  let best: Dish | null = null;
  for (const d of pool) if (!best || rankPrice(d) > rankPrice(best)) best = d;
  return best;
}

export interface FacilityFetch {
  at: number; // last fetch, successful or not (epoch ms)
  ok: boolean;
  lines: boolean; // the last successful fetch had menu lines
}

/**
 * The facility to fetch next: the least recently fetched one that is due (never fetched first). Due means fetched
 * longer than MENU_INTERVAL_S ago by day, MENU_NIGHT_INTERVAL_S at night (MENU_QUIET_HOURS); menus change rarely then.
 */
export function pickFacility(ids: number[], fetches: Record<number, Pick<FacilityFetch, "at">>, now: number): number | null {
  const interval = (isQuiet(now, MENU_QUIET_HOURS) ? MENU_NIGHT_INTERVAL_S : MENU_INTERVAL_S) * 1000;
  const due = ids.filter((id) => now - (fetches[id]?.at ?? 0) >= interval);
  due.sort((a, b) => (fetches[a]?.at ?? 0) - (fetches[b]?.at ?? 0) || a - b);
  return due[0] ?? null;
}

/** The dates and meals that have a menu, for the meal stepper: when each ends at the latest of the places. */
export interface Slot {
  date: IsoDate;
  meal: MealName;
  to: string;
}
