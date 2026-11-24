"use strict";

// Pure logic for the page (no DOM, like geo.js): sorting, URLs, stars and search. Loaded before map.js and app.js,
// and unit-tested in test/lib.test.ts.

/**
 * The lists' order: starred places first, then places in a starred building, then by the distance of their building
 * when the position is known (nearest first; places whose building has no distance after those that have one), else
 * by `order` when given (an array of ids, the location's mensas in our order: listed ones in that order, the rest
 * after them by name), else the order they came in (the server's). Stable. `stars` is a Set of ids; an item's id is
 * `id` (spaces) or `room` (rooms). `distances` is a Map of building code to metres, or null. `starredBuildings` is a
 * Set of building codes, or null.
 */
function sortPlaces(items, { stars = null, distances = null, starredBuildings = null, order = null } = {}) {
  const idOf = (x) => x.id ?? x.room;
  const rank = (x) => (stars?.has(idOf(x)) ? 0 : starredBuildings?.has(x.building) ? 1 : 2);
  const dist = (x) => (distances?.has(x.building) ? distances.get(x.building) : Infinity);
  const pos = order?.length && !distances ? orderIndex(order) : null;
  const byOrder = (a, b) => {
    if (!pos) return 0;
    const [pa, pb] = [pos(a), pos(b)];
    if (pa !== pb) return pa < pb ? -1 : 1;
    return pa === Infinity ? String(a.name ?? "").localeCompare(String(b.name ?? ""), "de", { sensitivity: "base" }) : 0;
  };
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item) - rank(b.item) || (distances ? dist(a.item) - dist(b.item) || 0 : 0) || byOrder(a.item, b.item) || a.i - b.i)
    .map(({ item }) => item);
}

/** An item's place in `order` (an array of ids), Infinity when it isn't listed. */
function orderIndex(order) {
  const at = new Map((order ?? []).map((id, i) => [id, i]));
  return (x) => at.get(x.id ?? x.room) ?? Infinity;
}

/** A duration in minutes as "30 min", "1 h", "1 h 30 min". */
function durationText(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// --- place URLs: /?room=HG+E+33.1&area=Z, /?space=MMB79&area=Z, /?building=HG&area=Z, /?microwave=MW-MM-1&area=Z ---

const PLACE_KINDS = ["room", "space", "building", "microwave"];

/** A place's own address on the page. */
function placeUrl({ kind, id, area }) {
  const q = new URLSearchParams({ [kind]: id });
  if (area) q.set("area", area);
  return `/?${q}`;
}

/** The place a page address names ({ kind, id, area }), or null. `?buildings=` (the old bookmark) is no place. */
function parsePlaceUrl(search) {
  const q = new URLSearchParams(search);
  for (const kind of PLACE_KINDS) {
    const raw = (q.get(kind) ?? "").trim().replace(/\s+/g, " ");
    if (!raw || raw.length > 40) continue;
    return { kind, id: kind === "building" ? raw.toUpperCase() : raw, area: (q.get("area") ?? "").trim() || null };
  }
  return null;
}

// --- invite links: /share?room=… or /share?space=…[&meal=lunch&t=1215][&at=…] ---

const isoDay = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const addDaysIso = (date, n) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
};

/** What an invite link names: { kind, id, area, at, meal, t }, or null. */
function parseInvite(search) {
  const q = new URLSearchParams(search);
  const at = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(q.get("at") ?? "") ? q.get("at") : null;
  const area = q.get("area") || null;
  if (q.get("room")) return { kind: "room", id: q.get("room").trim().replace(/\s+/g, " "), area, at, meal: null, t: null };
  if (q.get("space")) {
    const meal = ["lunch", "dinner"].includes(q.get("meal")) ? q.get("meal") : null;
    return { kind: "space", id: q.get("space").trim(), area, at, meal, t: meal ? q.get("t") : null };
  }
  return null;
}

/**
 * The invite's sentence, as the Worker puts it into the link's title (worker/index.ts inviteTarget): "I'm in HG E
 * 33.1, come join me!", "Join me at Mensa Polyterrasse!", "Lunch at Mensa Polyterrasse at 12:15?". `place` is
 * { name, category, kind } (null for a room), `today` the date in Zurich.
 */
