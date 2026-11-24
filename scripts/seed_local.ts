// Seeds the local D1 (`wrangler dev`'s, in .wrangler/) with invented and sample data, so the page has something to show
// without running the prefetch (which would send real requests to ETH, UZH and ZFV). Local only: nothing here is sent
// anywhere, and the remote D1 is never touched.
//
//   node scripts/seed_local.ts            (Node 24 or later; Node 22 needs --experimental-strip-types)
//   npx wrangler d1 migrations apply fruum --local
//   npx wrangler d1 execute fruum --local --file build/seed_local.sql
//
// It writes build/seed_local.sql with:
// - bookings (allocations) for today and the next two days, for every Zentrum room in a building with a floor plan
//   (data/floors/*.json): invented blocks, so there are free, busy, free-soon and short-gap rooms;
// - menus for today and tomorrow: Cookpit's samples (data/samples/cookpit_rotas_f*.json, Polyterrasse, Alumni quattro,
//   Rice Up!) and food2050's (data/samples/food2050_week_*.html, the Obere and the Untere Mensa), moved to these dates
//   by weekday (a Saturday or Sunday gets Friday's menu, so the Eat tab always has something);
// - 60 days of occupancy history for the spaces with sensors (ETH's and the University Library's), with a daily curve
//   and a fuller last week, and "usually this full" built from it (worker/usual.ts), and a live reading of ETH's as of
//   now (frooms' estimate, shown for 15 minutes);
// - a handful of occupancy reports for two rooms and two study spaces, over the past 4 hours;
// and build/seed_equipment.json: invented equipment for those rooms, for the local KV (the command is printed).
//
// The rooms' days count as fresh for 2 hours after seeding (like the prefetch's, worker/index.ts maxAgeMs): run it again
// when the rooms say "not loaded yet". The dishes' photos are fetched from Cookpit by the local Worker when the page
// shows them, as on the live site.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The Worker's modules use extensionless imports, JSON imports without attributes and TypeScript that type stripping
// alone doesn't cover (parameter properties): resolve and transform them here, so the pure functions can be imported.
registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.\w+$/.test(specifier) && context.parentURL) {
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".json")) {
      return { format: "module", source: `export default ${readFileSync(fileURLToPath(url), "utf8")};`, shortCircuit: true };
    }
    if (url.startsWith("file:") && url.includes("/worker/") && url.endsWith(".ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "transform" });
      return { format: "module", source, shortCircuit: true };
    }
    return next(url, context);
  },
});
process.removeAllListeners("warning"); // stripTypeScriptTypes is "experimental"

const worker = (name: string) => import(pathToFileURL(join(ROOT, "worker", `${name}.ts`)).href);
const [{ parseCatalogue, roomPath }, menus, uzhmenus, { UZH_SENSORS }, tz, config, usual] = await Promise.all([
  worker("catalogue"),
  worker("menus"),
  worker("uzhmenus"),
  worker("uzhspaces"),
  worker("tz"),
  worker("config"),
  worker("usual"),
]);
const { addDays, weekday, zurichDate, zurichToUtc } = tz;

