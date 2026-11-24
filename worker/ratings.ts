// Meal ratings (plans/PLAN_STREET_CRED.md, section 10): signed-in people rate a day's dish in three optional categories
// (taste, portion size, value for money), each -5 to 5 in steps of 0.5. Ratings live in the accounts database
// (`meal_ratings`, migrations-accounts/0002_cred.sql) by dish key; the page sees only averages and counts, and your own.
//
// A dish is one day's serving: its key is facility|date|meal|line|name (static/lib.js dishKey makes the same string).
// Ratings are taken for today's and yesterday's dishes (Zurich), and earn `meal_rating` street cred once per dish.

import { AuthError } from "./auth";
import { award, credState, earned, takeBack } from "./cred";
import { batchWithBump, bumpFor } from "./stats";
import { addDays, zurichDate } from "./tz";

export const CATEGORIES = ["taste", "portion", "value"] as const;
export type Category = (typeof CATEGORIES)[number];
export const RATING_MIN = -5;
export const RATING_MAX = 5;
export const RATING_STEP = 0.5;

/** A dish's key: the parts joined with "|", the name trimmed and lower-cased (lib.js dishKey, compared in a test). */
export function dishKey(facility: number | string, date: string, meal: string, line: string, name: string): string {
  return [String(facility), date, meal, line, name.trim().toLowerCase()].join("|");
}

/** Rounded to one decimal, never -0 (lib.js roundRating). */
export const roundRating = (x: number) => Math.round(x * 10) / 10 + 0;

/**
 * Ø: the mean of the category means that are present, rounded to 0.1; null when none is (lib.js ratingAverage, the
 * same rule for the live Ø of the rate window).
 */
export function ratingAverage(means: (number | null | undefined)[]): number | null {
  const set = means.filter((m): m is number => typeof m === "number");
  return set.length ? roundRating(set.reduce((a, b) => a + b, 0) / set.length) : null;
}

/** A category's value from a request: a number -5 to 5 in steps of 0.5, null when unset; anything else is refused. */
export function ratingValue(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < RATING_MIN || v > RATING_MAX || !Number.isInteger(v / RATING_STEP)) {
    throw new AuthError(400, "bad_rating");
  }
  return v + 0;
}

export interface Mine {
  taste: number | null;
  portion: number | null;
  value: number | null;
}

/** One dish's ratings as the page sees them. Category means and Ø rounded to 0.1, null when nobody set them. */
export interface DishSummary {
  avg: number | null;
  taste: number | null;
  portion: number | null;
  value: number | null;
  n: number;
  nTaste: number;
  nPortion: number;
  nValue: number;
  mine?: Mine | null;
}

interface SumRow {
  dish: string;
  n: number;
  taste: number | null;
  portion: number | null;
  value: number | null;
  n_taste: number;
  n_portion: number;
  n_value: number;
}

const summaryOf = (r: SumRow): DishSummary => ({
  avg: ratingAverage([r.taste, r.portion, r.value]),
  taste: r.taste === null ? null : roundRating(r.taste),
  portion: r.portion === null ? null : roundRating(r.portion),
  value: r.value === null ? null : roundRating(r.value),
  n: r.n,
  nTaste: r.n_taste,
  nPortion: r.n_portion,
  nValue: r.n_value,
});

const SUM_COLS = `dish, COUNT(*) AS n, AVG(taste) AS taste, AVG(portion) AS portion, AVG(value) AS value,
  COUNT(taste) AS n_taste, COUNT(portion) AS n_portion, COUNT(value) AS n_value`;

/**
 * GET /api/meal-ratings: every rated dish of a place on a date, by key (on the meal_ratings_place index). With `me`,
 * each also has `mine` (your values, or null), and dishes only you rated are there too.
 */
export async function readMealRatings(db: D1Database, place: string, date: string, me: string | null): Promise<Record<string, DishSummary>> {
  const [sums, mine] = await Promise.all([
    db.prepare(`SELECT ${SUM_COLS} FROM meal_ratings WHERE place = ? AND date = ? GROUP BY dish`).bind(place, date).all<SumRow>(),
    me
      ? db.prepare("SELECT dish, taste, portion, value FROM meal_ratings WHERE place = ? AND date = ? AND user_id = ?").bind(place, date, me).all<Mine & { dish: string }>()
      : Promise.resolve(null),
  ]);
  const out: Record<string, DishSummary> = {};
  for (const r of sums.results) out[r.dish] = summaryOf(r);
  if (mine) {
    const byDish = new Map(mine.results.map((m) => [m.dish, { taste: m.taste, portion: m.portion, value: m.value }]));
    for (const [key, s] of Object.entries(out)) s.mine = byDish.get(key) ?? null;
  }
  return out;
}