function inviteTitle(inv, place, today) {
  if (inv.kind === "room") return `I'm in ${inv.id}, come join me!`;
  if (!place) return null;
  if (inv.meal && place.kind === "mensa") {
    const date = (inv.at ?? "").slice(0, 10);
    const other = date && date !== today ? date : null;
    const weekday = other ? new Date(`${other}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }) : "";
    const day = !other ? "today" : other === addDaysIso(today, 1) ? "tomorrow" : weekday.toLowerCase();
    const onDay = day === "today" ? "" : day === "tomorrow" ? " tomorrow" : ` on ${weekday}`;
    const t = inv.t ?? "";
    const quarter = /^([01]\d|2[0-3])(00|15|30|45)$/.test(t);
    const question = t === "now" ? " now?" : quarter ? `${onDay} at ${t.slice(0, 2)}:${t.slice(2)}?` : day === "today" ? " today?" : `${onDay}?`;
    return `${inv.meal === "lunch" ? "Lunch" : "Dinner"} at ${place.name}${question}`;
  }
  return place.category === "mensa" ? `Join me at ${place.name}!` : `I'm at ${place.name}, come join me!`;
}

// --- stars: rooms, study spaces, mensas, cafeterias and buildings, kept in the browser only (newest first, at most
// 40 over all kinds). A building's star is { kind: "building", id: code, area, name, building: code }. ---

const MAX_STARS = 40;
const STAR_KINDS = ["room", "space", "building", "microwave"];

/** Stored stars, checked: unknown fields and broken entries are left out. */
function cleanStars(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    if (!s || !STAR_KINDS.includes(s.kind) || typeof s.id !== "string" || typeof s.area !== "string") continue;
    const key = `${s.kind}|${s.area}|${s.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const building = s.kind === "building" ? s.id : typeof s.building === "string" ? s.building : "";
    const star = { kind: s.kind, id: s.id, area: s.area, name: typeof s.name === "string" ? s.name : s.id, building };
    if (typeof s.typecode === "string") star.typecode = s.typecode;
    if (typeof s.category === "string") star.category = s.category;
    out.push(star);
  }
  return out.slice(0, MAX_STARS);
}

function isStarred(stars, { kind, id, area }) {
  return stars.some((s) => s.kind === kind && s.id === id && s.area === area);
}

/**
 * Star or unstar a place ({ kind, id, area, name, building, typecode? }). Returns { stars, starred, full }: the new
 * list (newest first), whether the place is starred now, and `full` when a 41st was refused.
 */
function toggleStar(stars, place) {
  if (isStarred(stars, place)) {
    return { stars: stars.filter((s) => !(s.kind === place.kind && s.id === place.id && s.area === place.area)), starred: false, full: false };
  }
  if (stars.length >= MAX_STARS) return { stars, starred: false, full: true };
  return { stars: cleanStars([place, ...stars]), starred: true, full: false };
}

/** The codes of the starred buildings in these areas (for sortPlaces and the building chips). */
function starredBuildingsIn(stars, areas) {
  return new Set(stars.filter((s) => s.kind === "building" && areas.includes(s.area)).map((s) => s.id));
}

/**
 * The building chips' order: starred buildings first (alphabetically), then the rest alphabetically. `counts` is a
 * Map or array of [code, count]; returns [{ code, count, starred }].
 */
function orderBuildingChips(counts, starred) {
  return [...counts]
    .map(([code, count]) => ({ code, count, starred: !!starred?.has(code) }))
    .sort((a, b) => Number(b.starred) - Number(a.starred) || a.code.localeCompare(b.code));
}

/** The stars per area, in the order they were starred; areas in the order of their newest star. */
function starsByArea(stars) {
  const out = new Map();
  for (const s of stars) out.set(s.area, [...(out.get(s.area) ?? []), s]);
  return out;
}

// --- search over /api/index: rooms, study spaces, mensas and buildings of all five locations ---

const SEARCH_LIMIT = 30;
const SEARCH_GROUPS = ["Buildings", "Rooms", "Study spaces", "Workspaces", "Mensas & cafeterias", "Microwaves"];

/**
 * Words a place is searched by besides its name (each word's start matches, like a name's): "inno" or "innovation"
 * finds both innovation workspaces (Raffaele, 21 November 2026).
 */
const SPACE_ALSO_NAMED = {
  IPZH: "Innovation Park Innovationspark Inovation",
  FABRIK: "Innovation Inovation",
};

/** Lower case, without accents, spaces, dots, hyphens or other punctuation: "HG E 33.1" -> "hge331", "Grün" -> "grun". */
function searchKey(text) {
  return String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The positions in searchKey(name) where a word starts ("Mensa Polyterrasse" -> 0 and 5). */
function wordStarts(name) {
  const starts = [];
  let pos = 0;
  for (const word of String(name ?? "").split(/[\s/&,()+]+|(?<=[a-z])-(?=[A-Za-z])/i)) {
    const k = searchKey(word);
    if (!k) continue;
    starts.push(pos);
    pos += k.length;
  }
  return starts;
}

/**
 * How well `q` (a searchKey) matches: 0 the code exactly, 1 the start of a code, 2 the start of a word of the name
 * (several words typed together match too: "mensapoly"), or null.
 */
function matchRank(q, codes, name) {
  const keys = codes.map(searchKey).filter(Boolean);
  if (keys.includes(q)) return 0;
  if (keys.some((k) => k.startsWith(q))) return 1;
  const nk = searchKey(name);
  if (nk && wordStarts(name).some((p) => nk.startsWith(q, p))) return 2;
  return null;
}

/**
 * Search the index ({ rooms, spaces, buildings } as /api/index sends them). Results: { kind, id, area, name, room,
 * group, category }, at most 30, in the groups' order (Buildings, Rooms, Study spaces, Mensas & cafeterias); within a
 * group the exact code first, then code starts, then word starts, then the current area, then starred places.
 * `names` maps "area|code" to a building's name.
 */
function searchPlaces(index, query, { area = null, stars = [], names = new Map() } = {}) {
  const q = searchKey(query);
  if (!q || !index) return [];
  const starred = new Set(stars.map((s) => `${s.kind}|${s.area}|${s.id}`));
  const hits = [];
  const add = (item, rank) => {
    if (rank === null) return;
    hits.push({ ...item, rank, here: item.area === area ? 0 : 1, star: starred.has(`${item.kind}|${item.area}|${item.id}`) ? 0 : 1, n: hits.length });
  };
  for (const [code, a, name] of index.buildings ?? []) {
    const label = name ?? names.get(`${a}|${code}`) ?? null;
    add({ kind: "building", id: code, area: a, name: label ? `${code} ${label}` : code, room: null, group: "Buildings", category: null }, matchRank(q, [code], label));
  }
  for (const [path, a, typecode, seats] of index.rooms ?? []) {
    add({ kind: "room", id: path, area: a, name: path, room: null, group: "Rooms", category: typecode, seats }, matchRank(q, [path], null));
  }
  for (const [id, a, name, room, category] of index.spaces ?? []) {
    const eat = category === "mensa" || category === "cafe";
    const group = eat ? "Mensas & cafeterias" : category === "workspace" ? "Workspaces" : "Study spaces";
    add({ kind: "space", id, area: a, name, room, group, category }, matchRank(q, [id, room], name) ?? matchRank(q, [], SPACE_ALSO_NAMED[id]));
  }
  for (const [id, a, name, building] of index.microwaves ?? []) {
    add({ kind: "microwave", id, area: a, name, room: building, group: "Microwaves", category: null }, matchRank(q, [], name));
  }
  hits.sort((x, y) => x.rank - y.rank || x.here - y.here || x.star - y.star || x.id.length - y.id.length || x.n - y.n);
  // A place listed in several locations (IPZ Hangar, in both ETH ones): once, the current location's first.
  const seen = new Set();
  const top = hits.filter((h) => !seen.has(`${h.kind}|${h.id}`) && seen.add(`${h.kind}|${h.id}`)).slice(0, SEARCH_LIMIT);
  return SEARCH_GROUPS.flatMap((g) => top.filter((h) => h.group === g))
    .map(({ rank, here, star, n, ...item }) => item);
}

// --- search for things, not names: "rooms", "library", "vegan", "microwave" (search's "Go to" results) ---

/**
 * What one can search for besides a place's name, with the words (English and German, singular and plural, common
 * misspellings) that mean it. Each gives one or two results that open a tab, the meal search or a location with the
 * fitting filters (places.js runIntent): `go` is what to do. `near` results use the position (asked for if needed).
 */
const SEARCH_INTENTS = [
  { key: "rooms", words: ["room", "rooms", "free room", "free rooms", "meeting room", "meeting", "meet", "discussion room", "group room", "group work", "team room", "project room", "study room", "workroom",
    "raum", "räume", "raeume", "zimmer", "sitzungszimmer", "besprechungsraum", "gruppenraum", "gruppenarbeit", "lernraum", "freier raum", "freie räume"],
    results: [{ id: "rooms-near", title: "Rooms near you", sub: "Free rooms, nearest first", go: { tab: "rooms", near: true } },
      { id: "rooms", title: "Room search", sub: "Meet: rooms free to meet in", go: { tab: "rooms" } }] },
  { key: "lecture", words: ["lecture hall", "lecture halls", "lecture theatre", "auditorium", "aula", "hörsaal", "hörsäle", "horsaal", "hoersaal"],
    results: [{ id: "lecture", title: "Free lecture halls", sub: "Meet: lecture halls only", go: { tab: "rooms", types: ["3430"] } }] },
  { key: "seminar", words: ["seminar room", "seminar rooms", "seminar", "classroom", "class room", "seminarraum", "seminarräume", "unterrichtsraum", "kursraum"],
    results: [{ id: "seminar", title: "Free seminar rooms", sub: "Meet: seminar rooms only", go: { tab: "rooms", types: ["3420"] } }] },
  { key: "computer", words: ["computer room", "computer rooms", "pc room", "computer lab", "computerraum", "pc-raum", "rechnerraum"],
    results: [{ id: "computer", title: "Free computer rooms", sub: "Meet: computer rooms only", go: { tab: "rooms", types: ["3650"] } }] },
  { key: "library", words: ["library", "libraries", "librarys", "libary", "bibliothek", "bibliotheken", "bibi", "bib", "lib"],
    results: [{ id: "library-near", title: "Libraries near you", sub: "Study: libraries, nearest first", go: { tab: "study", near: true, section: "s-library" } },
      { id: "library", title: "Libraries", sub: "Study: libraries and how full they are", go: { tab: "study", section: "s-library" } }] },
  { key: "study", words: ["study", "study space", "study spaces", "study place", "place to study", "space", "spaces", "learning", "learn", "desk", "quiet",
    "lernen", "lernplatz", "lernplätze", "lernzone", "arbeitsplatz", "arbeitsplätze", "ruhig"],
    results: [{ id: "study-near", title: "Study spaces near you", sub: "Open study spaces, nearest first", go: { tab: "study", near: true } },
      { id: "study", title: "Study spaces", sub: "Study: libraries and open study spaces", go: { tab: "study" } }] },
  { key: "workspace", words: ["workspace", "workspaces", "work space", "work spaces", "makerspace", "makerspaces", "maker space", "project space", "project house",
    "student project house", "coworking", "co-working", "workshop", "werkstatt", "werkraum", "prototyping", "tinkering", "projekt", "projektraum"],
    results: [{ id: "workspace", title: "Workspaces", sub: "Study: SPH, Fabrik, IPZ Hangar", go: { tab: "study", section: "s-workspace" } }] },
  { key: "buildings", words: ["building", "buildings", "gebäude", "gebaude", "gebaeude", "haus", "häuser"],
    results: [{ id: "buildings-near", title: "Buildings near you", sub: "What's open and free around you", go: { nearView: true } },
      { id: "buildings", title: "All buildings on the map", sub: "The whole campus", go: { fit: true } }] },
  { key: "campus", words: ["campus", "campuses", "campi", "location", "locations", "standort", "standorte", "uni", "university", "universität", "hochschule"],
    results: [{ id: "campus", title: "Change campus", sub: "ETH Zentrum, Hönggerberg, UZH Zentrum, Irchel, Oerlikon", go: { campusMenu: true } }] },
  { key: "microwave", words: ["microwave", "microwaves", "micro", "mikrowelle", "mikrowellen", "mikro", "heat food", "warm up", "aufwärmen", "aufwaermen"],
    results: [{ id: "microwave-near", title: "Microwaves near you", sub: "Eat: microwaves, nearest first", go: { tab: "mensa", near: true, section: "s-micro", layer: "mensa" } }] },
  { key: "mensa", words: ["mensa", "mensas", "mensen", "canteen", "canteens", "cafeteria lunch", "food", "eat", "eating", "lunch", "dinner", "menu", "menus", "meal", "meals",
    "essen", "mittagessen", "abendessen", "menü", "menüs", "mittag", "hunger", "hungry", "restaurant"],
    results: [{ id: "mensa-near", title: "Mensas near you", sub: "Eat: mensas, nearest first", go: { tab: "mensa", near: true, section: "s-mensa", layer: "mensa" } },
      { id: "compare", title: "Compare menus", sub: "Today's menus side by side", go: { compare: true } },
      { id: "meal", title: "Find your meal", sub: "Every dish, sorted and filtered", go: { meal: { sort: "price", filters: [] } } }] },
  { key: "cafe", words: ["cafeteria", "cafeterias", "caffeteria", "cafe", "cafes", "café", "cafés", "coffee", "kaffee", "kafi", "bar", "bars", "snack", "snacks", "kiosk", "espresso", "cappuccino"],
    results: [{ id: "cafe-near", title: "Cafeterias near you", sub: "Eat: cafeterias and bars, nearest first", go: { tab: "mensa", near: true, section: "s-cafe", layer: "cafe" } }] },
  // The tutorial (static/tutorial.js): the welcome screen with its journeys, or one journey for its own phrases.
  { key: "tutorial", words: ["tutorial", "tutorials", "tour", "guided tour", "take the tour", "walkthrough", "walk through", "introduction", "intro", "onboarding",
    "getting started", "get started", "first steps", "how to use", "how to use frooms", "how does frooms work", "how frooms works", "how it works", "explain", "explanation",
    "demo", "learn frooms", "show me around", "einführung", "einfuehrung", "anleitung", "rundgang", "erklärung", "erklaerung", "wie funktioniert", "erste schritte"],
    results: [{ id: "tutorial", title: "Tutorial", sub: "A guided tour of frooms: pick what you want to do", go: { tour: true } }] },
  { key: "tour-friends", words: ["friends tutorial", "tutorial friends", "add friends", "add a friend", "find my friends", "connect with friends", "how to add friends", "freunde hinzufügen"],
    results: [{ id: "tour-friends", title: "Tutorial: Connect with my friends on campus", sub: "A guided tour", go: { tour: "friends" } }] },
  { key: "tour-study", words: ["study tutorial", "tutorial study", "how to find a study space", "find places to study"],
    results: [{ id: "tour-study", title: "Tutorial: Find places to study", sub: "A guided tour", go: { tour: "study" } }] },
  { key: "tour-meet", words: ["meet tutorial", "tutorial meet", "how to find a room", "find a room to meet"],
    results: [{ id: "tour-meet", title: "Tutorial: Find a room to meet with my team", sub: "A guided tour", go: { tour: "meet" } }] },
  { key: "tour-food", words: ["food tutorial", "tutorial food", "eat tutorial", "food options"],
    results: [{ id: "tour-food", title: "Tutorial: Look through food options", sub: "A guided tour", go: { tour: "food" } }] },
  { key: "tour-cred", words: ["street cred", "streetcred", "cred", "cred tutorial", "tutorial cred", "earn points", "earn cred", "how to earn", "points", "punkte", "level up", "levels", "bubble styles"],
    results: [{ id: "tour-cred", title: "Tutorial: Earn street cred", sub: "A guided tour", go: { tour: "cred" } }] },
  { key: "tour-map", words: ["map tutorial", "tutorial map", "navigate", "navigation", "navigate the campus", "how to use the map", "find my way", "wayfinding", "orientierung"],
    results: [{ id: "tour-map", title: "Tutorial: Navigate the campus", sub: "A guided tour", go: { tour: "map" } }] },
  // Help words lead to the tutorial for now. If frooms ever gets an FAQ, they should lead there too
  // (plans/FAQ_NOTES.md lists them).
  { key: "help", words: ["help", "hilfe", "faq", "faqs", "question", "questions", "frage", "fragen", "support", "manual", "instructions", "how to", "how do i", "how does",
    "what is frooms", "what's frooms", "about frooms", "info", "information", "documentation", "docs", "guide", "user guide", "tips", "tricks", "stuck", "confused", "lost",
    "problem", "issue", "contact", "hilfe bitte", "wie geht", "bedienung", "benutzung"],
    results: [{ id: "help-tutorial", title: "Tutorial", sub: "Help: a guided tour of frooms", go: { tour: true } }] },
];

/** Meal words: each adds a filter or a sort to one "… meals" result that opens Find your meal. */
const MEAL_INTENTS = [
  { words: ["vegan", "vegane", "plant based", "plant-based", "pflanzlich"], filter: "vegan" },
  { words: ["vegetarian", "vegetarisch", "vegetarische", "veggie", "vegi", "vegie", "meatless", "fleischlos"], filter: "vegetarian" },
  { words: ["meat", "fleisch", "chicken", "poulet", "beef", "rind", "pork", "schwein", "burger", "steak"], filter: "meat" },
  { words: ["fish", "fisch", "seafood", "salmon", "lachs"], filter: "fish" },
  { words: ["gluten free", "gluten-free", "glutenfree", "glutenfrei", "no gluten", "coeliac", "celiac", "zöliakie"], filter: "glutenfree" },
  { words: ["lactose free", "lactose-free", "lactosefree", "laktosefrei", "laktose", "dairy free", "dairy-free", "milchfrei"], filter: "lactosefree" },
  { words: ["protein", "proteins", "high protein", "eiweiss", "eiweiß", "gym", "gains", "bulk", "bulking", "muscle"], sort: "protein" },
  { words: ["carbs", "carb", "carbohydrates", "kohlenhydrate", "carb load", "pasta"], sort: "carbs" },
  { words: ["low calorie", "low-calorie", "light", "kalorienarm", "diet", "diät", "cut", "cutting"], sort: "kcal", dir: "asc" },
  { words: ["calories", "calorie", "kcal", "kalorien", "energy"], sort: "kcal", dir: "asc" },
  { words: ["cheap", "cheapest", "budget", "günstig", "guenstig", "billig", "preiswert", "price", "prices", "preis", "affordable"], sort: "price" },
];

const MEAL_SORT_WORDS = { price: "Cheapest", protein: "High-protein", carbs: "High-carb" };

/**
 * How well a word means the query (both searchKeys): 0 the same, 1 the query starts with the word ("veganmeals"),
 * 2 the word starts with the query ("libr", 3 letters at least), 3 the word is inside a longer query ("cheapvegan"),
 * else null.
 */
function intentRank(q, word) {
  const w = searchKey(word);
  if (!w) return null;
  if (q === w) return 0;
  if (w.length >= 3 && q.startsWith(w)) return 1;
  if (q.length >= 3 && w.startsWith(q)) return 2;
  if (w.length >= 4 && q.includes(w)) return 3;
  return null;
}

/** The best rank of any of the words, or null. */
function bestRank(q, words) {
  let best = null;
  for (const w of words) {
    const r = intentRank(q, w);
    if (r !== null && (best === null || r < best)) best = r;
  }
  return best;
}

/**
 * The "Go to" results for a query: the intents its words mean (SEARCH_INTENTS), a "… meals" result when it names
 * meal types, values or prices (MEAL_INTENTS, all of them together: "cheap vegan" gives "Cheapest vegan meals"), and
 * the locations whose name it starts (`areas`: [{ area, name }]). Each { id, title, sub, go, rank } (rank 0: the query
 * is one of the words); the best matches first,
 * at most `limit`. Under 3 letters: none (codes like HG are places).
 */
function searchIntents(query, { areas = [], limit = 5 } = {}) {
  const q = searchKey(query);
  if (q.length < 3) return [];
  const found = [];
  // The meal search: every meal word in the query counts.
  const filters = [];
  let sort = null;
  let dir = null;
  let mealRank = null;
  for (const m of MEAL_INTENTS) {
    const r = bestRank(q, m.words);
    if (r === null) continue;
    mealRank = mealRank === null ? r : Math.min(mealRank, r);
    if (m.filter && !filters.includes(m.filter)) filters.push(m.filter);
    if (m.sort && !sort) {
      sort = m.sort;
      dir = m.dir ?? null;
    }
  }
  if (mealRank !== null) {
    const kinds = cleanMealFilters(filters).map((f) => MEAL_FILTER_LABELS[f].toLowerCase());
    const lead = sort === "kcal" ? "Low-calorie" : sort ? MEAL_SORT_WORDS[sort] : null;
    const words = [lead, ...kinds, "meals"].filter(Boolean).join(" ");
    found.push({ rank: mealRank, n: -1, id: "meal-type", title: words[0].toUpperCase() + words.slice(1), sub: "Find your meal",
      go: { meal: { sort: sort ?? "price", filters: cleanMealFilters(filters), ...(dir ? { dir } : {}) } } });
  }
  SEARCH_INTENTS.forEach((intent, n) => {
    const r = bestRank(q, intent.words);
    if (r === null) return;
    intent.results.forEach((res, i) => found.push({ rank: r, n: n + i / 10, ...res }));
  });
  for (const a of areas) {
    const parts = String(a.name).split(/\s+/);
    // "Irchel", "Hönggerberg", "UZH Zentrum": the name or one of its words from the start.
    const r = [a.name, ...parts.slice(1)].map((w) => intentRank(q, w)).filter((x) => x !== null && x !== 3).sort()[0];
    if (r !== undefined) found.push({ rank: r, n: 100, id: `area-${a.area}`, title: a.name, sub: "Go to this campus", go: { area: a.area } });
  }
  found.sort((x, y) => x.rank - y.rank || x.n - y.n);
  // One row per title ("help tutorial" means the tutorial once).
  const titles = new Set();
  return found.filter((r) => !titles.has(r.title) && titles.add(r.title)).slice(0, limit).map(({ n, ...r }) => r);
}

// --- the date and time picker (static/picker.js): the calendar's grid and the time wheel's physics ---

/** The minute step of the time wheel. */
const TIME_STEP_MIN = 5;
/** One step of a drum in pixels: a drag of this length moves the drum by one value. */
const WHEEL_STEP_PX = 36;
/** How fast a flicked drum slows down, in px/ms²: the glide's distance is v² / (2 × friction). */
const WHEEL_FRICTION = 0.0025;
/** A release slower than this (px/ms) doesn't glide: the drum just snaps to the nearest value. */
const WHEEL_MIN_VELOCITY = 0.05;
/** A glide lasts at most this long (so a wild flick doesn't spin for seconds). */
const WHEEL_MAX_MS = 2000;

/** "HH:MM" rounded down to a multiple of `step` minutes ("10:17" -> "10:15"). */
function roundToStep(hhmm, step = TIME_STEP_MIN) {
  const h = Number(hhmm.slice(0, 2));
  const m = Math.floor(Number(hhmm.slice(3, 5)) / step) * step;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * The value in the drum's window at an offset: `offsetPx` is how far the list has been pulled up (one value further is
 * `stepPx` more), the drum is circular, so the index wraps (23 -> 0, 55 -> 0) in both directions.
 */
function wheelIndex(offsetPx, stepPx, count) {
  return ((Math.round(offsetPx / stepPx) % count) + count) % count;
}

/**
 * Where a released drum glides to: { distance, duration } (px and ms) for the release velocity in px/ms, slowing down
 * with constant friction. The distance grows with the square of the velocity, so a flick twice as fast goes about four
 * times as far; a slow release (under WHEEL_MIN_VELOCITY) doesn't glide at all.
 */
function wheelGlide(velocityPxPerMs) {
  const speed = Math.min(Math.abs(velocityPxPerMs), WHEEL_FRICTION * WHEEL_MAX_MS);
  if (speed < WHEEL_MIN_VELOCITY) return { distance: 0, duration: 0 };
  const sign = velocityPxPerMs < 0 ? -1 : 1;
  return { distance: sign * (speed * speed) / (2 * WHEEL_FRICTION), duration: speed / WHEEL_FRICTION };
}

/**
 * The calendar's month: { title, weeks } for "YYYY-MM", `weeks` rows of seven ISO dates or null (the blanks before the
 * first and after the last day), Monday first. The title is "November 2026".
 */
function calendarMonth(yearMonth) {
  const [y, m] = yearMonth.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const title = first.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${yearMonth}-${String(i + 1).padStart(2, "0")}`)];
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { title, weeks };
}