const now = Date.now();
const today: string = zurichDate(now);
const sql: string[] = ["-- Local seed (scripts/seed_local.ts), " + new Date(now).toISOString() + ". Never run with --remote."];
const q = (v: unknown) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/** Multi-row inserts, a few hundred rows each. */
function insert(table: string, columns: string[], rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += 200) {
    const values = rows.slice(i, i + 200).map((r) => `(${r.map(q).join(", ")})`).join(",\n  ");
    sql.push(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES\n  ${values};`);
  }
}

/** A small seeded random generator, so a room gets the same day every time the script runs on that day. */
function random(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rnd: () => number, xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

// --- bookings ---

const TITLES = ["Lecture", "Exercise class", "Seminar", "Meeting", "Workshop", "Exam review", "Colloquium", "Tutorial"];
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Invented bookings of one room on one day, packed as the prefetch stores them (worker/store.ts PackedAllocation). */
function bookings(path: string, day: string): unknown[][] {
  const rnd = random(`${path}|${day}`);
  const kind = rnd();
  const at = (min: number) => `${day}T${hm(min)}:00`;
  if (kind < 0.1) return []; // free all day
  if (kind < 0.18) return [[at(8 * 60), at(20 * 60), 2, pick(rnd, TITLES), 1]]; // busy all day
  const out: unknown[][] = [];
  let t = 7 * 60 + 15 * Math.floor(rnd() * 8); // 07:00 to 08:45
  let busy = rnd() < 0.5;
  while (t < 20 * 60) {
    const length = busy ? pick(rnd, [45, 60, 90, 105, 120, 180]) : pick(rnd, [15, 15, 30, 45, 60, 90, 120, 180, 240]);
    const end = Math.min(t + length, 21 * 60);
    if (busy) out.push([at(t), at(end), 2, pick(rnd, TITLES), 1]);
    t = end;
    busy = !busy;
  }
  return out;
}

const withPlans = new Set(readdirSync(join(ROOT, "data", "floors")).filter((f) => /^[A-Z]+\.json$/.test(f)).map((f) => f.slice(0, -5)));
const rooms = parseCatalogue(JSON.parse(read("data", "rooms_snapshot.json")), "Z").filter((r: { building: string }) => withPlans.has(r.building));
const days = [today, addDays(today, 1), addDays(today, 2)];
const allocationRows: unknown[][] = [];
for (const r of rooms) for (const day of days) allocationRows.push([roomPath(r), day, now, JSON.stringify(bookings(roomPath(r), day))]);
insert("allocations", ["path", "day", "at", "raw"], allocationRows);
insert("fetches", ["path", "full_from", "at"], rooms.map((r: object) => [roomPath(r), today, now]));
// The dates visitors may pick, so the Worker doesn't ask ETH for them; and the time of the "last prefetch".
const minmax = { at: now, min: addDays(today, -config.HISTORY_DAYS), max: addDays(today, 200) };
insert("meta", ["key", "value"], [["minmax", JSON.stringify(minmax)], ["updated", String(now)]]);

// --- menus ---

const menuDays = [today, addDays(today, 1)];
/** The sample's weekday for a date: the same one, Friday's for a weekend. */
const sourceWeekday = (date: string) => Math.min(weekday(date), 4);
const menuRows: unknown[][] = [];
const fetchRows: unknown[][] = [];

for (const facility of [9, 14, 22]) {
  const raw = JSON.parse(read("data", "samples", `cookpit_rotas_f${facility}.json`));
  const all = menus.normalizeRotas(raw, "2000-01-01", "2099-12-31") as { date: string; day: { meals: { dishes: unknown[] }[] } }[];
  // Per weekday the sample's first day with dishes.
  const byWeekday = new Map<number, unknown>();
  for (const r of all) {
    if (!byWeekday.has(weekday(r.date)) && r.day.meals.some((m) => m.dishes.length)) byWeekday.set(weekday(r.date), r.day);
  }
  for (const date of menuDays) {
    const day = byWeekday.get(sourceWeekday(date));
    if (day) menuRows.push([facility, date, now, JSON.stringify(day)]);
  }
  fetchRows.push([facility, now, 1, 1]);
}

// UZH: the weekly pages of the Obere Mensa (lunch) and the Untere Mensa (dinner), and one dish page's prices.
const uzhPages: [string, string, string[]][] = [
  ["obere-mensa", "lunch", ["food2050_week_obere_mensa_w46.html", "food2050_week_obere_mensa_w47.html"]],
  ["untere-mensa", "dinner", ["food2050_week_untere_mensa_dinner_w46.html"]],
];
const prices = uzhmenus.parseDishPage(read("data", "samples", "food2050_dish_obere_mensa_menu1.html"));
for (const [outlet, mealName, files] of uzhPages) {
  const mensa = uzhmenus.UZH_MENSAS.find((m: { outlet: string }) => m.outlet === outlet);
  const meal = mensa.meals.find((m: { meal: string }) => m.meal === mealName);
  const items: { date: string }[] = files.flatMap((f) => uzhmenus.parseWeek(read("data", "samples", f)).items);
  const sourceDates = new Map<number, string>();
  for (const i of items) if (!sourceDates.has(weekday(i.date))) sourceDates.set(weekday(i.date), i.date);
  for (const date of menuDays) {
    const from = sourceDates.get(sourceWeekday(date));
    if (!from) continue;
    const week = { dates: [date], items: items.filter((i) => i.date === from).map((i) => ({ ...i, date })) };
    const merged = uzhmenus.mergeWeek(mensa, meal, week, new Map()).get(date);
    if (!merged) continue;
    const day = uzhmenus.withDetails(merged, prices) ?? merged;
    menuRows.push([mensa.facility, date, now, JSON.stringify(day)]);
  }
  fetchRows.push([mensa.facility, now, 1, 1]);
}
insert("menu_days", ["facility", "date", "at", "data"], menuRows);
insert("menu_fetches", ["facility", "at", "ok", "lines"], fetchRows);

// --- occupancy history ---

// ETH's spaces with a sensor (those with a head count in the sample feed, in our locations) and UZH's libraries.
const ownSpaces = new Set((JSON.parse(read("data", "spaces_snapshot.json")) as { attributes: { roomGlobalIdentifier: string } }[]).map((s) => s.attributes.roomGlobalIdentifier));
const feed = JSON.parse(read("data", "samples", "studyspaces_availability.json")).data as { id: string; attributes: { maxPeople?: number } }[];
const sensors: { id: string; capacity: number; eth: boolean }[] = [
  ...feed.filter((s) => s.attributes.maxPeople && ownSpaces.has(s.id)).map((s) => ({ id: s.id, capacity: s.attributes.maxPeople!, eth: true })),
  ...UZH_SENSORS.map((s: { id: string }) => ({ id: s.id, capacity: 120, eth: false })),
];
const HISTORY = 60;
const STEP_MIN = 15;
const occupancyRows: unknown[][] = [];
for (const s of sensors) {
  const rnd = random(`occupancy|${s.id}`);
  const peak = 0.55 + rnd() * 0.45; // how full the space gets at its busiest
  for (let d = HISTORY; d >= 0; d--) {
    const day = addDays(today, -d);
    const [y, m, dd] = day.split("-").map(Number);
    const weekend = weekday(day) >= 5;
    const recent = d <= 7 ? 1.12 : 1; // the last week a bit fuller, so the two halves of "usually" differ
    for (let min = 7 * 60; min <= 22 * 60; min += STEP_MIN) {
      const at = zurichToUtc(y, m, dd, Math.floor(min / 60), min % 60);
      if (at > now) break;
      const hour = min / 60;
      const curve = Math.exp(-((hour - 13.5) ** 2) / (2 * 3.2 ** 2)); // a day's bell, fullest after lunch
      const share = Math.max(0, Math.min(1, peak * curve * (weekend ? 0.35 : 1) * recent + (rnd() - 0.5) * 0.12));
      // ETH sends 20 % steps, the library's widget whole percents.
      const pct = s.eth ? Math.min(100, 20 * Math.round(share * 5)) : Math.round(share * 100);
      const people = Math.round(share * s.capacity);
      const status = pct >= 80 ? "red" : pct >= 60 ? "yellow" : "green";
      occupancyRows.push([s.id, at, at, people, s.capacity, pct, s.eth ? status : null, null, 1]);
    }
  }
}
sql.push(`DELETE FROM occupancy WHERE space IN (${sensors.map((s) => q(s.id)).join(", ")});`);
insert("occupancy", ["space", "at", "measured_at", "people", "capacity", "pct", "status", "trend", "active"], occupancyRows);

// "Usually this full" from that history, with the Worker's own statements (worker/usual.ts rebuildUsual), their
// parameters written into the SQL.
const recorder = { prepare: (text: string) => ({ text, bind: (...params: unknown[]) => ({ text, params }) }) };
for (const st of usual.rebuildUsual(recorder, sensors.map((s) => s.id), now) as { text: string; params?: unknown[] }[]) {
  let i = 0;
  sql.push(`${st.text.replace(/\?/g, () => q(st.params![i++]))};`);
}

// A live reading for the ETH sensors as of now (the prefetch's "spaces_live"), so a space that is open has frooms'
// estimate and its view offers the percentage slider and "Rate the estimate". It counts for 15 minutes after seeding,
// like a real reading (worker/spaces.ts): run the script again for more.
const liveReadings: Record<string, unknown> = {};
for (const s of sensors.filter((x) => x.eth)) {
  const rnd = random(`live|${s.id}|${today}`);
  const pct = 20 * (1 + Math.floor(rnd() * 4)); // 20 to 80 %
  liveReadings[s.id] = { people: Math.round((pct / 100) * s.capacity), capacity: s.capacity, pct, status: pct >= 80 ? "red" : pct >= 60 ? "yellow" : "green", trend: null, measured_at: now - 60_000, active: true };
}
insert("meta", ["key", "value"], [["spaces_live", JSON.stringify({ at: now, readings: liveReadings })]]);

// --- reports ---

// A handful of occupancy reports from invented browsers: two rooms (levels) and two spaces (a space with a sensor gets
// percentages and a rating, one without gets levels), spread over the past 4 hours so the log has older lines than the
// 2-hour summary. Earlier runs' are replaced (only theirs: reports sent from the local page stay).
const seedReporters = Array.from({ length: 8 }, (_, i) => createHash("sha256").update(`frooms-local-seed-${i}`).digest("hex"));
const seedRooms = ["HG E 33.1", "HG F 1"].filter((p) => rooms.some((r: object) => roomPath(r) === p));
for (const r of rooms) if (seedRooms.length < 2 && !seedRooms.includes(roomPath(r))) seedRooms.push(roomPath(r));
const sensorSpace = sensors.find((s) => s.eth && s.id === "GLCE31")?.id ?? sensors.find((s) => s.eth)!.id;
const plainSpace = "CHND8"; // Grüner Boden: open around the clock, no sensor
const ago = (min: number) => now - min * 60_000;
// [minutes ago, kind, place_kind, place, value, reporter, estimate]
const reportRows: [number, string, string, string, number, number, number | null][] = [
  [8, "level", "room", seedRooms[0], 2, 0, null],
  [25, "level", "room", seedRooms[0], 2, 1, null],
  [70, "level", "room", seedRooms[0], 1, 2, null],
  [170, "level", "room", seedRooms[0], 0, 3, null],
  [40, "level", "room", seedRooms[1], 0, 0, null],
  [12, "pct", "space", sensorSpace, 70, 4, 60],
  [55, "pct", "space", sensorSpace, 80, 5, 60],
  [50, "rating", "space", sensorSpace, 2, 5, 60],
  [200, "pct", "space", sensorSpace, 40, 6, 40],
  [15, "level", "space", plainSpace, 1, 7, null],
  [95, "level", "space", plainSpace, 0, 6, null],
];
sql.push(`DELETE FROM reports WHERE reporter IN (${seedReporters.map(q).join(", ")});`);
insert(
  "reports",
  ["at", "kind", "place_kind", "place", "area", "value", "reporter", "estimate"],
  reportRows.map(([min, kind, placeKind, place, value, who, estimate]) => [ago(min), kind, placeKind, place, "Z", value, seedReporters[who], estimate]),
);

// --- equipment (local KV) ---

// Invented flags for the seeded rooms (about half with a screen or projector, a tenth unknown), so Meet's "Screen or
// projector" chip has something to filter. Written to build/seed_equipment.json for the local KV.
const equipment: Record<string, { at: number; flags: Record<string, boolean> | null }> = {};
for (const r of rooms) {
  const rnd = random(`equipment|${roomPath(r)}`);
  if (rnd() < 0.1) continue;
  const screen = rnd() < 0.3;
  const projector = !screen && rnd() < 0.4;
  equipment[roomPath(r)] = {
    at: now,
    flags: { screen, projector, hdmi: screen || projector, wireless: rnd() < 0.5, blackboard: rnd() < 0.6, whiteboard: rnd() < 0.3, flipchart: rnd() < 0.2 },
  };
}

mkdirSync(join(ROOT, "build"), { recursive: true });
const out = join(ROOT, "build", "seed_local.sql");
writeFileSync(out, sql.join("\n") + "\n");
writeFileSync(join(ROOT, "build", "seed_equipment.json"), JSON.stringify(equipment));
console.log(
  `Wrote build/seed_local.sql: ${rooms.length} rooms × ${days.length} days of bookings, ${menuRows.length} menu days, ` +
    `${occupancyRows.length} occupancy readings of ${sensors.length} spaces, ${reportRows.length} reports ` +
    `(${seedRooms.join(", ")}, ${sensorSpace}, ${plainSpace}).\n` +
    "Load it into the local D1 (once: npx wrangler d1 migrations apply fruum --local):\n" +
    "  npx wrangler d1 execute fruum --local --file build/seed_local.sql\n" +
    "and the rooms' equipment into the local KV:\n" +
    "  npx wrangler kv key put equipment --path build/seed_equipment.json --binding ROOMS --local",
);