/** One dish's summary (after a rating), with your values. */
async function dishSummary(db: D1Database, key: string, me: string): Promise<DishSummary> {
  const [sum, mine] = await Promise.all([
    db.prepare(`SELECT ${SUM_COLS} FROM meal_ratings WHERE dish = ? GROUP BY dish`).bind(key).first<SumRow>(),
    db.prepare("SELECT taste, portion, value FROM meal_ratings WHERE dish = ? AND user_id = ?").bind(key, me).first<Mine>(),
  ]);
  const s = sum ? summaryOf(sum) : summaryOf({ dish: key, n: 0, taste: null, portion: null, value: null, n_taste: 0, n_portion: 0, n_value: 0 });
  s.mine = mine ? { taste: mine.taste, portion: mine.portion, value: mine.value } : null;
  return s;
}

/** The dish a rating names, from the stored menus (index.ts): its key and its name as the menu writes it, or null. */
export type LookupDish = (place: string, date: string, meal: string, line: string, name: string) => Promise<{ key: string; name: string } | null>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 200;

/** The dates that take ratings at `now`: today and yesterday in Zurich. */
export function rateableDates(now: number): [string, string] {
  const today = zurichDate(now);
  return [today, addDays(today, -1)];
}

/**
 * DELETE /api/meal-ratings { place, date, meal, line, name }: your rating of a dish removed, with the 3 street cred it
 * earned (rating it again earns them again, within the day's cap). Fine when there's none. Answers the dish's key, its
 * new summary and `cred`.
 */
export async function unrateMeal(db: D1Database, me: string, b: Record<string, unknown>, lookupDish: LookupDish, now: number) {
  const text = (v: unknown) => {
    if (typeof v !== "string" || !v.trim() || v.length > MAX_TEXT) throw new AuthError(400, "bad_dish");
    return v;
  };
  if (typeof b.line !== "string" || b.line.length > MAX_TEXT) throw new AuthError(400, "bad_dish");
  const [place, date, meal, name] = [text(b.place), text(b.date), text(b.meal), text(b.name)];
  if (!DATE_RE.test(date) || (meal !== "lunch" && meal !== "dinner")) throw new AuthError(400, "bad_dish");
  const dish = await lookupDish(place, date, meal, b.line, name);
  if (!dish) throw new AuthError(404, "no_such_dish");
  await db.batch([
    db.prepare("DELETE FROM meal_ratings WHERE dish = ? AND user_id = ?").bind(dish.key, me),
    ...(await takeBack(db, me, "meal_rating", dish.key)),
  ]);
  return { key: dish.key, dish: await dishSummary(db, dish.key, me), cred: await credState(db, me, 0) };
}

/**
 * PUT /api/meal-ratings { place, date, meal, line, name, taste?, portion?, value? }: your rating of a dish of today or
 * yesterday that is on the stored menu (404 `no_such_dish`), at least one category set. Rating again replaces yours
 * (unset categories become unset) and earns nothing more; the first earns `meal_rating` (3, at most 5 a day). Answers
 * the dish's key, its new summary and `cred`.
 */
export async function rateMeal(db: D1Database, me: string, b: Record<string, unknown>, lookupDish: LookupDish, now: number) {
  const text = (v: unknown) => {
    if (typeof v !== "string" || !v.trim() || v.length > MAX_TEXT) throw new AuthError(400, "bad_dish");
    return v;
  };
  const place = text(b.place);
  const date = text(b.date);
  const meal = text(b.meal);
  const name = text(b.name);
  // A dish's line can be empty (a café's single counter).
  if (typeof b.line !== "string" || b.line.length > MAX_TEXT) throw new AuthError(400, "bad_dish");
  const line = b.line;
  if (!DATE_RE.test(date) || (meal !== "lunch" && meal !== "dinner")) throw new AuthError(400, "bad_dish");
  const values = { taste: ratingValue(b.taste), portion: ratingValue(b.portion), value: ratingValue(b.value) };
  if (CATEGORIES.every((c) => values[c] === null)) throw new AuthError(400, "bad_rating");
  if (!rateableDates(now).includes(date)) throw new AuthError(400, "not_rateable");
  const dish = await lookupDish(place, date, meal, line, name);
  if (!dish) throw new AuthError(404, "no_such_dish");
  const earn = await award(db, me, "meal_rating", dish.key, now, dish.name);
  // Usage counters (stats.ts): a new rating only, told apart by your row for the dish (rating again replaces it).
  const rated = await db.prepare("SELECT 1 FROM meal_ratings WHERE dish = ? AND user_id = ?").bind(dish.key, me).first();
  await batchWithBump(db, [
    db
      .prepare(
        `INSERT INTO meal_ratings (dish, date, place, user_id, taste, portion, value, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (dish, user_id) DO UPDATE SET taste = ?5, portion = ?6, value = ?7, at = ?8`,
      )
      .bind(dish.key, date, place, me, values.taste, values.portion, values.value, now),
    ...earn,
  ], bumpFor(db, now, { meal_rating: rated ? 0 : 1 }));
  return { key: dish.key, dish: await dishSummary(db, dish.key, me), cred: await credState(db, me, earned("meal_rating", earn)) };
}