/** "YYYY-MM" shifted by `n` months. */
function addMonthsTo(yearMonth, n) {
  const [y, m] = yearMonth.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * The map's region tiles (static/map/region/index.json: `bounds`, `tile` in metres, `tiles` like "3_7" for column 3,
 * row 7) that overlap a box [x0, y0, x1, y1] in the region's metres, widened by `margin` metres. Only tiles that
 * exist (the others have nothing on them).
 */
function tilesInView(index, [x0, y0, x1, y1], margin = 0) {
  const [bx0, by0] = index.bounds;
  const t = index.tile;
  const have = (index.have ??= new Set(index.tiles));
  const c0 = Math.floor((x0 - margin - bx0) / t);
  const c1 = Math.floor((x1 + margin - bx0) / t);
  const r0 = Math.floor((y0 - margin - by0) / t);
  const r1 = Math.floor((y1 + margin - by0) / t);
  const out = [];
  for (let r = Math.max(0, r0); r <= r1; r++) {
    for (let c = Math.max(0, c0); c <= c1; c++) if (have.has(`${c}_${r}`)) out.push(`${c}_${r}`);
  }
  return out;
}

// --- Study's rooms and Meet's room types ---

/**
 * Study's room groups from /api/map's `rooms`: for each typecode of `types` (in that order), the rooms free for at
 * least `minFree` minutes from the chosen time (free for the rest of the stored window counts too), in the order they
 * came in (the server's: longest free first). Rooms free for less, busy or without data are left out (Meet has them).
 * `picked` (a Set of building codes, empty = all) filters them like the study spaces.
 */
function studyRoomGroups(rooms, types, minFree, picked = new Set()) {
  const long = (rooms ?? []).filter((r) => r.status === "free" && (r.minutes == null || r.minutes >= minFree)
    && (!picked.size || picked.has(r.building)));
  return types.map((typecode) => ({ typecode, rooms: long.filter((r) => r.typecode === typecode) }));
}

/**
 * The room types to keep from a stored choice: those the location offers (`known`, a Set). Null when nothing was
 * stored yet, or when nothing stored is offered any more (an old choice of computer rooms only): then the defaults.
 * A choice stored empty on purpose stays empty (every type).
 */
function keptTypes(stored, known) {
  if (!Array.isArray(stored)) return null;
  const kept = stored.filter((t) => known.has(t));
  return stored.length && !kept.length ? null : kept;
}

// A room's equipment flags (/api/room's and the rooms list's `equipment`, from ETH's room details), as named on the page.
const EQUIPMENT_NAMES = [
  ["screen", "screen"], ["projector", "projector"], ["hdmi", "HDMI"], ["wireless", "wireless presenter"],
  ["blackboard", "blackboard"], ["whiteboard", "whiteboard"], ["flipchart", "flipchart"],
];

/** "Equipment: screen, projector, HDMI" from the flags, or null when they're unknown or name nothing. */
function equipmentText(flags) {
  if (!flags || typeof flags !== "object") return null;
  const names = EQUIPMENT_NAMES.filter(([key]) => flags[key] === true).map(([, name]) => name);
  return names.length ? `Equipment: ${names.join(", ")}` : null;
}

/** Whether a room has something to present on (Meet's "Screen or projector" filter); null when unknown. */
const hasScreen = (flags) => (flags && typeof flags === "object" ? !!(flags.screen || flags.projector) : null);

// --- the schedule bar on room rows (app.js scheduleBar): the day's blocks from /api/map's and /api/room's `blocks` ---

/** The bar shows this part of the day (minutes since midnight): 07:00 to 22:00. */
const BAR_FROM = 7 * 60;
const BAR_TO = 22 * 60;

/** "08:15" from minutes since midnight. */
const minutesText = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * The bar's segments from a room's `blocks` ([from, to, kind] in minutes since midnight, "b" booked or "c" closed): each
 * as { left, width } in percent of the bar (BAR_FROM to BAR_TO; blocks outside are cut to it, those wholly outside left
 * out) with its kind. Closures come after bookings, so where both overlap the closure is drawn on top.
 */
function barSegments(blocks, from = BAR_FROM, to = BAR_TO) {
  const span = to - from;
  const out = [];
  for (const kind of ["b", "c"]) {
    for (const [a, b, k] of blocks ?? []) {
      if (k !== kind) continue;
      const [x0, x1] = [Math.max(a, from), Math.min(b, to)];
      if (x1 <= x0) continue;
      out.push({ left: ((x0 - from) / span) * 100, width: ((x1 - x0) / span) * 100, kind });
    }
  }
  return out;
}

/** Where the needle sits for "HH:MM" in percent of the bar, clamped to its ends; null outside the shown hours. */
function barNeedle(hhmm, from = BAR_FROM, to = BAR_TO) {
  const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  if (m < from || m > to) return null;
  return ((m - from) / (to - from)) * 100;
}

/** The blocks as text for the bar's tooltip: "08:15–10:00 booked, 18:00–24:00 closed"; "Free all day" without any. */
function blocksTitle(blocks) {
  const words = { b: "booked", c: "closed" };
  const parts = [...(blocks ?? [])].sort((x, y) => x[0] - y[0]).map(([a, b, k]) => `${minutesText(a)}–${b >= 1440 ? "24:00" : minutesText(b)} ${words[k]}`);
  return parts.length ? parts.join(", ") : "Free all day";
}

// --- occupancy reports (the Worker's `reports` summary: { levels: [free, crowded, full], pct, n_pct, last }) ---

const REPORT_LEVELS = ["free", "crowded", "full"];
/** A reported percentage counts as crowded from here, and as full from here. */
const REPORT_CROWDED_PCT = 60;
const REPORT_FULL_PCT = 80;

/**
 * The level a place's reports say: the level with the most reports (ties go to the fuller one), or without any level
 * reports the average of the percentage reports (crowded from 60 %, full from 80 %); null without reports.
 */
function reportLevel(summary) {
  if (!summary) return null;
  const levels = summary.levels ?? [0, 0, 0];
  const most = Math.max(...levels);
  if (most > 0) return levels.lastIndexOf(most);
  if (summary.pct == null || !summary.n_pct) return null;
  return pctLevel(summary.pct);
}

/** The level a reported percentage counts as: 0 free, 1 crowded (from 60 %), 2 full (from 80 %). */
const pctLevel = (pct) => (pct >= REPORT_FULL_PCT ? 2 : pct >= REPORT_CROWDED_PCT ? 1 : 0);

/** The reported levels with their counts, fullest first, only those reported: [{ level, count }]. */
function reportedLevels(summary) {
  return [2, 1, 0].map((level) => ({ level, count: summary?.levels?.[level] ?? 0 })).filter((x) => x.count > 0);
}

// --- a microwave spot's queue (kind "queue": 0 free, 1 about 5 minutes, 2 about 10, 3 15 minutes or more) ---

const QUEUE_NAMES = ["no queue", "about 5 min", "about 10 min", "15 min or more"];
const QUEUE_BUTTONS = ["Free", "~5 min", "~10 min", "15 min+"];

/** The queue a microwave's reports say: the length with the most reports (ties go to the longer one), or null. */
function queueLevel(summary) {
  const q = summary?.queue;
  if (!Array.isArray(q)) return null;
  const most = Math.max(...q);
  return most > 0 ? q.lastIndexOf(most) : null;
}

/** The reported queue lengths with their counts, longest first, only those reported: [{ level, count }]. */
const reportedQueues = (summary) => [3, 2, 1, 0].map((level) => ({ level, count: summary?.queue?.[level] ?? 0 })).filter((x) => x.count > 0);

/** A microwave spot's name as its page shows it: "Einstein microwaves" ("BIN Microwaves" stays). */
const microwaveName = (m) => (/microwave/i.test(m.name) ? m.name : `${m.name} microwaves`);

// --- your own reports (POST /api/report): the browser's random id, and what it sent in the past 2 hours ---

/** How long a report counts (the Worker's REPORT_WINDOW_MS): the controls show your report for as long. */
const MY_REPORT_MS = 2 * 60 * 60 * 1000;
const MY_REPORT_KINDS = ["level", "pct", "rating", "queue"];
/** A client id is 32 hex digits (16 random bytes); the Worker stores only its SHA-256. */
const CLIENT_ID_RE = /^[0-9a-f]{32}$/;

/** The client id from 16 random bytes (crypto.getRandomValues), as 32 hex digits. */
const clientIdFrom = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The key a place's reports are kept under: "room|Z|HG E 33.1", "space|Z|HGH30.1". */
const reportKey = (p) => `${p.kind}|${p.area}|${p.id}`;

/**
 * Your reports as stored ({ place, kind, at, value }): only well-formed ones of the past 2 hours, one per place and
 * kind (the newest), newest first, at most 50.
 */
function cleanMyReports(list, now) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .filter((r) => r && typeof r.place === "string" && MY_REPORT_KINDS.includes(r.kind) && Number.isFinite(r.at) && Number.isInteger(r.value)
      && r.at <= now + 60_000 && now - r.at < MY_REPORT_MS)
    .sort((a, b) => b.at - a.at)
    .filter((r) => !seen.has(`${r.place}|${r.kind}`) && seen.add(`${r.place}|${r.kind}`))
    .slice(0, 50)
    .map(({ place, kind, at, value }) => ({ place, kind, at, value }));
}

/** The list with a new report of yours: it replaces your earlier one of the same place and kind. */
const noteMyReport = (list, report, now) => cleanMyReports([report, ...list], now);

/** The list without your report of `place` (a reportKey) and `kind`: you removed it. */
const forgetMyReport = (list, place, kind, now) => cleanMyReports(list, now).filter((r) => !(r.place === place && r.kind === kind));

/** Your report of a place (its reportKey) and kind in the past 2 hours, or null. */
const myReportOf = (list, place, kind, now) => cleanMyReports(list, now).find((r) => r.place === place && r.kind === kind) ?? null;

/** Where the percentage slider starts: frooms' estimate rounded to its 5 % steps, within 0 to 100. */
const sliderStart = (pct) => Math.min(100, Math.max(0, Math.round((pct ?? 50) / 5) * 5));


// --- the Eat tab (app.js renderEat, mensaCard): a mensa's status in meal words, the photo tile, the microwaves ---

const EAT_MEAL_NAMES = { lunch: "Lunch", dinner: "Dinner" };
const isoHHMM = (iso) => iso.slice(11, 16);
const isoDate_ = (iso) => iso.slice(0, 10);
const shortWeekday = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });

/**
 * A mensa's or cafeteria's status in the Eat tab, as lines [{ text, cls }] from a /api/spaces entry at `at` (a Zurich
 * ISO time): a mensa says "Lunch until 13:30" (amber) while serving, "Lunch at 11:15" (plain) before its next meal
 * today, "Lunch tomorrow at 11:15" or "Lunch on Mon at 11:15" (grey) when its next meal is another day, "Open until
 * 21:00" (plain) when it's open after its last meal, "Closed today" (grey) otherwise; a cafeteria or bar "Open until
 * 18:30" (brown) or "Closed · opens 07:30" (grey). A mensa that is a study space right now adds "Study space now,
 * until 11:15" as a second line (the detail view shows it; the card shows the first line only).
 */
function eatStatus(s, at) {
  const t = isoHHMM(at);
  const today = isoDate_(at);
  const sameDay = (iso) => iso && isoDate_(iso) === today;
  const untilText = (iso) => (sameDay(iso) ? ` until ${isoHHMM(iso)}` : "");
  if (s.kind === "cafe" || (s.kind == null && s.category === "mensa")) {
    if (s.open) return [{ text: `Open${untilText(s.until)}`, cls: "cafe" }];
    return [{ text: s.opens_at ? `Closed · opens ${sameDay(s.opens_at) ? isoHHMM(s.opens_at) : `${shortWeekday(isoDate_(s.opens_at))} ${isoHHMM(s.opens_at)}`}` : "Closed", cls: "closed" }];
  }
  const meals = s.meals_today ?? [];
  const now = meals.find((m) => m.from <= t && t < m.to);
  const next = meals.find((m) => m.from > t);
  let line;
  if (s.open && s.meal && now) line = { text: `${EAT_MEAL_NAMES[now.meal]} until ${now.to}`, cls: "food" };
  else if (next) line = { text: `${EAT_MEAL_NAMES[next.meal]} at ${next.from}`, cls: "plain" };
  else if (s.open) line = { text: `Open${untilText(s.until)}`, cls: "plain" };
  else if (s.meals_next?.meals?.length) {
    const first = s.meals_next.meals[0];
    const when = s.meals_next.date === addDaysIso(today, 1) ? "tomorrow" : `on ${shortWeekday(s.meals_next.date)}`;
    line = { text: `${EAT_MEAL_NAMES[first.meal]} ${when} at ${first.from}`, cls: "closed" };
  } else line = { text: "Closed today", cls: "closed" };
  const lines = [line];
  // A study space between its meals: the next meal ends that, or closing time does.
  if (s.open && s.study && !s.meal) {
    const end = next && (!s.until || !sameDay(s.until) || next.from < isoHHMM(s.until)) ? next.from : sameDay(s.until) ? isoHHMM(s.until) : null;
    lines.push({ text: end ? `Study space now, until ${end}` : "Study space now", cls: "study" });
  }
  return lines;
}

/**
 * One or two letters for a mensa's photo tile when it has no photo: the initials of the first two words of its name,
 * skipping a leading "Mensa" ("Mensa Polyterrasse" -> "P", "Obere Mensa" -> "OM", "food&lab" -> "FL", "Rice Up!" -> "RU").
 */
function placeInitials(name) {
  const words = String(name ?? "").split(/[\s&/+-]+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  const own = words.length > 1 && words[0].toLowerCase() === "mensa" ? words.slice(1) : words;
  return own.slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}

/**
 * The Eat tab's microwaves (/api/spaces' `microwaves`) by building, as Meet groups rooms: [{ building, count, items }],
 * the nearest building first when `distances` (building code -> metres) is known, else in the file's order; `count` is
 * the building's microwaves in all.
 */
function microwaveGroups(list, distances = null) {
  const groups = new Map();
  for (const m of list ?? []) {
    if (!groups.has(m.building)) groups.set(m.building, { building: m.building, count: 0, items: [] });
    const g = groups.get(m.building);
    g.count += m.count;
    g.items.push(m);
  }
  const dist = (code) => (distances?.has(code) ? distances.get(code) : Infinity);
  return [...groups.values()]
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (distances ? dist(a.g.building) - dist(b.g.building) || 0 : 0) || a.i - b.i)
    .map(({ g }) => g);
}

// --- "usually this full" (the Worker's `usual`: { pct, curve } with 96 quarter hours) ---

/** The quarter hour of the day "HH:MM" falls in, 0..95. */
const slotOfTime = (hhmm) => Number(hhmm.slice(0, 2)) * 4 + Math.floor(Number(hhmm.slice(3, 5)) / 15);

/** "almost empty", "about 55 % full" or "full", as the occupancy estimate puts it. */
const fullText = (pct) => (pct <= 0 ? "almost empty" : pct >= 100 ? "full" : `about ${pct} % full`);

// --- the comparison's mensas ---

/**
 * The comparison's mensa chips: starred first, in the order they were starred (`starred`, ids); then by the distance
 * of their building when `distances` (a Map of building code to metres) is known, nearest first; else in the
 * location's order (`order`, ids: the Worker's `order`, data/overrides.json `mensa_order`), then the rest
 * alphabetically. Without a distance, a mensa goes after those that have one, alphabetically.
 */
function compareOrder(mensas, { starred = [], distances = null, order = [] } = {}) {
  const star = (m) => { const i = starred.indexOf(m.id); return i < 0 ? Infinity : i; };
  const pos = orderIndex(order);
  const dist = (m) => (distances?.has(m.building) ? distances.get(m.building) : Infinity);
  const diff = (a, b) => (a === b ? 0 : a < b ? -1 : 1); // Infinity - Infinity is NaN
  return [...mensas].sort((a, b) => diff(star(a), star(b))
    || (distances ? diff(dist(a), dist(b)) : diff(pos(a), pos(b)))
    || a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
}

/**
 * The comparison's columns before anything is picked (ids): the starred mensas among `mensas`, in the order they were
 * starred (`starred`, ids); with exactly one, it and the first other mensa of `order` (Polymensa, or the Obere Mensa
 * when the star is Polymensa); with none, the first two of `order` that are there (Polymensa and the Obere Mensa,
 * food market and FUSION meal). A location without an order takes the first two of `mensas` (the chips' order).
 */
function compareDefault(mensas, { starred = [], order = [] } = {}) {
  const ids = new Set(mensas.map((m) => m.id));
  const stars = starred.filter((id) => ids.has(id));
  if (stars.length > 1) return stars;
  const pool = [...order.filter((id) => ids.has(id)), ...mensas.map((m) => m.id)];
  const picks = [...stars];
  for (const id of pool) {
    if (picks.length >= 2) break;
    if (!picks.includes(id)) picks.push(id);
  }
  return picks;
}

// --- Find your meal (the meal search, its presets and "Your meal" on the Eat cards) ---

const MEAL_SORTS = ["near", "price", "protein", "carbs", "kcal", "climate"];
// Each sort's direction until it's tapped again: cheapest first, the most protein, carbs and calories first, the lowest
// climate impact first.
const MEAL_SORT_DIRS = { price: "asc", protein: "desc", carbs: "desc", kcal: "desc", climate: "asc" };
/** A sort's direction: `dir` when it's "asc" or "desc" and the sort has one, else the sort's own. Nearest has none. */
const sortDir = (sort, dir) => (!MEAL_SORT_DIRS[sort] ? null : dir === "asc" || dir === "desc" ? dir : MEAL_SORT_DIRS[sort]);
const MEAL_FILTERS = ["vegan", "vegetarian", "meat", "fish", "glutenfree", "lactosefree"];
const MEAL_FILTER_LABELS = { vegan: "Vegan", vegetarian: "Vegetarian", meat: "Meat", fish: "Fish", glutenfree: "Gluten-free", lactosefree: "Lactose-free" };
const MEAL_SORT_TEXT = { near: "Nearest first", price: "Cheapest first", protein: "Protein per 100 g", carbs: "Carbs per 100 g", kcal: "Calories per 100 g", climate: "Lowest climate impact first" };
// The text of a sort turned around from its own direction.
const MEAL_SORT_TEXT_FLIPPED = { price: "Priciest first", protein: "Least protein per 100 g", carbs: "Fewest carbs per 100 g", kcal: "Fewest calories per 100 g", climate: "Highest climate impact first" };
// The presets: a sort without filters ("then nearest" is how every sort breaks its ties). "custom" is "Your selection".
const MEAL_PRESETS = {
  budget: { name: "Budget-maxx", sort: "price" },
  protein: { name: "Protein-maxx", sort: "protein" },
  lowcarb: { name: "Low carb", sort: "carbs", dir: "asc" },
  carbs: { name: "Carb load", sort: "carbs" },
};
const CUSTOM_PRESET = "custom";

/**
 * A preset by its key ("budget", "protein", "lowcarb", "carbs") as a food preference { preset, name, sort, filters,
 * dir? } (dir only for one sorted against its sort's own direction: Low carb), else null.
 */
function presetOf(name) {
  const p = Object.hasOwn(MEAL_PRESETS, name) ? MEAL_PRESETS[name] : null;
  return p ? { preset: name, name: p.name, sort: p.sort, filters: [], ...(p.dir ? { dir: p.dir } : {}) } : null;
}

/** The filters as stored: the known ones, once each, in the chips' order. */
const cleanMealFilters = (filters) => MEAL_FILTERS.filter((f) => Array.isArray(filters) && filters.includes(f));

/**
 * A stored food preference ({ preset, sort, filters, dir? }) made safe: a named preset is taken from its definition (so
 * a changed definition wins over the stored copy), "custom" keeps its own sort and filters, and `dir` only when it
 * turns the sort around; anything else is null.
 */
function cleanMealPref(p) {
  if (!p || typeof p !== "object") return null;
  const named = presetOf(p.preset);
  if (named) return { preset: named.preset, sort: named.sort, filters: [], ...(named.dir ? { dir: named.dir } : {}) };
  if (p.preset !== CUSTOM_PRESET || !MEAL_SORTS.includes(p.sort)) return null;
  const out = { preset: CUSTOM_PRESET, sort: p.sort, filters: cleanMealFilters(p.filters) };
  const dir = sortDir(p.sort, p.dir);
  if (dir && dir !== MEAL_SORT_DIRS[p.sort]) out.dir = dir;
  return out;
}

/**
 * Which preset a sort, filters and direction are: a named one when they match it exactly (in the sort's own direction),
 * else "custom" (Your selection).
 */
function presetMatching(sort, filters, dir = null) {
  if (cleanMealFilters(filters).length) return CUSTOM_PRESET;
  return Object.keys(MEAL_PRESETS).find((k) => MEAL_PRESETS[k].sort === sort && sortDir(sort, MEAL_PRESETS[k].dir) === sortDir(sort, dir)) ?? CUSTOM_PRESET;
}

const mealPrefName = (pref) => presetOf(pref?.preset)?.name ?? "Your selection";

/** A food preference in words: "Protein per 100 g, nearest first · Vegetarian", "Cheapest first, nearest first". */
function mealPrefText(pref) {
  const flipped = pref.sort !== "near" && sortDir(pref.sort, pref.dir) !== MEAL_SORT_DIRS[pref.sort];
  const sort = pref.sort === "near" ? MEAL_SORT_TEXT.near : `${(flipped ? MEAL_SORT_TEXT_FLIPPED : MEAL_SORT_TEXT)[pref.sort]}, nearest first`;
  return [sort, ...cleanMealFilters(pref.filters).map((f) => MEAL_FILTER_LABELS[f])].join(" · ");
}

const hasAllergen = (dish, words) => (dish.allergens ?? []).some((a) => words.some((w) => String(a).toLowerCase().includes(w)));
// The cereals with gluten count too: Cookpit lists "wheat" on some dishes without the word gluten.
const GLUTEN_WORDS = ["gluten", "wheat", "rye", "barley", "spelt", "oats"];
const LACTOSE_WORDS = ["milk", "lactose"];
const MEAL_TYPE_FILTERS = { vegan: ["vegan"], vegetarian: ["vegan", "vegetarian"], meat: ["meat"], fish: ["fish"] };

/** Does a dish pass the filters? The dish types are alternatives (any of those on); the two allergen filters each must hold. */
function dishPasses(dish, filters) {
  const on = cleanMealFilters(filters);
  const types = on.flatMap((f) => MEAL_TYPE_FILTERS[f] ?? []);
  if (types.length && !types.includes(dish.type)) return false;
  if (on.includes("glutenfree") && hasAllergen(dish, GLUTEN_WORDS)) return false;
  if (on.includes("lactosefree") && hasAllergen(dish, LACTOSE_WORDS)) return false;
  return true;
}

/**
 * The meal search's results. `dishes` are a meal's dishes, each with its `place` ({ id, name, building }), in the
 * server's order. They are filtered (dishPasses), then sorted: "near" by the distance of the place's building
 * (`distances`, a Map of building code to metres; without it the given order stays), "price" by the price for
 * `priceGroup`, cheapest first, "protein", "carbs" and "kcal" by that value per 100 g, highest first, "climate" by
 * food2050's climate rating (UZH's dishes only), lowest first; `dir` ("asc" or
 * "desc") turns a sort around (lib.js MEAL_SORT_DIRS has each one's own direction). Ties go to the nearer
 * place, then the cheaper dish, then the given order. Dishes without a value for the sort key (no price, no nutrition,
 * no climate rating) come back apart, in `rest`, nearest first: { ranked, rest }.
 */
function rankDishes(dishes, { sort = "near", filters = [], distances = null, priceGroup = "student", dir = null } = {}) {
  const dist = (d) => (distances?.has(d.place?.building) ? distances.get(d.place.building) : Infinity);
  const cost = (d) => d.price?.[priceGroup] ?? Infinity;
  const diff = (a, b) => (a === b ? 0 : a < b ? -1 : 1); // Infinity - Infinity is NaN
  const value = sort === "price" ? (d) => d.price?.[priceGroup] ?? null
    : sort === "protein" || sort === "carbs" || sort === "kcal" ? (d) => d.nutrition?.[sort] ?? null
    : sort === "climate" ? (d) => CLIMATE_ORDER[d.climate] ?? null
    : () => 0;
  const sign = sortDir(sort, dir) === "asc" ? 1 : -1;
  const rows = dishes.filter((d) => dishPasses(d, filters)).map((d, i) => ({ d, i, v: value(d) }));
  const tie = (a, b) => diff(dist(a.d), dist(b.d)) || diff(cost(a.d), cost(b.d)) || a.i - b.i;
  // Without a position "Nearest" is the server's order: no price tie-break, or it would be a price sort.
  const order = sort === "near" && !distances ? (a, b) => a.i - b.i : (a, b) => sign * diff(a.v, b.v) || tie(a, b);
  return {
    ranked: rows.filter((r) => r.v != null).sort(order).map((r) => r.d),
    rest: rows.filter((r) => r.v == null).sort(tie).map((r) => r.d),
  };
}

/**
 * "Your meal" on a mensa's card: the top dish of `dishes` (one meal of `place`) under the food preference `pref`
 * ({ sort, filters }), or null when no dish passes its filters or none has the value it sorts by (the card then keeps
 * the flagship dish). Within one mensa "nearest" says nothing, so that preference takes the cheapest dish.
 */
function yourMeal(place, dishes, pref, priceGroup = "student") {
  if (!pref || !dishes?.length) return null;
  const sort = pref.sort === "near" ? "price" : pref.sort;
  const { ranked, rest } = rankDishes(dishes.map((d) => ({ ...d, place })), { sort, filters: pref.filters, priceGroup, dir: pref.sort === "near" ? null : pref.dir });
  return ranked[0] ?? (pref.sort === "near" ? rest[0] ?? null : null);
}

/**
 * The meal a mensa's card is about at `at` (a Zurich ISO time), from its /api/spaces entry: the meal time it falls in,
 * else the next one that day, else the first meal of the next day with meals; null when none is known. The same pick
 * as the Worker's flagship dish (worker/menus.ts cardMeal).
 */
function cardMealOf(s, at) {
  const t = isoHHMM(at);
  const today = s.meals_today ?? [];
  const now = today.find((m) => m.from <= t && t < m.to) ?? today.find((m) => m.from > t);
  if (now) return { date: isoDate_(at), meal: now.meal };
  const first = s.meals_next?.meals?.[0];
  return first ? { date: s.meals_next.date, meal: first.meal } : null;
}

// food2050's climate ratings (UZH's dishes), lowest impact first; ETH's dishes have none.
const CLIMATE_ORDER = { low: 1, medium: 2, high: 3 };
const CLIMATE_LABELS = { low: "Low", medium: "Medium", high: "High" };
/** "Low climate impact", or "" for a dish without a rating. */
const climateText = (dish) => (Object.hasOwn(CLIMATE_LABELS, dish.climate ?? "") ? `${CLIMATE_LABELS[dish.climate]} climate impact` : "");

const gram = (v) => `${Math.round(v * 10) / 10} g`;

/**
 * A dish's description as one line: its parts ("Onions | Capers") joined by commas. Cookpit cuts long ones off
 * mid-word ("… | Grated cheese | Pete..."), in its data too: the cut part is left out ("…, Grated cheese, …"), and
 * text without parts ends at its last whole word.
 */
function dishDesc(desc) {
  const parts = String(desc ?? "").split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
  const last = parts.at(-1);
  if (!last || !/(\.{2,}|…)$/.test(last)) return parts.join(", ");
  if (parts.length > 1) return `${parts.slice(0, -1).join(", ")}, …`;
  const words = last.replace(/(\.{2,}|…)$/, "").split(/\s+/);
  return words.length > 1 ? `${words.slice(0, -1).join(" ").replace(/[\s,;:(+-]+$/, "")} …` : `${words[0]}…`;
}

/**
 * A dish's values per 100 g as the results, the menus and the dish's lightbox show them: the sort's own value alone ("12 g protein / 100 g", "30 g carbs
 * / 100 g"), else what there is of protein, carbs and energy ("6 g protein · 17 g carbs · 165 kcal / 100 g"); "" when
 * the dish has none. Sorted by climate impact, the dish's rating instead ("Low climate impact").
 */
function nutritionText(dish, sort) {
  if (sort === "climate") return climateText(dish);
  const n = dish.nutrition;
  if (!n) return "";
  if (sort === "protein" || sort === "carbs") return n[sort] == null ? "" : `${gram(n[sort])} ${sort} / 100 g`;
  if (sort === "kcal") return n.kcal == null ? "" : `${Math.round(n.kcal)} kcal / 100 g`;
  const parts = [n.protein != null ? `${gram(n.protein)} protein` : null, n.carbs != null ? `${gram(n.carbs)} carbs` : null, n.kcal != null ? `${Math.round(n.kcal)} kcal` : null].filter(Boolean);
  return parts.length ? `${parts.join(" · ")} / 100 g` : "";
}

// --- switching buildings in the floor view ---

/** ETH's level letters from the bottom: one letter per floor, without I (A, B, …, H, J, K, …). */
const LEVEL_LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ";

/**
 * The level of building `to` that matches `fromLevel` of building `from`: the same number of floors above or below
 * street level (static/map/floors/index.json's `levels`: { HG: { ground: "E", order: ["B", …, "K"] } }; a building's
 * street level needn't have plans, CAB's E hasn't), then the nearest of `to`'s levels, which clamps it to its lowest or
 * highest; the lower one on a tie. `shown`: the levels `to` has plans for (one without anything on frooms is left out
 * of its plans), when they're fewer than `order`. Without `to`'s entry: `fromLevel` if shown, else `to`'s first. The
 * links between buildings that name a level (CLA D is LEE F) are applied by the caller and win over this.
 */
function matchLevel(from, fromLevel, to, levels, shown = null) {
  const rank = (lv) => LEVEL_LETTERS.indexOf(lv);
  const a = levels?.[from];
  const b = levels?.[to];
  const order = (b?.order ?? []).filter((lv) => !shown || shown.includes(lv));
  if (!b || !order.length) return !shown || shown.includes(fromLevel) ? fromLevel : (shown[0] ?? null);
  const offset = a && rank(fromLevel) >= 0 && rank(a.ground) >= 0 ? rank(fromLevel) - rank(a.ground) : 0;
  const want = rank(b.ground) + offset;
  return [...order].sort((x, y) => Math.abs(rank(x) - want) - Math.abs(rank(y) - want) || rank(x) - rank(y))[0];
}

// --- the map's labels ---

/**
 * The map's place labels in the order they're placed (the first ones win where labels crowd): those in `order` (the
 * location's mensas in our order, /api/map's `order`) first, in that order, then the rest as they came. `ids` are
 * place ids; returns their indexes into `ids`.
 */
function placeLabelOrder(ids, order) {
  const pos = orderIndex(order);
  return ids.map((id, i) => ({ i, p: pos({ id }) })).sort((a, b) => (a.p === b.p ? a.i - b.i : a.p < b.p ? -1 : 1)).map(({ i }) => i);
}

/**
 * Where a small marker goes on the map (screen px): at (px, py), else just beside the first of the `placed` boxes it would cover
 * (right of it, left, below, above), wherever that's clear of all of them; at (px, py) when nothing is.
 */
function besideBoxes(px, py, w, h, placed) {
  const boxAt = (x, y) => [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
  const clear = ([x, y]) => {
    const a = boxAt(x, y);
    return !placed.some((b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]);
  };
  if (clear([px, py])) return [px, py];
  const a = boxAt(px, py);
  const hit = placed.find((b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]);
  return [[hit[2] + w / 2 + 1, py], [hit[0] - w / 2 - 1, py], [px, hit[3] + h / 2 + 1], [px, hit[1] - h / 2 - 1]].find(clear) ?? [px, py];
}

/** Zoomed out further than this (px per metre), every building's microwaves are one round label with the total. */
const MICRO_SPOT_SCALE = 0.75;
/** Each microwave gets its own marker only while the markers of its building are at least this far apart (px). */
const MICRO_SPOT_GAP_PX = 24;

/**
 * The buildings whose microwaves the map draws one by one at `scale` (px per metre): those whose entries all have a
 * position (`at`, map metres) and sit at least MICRO_SPOT_GAP_PX apart on screen. Each other building gets one label
 * with its total. `list`: { building, at } entries.
 */
function microwaveSpots(list, scale) {
  if (scale < MICRO_SPOT_SCALE) return new Set();
  const byBuilding = new Map();
  for (const m of list ?? []) byBuilding.set(m.building, [...(byBuilding.get(m.building) ?? []), m.at ?? null]);
  const out = new Set();
  for (const [code, spots] of byBuilding) {
    if (spots.some((at) => !at)) continue;
    const apart = spots.every((a, i) => spots.slice(i + 1).every((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) * scale >= MICRO_SPOT_GAP_PX));
    if (apart) out.add(code);
  }
  return out;
}

// --- accounts (plans/PLAN_ACCOUNTS.md, section 8): bubbles, their colours, usernames, stars with the account ---

/** WCAG relative luminance of a "#rrggbb" colour (worker/social.ts has the same rule). */
function hexLuminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two "#rrggbb" colours, 1 to 21. */
function colourContrast(a, b) {
  const [hi, lo] = [hexLuminance(a), hexLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A bubble's colours need this contrast, as the Worker checks it (POST /api/me/profile answers low_contrast). */
const MIN_BUBBLE_CONTRAST = 3;
const BUBBLE_COLOUR_RE = /^#[0-9a-f]{6}$/;

/** The lowest contrast between any background stop and any text stop of a bubble (gradients have two of each). */
function bubbleContrast(bgs, fgs) {
  let low = Infinity;
  for (const b of bgs) for (const f of fgs) low = Math.min(low, colourContrast(b, f));
  return low;
}

/**
 * "#rrggbb" colours (lower case) that read well enough as a bubble: every background stop against every text stop.
 * `bg2` and `fg2` are the gradients' second colours (Street cred levels 2 and 3), null or left out when flat.
 */
function readableBubble(bg, fg, bg2 = null, fg2 = null) {
  const hex = (c) => BUBBLE_COLOUR_RE.test(c ?? "");
  if (!hex(bg) || !hex(fg) || (bg2 != null && !hex(bg2)) || (fg2 != null && !hex(fg2))) return false;
  return bubbleContrast([bg, bg2].filter(Boolean), [fg, fg2].filter(Boolean)) >= MIN_BUBBLE_CONTRAST;
}

/** The level each bubble style needs (worker/cred.ts UNLOCKS, compared in test/cred.test.ts). */
const BUBBLE_STYLE_LEVELS = { bg2: 2, fg2: 3, bronze: 4, silver: 5, gold: 6 };

/**
 * The metal bubbles (levels 4 to 6): a background of a dark, a lighter band and a dark stop, and letters in a gradient
 * of their own. Every background stop against every text stop keeps MIN_BUBBLE_CONTRAST (tested). Bronze and gold are
 * dark coins with bright letters, silver a bright one with dark letters.
 */
const BUBBLE_METALS = {
  bronze: { label: "Bronze", bg: ["#5a3210", "#8c5629", "#663914"], fg: ["#ffe4c4", "#f4bd84"] },
  silver: { label: "Silver", bg: ["#aeb4ba", "#eef1f4", "#b8bec4"], fg: ["#1c1f23", "#454c55"] },
  gold: { label: "Gold", bg: ["#644800", "#8a6700", "#6e4f00"], fg: ["#fff7d6", "#f7d465"] },
};

const bubbleGradient = (stops) => `linear-gradient(135deg, ${stops.join(", ")})`;

/**
 * How a bubble is painted, or null for the default look: `background` (a colour or a gradient), `color` (the letters'
 * colour, also the fallback under gradient letters), `text` (the letters' gradient or null) and `metal` (its name or
 * null). A metal wins over the gradients (the Worker never stores both).
 */
function bubbleLook(p) {
  const metal = p?.metal ? BUBBLE_METALS[p.metal] : null;
  if (metal) return { background: bubbleGradient(metal.bg), color: metal.fg[0], text: bubbleGradient(metal.fg), metal: p.metal };
  if (!p?.bg || !p?.fg) return null;
  return {
    background: p.bg2 ? bubbleGradient([p.bg, p.bg2]) : p.bg,
    color: p.fg,
    text: p.fg2 ? bubbleGradient([p.fg, p.fg2]) : null,
    metal: null,
  };
}

/** The level a bubble's style needs: 1 for two plain colours, else the highest of its gradients and metal. */
function bubbleStyleLevel(p) {
  return Math.max(1, p?.bg2 ? BUBBLE_STYLE_LEVELS.bg2 : 1, p?.fg2 ? BUBBLE_STYLE_LEVELS.fg2 : 1, BUBBLE_STYLE_LEVELS[p?.metal] ?? 1);
}

/** frooms' navy (the wordmark's, --accent in light mode). */
const BUBBLE_NAVY = "#010057";

/**
 * The background swatches offered for a bubble: the page's own colour (black in dark mode, white in light mode) and
 * frooms' navy. The colour wheel (account.js colourWheel) offers the rest.
 */
const bubbleBackgrounds = (dark) => [dark ? "#000000" : "#ffffff", BUBBLE_NAVY];
const BUBBLE_TEXTS = ["#ffffff", "#1c1f23", "#010057", "#fff4d6", "#f6c945"];

/** The backgrounds a new bubble starts from at random (varied, so friends' bubbles tell apart before anyone picks). */
const BUBBLE_RANDOM_BACKGROUNDS = ["#010057", "#215caf", "#0e7490", "#2e7d32", "#7c8f2a", "#a15f00", "#da291c", "#9a3b3b", "#a14a8c", "#5b3fa8", "#1c1f23", "#f6c945", "#9fd3c7", "#f4b6c2", "#e3e5e8"];

/** HSV (hue 0 to 360, saturation and value 0 to 1) as "#rrggbb", lower case: the colour wheel's colours. */
function hsvToHex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return "#" + [f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
}

/** "#rrggbb" as HSV { h: 0 to 360, s and v: 0 to 1 }, hue 0 for greys. */
function hexToHsv(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

/**
 * A random readable pair for a new bubble: a background from BUBBLE_RANDOM_BACKGROUNDS and the text colour with the
 * best contrast on it. `rand` returns 0 to 1 (Math.random).
 */
function randomBubble(rand = Math.random) {
  const all = BUBBLE_RANDOM_BACKGROUNDS;
  const bg = all[Math.min(all.length - 1, Math.floor(rand() * all.length))];
  const fg = [...BUBBLE_TEXTS].sort((a, b) => colourContrast(bg, b) - colourContrast(bg, a))[0];
  return { bg, fg };
}

/** Usernames as the Worker takes them: 3 to 20 of a-z, 0-9, "_" and ".", stored lower case. */
const USERNAME_PATTERN = /^[a-z0-9_.]{3,20}$/;

/** What's wrong with a typed username (as typed, before lower-casing), or null when it may be sent. */
function usernameProblem(typed) {
  const u = String(typed ?? "").trim().toLowerCase();
  if (!u) return "Pick a username.";
  if (/[^a-z0-9_.]/.test(u)) return "Only letters a–z, digits, “_” and “.”.";
  if (u.length < 3) return "At least 3 characters.";
  if (u.length > 20) return "At most 20 characters.";
  return null;
}

/**
 * Stars after signing in (plan 7.4): the account's first, then the browser's that aren't in it, cut to 40. Both lists
 * are cleaned like cleanStars.
 */
const mergeStars = (account, browser) => cleanStars([...cleanStars(account), ...cleanStars(browser)]);

/** Whether two star lists are the same (same places in the same order, same fields). */
const sameStars = (a, b) => JSON.stringify(cleanStars(a)) === JSON.stringify(cleanStars(b));

// --- friends (plan 8.5) ---

/** Lower case without accents, for matching names as people type them ("Zoë" → "zoe"). */
const foldText = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Friends in alphabetical order of their usernames. */
const sortFriends = (list) => [...(list ?? [])].sort((a, b) => String(a.username).localeCompare(String(b.username)));

/**
 * Whether a person ({ username, name: "Raffaele W." }) matches what's typed in Friends' search: the username from its
 * start ("@" ignored), or the name from the start of a word or as a whole ("raffaele w").
 */
function friendMatches(p, query) {
  const q = foldText(query).trim().replace(/^@/, "");
  if (!q) return true;
  if (foldText(p.username).startsWith(q)) return true;
  const name = foldText(p.name);
  return name.startsWith(q) || name.split(/[\s.\-']+/).some((w) => w && w.startsWith(q));
}

/** An add-a-friend link's username (?add=raffi), when it is one; else null. */
function addParam(search) {
  const u = new URLSearchParams(search).get("add")?.trim().toLowerCase() ?? "";
  return USERNAME_PATTERN.test(u) ? u : null;
}

// --- check-ins (plan 8.6, 8.7) ---

const CHECKIN_HOURS = [1, 2, 3];
const CHECKIN_DEFAULT_HOURS = 3; // decision 5: without a choice it ends after 3 hours
const CHECKIN_MAX_MS = 12 * 60 * 60 * 1000; // the Worker refuses later ends (bad_until)

/** "14:05" in this device's time. */
const clockOf = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/**
 * The end time for a typed "HH:MM": today at that time, or tomorrow when it has passed; null when it isn't a time or
 * lies more than 12 hours ahead (the Worker's limit).
 */
function untilAt(hhmm, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  let t = d.getTime();
  if (t <= now) {
    d.setDate(d.getDate() + 1);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    t = d.getTime();
  }
  return t - now > CHECKIN_MAX_MS ? null : t;
}

/**
 * The time wheel's "HH:MM" kept to a possible end of a check-in: its next occurrence within the next 12 hours, at
 * least a minute from now. A time outside goes to the nearer end: the first `stepMin` step a minute from now, or the
 * last step within 12 hours.
 */
function untilClamp(hhmm, now, stepMin = 5) {
  const step = stepMin * 60_000;
  const first = Math.ceil((now + 60_000) / step) * step;
  const last = Math.floor((now + CHECKIN_MAX_MS) / step) * step;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return clockOf(first);
  const at = (days) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d.getTime();
  };
  const t = at(0) > now ? at(0) : at(1); // the next time the clock shows it
  if (t >= first && t <= last) return clockOf(t);
  if (t < first) return clockOf(first);
  // More than 12 hours ahead: back to now if it lies just behind it, else to the last end.
  return now - at(t === at(0) ? -1 : 0) < t - last ? clockOf(first) : clockOf(last);
}

/**
 * The spans (of twelve columns) of a row of `n` place actions (places.js actionGrid): equal shares, except that with a
 * Check out (`checkinAt`: the index of Checked in, the Check out right after it) Check out takes 2 and Checked in the
 * rest of the leftover.
 */
function actionSpans(n, checkinAt = -1) {
  if (checkinAt < 0 || n < 2) return Array.from({ length: n }, () => 12 / n);
  const others = n - 1;
  const each = Math.floor(10 / others);
  const spans = Array.from({ length: n }, () => each);
  spans[n - 1] = 2;
  spans[checkinAt] += 10 - each * others;
  return spans;
}

/** Which of the 1 h, 2 h, 3 h choices an end time is (within 2 minutes of `from` plus that), or null. */
function untilHours(until, from) {
  return CHECKIN_HOURS.find((h) => Math.abs(until - (from + h * 3600_000)) < 2 * 60_000) ?? null;
}

/** "since 14:05 · until 16:00" (an end after midnight: "until 01:30 tomorrow"). */
function checkinWhen({ since, until }, now = since) {
  const nextDay = new Date(until).toDateString() !== new Date(now).toDateString();
  return `since ${clockOf(since)} · until ${clockOf(until)}${nextDay ? " tomorrow" : ""}`;
}

/** A check-in that is still running (`until` in the future). */
const runningCheckin = (c, now) => !!c && c.until > now;

/** A room's building from its code in the search index: "HG E 33.1" → HG, UZH's "KOL-F-101" → KOL. */
const roomBuilding = (path) => String(path).split(/[ -]/)[0];

// --- friends' check-ins: the You tab's order and the map's bubbles (plan 8.7, 8.8) ---

/**
 * Friends' running check-ins in the You tab's order: by the distance from you to their building when it's known for
 * any (`distance(c)` gives metres or null; unknown ones after, latest first); else this campus (`area`) first, then
 * the latest check-in first.
 */
function sortFriendCheckins(list, { distance = null, area = null } = {}) {
  const d = new Map((list ?? []).map((c) => [c, distance ? distance(c) : null]));
  const anyKnown = [...d.values()].some((v) => v != null);
  return [...(list ?? [])].sort((a, b) => {
    if (anyKnown) {
      const da = d.get(a);
      const db = d.get(b);
      if (da != null && db != null && da !== db) return da - db;
      if ((da == null) !== (db == null)) return da == null ? 1 : -1;
    } else if ((a.area === area) !== (b.area === area)) return a.area === area ? -1 : 1;
    return b.since - a.since;
  });
}

/**
 * The map's friend bubbles: one per building (`items`: { key, x, y, n } in screen px, n people there), and bubbles
 * whose centres are closer than `gap` px merge into one with the total, placed between them (weighted by their
 * people), again and again until none overlap; zooming in separates them. Returns { keys, x, y, n }, keys in the
 * items' order.
 */
function stackBubbles(items, gap) {
  let groups = (items ?? []).map((it, i) => ({ keys: [it.key], order: [i], x: it.x, y: it.y, n: it.n }));
  for (;;) {
    let best = null;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const dist = Math.hypot(groups[i].x - groups[j].x, groups[i].y - groups[j].y);
        if (dist < gap && (!best || dist < best.dist)) best = { i, j, dist };
      }
    }
    if (!best) break;
    const a = groups[best.i];
    const b = groups[best.j];
    const n = a.n + b.n;
    const order = [...a.order, ...b.order].sort((x, y) => x - y);
    const merged = { order, keys: order.map((k) => items[k].key), x: (a.x * a.n + b.x * b.n) / n, y: (a.y * a.n + b.y * b.n) / n, n };
    groups = groups.filter((_, k) => k !== best.i && k !== best.j).concat(merged);
  }
  return groups.sort((a, b) => a.order[0] - b.order[0]).map(({ keys, x, y, n }) => ({ keys, x, y, n }));
}

/**
 * Street cred levels on all-time points (worker/cred.ts keeps the same rule; test/cred.test.ts compares them): level 1
 * from 0, then each step costs 50 more than the one before (level 2 at 100, 3 at 250, 4 at 450, 5 at 700, 6 at 1000 …),
 * up to CRED_MAX_LEVEL (20, at 10,450).
 */
const CRED_MAX_LEVEL = 20;

function levelStart(level) {
  const n = Math.max(0, Math.floor(level) - 1);
  return 100 * n + 25 * n * (n - 1);
}

function levelOf(points) {
  let level = 1;
  while (level < CRED_MAX_LEVEL && levelStart(level + 1) <= points) level++;
  return level;
}

/** Points per action and awards per Zurich day (worker/cred.ts POINTS and CAPS; test/cred.test.ts compares them). */
const CRED_POINTS = { friend: 25, checkin: 5, report: 3, report_liked: 1, report_vote: 1, invite: 3, problem: 5, feedback: 10, meal_rating: 3, bug: 50 };
const CRED_CAPS = { checkin: 4, report: 10, report_vote: 20, invite: 5, problem: 3, feedback: 1, meal_rating: 5 };

/** What each level unlocks for the bubble (worker/cred.ts UNLOCKS); higher levels unlock nothing new yet. */
const CRED_UNLOCKS = { 2: "Gradient background", 3: "Gradient text", 4: "Bronze bubble", 5: "Silver bubble", 6: "Gold bubble" };

/** 👍 received on your reports from this many on: a trusted reporter (worker/cred.ts TRUSTED_LIKES). */
const TRUSTED_LIKES = 20;

/**
 * Where an all-time total stands: its level, where that level started and the next begins, how many points are still
 * missing and how far along the bar is (0 to 1). At the top level the bar is full: `top` true, `to` null, nothing to go.
 */
function levelProgress(total) {
  const points = Math.max(0, Math.floor(Number(total) || 0));
  const level = levelOf(points);
  const from = levelStart(level);
  if (level >= CRED_MAX_LEVEL) return { level, from, to: null, toGo: 0, fraction: 1, top: true };
  const to = levelStart(level + 1);
  return { level, from, to, toGo: to - points, fraction: (points - from) / (to - from), top: false };
}

/** The next unlock above `level` as "Level 5: silver bubble", or null when there is none. */
function nextUnlockText(level) {
  const next = Object.keys(CRED_UNLOCKS).map(Number).sort((a, b) => a - b).find((l) => l > level);
  if (next === undefined) return null;
  const label = CRED_UNLOCKS[next];
  return `Level ${next}: ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/**
 * When a log entry was earned, in the browser's time: "Today 14:05", "Yesterday 18:30", "Mon 16 Nov" this year, else
 * "16 Nov 2025".
 */
function credWhen(at, now = Date.now()) {
  const d = new Date(at);
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const today = new Date(now);
  const days = Math.round((day(today) - day(d)) / 86_400_000);
  const clock = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  const month = d.toLocaleDateString("en-GB", { month: "short" });
  if (d.getFullYear() === today.getFullYear()) return `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${d.getDate()} ${month}`;
  return `${d.getDate()} ${month} ${d.getFullYear()}`;
}

/**
 * The toast for an answer's `cred` ({ points, total, level }), given the level before: "+5 street cred", and on a
 * level-up "+25 street cred · Level 3! Gradient text unlocked" (or "Level 7!" alone). Null when nothing was earned.
 */
function credToastText(cred, levelBefore = null) {
  if (!cred || !(cred.points > 0)) return null;
  const earned = `+${cred.points} street cred`;
  if (levelBefore === null || !(cred.level > levelBefore)) return earned;
  const unlock = CRED_UNLOCKS[cred.level];
  return `${earned} · Level ${cred.level}!${unlock ? ` ${unlock} unlocked` : ""}`;
}

// --- Meal ratings (plans/PLAN_STREET_CRED.md, section 10; worker/ratings.ts keeps the same rules, compared in tests) ---

const RATING_MIN = -5;
const RATING_MAX = 5;
const RATING_STEP = 0.5;
const RATING_CATEGORIES = ["taste", "portion", "value"];

/** A day's dish: facility|date|meal|line|name, the name trimmed and lower-cased (worker/ratings.ts dishKey). */
function dishKey(facility, date, meal, line, name) {
  return [String(facility), date, meal, line, String(name).trim().toLowerCase()].join("|");
}

/** Rounded to one decimal, never -0. */
const roundRating = (x) => Math.round(x * 10) / 10 + 0;

/** Ø: the mean of the category means present, rounded to 0.1; null when none is (worker/ratings.ts ratingAverage). */
function ratingAverage(means) {
  const set = (means ?? []).filter((m) => typeof m === "number" && Number.isFinite(m));
  return set.length ? roundRating(set.reduce((a, b) => a + b, 0) / set.length) : null;
}

/** A value snapped to 0.5 and kept within -5 and 5; null for anything that isn't a number. */
function snapRating(v) {
  const n = typeof v === "string" ? Number(v.replace("−", "-").replace(",", ".")) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || (typeof v === "string" && !v.trim())) return null;
  return Math.min(RATING_MAX, Math.max(RATING_MIN, Math.round(n / RATING_STEP) * RATING_STEP)) + 0;
}

/**
 * The value at a point of a bar's track: `y` px from the track's top, `height` its height, 0 in the middle, 5 at the
 * top, -5 at the bottom, snapped to 0.5.
 */
const ratingAtY = (y, height) => snapRating(RATING_MAX - (y / height) * (RATING_MAX - RATING_MIN));

/** "+2.5", "−1.0" (a real minus), "0.0"; "–" (a dash) when there's none. */
function ratingFigure(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "–";
  const r = roundRating(v);
  return r > 0 ? `+${r.toFixed(1)}` : r < 0 ? `−${(-r).toFixed(1)}` : "0.0";
}

/** Whether a dish of `date` takes ratings (today and yesterday, Zurich, as the Worker checks), shows them (past), or neither. */
function ratingDay(date, today, yesterday) {
  if (date === today || date === yesterday) return "rate";
  return date < today ? "past" : "future";
}

/** "#rrggbb" to OKLab [L, a, b]. */
function hexToOklab(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab [L, a, b] to "#rrggbb" (clipped to sRGB). */
function oklabToHex([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return "#" + lin.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  }).join("");
}

/** The ratings' colours (style.css --rate-neg, --rate-zero, --rate-pos; the page reads the current theme's). */
const RATING_COLOURS = { light: { neg: "#8b1a1a", zero: "#010057", pos: "#1b5e20" }, dark: { neg: "#ff8a80", zero: "#ffffff", pos: "#81c784" } };

/**
 * A rating's colour: -5 the red, 0 the neutral, +5 the green of `stops` ({ neg, zero, pos }), mixed in OKLab in
 * between (so the middle stays as light and as readable as the ends).
 */
function ratingColour(value, stops = RATING_COLOURS.light) {
  const v = Math.min(RATING_MAX, Math.max(RATING_MIN, Number(value) || 0));
  const t = Math.abs(v) / RATING_MAX;
  const from = hexToOklab(stops.zero);
  const to = hexToOklab(v < 0 ? stops.neg : stops.pos);
  return oklabToHex(from.map((x, i) => x + (to[i] - x) * t));
}

// --- Usage counters (plans/PLAN_ADMIN_STATS.md, 5.5): daily totals without any identifier ---

/** What the page counts (worker/stats.ts METRICS' page keys; a test checks they're the same). */
const STATS_KEYS = ["load", "load_signed_in", "tab_study", "tab_meet", "tab_eat", "tab_you", "search", "search_pick", "meal_search", "people_search", "place_open", "menu_open", "invite", "install",
  // The tutorial (plans/PLAN_TUTORIAL.md, section 7): opened, and each journey started and finished (tourStatKey).
  "tutorial_open", "tutorial_start_friends", "tutorial_start_study", "tutorial_start_meet", "tutorial_start_food", "tutorial_start_map",
  "tutorial_done_friends", "tutorial_done_study", "tutorial_done_meet", "tutorial_done_food", "tutorial_done_map",
  "tutorial_start_cred", "tutorial_done_cred"];
/** The most one beacon carries per key (the Worker refuses more): counts beyond it, between two beacons, are dropped. */
const STATS_MAX = 50;

/** Stored counts as the beacon sends them, `{ c: { key: n } }`: known keys only, whole numbers 1 to STATS_MAX. */
function cleanStats(raw) {
  const c = {};
  const from = raw && typeof raw === "object" && raw.c && typeof raw.c === "object" ? raw.c : {};
  for (const key of STATS_KEYS) {
    const n = from[key];
    if (Number.isInteger(n) && n >= 1) c[key] = Math.min(n, STATS_MAX);
  }
  return { c };
}

/** `stored` with one more `key` (a new object; an unknown key changes nothing; at most STATS_MAX each). */
function addStat(stored, key) {
  const out = cleanStats(stored);
  if (STATS_KEYS.includes(key)) out.c[key] = Math.min((out.c[key] ?? 0) + 1, STATS_MAX);
  return out;
}

/** The beacon's body, or null when there is nothing to send. */
function statsBody(stored) {
  const clean = cleanStats(stored);
  return Object.keys(clean.c).length ? JSON.stringify(clean) : null;
}

// --- The tutorial (plans/PLAN_TUTORIAL.md): what static/tutorial.js needs that can be tested without a page ---

/** Where the tutorial's progress is kept (localStorage, cleanTour's shape); app.js writes `seenOffer` there too. */
const TOUR_STORE = "frooms.tour";
/** The journeys, in the welcome screen's order ("map": Navigate the campus, added after the plan's four). */
const TOUR_JOURNEY_IDS = ["friends", "study", "meet", "food", "map", "cred"];
/** The shared chapters (section 9): A map and sheet, B search, C time and filters, D place details, E reports, F stars and You, G account. */
const TOUR_CHAPTER_IDS = ["A", "B", "C", "D", "E", "F", "G"];
/**
 * What happens to a chapter seen before: "auto" leaves it out without asking (A runs only once), "offer" asks
 * (Skip or Show again); the others always run.
 */
const TOUR_SKIP = { A: "auto", B: "offer", D: "offer", E: "offer", F: "offer" };
/** The most steps a journey has; a `step` beyond it in the address is ignored. */
const TOUR_MAX_STEP = 200;

/**
 * The journey whose places a chapter run on its own uses (`?tutorial=chapter:D`): D opens a study space, C a room
 * (Meet's tomorrow at 14:00), G is the friends journey's.
 */
const TOUR_CHAPTER_CONTEXT = { A: "study", B: "study", C: "meet", D: "study", E: "study", F: "study", G: "friends" };

/**
 * The tutorial asked for in the address (`location.search`), or null: `?tutorial` is the welcome screen
 * ({ journey: null, step: null }), `?tutorial=food` that journey, `&step=3` resumes it there (with a journey only).
 * An unknown journey opens the welcome screen. The debug value `chapter:<ids>[:<journey>]` (`chapter:D`,
 * `chapter:B,D:food`) runs those chapters alone, with that journey's places (TOUR_CHAPTER_CONTEXT's by default):
 * { journey, step: null, chapters: ["B", "D"] }; without a known chapter it's the welcome screen.
 */
function parseTourParam(search) {
  const q = new URLSearchParams(search ?? "");
  if (!q.has("tutorial")) return null;
  const v = (q.get("tutorial") ?? "").trim().toLowerCase();
  if (v.startsWith("chapter:")) {
    const [ids = "", ctx = ""] = v.slice(8).split(":");
    const chapters = [...new Set(ids.toUpperCase().split(",").map((c) => c.trim()))].filter((c) => TOUR_CHAPTER_IDS.includes(c));
    if (!chapters.length) return { journey: null, step: null };
    return { journey: TOUR_JOURNEY_IDS.includes(ctx) ? ctx : TOUR_CHAPTER_CONTEXT[chapters[0]], step: null, chapters };
  }
  const journey = TOUR_JOURNEY_IDS.includes(v) ? v : null;
  const raw = q.get("step");
  const n = raw != null && /^\d{1,3}$/.test(raw) ? Number(raw) : null;
  return { journey, step: journey && n != null && n < TOUR_MAX_STEP ? n : null };
}

/**
 * The stored progress (localStorage `frooms.tour`) as the tutorial uses it: { done: { chapters, journeys }, seenOffer },
 * known ids only, each once, in the lists' own order.
 */
function cleanTour(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const done = o.done && typeof o.done === "object" ? o.done : {};
  const pick = (list, known) => known.filter((id) => Array.isArray(list) && list.includes(id));
  return { done: { chapters: pick(done.chapters, TOUR_CHAPTER_IDS), journeys: pick(done.journeys, TOUR_JOURNEY_IDS) }, seenOffer: o.seenOffer === true };
}

/** `tour` (cleanTour's shape) with a chapter or journey marked done (a new object). */
function tourMarkDone(tour, { chapter = null, journey = null }) {
  const t = cleanTour(tour);
  if (chapter && !t.done.chapters.includes(chapter)) t.done.chapters.push(chapter);
  if (journey && !t.done.journeys.includes(journey)) t.done.journeys.push(journey);
  return cleanTour(t);
}

/**
 * A journey's steps in order. `parts` lists chapter ids ("A") and the journey's own steps (any other value);
 * `chapters` gives each chapter's steps; `done` the chapters seen before (cleanTour's `done.chapters`). Every step comes
 * back as { step, chapter (null for the journey's own), first (the chapter's first step), skip }: `skip` is
 * TOUR_SKIP's "auto" or "offer" for a chapter seen before, else null. Seen chapters stay in the list, so a step's index
 * (the address's `step`) means the same before and after a chapter is marked done.
 */
function tourPlan(parts, chapters, done = []) {
  const seen = new Set(done);
  const out = [];
  for (const part of parts) {
    if (typeof part === "string" && TOUR_CHAPTER_IDS.includes(part)) {
      const skip = seen.has(part) ? TOUR_SKIP[part] ?? null : null;
      (chapters[part] ?? []).forEach((step, i) => out.push({ step, chapter: part, first: i === 0, skip }));
    } else out.push({ step: part, chapter: null, first: false, skip: null });
  }
  return out;
}

/**
 * The run of steps of one chapter around step `i` of tourPlan's list: [start, end) (the next step after it at `end`),
 * or null for a journey's own step. The same chapter twice in a row in `parts` is one run.
 */
function tourChapterSpan(plan, i) {
  const chapter = plan[i]?.chapter;
  if (!chapter) return null;
  let start = i;
  while (start > 0 && plan[start - 1].chapter === chapter && !plan[start].first) start--;
  let end = i + 1;
  while (end < plan.length && plan[end].chapter === chapter && !plan[end].first) end++;
  return [start, end];
}

/**
 * Which of the Eat cards a tutorial step points at as "a mensa card": the first one serving now (status class
 * "food"), else the first one with a meal still to come today or open ("plain"); -1 when every one is closed.
 * `statuses` are the cards' status classes (lib.js eatStatus's `cls`) in the list's order.
 */
function tourFirstMensa(statuses) {
  const serving = statuses.indexOf("food");
  return serving >= 0 ? serving : statuses.indexOf("plain");
}

/**
 * Whether the first-visit window ("Take the tour" or "Skip") shows: on a plain first load only, so `prefs` (the page's
 * stored choices, its localStorage text) is null, the stored tour (`tour`, parsed) hasn't `seenOffer`, and the address
 * is `/` without a query (not an invite, a place's address, ?add=, ?tutorial, ?edit or ?pins).
 */
function tourOfferShown({ prefs = null, tour = null, path = "/", search = "" } = {}) {
  if (prefs != null || cleanTour(tour).seenOffer) return false;
  return path === "/" && !new URLSearchParams(search ?? "").size;
}

/** The counter for the tutorial:"tutorial_open", or "tutorial_start_food" / "tutorial_done_food"; null for anything else. */
function tourStatKey(kind, journey = null) {
  if (kind === "open") return "tutorial_open";
  return ["start", "done"].includes(kind) && TOUR_JOURNEY_IDS.includes(journey) ? `tutorial_${kind}_${journey}` : null;
}
