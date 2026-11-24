"use strict";

const REFRESH_MS = 5 * 60 * 1000;
const FREE_SOON_MIN = 30;
const STORE_KEY = "eth-free-rooms-v2";
// Must match MAX_ROOMS_PER_REQUEST in worker/config.ts.
const MAX_ROOMS_PER_REQUEST = 45;
// The time wheel refreshes the list this long after its last change, so a spin doesn't fire ten requests.
const WHEEL_REFRESH_MS = 300;
// A press outside the open picker that gives no click (a scroll) closes it this long after it ends; a click closes it
// at once (app.js watchOutsidePress). Longer than the gap between a press's end and its click.
const OUTSIDE_PRESS_MS = 350;
const OFFLINE_MSG = "You're offline. Room data needs a connection; it will load again once you're back online.";

const $ = (sel) => document.querySelector(sel);

// Meet: how long a room must stay free (minutes); the map counts the same.
const DURATIONS = [30, 60, 120, 180];
const DEFAULT_DURATION = 60;
// Meet: rooms shown per building before "All 12 in HG".
const ROOMS_PER_BUILDING = 3;
// Study: rooms free to study in, below the study spaces: computer rooms, seminar rooms, lecture halls (in that order),
// those free for at least STUDY_MIN_FREE minutes, STUDY_ROOMS_SHOWN per group before "All 23 computer rooms".
const STUDY_ROOM_TYPES = ["3650", "3420", "3430"];
const STUDY_MIN_FREE = 60;
const STUDY_ROOMS_SHOWN = 5;
const STUDY_ROOM_NAMES = { 3650: "Computer rooms", 3420: "Seminar rooms", 3430: "Lecture halls" };
// Meet's "Screen or projector" chip: the Worker filters on `equip=screen` and sends each room's `equipment`
// (worker/equipment.ts). False hides the chip again.
const EQUIPMENT_FILTER = true;
// The four tabs: Study (study spaces and libraries), Meet (bookable rooms), Eat (mensas), You (starred places).
const MODES = ["study", "rooms", "mensa", "you"];
const LIST_MODES = ["study", "rooms", "mensa"];
const KINDS = ["mensa", "cafe"];
const PRICE_GROUPS = ["student", "internal", "external"];
const DIETS = ["all", "vegetarian", "vegan"];
// The map's filters (map.js LAYERS): at most one is on; none shows the buildings' codes alone.
const MAP_LAYERS = ["study", "rooms", "mensa", "cafe"];
const state = {
  mode: "study",
  area: null,
  areas: null,
  buildings: new Set(), // Meet's buildings: nothing picked means all
  duration: DEFAULT_DURATION, // Meet: free for at least this many minutes
  expanded: new Set(), // Meet: buildings whose rooms are all shown
  roomBuildingList: [], // the rooms tab's buildings, from /api/buildings
  areaBuildings: [],
  buildingRooms: new Map(), // building -> number of rooms of the selected types
  typeList: [],
  types: null, // room types picked in More filters: null until known (then the defaults), empty = every type
  equip: false, // Meet: only rooms with a screen or projector (More filters)
  minSeats: "",
  now: true,
  // The chosen date ("2026-11-13") and time ("10:15") while Now is off (set to the current ones when it's turned on),
  // and the pickable range from /api/dates ({ min, max }).
  date: null,
  time: null,
  dates: null,
  defaults: [],
  sharedAt: null, // date and time from an invite link
  pendingPlace: null, // a place to open once the page is ready: { place, banner?, meal?, invite? } (its address or an invite)
  // Study spaces: an optional building filter (empty = all), and the last /api/spaces answer. Eat has no building filter
  // any more; its old choice stays in the preferences, unused.
  spaceBuildings: { study: new Set(), mensa: new Set() },
  spaces: null,
  // Eat: the mensas with a photo of their own in static/mensa-photos/ (its index.json), shown on their cards.
  mensaPhotos: new Set(),
  // Study: the rooms of STUDY_ROOM_TYPES from the map's /api/map answer ({ area, when, at, rooms }, rooms null beyond
  // the stored range), and the groups whose rooms are all shown.
  studyRooms: null,
  studyExpanded: new Set(),
  // Mensas tab: which kinds of places to list (More filters).
  kinds: new Set(KINDS),
  // Menus: the price shown (student, internal or external), the comparison's diet filter (all, vegetarian, vegan)
  // and its places per area (the ones picked; saved as `comparePicks`, so the preview's old "everything" under
  // `compare` is dropped).
  priceGroup: "student",
  diet: "all",
  compare: {},
  // The starred food preference ({ preset, sort, filters }, lib.js cleanMealPref) or null, and "Your meal" on the Eat
  // cards for it ({ area, pref, group, sig, map: place id -> { dish, photo } }).
  mealPref: null,
  yourMeals: null,
  // Starred places (lib.js stars), newest first; saved only in this browser. starsSaved is false when storage isn't
  // available: then they last for this visit.
  stars: [],
  starsSaved: true,
  // What the map shows (its filter buttons): one of MAP_LAYERS, or null.
  mapLayer: null,
  // Whether the map's filter buttons show their names (expanded) or only their icons; open until collapsed.
  mapLayersOpen: true,
  // Occupancy reports: this browser's random id (made on the first report; the Worker stores only its SHA-256) and the
  // reports it sent in the past 2 hours (lib.js cleanMyReports), so a view shows what you reported.
  client: null,
  myReports: [],
  // The first-visit window "Take the tour" or "Skip" (lib.js tourOfferShown): decided when the stored choices are read.
  tourOffer: false,
};
// The preview backgrounds (from og/backgrounds.json): their number and which of them are UZH's; the same for meal invites.
let shareBackgrounds = { count: 1, uzh: [] };
let mealBackgrounds = { count: 1, uzh: [] };
let refreshTimer = null;
let requestId = 0;

// --- persistence (per-browser convenience only) ---

function loadPrefs() {
  try {
    const stored = localStorage.getItem(STORE_KEY);
    let tour = null;
    try {
      tour = JSON.parse(localStorage.getItem(TOUR_STORE) ?? "null");
    } catch { /* unreadable: as none */ }
    state.tourOffer = tourOfferShown({ prefs: stored, tour, path: location.pathname, search: location.search });
    const p = JSON.parse(stored || "{}");
    if (MODES.includes(p.mode)) state.mode = p.mode;
    if (p.area) state.area = p.area;
    for (const m of ["study", "mensa"]) if (p.spaceBuildings?.[m]) state.spaceBuildings[m] = new Set(p.spaceBuildings[m]);
    if (p.buildings) state.buildings = new Set(p.buildings);
    if (Array.isArray(p.types)) state.types = new Set(p.types);
    state.equip = p.equip === "screen";
    state.minSeats = p.minSeats || "";
    if (DURATIONS.includes(p.duration)) state.duration = p.duration;
    if (Array.isArray(p.kinds) && p.kinds.some((k) => KINDS.includes(k))) state.kinds = new Set(p.kinds.filter((k) => KINDS.includes(k)));
    if (PRICE_GROUPS.includes(p.priceGroup)) state.priceGroup = p.priceGroup;
    if (DIETS.includes(p.diet)) state.diet = p.diet;
    if (p.comparePicks && typeof p.comparePicks === "object") state.compare = p.comparePicks;
    // An older saved `mapLayers` (several at once) is ignored: everyone starts on none.
    if (MAP_LAYERS.includes(p.mapLayer)) state.mapLayer = p.mapLayer;
    if (p.mapLayersOpen === false) state.mapLayersOpen = false;
    state.stars = cleanStars(p.stars);
    state.mealPref = cleanMealPref(p.mealPref);
    if (typeof p.client === "string" && CLIENT_ID_RE.test(p.client)) state.client = p.client;
    state.myReports = cleanMyReports(p.reports, Date.now());
    localStorage.setItem(`${STORE_KEY}-probe`, "1");
    localStorage.removeItem(`${STORE_KEY}-probe`);
  } catch {
    state.starsSaved = false; // storage unavailable
  }
  // ?buildings=HG,CAB overrides the remembered selection (handy for bookmarks)
  const fromUrl = new URLSearchParams(location.search).get("buildings");
  if (fromUrl) {
    state.buildings = new Set(fromUrl.split(",").map((b) => b.trim().toUpperCase()).filter(Boolean));
    state.mode = "rooms";
  }
  if (location.pathname === "/share") return loadInvite();
  // A place's own address (/?room=HG+E+33.1&area=Z): opened over the tab that fits it.
  const place = parsePlaceUrl(location.search);
  if (place) {
    if (place.area) state.area = place.area;
    if (place.kind === "room") state.mode = "rooms";
    else if (place.kind === "space" && !["study", "mensa"].includes(state.mode)) state.mode = "study";
    else if (place.kind === "microwave") state.mode = "mensa";
    state.pendingPlace = { place, from: "url" };
  }
}

// An invite link (/share?room=… or /share?space=…) opens the place's detail view with the sender's sentence above it
// ("I'm in HG E 33.1, come join me!"), at the sender's time if they chose one. The sender's buildings and filters
// aren't applied and nothing is saved: the receiver's own choices stay as they were. The address becomes the place's.
function loadInvite() {
  const inv = parseInvite(location.search);
  if (!inv) return history.replaceState(null, "", "/");
  if (inv.area) state.area = inv.area;
  if (inv.at) state.sharedAt = inv.at;
  if (inv.kind === "room") state.mode = "rooms";
  else state.mode = inv.meal ? "mensa" : new URLSearchParams(location.search).get("mode") === "mensa" ? "mensa" : "study";
  state.pendingPlace = { place: { kind: inv.kind, id: inv.id, area: inv.area }, from: "url", invite: inv };
}

function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      mode: state.mode,
      area: state.area,
      spaceBuildings: { study: [...state.spaceBuildings.study], mensa: [...state.spaceBuildings.mensa] },
      buildings: [...state.buildings],
      types: state.types && [...state.types],
      equip: state.equip ? "screen" : null,
      minSeats: state.minSeats,
      duration: state.duration,
      kinds: [...state.kinds],
      priceGroup: state.priceGroup,
      diet: state.diet,
      comparePicks: state.compare,
      mapLayer: state.mapLayer,
      mapLayersOpen: state.mapLayersOpen,
      stars: state.stars,
      mealPref: state.mealPref,
      client: state.client,
      reports: cleanMyReports(state.myReports, Date.now()),
    }));
  } catch { /* storage unavailable */ }
}

// --- helpers ---

/** The live answers are cached for 60 s; for that long after your own report, they're fetched past the browser's cache. */
const LIVE_CACHE_MS = 65 * 1000;
const LIVE_PATHS = ["/api/map", "/api/spaces", "/api/room", "/api/reports"];

/** GET a JSON answer. `fresh`: past the browser's cache (a signed-in Report log, whose answer is personal). */
async function getJSON(url, { fresh: force = false } = {}) {
  let res;
  const fresh = force || LIVE_PATHS.some((p) => url.startsWith(p + "?") || url === p) &&
    state.myReports.some((r) => r.kind !== "rating" && Date.now() - r.at < LIVE_CACHE_MS);
  try {
    res = await fetch(url, fresh ? { cache: "no-cache" } : undefined);
  } catch (e) {
    throw new Error(navigator.onLine === false ? "offline" : "network error");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
  return body;
}

const hhmm = (iso) => iso.slice(11, 16);
const day = (iso) => iso.slice(0, 10);
const weekday = (iso) => new Date(day(iso) + "T12:00").toLocaleDateString("en-GB", { weekday: "short" });

/** When data was fetched: its time, with the weekday if it wasn't today (Zurich). */
function asOfLabel(iso) {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
  return day(iso) === today ? hhmm(iso) : `${weekday(iso)} ${hhmm(iso)}`;
}

/** The note for answers with `stale` rooms: the last bookings frooms has, which may since have changed. */
const staleNote = () => `${university()} hasn't sent newer bookings`;

function untilLabel(iso, atIso) {
  return day(iso) === day(atIso) ? hhmm(iso) : `${weekday(iso)} ${hhmm(iso)}`;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

/**
 * A target of the tutorial (plans/PLAN_TUTORIAL.md, section 8): `data-tour="<name>"` on the element, which
 * tutorial.js finds by that name rather than by the layout. Returns the node (null stays null).
 */
function markTour(node, name) {
  if (node) node.dataset.tour = name;
  return node;
}

/**
 * The tutorial's "first-*" targets: `name` moves to the row-open button of `row` (the first suitable row of a list
 * just drawn), or goes when there's none.
 */
function markFirstRow(name, row) {
  document.querySelectorAll(`[data-tour="${name}"]`).forEach((n) => delete n.dataset.tour);
  markTour(row?.querySelector(".row-open") ?? null, name);
}

function chip(label, on, onClick, extra) {
  const b = el("button", { class: "chip" + (on ? " on" : ""), type: "button", "aria-pressed": String(on) }, label);
  if (extra != null) b.append(el("small", {}, String(extra)));
  b.addEventListener("click", onClick);
  return b;
}

// --- controls ---

/** One line under the sheet's head saying what each tab is for (hidden in detail views and search by the CSS). */
const TAB_BLURBS = {
  study: "Find libraries and places to study on campus",
  rooms: "Find free rooms to meet with your team",
  mensa: "Compare menus and find your perfect meal",
  you: "Check-ins, friends and your favourite places on campus",
};

function renderModes() {
  document.querySelectorAll("#tabs button").forEach((b) => {
    const on = b.dataset.mode === state.mode;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  });
  const rooms = state.mode === "rooms";
  const you = state.mode === "you";
  // Meet: duration and people; More filters: room types in Meet, mensas and cafés in Eat.
  $("#filters").hidden = state.mode === "study";
  for (const id of ["#duration-field", "#people-field", "#types"]) $(id).hidden = !rooms;
  $("#equipment").hidden = !rooms || !EQUIPMENT_FILTER;
  $("#kinds").hidden = state.mode !== "mensa";
  if (rooms) renderDurations();
  if (state.mode === "mensa") renderKinds();
  else renderTypes();
  $("#results").hidden = !rooms;
  $("#space-results").hidden = rooms || you;
  $("#you").hidden = !you;
  // Eat has no building filter: every mensa of the location is listed, nearest first.
  $("#buildings-field").hidden = state.mode === "mensa";
  $("#buildings-hint").textContent = rooms ? "" : "· optional";
  // The You tab has no filters: its head says what it is instead.
  $("#filter-line").hidden = you;
  $("#sheet-title").hidden = !you;
  $("#sheet-title").textContent = you ? "Your frooms" : "";
  if (you) closeFilters();
  $("#tab-blurb").textContent = TAB_BLURBS[state.mode] ?? "";
  renderFilterLine();
}

// --- the filter line: the current choice in a few words, opening the filters ---

/** "Fri 13.11." */
function shortDate(iso) {
  const d = new Date(`${iso}T12:00`);
  return `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
}

/** "Now", or the chosen time as "Fri 13.11. 10:15". */
function timeText() {
  if (state.now || !state.date || !state.time) return "Now";
  return `${shortDate(state.date)} ${state.time}`;
}

/** "all buildings", "HG, CAB" or "HG, CAB, ML +2". */
function buildingsText(list) {
  if (!list.length) return "all buildings";
  return list.length <= 3 ? list.join(", ") : `${list.slice(0, 3).join(", ")} +${list.length - 3}`;
}

function renderFilterLine() {
  renderTimeField();
  if (state.mode === "you") return;
  const parts = [timeText()];
  if (state.mode === "rooms") parts.push(durationText(state.duration), state.minSeats ? `${state.minSeats}+ people` : "any size");
  if (state.mode !== "mensa") parts.push(buildingsText(pickedBuildings())); // Eat has no building filter: the time alone
  if (state.mode === "mensa" && state.kinds.size === 1) parts.push(state.kinds.has("mensa") ? "mensas only" : "cafeterias only");
  const text = parts.join(" · ");
  $("#filter-text").textContent = text;
  $("#filter-line").setAttribute("aria-label", `Filters: ${text}`);
}

/** Picked buildings, each with a way to its detail view (the building's view is reachable from the list too). */
function renderPickedBar() {
  const bar = $("#picked-bar");
  const picked = state.mode === "you" ? [] : pickedBuildings();
  bar.hidden = !picked.length;
  bar.replaceChildren(...picked.map((code) => {
    const b = el("button", { type: "button", class: "picked" }, el("b", {}, buildingLabel(code)), " Details →");
    b.addEventListener("click", () => openPlace({ kind: "building", id: code, area: state.area }, { opener: b }));
    return b;
  }));
}

let filtersFrom = null; // the sheet's position before the filters opened (phones)

function openFilters() {
  $("#sheet-filters").hidden = false;
  $("#filter-line").setAttribute("aria-expanded", "true");
  filtersFrom = sheet.current();
  sheet.snap("full");
  $("#sheet-body").scrollTop = 0;
}

function closeFilters() {
  if ($("#sheet-filters").hidden) return;
  openPicker(null);
  $("#sheet-filters").hidden = true;
  $("#filter-line").setAttribute("aria-expanded", "false");
  if (filtersFrom && filtersFrom !== "full") sheet.snap(filtersFrom);
  filtersFrom = null;
}

/** The buildings of one tab's spaces (in Study also of its rooms free long enough), or null while that isn't loaded yet. */
function spaceBuildingsOf(mode) {
  if (state.spaces?.area !== state.area) return null;
  const codes = new Set(state.spaces.spaces.filter((s) => (mode === "mensa") === (s.category === "mensa")).map((s) => s.building));
  if (mode === "study") studyRoomsListed().forEach((r) => codes.add(r.building));
  return codes;
}

/** Carry the building selection over to another tab, dropping buildings the new tab doesn't have. */
function carryBuildings(from, to) {
  if (from === "you" || to === "you" || from === "mensa" || to === "mensa") return; // Eat has no building filter
  const picked = from === "rooms" ? selectedBuildings() : [...state.spaceBuildings[from]].filter((b) => spaceBuildingsOf(from)?.has(b) ?? true);
  const available = to === "rooms" ? (state.areaBuildings.length ? new Set(state.areaBuildings) : null) : spaceBuildingsOf(to);
  const kept = new Set(available ? picked.filter((b) => available.has(b)) : picked);
  if (to === "rooms") state.buildings = kept;
  else state.spaceBuildings[to] = kept;
}

/** The buildings the list is filtered to in the current tab (highlighted on the map). */
function pickedBuildings() {
  // The You tab highlights the buildings of the starred places here.
  if (state.mode === "you") return [...new Set(state.stars.filter((s) => s.area === state.area && s.building).map((s) => s.building))];
  if (state.mode === "rooms") return selectedBuildings();
  if (state.mode === "mensa") return []; // Eat has no building filter (the stored choice is ignored)
  const available = spaceBuildingsOf(state.mode);
  return [...state.spaceBuildings[state.mode]].filter((b) => available?.has(b) ?? true);
}

/** From the map: the list in `mode`, filtered to `building` (or with `building` added or removed when `add`). */
function filterList(mode, building, add = false) {
  if (mode !== state.mode) carryBuildings(state.mode, mode);
  state.mode = mode;
  const set = mode === "rooms" ? state.buildings : state.spaceBuildings[mode];
  if (!add) {
    set.clear();
    set.add(building);
  } else if (set.has(building) && set.size > 1) set.delete(building);
  else set.add(building);
  savePrefs();
  closeInviteMenus();
  renderModes();
  if (mode === "rooms") renderBuildings(state.roomBuildingList);
  else if (state.spaces?.area === state.area) renderSpaces();
  refresh();
}

/**
 * The buildings picked in the lists are reset, in Study and Meet both, and the whole location is listed again: a click
 * on the map beside the buildings, or on a building that isn't picked (`keep`: a building picked in the current tab,
 * or with Eat or You open in either, leaves them as they are). `render` false: the caller draws the list itself
 * (filterList). Returns false when there was nothing to reset.
 */
function clearPickedBuildings({ keep = null, render = true } = {}) {
  const sets = [state.buildings, state.spaceBuildings.study];
  if (!sets.some((set) => set.size)) return false;
  if (keep) {
    const own = state.mode === "rooms" ? [state.buildings] : state.mode === "study" ? [state.spaceBuildings.study] : sets;
    if (own.some((set) => set.has(keep))) return false;
  }
  sets.forEach((set) => set.clear());
  savePrefs();
  if (!render) return true;
  closeInviteMenus();
  if (state.mode === "rooms") renderBuildings(state.roomBuildingList);
  else if (state.mode === "study" && state.spaces?.area === state.area) renderSpaces();
  refresh();
  return true;
}

function selectMode(mode) {
  showNotice(null);
  if (mode === state.mode) return;
  carryBuildings(state.mode, mode);
  state.mode = mode;
  savePrefs();
  closeInviteMenus();
  renderModes();
  if (mode === "rooms") renderBuildings(state.roomBuildingList);
  else if (mode !== "you" && state.spaces?.area === state.area) renderSpaces(); // one answer covers both tabs; refresh() updates it
  syncMap();
  $("#sheet-body").scrollTop = 0;
  refresh();
}

/** The campus menu in the top bar: the five locations, under ETH and UZH. */
function renderAreas() {
  const groups = [];
  for (const uni of ["ETH", "UZH"]) {
    const list = state.areas.areas.filter((a) => (a.university ?? "ETH") === uni);
    if (!list.length) continue;
    groups.push(el("div", { class: "uni", "aria-hidden": "true" }, uni), ...list.map(({ area, name }) => {
      // Friends checked in on another campus show as a count there (friends.js).
      const b = el("button", { type: "button", role: "menuitemradio", "aria-checked": String(area === state.area) }, name, area !== state.area ? friendsBadge(area) ?? "" : "");
      b.addEventListener("click", () => {
        closeCampusMenu();
        selectArea(area);
      });
      return b;
    }));
  }
  $("#areas").replaceChildren(...groups);
  $("#campus-name").textContent = state.areas.areas.find((a) => a.area === state.area)?.name ?? state.area;
}

function closeCampusMenu() {
  $("#campus-menu").hidden = true;
  $("#campus").setAttribute("aria-expanded", "false");
}

function initCampusMenu() {
  $("#campus").addEventListener("click", (e) => {
    e.stopPropagation();
    closeAccountMenu();
    const show = $("#campus-menu").hidden;
    $("#campus-menu").hidden = !show;
    $("#campus").setAttribute("aria-expanded", String(show));
    if (show) $("#campus-menu button[aria-checked=true]")?.focus();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.(".campus-box")) closeCampusMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#campus-menu").hidden) {
      e.preventDefault();
      closeCampusMenu();
      $("#campus").focus();
    }
  });
}

async function selectArea(area, { save = true } = {}) {
  if (area === state.area) return;
  state.area = area;
  if (save) savePrefs();
  renderAreas();
  renderMapAreas();
  flyMapTo(area); // the map flies there (or keeps its view between the two Zentrum maps) while the list loads
  try {
    await loadArea();
  } catch (e) {
    showMessage(`Could not load ${area}: ${e.message}`);
  }
}

async function loadArea() {
  const types = await getJSON(`/api/types?area=${state.area}`);
  state.defaults = types.default;
  state.typeList = types.types;
  const known = new Set(types.types.map((t) => t.typecode));
  // The defaults on a first visit, or when none of the remembered types are offered here (an older choice of computer
  // rooms, which Meet no longer lists); nothing picked on purpose shows every type.
  const kept = keptTypes(state.types ? [...state.types] : null, known);
  state.types = new Set(kept ?? state.defaults.filter((t) => known.has(t)));
  renderTypes();
  await loadBuildings();
  refresh();
}

const selectedBuildings = () => state.areaBuildings.filter((b) => state.buildings.has(b));

function renderBuildings(list) {
  const box = $("#buildings");
  state.roomBuildingList = list;
  state.areaBuildings = list.map((b) => b.building);
  state.buildingRooms = new Map(list.map((b) => [b.building, b.rooms]));
  if (state.mode !== "rooms") return; // the other tabs show their own buildings (renderSpaceBuildings)
  syncMap();
  if (list.length === 0) {
    box.replaceChildren(el("span", { class: "empty" }, "No buildings with the selected room types here."));
    return;
  }
  const picked = new Set(selectedBuildings());
  box.replaceChildren(...buildingChips(list.map((b) => [b.building, b.rooms]), picked, (code) => {
    if (code == null) state.buildings.clear();
    else state.buildings.has(code) ? state.buildings.delete(code) : state.buildings.add(code);
    savePrefs();
    renderBuildings(list);
    refresh();
  }));
}

/**
 * The building chips of Study, Meet and Eat: "All" (on when nothing is picked), then the starred buildings with a
 * small star, then the rest alphabetically, each with its count. `onPick(code)` toggles a building; `onPick(null)`
 * clears the choice. One scrolling line on phones, wrapped on wide windows (the CSS).
 */
function buildingChips(counts, picked, onPick) {
  const all = chip("All", picked.size === 0, () => { if (picked.size) onPick(null); });
  all.classList.add("all");
  return [all, ...orderBuildingChips(counts, starredBuildingSet()).map(({ code, count, starred }) => {
    const b = chip(code, picked.has(code), () => onPick(code), count);
    if (starred) {
      b.prepend(el("span", { class: "chip-star", "aria-hidden": "true" }, "★"));
      b.setAttribute("aria-label", `${code}, starred, ${count}`);
    }
    return b;
  })];
}

/** Meet's duration chips: 30 min, 1 h, 2 h, 3 h. */
function renderDurations() {
  $("#durations").replaceChildren(...DURATIONS.map((d) => chip(durationText(d), d === state.duration, () => {
    if (d === state.duration) return;
    state.duration = d;
    savePrefs();
    renderDurations();
    refresh();
  })));
}

function renderTypes() {
  const list = state.typeList;
  const box = $("#types");
  box.replaceChildren(...list.map(({ typecode, type, count }) =>
    chip(type, !!state.types?.has(typecode), () => {
      state.types ??= new Set();
      state.types.has(typecode) ? state.types.delete(typecode) : state.types.add(typecode);
      savePrefs();
      renderTypes();
      loadBuildings().then(refresh);
    }, count)));
  renderEquipment();
  // Before the types are known (first visit, init() runs this before /api/types answers) nothing is picked yet.
  const names = state.types?.size ? list.filter((t) => state.types.has(t.typecode)).map((t) => t.type) : ["All room types"];
  if (equipOn()) names.push("screen or projector");
  if (state.mode !== "rooms") return;
  $("#filter-summary").textContent = `· ${names.join(", ")}`;
}

/**
 * Meet's equipment chip, "Screen or projector": only rooms whose stored equipment has a presentation monitor or a
 * projector (the request carries `equip=screen`; rooms without equipment data come in a group of their own). Shown
 * in Meet when EQUIPMENT_FILTER is on.
 */
function renderEquipment() {
  $("#equipment").replaceChildren(chip("Screen or projector", state.equip, () => {
    state.equip = !state.equip;
    savePrefs();
    renderTypes();
    refresh();
  }));
}

const KIND_LABELS = { mensa: "Mensas", cafe: "Cafeterias & bars" };

/** The mensas tab's More filters: mensas and cafés, both on by default; turning both off turns both on again. */
function renderKinds() {
  $("#kinds").replaceChildren(...KINDS.map((k) => chip(KIND_LABELS[k], state.kinds.has(k), () => {
    state.kinds.has(k) ? state.kinds.delete(k) : state.kinds.add(k);
    if (state.kinds.size === 0) KINDS.forEach((x) => state.kinds.add(x));
    savePrefs();
    renderKinds();
    renderFilterLine();
    if (state.spaces?.area === state.area) renderSpaces();
  })));
  $("#filter-summary").textContent = `· ${KINDS.filter((k) => state.kinds.has(k)).map((k) => KIND_LABELS[k]).join(", ")}`;
}

/** Meet's equipment filter is on (and offered). */
const equipOn = () => EQUIPMENT_FILTER && state.equip;

/** The room types to ask for: the picked ones, or every type of the area when none is picked. */
const wantedTypes = () => (state.types?.size ? [...state.types] : state.typeList.map((t) => t.typecode));

async function loadBuildings() {
  const list = await getJSON(`/api/buildings?area=${state.area}&types=${wantedTypes().join(",")}`);
  renderBuildings(list);
}

// --- the Time field: Now, or a date from the calendar and a time from the wheel (static/picker.js) ---

const nowParts = () => {
  const now = new Date();
  return { date: isoDate(now), time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}` };
};

/** Now on or off. On: the date and time become the current ones (what the buttons show) and the pickers close. */
function setNow(on, reload = true) {
  state.now = on;
  const btn = $("#now-toggle");
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  clearTimeout(wheelRefresh);
  wheelRefresh = null;
  if (on) {
    Object.assign(state, nowParts());
    openPicker(null);
  }
  renderTimeField();
  if (reload) refresh();
}

const timePickers = { date: null, time: null };
let wheelRefresh = null; // the list's refresh after the wheel settled, while it waits

/** The date and time buttons: the chosen ones, or the current ones (muted) while Now is on; the open picker follows. */
function renderTimeField() {
  const { date, time } = chosenTime();
  const dateBtn = $("#date-btn");
  const timeBtn = $("#time-btn");
  dateBtn.textContent = shortDate(date);
  dateBtn.setAttribute("aria-label", `Date: ${shortDate(date)}`);
  timeBtn.textContent = time;
  timeBtn.setAttribute("aria-label", `Time: ${time}`);
  dateBtn.classList.toggle("live", state.now);
  timeBtn.classList.toggle("live", state.now);
  if (!$("#date-picker").hidden) timePickers.date?.update(date);
  if (!$("#time-picker").hidden) timePickers.time?.setValue(time);
}

/**
 * Open the calendar or the time wheel under the Time row (`which` "date" or "time"; the other closes; the open one
 * closes again on its own button; null closes both). `byKeyboard` moves the focus into the picker.
 */
function openPicker(which, byKeyboard = false) {
  const show = which && $(`#${which}-picker`).hidden;
  for (const k of ["date", "time"]) {
    $(`#${k}-picker`).hidden = !(show && k === which);
    $(`#${k}-btn`).setAttribute("aria-expanded", String(show && k === which));
  }
  if (!show) return;
  const { date, time } = chosenTime();
  if (which === "date") {
    if (!timePickers.date) {
      timePickers.date = datePicker({ value: date, min: state.dates?.min, max: state.dates?.max, onPick: pickDate, onClose: () => {
        openPicker(null);
        $("#date-btn").focus();
      } });
      $("#date-picker").append(timePickers.date);
    }
    timePickers.date.update(date);
    if (byKeyboard) timePickers.date.focusDay();
  } else {
    // The wheel steps by 5 minutes: the chosen time is rounded down to the step when it opens.
    const rounded = roundToStep(time);
    if (!state.now && rounded !== state.time) {
      state.time = rounded;
      renderFilterLine();
      refresh();
    }
    if (!timePickers.time) {
      timePickers.time = timeWheel({ value: rounded, onChange: pickTime, onClose: () => {
        commitPicker();
        $("#time-btn").focus();
      } });
      $("#time-picker").append(timePickers.time);
    }
    timePickers.time.setValue(rounded);
    if (byKeyboard) timePickers.time.focusDrum();
  }
}

/**
 * Close the open picker keeping what it shows: a gliding drum lands where it was heading (which picks that time), and
 * a refresh still waiting for the wheel to rest runs now. Nothing open: nothing happens.
 */
function commitPicker() {
  if ($("#date-picker").hidden && $("#time-picker").hidden) return;
  if (!$("#time-picker").hidden) timePickers.time?.finish();
  if (wheelRefresh) {
    clearTimeout(wheelRefresh);
    wheelRefresh = null;
    refresh();
  }
  openPicker(null);
}

/**
 * A press anywhere outside the open picker and the date and time buttons closes it with its value (commitPicker),
 * and still does what it's on (a tab, a row, the map). It closes when the press ends, at its click: closing at the
 * press would pull the list up under the pointer, and the click would miss the row it was aimed at. A press that
 * gives no click (a scroll, a drag on the map) closes it shortly after it ends. The date and time buttons themselves
 * keep switching and closing pickers.
 */
const outsidePress = { on: false, timer: 0 };

function outsidePressStart(e) {
  if ($("#date-picker").hidden && $("#time-picker").hidden) return;
  if (e.target.closest?.(".picker, #date-btn, #time-btn")) return;
  clearTimeout(outsidePress.timer);
  outsidePress.on = true;
}

function outsidePressEnd() {
  clearTimeout(outsidePress.timer);
  if (!outsidePress.on) return;
  outsidePress.on = false;
  commitPicker();
}

function watchOutsidePress() {
  document.addEventListener("pointerdown", outsidePressStart, true);
  document.addEventListener("click", outsidePressEnd, true);
  for (const type of ["pointerup", "pointercancel"]) {
    document.addEventListener(type, () => {
      if (outsidePress.on) outsidePress.timer = setTimeout(outsidePressEnd, OUTSIDE_PRESS_MS);
    }, true);
  }
}

/** A day picked in the calendar: Now goes off (the time stays), the calendar closes, the list refreshes. */
function pickDate(date) {
  if (state.now) {
    Object.assign(state, nowParts());
    setNow(false, false);
  }
  state.date = date;
  openPicker(null);
  $("#date-btn").focus({ preventScroll: true });
  renderFilterLine();
  refresh();
}

/** A time the wheel settled on: Now goes off (the date stays), the wheel stays open, the list refreshes shortly. */
function pickTime(time) {
  if (state.now) {
    Object.assign(state, nowParts());
    setNow(false, false);
  }
  state.time = time;
  renderFilterLine();
  clearTimeout(wheelRefresh);
  wheelRefresh = setTimeout(() => {
    wheelRefresh = null;
    refresh();
  }, WHEEL_REFRESH_MS);
}

// --- results ---

function describe(r, at) {
  if (r.status === "free") {
    if (!r.free_until || day(r.free_until) !== day(at)) return "free rest of day";
    if (r.next_kind === "closed") return `free until closing (${hhmm(r.free_until)})`;
    return `free until ${hhmm(r.free_until)}`;
  }
  if (r.status === "managed") return `${r.managed_by} managed`;
  if (r.status === "busy") {
    if (r.current_kind === "closed") {
      return day(r.busy_until) === day(at) ? `closed until ${hhmm(r.busy_until)}` : "closed";
    }
    // A department's room isn't free after ETH's booking, only managed again.
    return r.managed_by ? `booked until ${untilLabel(r.busy_until, at)}` : `free at ${untilLabel(r.busy_until, at)}`;
  }
  if (r.status === "pending") return "not loaded yet";
  return r.status === "error" ? "request failed" : "no data";
}

/**
 * A room row's look: free, soon (free within FREE_SOON_MIN), busy, managed (a department books it too: orange) or
 * `none` without data. A department's room is never "soon": it isn't free after ETH's booking.
 */
function roomLook(r, none = "") {
  if (r.status === "free") return "free";
  if (r.status === "managed") return "managed";
  if (r.status === "busy") return r.minutes <= FREE_SOON_MIN && !r.managed_by ? "soon" : "busy";
  return none;
}

/** The university of the chosen location ("ETH" or "UZH", from /api/areas). */
const university = () => universityOf(state.area);
/** "ETH" or "UZH": whose location an area is. */
const universityOf = (area) => state.areas?.areas.find((a) => a.area === area)?.university ?? "ETH";

function details(r, at) {
  const lines = [];
  if (r.status === "busy" && r.current_kind === "booking") {
    lines.push(`Now: ${r.current_title || "booked"} until ${untilLabel(r.current_until, at)}`);
    if (r.next_gap_minutes != null && !r.managed_by) {
      const then = r.next_kind === "closed" ? "until closing" : `before ${r.next_title || "next booking"}`;
      lines.push(`Then free for ${r.next_gap_minutes} min ${then}`);
    }
  } else if ((r.status === "free" || r.status === "managed") && r.next_kind === "booking") {
    lines.push(`Next: ${r.next_title || "booking"} at ${untilLabel(r.free_until, at)}`);
  }
  if (r.managed_by) {
    lines.push(`${r.managed_by} also books this room in its own system, which frooms can't see: it may be taken when ETH lists nothing`);
  }
  if (r.stale_since) {
    lines.push(`Bookings as of ${asOfLabel(r.stale_since)}: ${university()} hasn't sent newer ones, so they may have changed`);
  }
  if (r.status === "pending") {
    lines.push(`frooms fetches rooms from ${university()} a few at a time to keep the load low. This one is due in a few minutes.`);
  } else if (r.status === "no_data") {
    lines.push(university() === "UZH"
      ? "frooms has UZH's bookings for the coming month only. Check UZH's room calendar for later days."
      : "ETH returned no allocations for this room. Check ETH's page.");
  }
  return lines.join(" · ");
}

/** A cross, for the round red remove buttons (removeButton). */
const REMOVE_ICON = "M7.5 7.5l9 9M16.5 7.5l-9 9";

/** A small round red button with a cross that removes something of yours: `label` is what screen readers hear. */
function removeButton(label, onClick) {
  const b = el("button", { type: "button", class: "remove-btn", "aria-label": label, title: label }, icon(REMOVE_ICON));
  b.addEventListener("click", onClick);
  return b;
}

function icon(d) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

// A menu card, for the Menu buttons.
const MENU_ICON = "M6 3h12v18H6zM9 7.5h6M9 11h6M9 14.5h6M9 18h3";
const INFO_ICON = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 4.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zM10.5 11h2.5v6.5h-2.5z";
const SEND_ICON = "M2.5 11.2 20.6 3.4c.6-.3 1.2.3 1 .9l-7.8 18.1c-.3.6-1.2.6-1.4-.1l-2-7-7-2c-.7-.2-.7-1.1-.1-1.4zM10.6 13.4l3.6-3.6";
const LINK_ICON = "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1";

/** A label with a shorter wording for phones (switched in style.css). */
function label(long, short) {
  return el("span", {}, el("span", { class: "long" }, long), el("span", { class: "short" }, short));
}

/** "120 m" to the building, while the position is known (straight line, buildings only: CHOICES.md). */
function distanceOf(building) {
  const d = placeDistances()?.get(building);
  return d == null ? null : distanceText(d);
}

// --- the schedule bar and the reports' mannequins ---

/**
 * A room's day as a strip: free green, bookings red, closed grey, 07:00 to 22:00 (lib.js BAR_FROM, BAR_TO), with a
 * navy needle at `at`. A department's room (`managed`) is orange where ETH lists nothing: the department may have booked it. From the room's `blocks` (null: no bar, the day isn't stored). `ticks` adds the hours under it
 * (the detail view). The status text says it all, so the bar is hidden from screen readers; its tooltip lists the
 * blocks. Blue (`--meeting`) is kept for scheduled meetings, later.
 */
function scheduleBar(blocks, at, ticks = false, managed = false) {
  if (!blocks) return null;
  const track = el("span", { class: `sched-track${managed ? " managed" : ""}` });
  for (const seg of barSegments(blocks)) {
    const s = el("i", { class: `sched-${seg.kind}` });
    s.style.left = `${seg.left}%`;
    s.style.width = `${seg.width}%`;
    track.append(s);
  }
  const bar = el("span", { class: "sched", "aria-hidden": "true", title: blocksTitle(blocks) }, track);
  const pos = at ? barNeedle(hhmm(at)) : null;
  if (pos != null) {
    const needle = el("b", { class: "sched-needle" });
    needle.style.left = `${pos}%`;
    bar.append(needle);
  }
  if (!ticks) return bar;
  const hours = el("span", { class: "sched-ticks", "aria-hidden": "true" }, ...[7, 10, 13, 16, 19, 22].map((h) => {
    const t = el("span", {}, String(h).padStart(2, "0"));
    t.style.left = `${barNeedle(`${String(h).padStart(2, "0")}:00`)}%`;
    return t;
  }));
  return el("span", { class: "sched-box" }, bar, hours);
}

// One figure (head and body) of the mannequins; the group repeats it.
const MANNEQUIN_ICON = "M5 .6a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2zM1.2 16v-5a3.8 3.8 0 0 1 7.6 0v5z";
const REPORT_LABELS = ["Reported free", "Reported crowded", "Reported full"];

/**
 * The mannequins that show what people reported (lib.js reportLevel): one grey figure without reports, one green for
 * free, two orange for crowded, three red for full; each group says so for screen readers, unless `decorative` (the
 * level is already written next to it, as in "full [•••] 5×" or the Full button).
 */
function people(level, decorative = false) {
  const n = level == null ? 1 : level + 1;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${n * 10} 16`);
  svg.setAttribute("width", String(n * 8.75));
  svg.setAttribute("height", "14");
  svg.setAttribute("class", `people ${level == null ? "none" : REPORT_LEVELS[level]}`);
  if (decorative) svg.setAttribute("aria-hidden", "true");
  else {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", level == null ? "No reports" : REPORT_LABELS[level]);
  }
  for (let i = 0; i < n; i++) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", MANNEQUIN_ICON);
    if (i) path.setAttribute("transform", `translate(${i * 10} 0)`);
    svg.append(path);
  }
  return svg;
}

// --- sending reports (the controls are in places.js reportControls) ---

// A report's answer stands in for the place's summary for this long, so a list or view loaded from a cached answer
// (the live endpoints are cached 60 s) doesn't hide the report just sent.
const REPORT_OVERRIDE_MS = 2 * 60 * 1000;
const reportOverrides = new Map(); // reportKey -> { at, summary }

/** The place's 2-hour summary: the one from the answer, or the fresher one a report of yours just brought back. */
function reportsOf(kind, id, area, summary) {
  const o = reportOverrides.get(reportKey({ kind, id, area }));
  return o && Date.now() - o.at < REPORT_OVERRIDE_MS ? o.summary : summary;
}

/** This browser's random id for reports: made on first use and kept in the preferences (for this visit without storage). */
function clientId() {
  if (!state.client) {
    state.client = clientIdFrom(crypto.getRandomValues(new Uint8Array(16)));
    savePrefs();
  }
  return state.client;
}

/**
 * Send a report about `p` ({ kind, id, area }) now: `kind` level, pct or rating, with frooms' estimate for the last two.
 * Remembers it, takes the answer's summary for the place and redraws the lists. Throws an Error with the text to show.
 */
async function sendReport(p, kind, value, estimate = null) {
  // The tutorial sends nothing (plans/PLAN_TUTORIAL.md, section 6): the controls show this instead of a confirmation.
  if (tourActive()) throw new Error(`${TOUR_NOT_SENT} This is where your report would go.`);
  let res;
  try {
    res = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, place_kind: p.kind, place: p.id, area: p.area, value, client: clientId(), estimate }),
    });
  } catch {
    throw new Error(navigator.onLine === false ? "You're offline." : "Couldn't send your report.");
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error(`${body.detail || "Too many reports right now, try again in a minute"}.`);
  if (!res.ok) throw new Error("Couldn't send your report.");
  const now = Date.now();
  state.myReports = noteMyReport(state.myReports, { place: reportKey(p), kind, at: now, value }, now);
  savePrefs();
  credEarned(body.cred);
  // Ratings aren't shown anywhere: nothing else changes.
  if (kind !== "rating") {
    reportOverrides.set(reportKey(p), { at: now, summary: body.summary ?? null });
    reportsChanged();
  }
  return body;
}

/**
 * Remove your report of `p` of `kind` (DELETE /api/report): forgotten here, the place's summary from the answer, the
 * lists redrawn. Throws an Error with the text to show.
 */
async function removeMyReport(p, kind) {
  if (tourActive()) throw new Error(`${TOUR_NOT_SENT} This is where your report would be removed.`);
  let res;
  try {
    res = await fetch("/api/report", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, place_kind: p.kind, place: p.id, area: p.area, client: clientId() }),
    });
  } catch {
    throw new Error(navigator.onLine === false ? "You're offline." : "Couldn't remove your report.");
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error(`${body.detail || "Too many reports right now, try again in a minute"}.`);
  if (!res.ok) throw new Error("Couldn't remove your report.");
  const now = Date.now();
  state.myReports = forgetMyReport(state.myReports, reportKey(p), kind, now);
  savePrefs();
  reportOverrides.set(reportKey(p), { at: now, summary: body.summary ?? null });
  reportsChanged();
  forgetCred();
  return body;
}

/** The lists after a report: their rows' mannequins follow (the view redraws itself). */
function reportsChanged() {
  if (state.mode === "rooms" && mapView.data?.rooms && $("#g-long .bgroup")) renderMeet(mapView.data);
  else if (["study", "mensa"].includes(state.mode) && state.spaces?.area === state.area) renderSpaces();
  else if (state.mode === "you") renderYou();
}

/** "Reported about 70 % full (3 reports)" from a summary with percentage reports, else null. */
function reportedLine(summary, suffix = "") {
  if (!summary?.n_pct) return null;
  return el("span", { class: "reported" }, `Reported ${fullText(summary.pct)} (${plural(summary.n_pct, "report", "reports")}${suffix})`);
}

/**
 * A room's row: name, the reports' mannequins and the status in its colour, one meta line (seats, type, the current
 * booking, distance) and the day's schedule bar. A click opens its detail view (`from`: how, see openPlace). Reports
 * show only for now (`now`; the You tab is always now).
 */
function roomItem(r, at, cls, from = "list", area = state.area, { now = state.now } = {}) {
  const short = r.short_gap && r.status === "free";
  const busyTitle = r.status === "busy" && r.current_kind === "booking" && r.current_title && university() !== "UZH"
    ? `${r.current_title} until ${untilLabel(r.current_until, at)}` : null;
  const meta = [r.seats != null ? `${r.seats} seats` : null, r.type, busyTitle, area === state.area ? distanceOf(r.building) : null].filter(Boolean).join(" · ");
  const live = now && (r.status === "free" || r.status === "busy" || r.status === "managed");
  const open = el("button", { type: "button", class: "row-open" },
    el("span", { class: "name" }, starMark("room", r.room, area), r.room),
    live ? people(reportLevel(reportsOf("room", r.room, area, r.reports))) : null,
    el("span", { class: "when" }, r.status ? describe(r, at) + (short ? " · short" : "") : ""),
    meta ? el("span", { class: "meta" }, meta) : null,
    scheduleBar(r.blocks, at, false, !!r.managed_by));
  open.addEventListener("click", () => openPlace({ kind: "room", id: r.room, area }, { from, opener: open }));
  return el("li", { class: `room ${cls}${short ? " short" : ""}`, "data-room": r.room, "data-building": r.building }, open);
}

// --- invites ---

/**
 * A random background of the place's university (UZH's own, the rest ETH's), as the link's `bg`. The place's own area
 * decides where it has one: both Zentrum campuses' mensas are listed together.
 */
function randomBackground(place, backgrounds = shareBackgrounds) {
  const all = Array.from({ length: backgrounds.count }, (_, i) => i);
  const uzh = universityOf(place?.area ?? state.area) === "UZH";
  const own = all.filter((i) => backgrounds.uzh.includes(i) === uzh);
  const pick = own.length ? own : all;
  return String(pick[Math.floor(Math.random() * pick.length)]);
}
const sharedTime = () => `${state.date}T${state.time}`;

/** A link to the sender's current view with this room open; its preview image is picked at random. */
function inviteUrl(r) {
  const q = new URLSearchParams({ room: r.room, bg: randomBackground(r) });
  q.set("area", state.area);
  q.set("b", selectedBuildings().join(","));
  q.set("t", [...(state.types ?? [])].join(","));
  if (state.minSeats) q.set("s", state.minSeats);
  if (!state.now) q.set("at", sharedTime());
  return `${location.origin}/share?${q}`;
}

/** The same for a study space or mensa, in the current tab. */
function spaceInviteUrl(s, mode = state.mode) {
  const q = new URLSearchParams({ space: s.id, bg: randomBackground(s), mode, area: state.area });
  const b = mode === "mensa" ? [] : [...(state.spaceBuildings[mode] ?? [])];
  if (b.length) q.set("b", b.join(","));
  if (!state.now) q.set("at", sharedTime());
  return `${location.origin}/share?${q}`;
}

function spaceInviteText(s, at) {
  const where = `${s.name} (${s.room})`;
  if (!state.now) return `Let's meet at ${where}, ${weekday(at)} ${hhmm(at)}!`;
  return s.category === "mensa" ? `Join me at ${where}!` : `I'm at ${where}, come join me!`;
}

// --- meal invites: "Lunch at Mensa Polyterrasse at 12:15?" ---

/**
 * The meal to invite for, with its date: the one on at `at` or the next one today, else the first one of the next day
 * with meals (tomorrow's lunch, once today's are over or the mensa is closed today); null if none is known.
 */
function inviteMeal(s, at) {
  const today = mealAt(s, at) ?? mealAfter(s, at);
  if (today) return { ...today, date: day(at) };
  const next = s.meals_next?.meals[0];
  return next ? { ...next, date: s.meals_next.date } : null;
}

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fromMinutes = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * The times to suggest for a meal, from `at`: "now" while it's on, then every quarter hour from the next one (or the
 * meal's start) to before its end. Must match quarters() in scripts/make_share_images.py, which renders their images.
 */
function inviteTimes(meal, at) {
  const now = meal.date === day(at) ? toMinutes(hhmm(at)) : -1; // another day: from the meal's start
  const times = state.now && now >= toMinutes(meal.from) && now < toMinutes(meal.to) ? ["now"] : [];
  const first = Math.ceil(Math.max(now + 1, toMinutes(meal.from)) / 15) * 15;
  for (let m = first; m < toMinutes(meal.to); m += 15) times.push(fromMinutes(m));
  return times;
}

/**
 * "Lunch at Clausiusbar today?", "… tomorrow at 12:15?", "… now?" or "… on Fri?": the meal (inviteMeal picks the next
 * one: today's lunch in the morning, dinner in the afternoon if there is one, else tomorrow's lunch), its day and
 * the suggested time.
 */
function mealInviteText(s, meal, time, at) {
  const today = meal.date === day(at) && state.now;
  const on = today ? " today" : meal.date === addDaysTo(day(at), 1) && state.now ? " tomorrow" : ` on ${weekday(meal.date)}`;
  const when = !time ? "?" : time === "now" ? " now?" : ` at ${time}?`;
  // A suggested time today needs no "today" ("Lunch at Clausiusbar at 12:15?").
  return `${MEAL_NAMES[meal.meal]} at ${s.name}${today && time ? "" : on}${when}`;
}

function mealInviteUrl(s, meal, time, at) {
  const q = new URLSearchParams({ space: s.id, meal: meal.meal, bg: randomBackground(s, mealBackgrounds), mode: "mensa", area: state.area });
  if (time) q.set("t", time === "now" ? "now" : time.replace(":", ""));
  // The day of the meal, so the link opens its menu (a time on that day: the suggested one, else the meal's start).
  if (meal.date !== day(at)) q.set("at", `${meal.date}T${time && time !== "now" ? time : meal.from}`);
  else if (!state.now) q.set("at", sharedTime());
  return `${location.origin}/share?${q}`;
}

/**
 * The time to suggest in a meal invite's menu, like the filters' Time field: a Now chip (while the meal is on) and a
 * time button that opens the time wheel below them, in quarter hours within the meal (the share images exist for
 * those, inviteTimes), and "No time" (the default). Its `value` is "", "now" or "HH:MM".
 */
function inviteTimePicker(meal, at) {
  const times = inviteTimes(meal, at);
  const quarters = times.filter((t) => t !== "now");
  let value = "";
  let wheel = null;
  const box = el("div", { class: "invite-when", role: "group", "aria-label": "Suggest a time (optional)" });
  Object.defineProperty(box, "value", { get: () => value });
  const noneChip = el("button", { type: "button", class: "chip", "aria-pressed": "true" }, "No time");
  const nowChip = times.includes("now") ? el("button", { type: "button", class: "chip", "aria-pressed": "false" }, "Now") : null;
  const timeBtn = quarters.length ? el("button", { type: "button", class: "time-btn", "aria-expanded": "false" }) : null;
  const holder = el("div", { class: "picker invite-wheel", hidden: "" });
  // The nearest of the meal's quarter hours to a time the wheel settled on.
  const allowed = (t) => quarters.reduce((best, q) => (Math.abs(toMinutes(q) - toMinutes(t)) < Math.abs(toMinutes(best) - toMinutes(t)) ? q : best), quarters[0]);
  const sync = () => {
    noneChip.classList.toggle("on", !value);
    noneChip.setAttribute("aria-pressed", String(!value));
    nowChip?.classList.toggle("on", value === "now");
    nowChip?.setAttribute("aria-pressed", String(value === "now"));
    if (!timeBtn) return;
    const set = value && value !== "now";
    timeBtn.textContent = set ? value : "Pick a time";
    timeBtn.classList.toggle("live", !set);
    timeBtn.setAttribute("aria-expanded", String(!holder.hidden));
    timeBtn.setAttribute("aria-label", set ? `Time: ${value}` : "Pick a time");
  };
  const showWheel = (open) => {
    // On a phone the wheel needs the room: the sheet goes up all the way (the menu opens upwards inside it).
    if (open && layout() === "full" && box.closest("#detail") && sheet.current() !== "full") sheet.snap("full");
    holder.hidden = !open;
    if (open && !wheel) {
      wheel = timeWheel({ value: value && value !== "now" ? value : quarters[0], step: 15, allowed, onChange: (t) => {
        value = t;
        sync();
      }, onClose: () => {
        wheel.finish();
        showWheel(false);
        timeBtn.focus();
      } });
      holder.append(wheel);
    }
    if (open) {
      if (!value || value === "now") value = quarters[0];
      wheel.setValue(value);
    } else wheel?.finish();
    sync();
  };
  noneChip.addEventListener("click", () => {
    value = "";
    showWheel(false);
  });
  nowChip?.addEventListener("click", () => {
    value = "now";
    showWheel(false);
  });
  timeBtn?.addEventListener("click", () => {
    if (!holder.hidden) return showWheel(false);
    showWheel(true);
  });
  box.append(el("span", { class: "invite-when-label" }, "Time (optional)"), el("div", { class: "row" }, noneChip, nowChip, timeBtn), holder);
  sync();
  return box;
}

function inviteText(r, at) {
  return r.status === "free"
    ? `I'm in ${r.room}, come join me!`
    : `Let's meet in ${r.room}, it's free at ${untilLabel(r.busy_until, at)}!`;
}

/**
 * The invite button and its menu: WhatsApp's own chat picker (the app on phones, WhatsApp Web elsewhere) or copying
 * the link. `text` and `url` are functions, so each invite gets its own random preview image. `labels` is the long
 * and the short (phones) label on a list card, one text elsewhere, or null for the icon alone (then `name` says
 * what it does); a meal invite has a time picker (`extra`) at the top of the menu. Signed in, sending it earns street
 * cred (cred.js credInvite, by `kind`: place, meal, checkin or friend-link), after the WhatsApp or Copy action itself.
 */
function inviteControl(text, url, { labels = ["Invite people to join", "Invite friends"], extra = null, name = null, kind = "place" } = {}) {
  // List cards: the label, then the icon; elsewhere the icon comes first ("➤ Invite"), or stands alone.
  const content = labels === null ? [icon(SEND_ICON)]
    : typeof labels === "string" ? [icon(SEND_ICON), el("span", {}, labels)]
    : [label(...labels), icon(SEND_ICON)];
  const button = el("button", { class: "action invite", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" }, ...content);
  if (name) {
    button.setAttribute("aria-label", name);
    button.title = name;
  }
  const whatsapp = el("button", { class: "whatsapp", type: "button", role: "menuitem" }, el("img", { src: "/icons/whatsapp.svg", alt: "", width: "20", height: "20" }), "WhatsApp");
  const copyLabel = el("span", {}, "Copy link");
  const copy = el("button", { class: "copy", type: "button", role: "menuitem" }, icon(LINK_ICON), copyLabel);
  // While the tutorial runs, WhatsApp and Copy link only say that nothing is sent (plans/PLAN_TUTORIAL.md, section 6).
  const tourNote = el("p", { class: "invite-tour-note", role: "status", hidden: "" });
  const tourBlocked = () => {
    if (!tourActive()) return false;
    tourNote.textContent = `${TOUR_NOT_SENT} This is where your invite would go.`;
    tourNote.hidden = false;
    return true;
  };
  const menu = markTour(el("div", { class: "invite-menu", role: "menu", hidden: "" }, extra, whatsapp, copy, tourNote), "invite-menu");
  menu.addEventListener("click", (e) => e.stopPropagation());
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const show = menu.hidden;
    closeInviteMenus();
    tourNote.hidden = true;
    menu.hidden = !show;
    button.setAttribute("aria-expanded", String(show));
  });
  whatsapp.addEventListener("click", () => {
    if (tourBlocked()) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(`${text()} ${url()}`)}`, "_blank", "noopener");
    closeInviteMenus();
    countUse("invite");
    credInvite(kind);
  });
  copy.addEventListener("click", async () => {
    if (tourBlocked()) return;
    try {
      await navigator.clipboard.writeText(url());
      copyLabel.textContent = "Link copied";
      countUse("invite");
      credInvite(kind);
    } catch {
      copyLabel.textContent = "Couldn't copy";
    }
    setTimeout(() => {
      closeInviteMenus();
      copyLabel.textContent = "Copy link";
    }, 1200);
  });
  return [button, menu];
}

/**
 * An invite button outside the list cards (map sheet, menu panel, comparison): button and menu in a box of their
 * own, so the menu opens below it (or above it with `up`).
 */
function inviteBox([button, menu], up = false) {
  return el("div", { class: `invite-box${up ? " up" : ""}` }, button, menu);
}

/**
 * A meal invite for a place ({ id, name }) and a meal ({ meal, from, to, date }), as seen at `at`: its label is
 * "Invite for lunch" (`labels` as for inviteControl), with the time picker.
 */
function mealInviteControl(place, meal, at, labels) {
  const picker = inviteTimePicker(meal, at);
  const name = `Invite for ${MEAL_NAMES[meal.meal].toLowerCase()}`;
  // WhatsApp shows *…* in bold: the link is the menu, not just a place.
  return inviteControl(() => `${mealInviteText(place, meal, picker.value, at)} *Check out the menu:*`, () => mealInviteUrl(place, meal, picker.value, at),
    { labels: labels === undefined ? name : labels, extra: picker, name, kind: "meal" });
}

/** The app's chosen time as "YYYY-MM-DDTHH:MM", like the API's `at`, for invites outside the list. */
const chosenAt = () => `${chosenTime().date}T${chosenTime().time}`;

function closeInviteMenus() {
  document.querySelectorAll(".invite-menu:not([hidden])").forEach((m) => { m.hidden = true; });
  document.querySelectorAll(".invite[aria-expanded=true]").forEach((b) => b.setAttribute("aria-expanded", "false"));
}

function fillGroup(id, items, at, cls) {
  const group = $(id);
  group.hidden = items.length === 0;
  group.querySelector(".count").textContent = items.length;
  group.querySelector("ul").replaceChildren(...items.map((r) => roomItem(r, at, cls)));
}

/** Free for the chosen duration or more (free for the rest of the stored window counts too). */
const longEnough = (r) => r.status === "free" && (r.minutes == null || r.minutes >= state.duration);

/**
 * Meet's list, from /api/map's `rooms` (or the per-building /api/free answers): rooms free for the chosen duration
 * by building (a building with a starred room first, then the nearest, then the one with the most; three rooms each
 * unless the building is picked or opened), then rooms free for less, free soon, busy and unavailable.
 */
function renderMeet(data) {
  const at = data.at;
  const picked = new Set(selectedBuildings());
  // A building drawn as part of a picked one (KOH in KOL, /api/map's `parts`) comes along, as a section of its own.
  const inPicked = picked.size ? data.rooms.filter((r) => picked.has(r.building) || picked.has(data.parts?.[r.building])) : data.rooms;
  // With "Screen or projector" on, the Worker sends the rooms that have one and those it knows nothing about: the
  // latter, when free long enough, go into a collapsed group of their own.
  const unknown = equipOn() ? inPicked.filter((r) => hasScreen(r.equipment) === null) : [];
  const rooms = unknown.length ? inPicked.filter((r) => hasScreen(r.equipment) !== null) : inPicked;
  const opts = sortOptions();
  const long = rooms.filter(longEnough);
  const short = rooms.filter((r) => r.status === "free" && !longEnough(r));
  const managed = rooms.filter((r) => r.status === "managed");
  const soon = rooms.filter((r) => roomLook(r) === "soon");
  const busy = rooms.filter((r) => roomLook(r) === "busy");
  const none = rooms.filter((r) => ["no_data", "error", "pending"].includes(r.status));
  const pending = rooms.filter((r) => r.status === "pending").length;

  const byBuilding = new Map();
  for (const r of long) byBuilding.set(r.building, [...(byBuilding.get(r.building) ?? []), r]);
  // Most fitting rooms first, then sortPlaces (stable) puts buildings with a starred room, then starred buildings,
  // then nearer buildings ahead.
  const buildings = sortPlaces([...byBuilding.keys()].sort((a, b) => byBuilding.get(b).length - byBuilding.get(a).length || a.localeCompare(b))
    .map((code) => ({ id: code, building: code, rooms: byBuilding.get(code) })), {
    stars: new Set([...byBuilding].filter(([, list]) => list.some((r) => opts.stars?.has(r.room))).map(([code]) => code)),
    distances: opts.distances,
    starredBuildings: opts.starredBuildings,
  });
  const g = $("#g-long");
  g.hidden = long.length === 0;
  g.querySelector(".title").textContent = `Free ${state.now ? "" : `at ${hhmm(at)} `}for ${durationText(state.duration)} or more`;
  g.querySelector(".count").textContent = long.length;
  g.querySelector(".bgroups").replaceChildren(...buildings.map(({ id: code, rooms: list }) => {
    const all = picked.has(code) || state.expanded.has(code) || list.length <= ROOMS_PER_BUILDING;
    const shown = all ? list : list.slice(0, ROOMS_PER_BUILDING);
    const dist = opts.distances?.get(code);
    const head = el("h3", { class: "bhead" }, el("span", {}, code), el("span", { class: "muted" },
      ` · ${list.length} room${list.length === 1 ? "" : "s"}${dist != null ? ` · ${distanceText(dist)}` : ""}`));
    const more = all ? null : el("button", { type: "button", class: "more-btn" }, `All ${list.length} in ${code}`);
    more?.addEventListener("click", () => {
      state.expanded.add(code);
      renderMeet(data);
    });
    return el("section", { class: "bgroup", "data-building": code }, head,
      el("ul", {}, ...shown.map((r) => roomItem(r, at, "free"))), more);
  }));
  fillGroup("#g-equip", sortPlaces(unknown.filter(longEnough), opts), at, "free");
  fillGroup("#g-short", sortPlaces(short, opts), at, "free");
  fillGroup("#g-managed", sortPlaces(managed, opts), at, "managed");
  fillGroup("#g-soon", sortPlaces(soon, opts), at, "soon");
  fillGroup("#g-busy", busy, at, "busy");
  fillGroup("#g-nodata", none, at, "");
  markFirstRow("first-room", long.length ? $("#g-long .bgroups li") : null);

  const asof = data.fetched_at ? `data as of ${asOfLabel(data.fetched_at)}${data.stale ? ` · ${staleNote()}` : ""}` : "";
  const when = state.now ? "" : ` · showing ${weekday(at)} ${day(at)} ${hhmm(at)}`;
  const loading = pending ? ` · ${pending} room${pending === 1 ? "" : "s"} still loading` : "";
  $("#asof").textContent = asof + when + loading;
  showMessage(inPicked.length ? null : "No rooms match these filters.");
}

function showMessage(text) {
  const m = $("#message");
  m.hidden = !text;
  m.textContent = text || "";
}

function clearResults() {
  for (const id of ["#g-long", "#g-equip", "#g-short", "#g-managed", "#g-soon", "#g-busy", "#g-nodata", "#s-library", "#s-open", "#s-mensa-study", "#s-rooms", "#s-workspace", "#s-eat", "#s-your", "#s-mensa", "#s-cafe", "#s-micro", "#s-closed"]) $(id).hidden = true;
}

// Same order as the server: free rooms first (longest free time first), then departments' rooms that ETH lists nothing
// for, then busy rooms that free up soonest.
function sortKey(r) {
  if (r.status === "free") return [0, -(r.minutes ?? 1e9)];
  if (r.status === "managed") return [1, -(r.minutes ?? 1e9)];
  if (r.status === "busy") return [2, r.minutes];
  return [3, r.status === "pending" ? 1 : 0];
}

function byStatus(a, b) {
  const [ka, kb] = [sortKey(a), sortKey(b)];
  return ka[0] - kb[0] || ka[1] - kb[1];
}

// One request per building keeps each request within the server's per-request room limit.
// A building with more rooms than that (e.g. HG with meeting rooms on) is split by room type.
function requestPlan(buildings) {
  const types = wantedTypes();
  return buildings.flatMap((building) => {
    if ((state.buildingRooms.get(building) ?? 0) <= MAX_ROOMS_PER_REQUEST || types.length < 2) {
      return [{ label: building, building, types }];
    }
    return types.map((t) => ({
      label: `${building} (${state.typeList.find((x) => x.typecode === t)?.type ?? t})`,
      building,
      types: [t],
    }));
  });
}

function mergeResults(responses) {
  const ok = responses.filter((r) => r.data).map((r) => r.data);
  const fetched = ok.map((d) => d.fetched_at).filter(Boolean).sort();
  return {
    at: ok[0].at,
    fetched_at: fetched[0] ?? null,
    stale: ok.some((d) => d.stale),
    rooms: ok.flatMap((d) => d.rooms).sort(byStatus),
  };
}

function showWarning(failed) {
  const w = $("#warning");
  w.hidden = failed.length === 0;
  if (!failed.length) return;
  const names = failed.map((f) => f.label).join(", ");
  const reasons = [...new Set(failed.map((f) => f.error))].join("; ");
  const retry = el("button", { class: "chip", type: "button" }, "Retry");
  retry.addEventListener("click", refresh);
  w.replaceChildren(el("span", {}, `Couldn't load ${names} (${reasons}). `), retry);
}

/** Reload the list and the map (the map only asks again when its time or area changed, or after a minute). */
async function refresh() {
  clearTimeout(refreshTimer);
  if (state.now) refreshTimer = setTimeout(() => {
    refresh();
    refreshPlace();
  }, REFRESH_MS);
  renderFilterLine();
  renderPickedBar();
  const map = refreshMap(); // in Meet, its answer is the list too (one request for both); in Study, its rooms
  if (state.mode === "you") return refreshYou();
  if (state.mode === "study") refreshStudyRooms(map);
  if (state.mode !== "rooms") return refreshSpaces();
  return refreshRooms(map);
}

/**
 * The map's answer for the current question: the early one when it's for the same query (the numbers arrive before
 * the campus is drawn), else `mapLoad`, or a newer call's when something asked the map again meanwhile (a floor view).
 */
async function mapAnswer(mapLoad) {
  const early = mapView.early;
  let res = early?.load && early.area === state.area && early.key === mapParams().toString() ? await early.load : await mapLoad;
  for (let i = 0; !res && mapView.latest && i < 3; i++) res = await mapView.latest;
  return res;
}

/** The time the lists are for: "now" or the chosen date and time (Study's rooms must match its spaces). */
const listWhen = () => (state.now ? "now" : sharedTime());

/** Study's rooms for the current location and time, or undefined while they're loading (null beyond the stored range). */
const studyRoomsNow = () => (state.studyRooms?.area === state.area && state.studyRooms.when === listWhen() ? state.studyRooms.rooms : undefined);

/** Study's rooms that it lists (free long enough), in every building. */
const studyRoomsListed = () => studyRoomGroups(studyRoomsNow(), STUDY_ROOM_TYPES, STUDY_MIN_FREE).flatMap((g) => g.rooms);

/** Study: its rooms come with the map's answer (/api/map with rooms=1); the list shows them once both are in. */
async function refreshStudyRooms(mapLoad) {
  const area = state.area;
  const when = listWhen();
  const res = await mapAnswer(mapLoad);
  if (state.mode !== "study" || state.area !== area || listWhen() !== when || !res) return;
  // An error leaves the rooms out (the study spaces are the list; the map note says what failed).
  state.studyRooms = { area, when, at: res.data?.at ?? null, rooms: res.error ? [] : res.data.rooms ?? null, parts: res.data?.parts ?? {} };
  if (state.spaces?.area === state.area) renderSpaces();
}

/** Meet: the area's rooms from the map's /api/map answer, or per building from /api/free beyond the stored range. */
async function refreshRooms(mapLoad) {
  if (navigator.onLine === false) {
    clearResults();
    showWarning([]);
    showMessage(OFFLINE_MSG);
    return;
  }
  const id = ++requestId;
  const known = $("#g-long").querySelector(".bgroup") !== null;
  if (!known) showMessage("Loading…");
  const res = await mapAnswer(mapLoad);
  if (id !== requestId || state.mode !== "rooms") return;
  if (!res) return;
  if (res.error) {
    clearResults();
    showWarning([]);
    showMessage(res.error === "offline" ? OFFLINE_MSG : `Could not load rooms: ${res.error}`);
    return;
  }
  if (res.data.rooms) {
    showWarning([]);
    return renderMeet(res.data);
  }
  // Outside the stored range: per building, as before (UZH has nothing that far ahead).
  if (university() === "UZH") {
    clearResults();
    showWarning([]);
    $("#asof").textContent = "";
    showMessage("frooms has UZH's bookings for the coming month only. Check UZH's room calendar for later days.");
    return;
  }
  const buildings = selectedBuildings();
  if (buildings.length === 0) {
    clearResults();
    showWarning([]);
    $("#asof").textContent = "";
    showMessage("Bookings this far ahead are loaded per building. Pick a building.");
    return;
  }
  return refreshPerBuilding(buildings, id);
}

/** /api/free, one request per building (split by room type when it has too many rooms). */
async function refreshPerBuilding(buildings, id) {
  // The area too, so a building code both universities use can't mix their rooms.
  const params = new URLSearchParams({ area: state.area });
  if (state.minSeats) params.set("min_seats", state.minSeats);
  if (!state.now) {
    if (!state.date || !state.time) return;
    params.set("at", sharedTime());
  }
  showMessage("Loading…");
  const responses = await Promise.all(requestPlan(buildings).map(async ({ label, building, types }) => {
    const q = new URLSearchParams(params);
    q.set("buildings", building);
    q.set("types", types.join(","));
    try {
      return { label, data: await getJSON(`/api/free?${q}`) };
    } catch (e) {
      return { label, error: e.message };
    }
  }));
  if (id !== requestId) return;

  const failed = responses.filter((r) => r.error);
  if (failed.length === responses.length) {
    clearResults();
    showWarning([]);
    showMessage(failed[0].error === "offline" ? OFFLINE_MSG : `Could not load rooms: ${failed[0].error}`);
  } else {
    renderMeet(mergeResults(responses));
    showWarning(failed);
  }
}

// --- sorting: starred first, then nearest (lib.js sortPlaces) ---

/**
 * Stars and distances for sortPlaces: distances only while the position is known; in Study and Meet also the starred
 * buildings, whose places come right after the starred ones.
 */
function sortOptions() {
  const starredBuildings = ["study", "rooms"].includes(state.mode) ? starredBuildingSet() : null;
  return { stars: starIds(), distances: placeDistances(), starredBuildings };
}

/** The starred buildings of the current area (and of the Zentrum partner, whose mensas are listed with it). */
const starredBuildingSet = () => starredBuildingsIn(state.stars, [state.area, ZENTRUM_PARTNER[state.area]].filter(Boolean));

/** The ids of the starred places in the current area (and the Zentrum partner's mensas listed with it). */
const starIds = () => new Set(state.stars.filter((s) => s.area === state.area || s.area === ZENTRUM_PARTNER[state.area]).map((s) => s.id));

/** The position moved enough to change the order: sort the list again. */
function distancesChanged() {
  if (state.mode === "rooms") {
    if (mapView.data?.rooms) renderMeet(mapView.data);
  } else if (["study", "mensa"].includes(state.mode) && state.spaces?.area === state.area) renderSpaces();
  if (menuPanel().open && menuView.view === "search") renderMenu(); // "Nearest" and the distances in the meal search
}

// --- study spaces and mensas ---

const inTab = (s) => (state.mode === "mensa" ? s.category === "mensa" && state.kinds.has(s.kind ?? "mensa") : s.category !== "mensa");

const MEAL_NAMES = { lunch: "Lunch", dinner: "Dinner" };

/** The meal time `at` falls in today, or the next one after it, from the place's meal times. */
const mealAt = (s, at) => s.meals_today?.find((m) => m.from <= hhmm(at) && hhmm(at) < m.to) ?? null;
const mealAfter = (s, at) => s.meals_today?.find((m) => m.from > hhmm(at)) ?? null;

/**
 * A space's status as one line with its colour: navy for a study space ("study"), amber while serving food ("food"),
 * brown for an open cafeteria or bar ("cafe", in the Mensas tab), plain text for a mensa between its meals ("plain"),
 * grey when closed. A mensa that is a study space says its next meal in navy ("Dinner at 17:00": the colour says it's
 * a study space until then), or until when it's one ("Study space until 17:30"). In the Eat tab a mensa speaks of its
 * meals instead ("Lunch until 13:30", "Lunch at 11:15", "Closed today"; lib.js eatStatus), with "Study space now,
 * until 11:15" as a second line for the detail view.
 */
function describeSpace(s, at) {
  if (s.category === "mensa" && state.mode === "mensa") return eatStatus(s, at);
  if (!s.open) return [{ text: s.opens_at ? `Closed · opens ${untilLabel(s.opens_at, at)}` : "Closed", cls: "closed" }];
  if (s.meal) {
    const m = mealAt(s, at);
    return [{ text: `${m ? MEAL_NAMES[m.meal] : "Meal time"} until ${hhmm(s.until)}`, cls: "food" }];
  }
  const until = s.card_only ? (s.card_uzh ? "with UZH card" : "with ETH card") : s.until && day(s.until) === day(at) ? `until ${hhmm(s.until)}` : "";
  // A cafeteria or bar is brown in the Mensas tab, even if it's a study space too (Einstein & Zweistein).
  if (s.category === "mensa" && s.kind === "cafe" && state.mode === "mensa") return [{ text: `Open ${until}`.trim(), cls: "cafe" }];
  const next = s.category === "mensa" ? mealAfter(s, at) : null;
  const beforeClosing = next && (!s.until || day(s.until) !== day(at) || next.from < hhmm(s.until));
  // Our own spaces say what they're open for ("Open for SPH projects").
  if (s.category !== "mensa") return [{ text: s.open_text ?? `Open ${until}`.trim(), cls: "study" }];
  if (s.study) return [{ text: beforeClosing ? `${MEAL_NAMES[next.meal]} at ${next.from}` : `Study space ${until}`.trim(), cls: "study" }];
  // Not a study space: a mensa before its meal, or a cafeteria.
  if (beforeClosing && s.kind === "mensa") return [{ text: `${MEAL_NAMES[next.meal]} from ${next.from}`, cls: "plain" }];
  return [{ text: `Open ${until}`.trim(), cls: s.kind === "cafe" ? "cafe" : "plain" }];
}

/**
 * frooms' estimate (ETH's or UZH's sensors) as five navy steps, e.g. "about 60 % full · filling up"; the reports'
 * mannequins beside it when `level` is given (null: none yet), so the two are told apart: navy is the sensor, the
 * coloured figures are people. `prefix` makes it "usually about 60 % full" for a future time.
 */
function occupancyBar(o, tag = "div", { level, prefix = "" } = {}) {
  const steps = Math.round(o.pct / 20);
  const bar = el("span", { class: "occ-bar", "aria-hidden": "true" },
    ...[0, 1, 2, 3, 4].map((i) => el("i", i < steps ? { class: "on" } : {})));
  const trend = o.trend === "filling" ? " · filling up" : o.trend === "emptying" ? " · emptying" : "";
  return el(tag, { class: `occ${prefix ? " usual" : ""}` }, level === undefined ? null : people(level), bar, el("span", {}, prefix + fullText(o.pct) + trend));
}

function spaceDetails(s) {
  const lines = [];
  if (s.notice) lines.push(s.notice);
  if (s.hours.length) lines.push(s.hours.join(" · "));
  return lines;
}

/**
 * A study space's, mensa's or cafeteria's row: name, status in its colour, one meta line, frooms' estimate as a navy
 * bar (for a future time, how full it usually is then), the reports' mannequins (beside the bar when there is one, else
 * beside the status; only for now, `now`) with "Reported about 70 % full (3 reports)" when people sent percentages,
 * and for a mensa its Menu button (unless `menuButton` is false: Study's mensas, whose view has it). A click opens its
 * detail view.
 */
function spaceItem(s, at, from = "list", area = state.area, { menuButton = true, now = state.now } = {}) {
  const status = describeSpace(s, at);
  const cls = status[0].cls;
  // The other Zentrum campus's mensas (listed with this one's) say whose they are.
  const meta = [s.partner ? universityOf(s.area) : null, s.room, s.seats != null ? `${s.seats} seats` : null, s.card24h ? "24 h with ETH card" : null, area === state.area ? distanceOf(s.building) : null].filter(Boolean).join(" · ");
  // Reports are about now and about open places; closed ones just say when they open.
  const live = now && s.open;
  const reports = reportsOf("space", s.id, s.area ?? area, s.reports);
  const level = live ? reportLevel(reports) : null;
  const gauge = s.occupancy ? occupancyBar(s.occupancy, "span", live ? { level } : {})
    : !now && s.usual?.pct != null ? occupancyBar({ pct: s.usual.pct }, "span", { prefix: "usually " }) : null;
  // Mensas get a Menu button, visible when closed too (Tannenbar keeps it while it's a bar); cafeterias don't.
  let menu = null;
  if (s.menu && menuButton) {
    menu = el("button", { class: "menu-btn", type: "button", "aria-haspopup": "dialog", "aria-label": `Menu of ${s.name}` }, icon(MENU_ICON), "Menu");
    menu.addEventListener("click", () => {
      if (area !== state.area) return openPlace({ kind: "space", id: s.id, area }, { opener: menu }).then(() => openMenu(s.id, menu));
      openMenu(s.id, menu);
    });
  }
  const open = el("button", { type: "button", class: "row-open" },
    el("span", { class: "name" }, starMark("space", s.id, area), s.name),
    live && !s.occupancy ? people(level) : null,
    el("span", { class: "status" }, ...status.map((line, i) => el("span", { class: `${i ? "when2" : "when"} ${line.cls}` }, line.text))),
    el("span", { class: "meta" }, meta),
    gauge,
    live && s.occupancy ? reportedLine(reports) : null);
  open.addEventListener("click", () => openPlace({ kind: "space", id: s.id, area }, { from, opener: open }));
  return el("li", { class: `room space ${cls}${menu ? " has-menu" : ""}`, "data-space": s.id, "data-building": s.building }, open, menu);
}

// --- the Eat tab (renderEat): the two buttons, your mensas, the mensas nearest first, the cafeterias, the microwaves ---

// A microwave, for the Eat tab's rows (the map's labels use it too, later).
const MICROWAVE_ICON = "M3 5.5h18v13H3zM6 8.5h9v7H6zM18 9v.5M18 12v.5";

/**
 * The photo on a mensa's card: its own photo when static/mensa-photos/ has one (state.mensaPhotos, from its index.json),
 * else the flagship dish's (/api/meal-image, today's and tomorrow's dishes), else a tile with the mensa's initials in
 * its university's colours. A photo that fails to load becomes the tile.
 */
function mensaPhoto(s, dishImage = s.flagship?.image) {
  const uzh = universityOf(s.area ?? state.area) === "UZH";
  const tile = () => el("span", { class: `mcard-tile ${uzh ? "uzh" : "eth"}`, "aria-hidden": "true" }, placeInitials(s.name));
  const src = state.mensaPhotos.has(s.id) ? `/mensa-photos/${encodeURIComponent(s.id)}.webp` : dishImage != null ? `/api/meal-image/${dishImage}` : null;
  if (!src) return tile();
  const img = el("img", { class: "mcard-photo", src, alt: "", loading: "lazy", width: "96", height: "96" });
  img.addEventListener("error", () => img.replaceWith(tile()));
  return img;
}

/**
 * A mensa's or cafeteria's card in the Eat tab (twice a row's height): the photo left; the name (with its star, and
 * "UZH" or "ETH" for the other Zentrum campus's), the status in meal words (lib.js eatStatus) with the reports'
 * mannequins beside it (now only, `now`), the flagship dish ("Street · Nippon Burger · 11.50", the price for the chosen
 * price group) and the distance right, and for a place with menus a round menu button at the far right (one tap to
 * the menu; the room code isn't shown). Still a `li.room.space`, so stars, clicks and the detail view work as on every
 * row. With a starred food
 * preference the dish is "Your meal" (`yours`: { dish, photo } from loadYourMeals), the mensa's top dish under it, with
 * its photo; a mensa without one keeps its flagship dish.
 */
function mensaCard(s, at, from = "list", area = state.area, { now = state.now, yours = null } = {}) {
  const status = eatStatus(s, at)[0];
  const meta = area === state.area ? distanceOf(s.building) : "";
  const live = now && s.open;
  const reports = reportsOf("space", s.id, s.area ?? area, s.reports);
  const dish = yours?.dish ?? s.flagship;
  let menu = null;
  if (s.menu) {
    menu = el("button", { class: "mcard-menu", type: "button", "aria-haspopup": "dialog", "aria-label": `Menu of ${s.name}`, title: "Menu" }, icon(MENU_ICON));
    menu.addEventListener("click", () => {
      if (area !== state.area) return openPlace({ kind: "space", id: s.id, area }, { opener: menu }).then(() => openMenu(s.id, menu));
      openMenu(s.id, menu);
    });
  }
  const dishPrice = dish ? price(dish.price?.[state.priceGroup]) : "";
  const open = el("button", { type: "button", class: "row-open" },
    yours ? mensaPhoto(s, yours.photo ? yours.dish.image : null) : mensaPhoto(s),
    el("span", { class: "mcard-body" },
      el("span", { class: "name" }, starMark("space", s.id, area), el("span", { class: "mcard-name" }, s.name), s.partner ? el("span", { class: "mcard-uni" }, universityOf(s.area)) : null),
      el("span", { class: "mcard-status" }, live ? people(reportLevel(reports)) : null, el("span", { class: `when ${status.cls}` }, status.text)),
      dish ? el("span", { class: "mcard-dish" }, yours ? el("span", { class: "mcard-yours" }, "Your meal:") : null, dish.line ? el("span", { class: "line" }, dish.line) : null, el("span", { class: "dish-name" }, dish.name), dishPrice ? el("span", { class: "dish-price" }, dishPrice) : null) : null,
      meta ? el("span", { class: "meta" }, meta) : null));
  open.addEventListener("click", () => openPlace({ kind: "space", id: s.id, area }, { from, opener: open }));
  return el("li", { class: `room space mcard ${status.cls}${menu ? " has-menu" : ""}`, "data-space": s.id, "data-building": s.building }, open, menu);
}

/** Fill an Eat group with cards (the Zentrum partner's mensas keep their own area: stars and links use it). */
function fillCards(id, items, at, title = null, meals = null) {
  const group = $(id);
  group.hidden = items.length === 0;
  group.querySelector(".count").textContent = items.length;
  if (title) group.querySelector(".title").textContent = title;
  group.querySelector("ul").replaceChildren(...items.map((s) => mensaCard(s, at, "list", s.partner ? s.area : state.area, { yours: meals?.get(s.id) ?? null })));
}

/**
 * A microwave spot's row: "3 microwaves · Einstein" (with its star), the queue its reports say (now only, `now`), its
 * floor and the distance (`dist`, metres; else the building's own when it's this location's). A click opens the
 * spot's page (places.js renderMicrowaveView).
 */
function microwaveItem(m, from = "list", { now = state.now, dist = null } = {}) {
  const reports = reportsOf("microwave", m.id, m.area, m.reports);
  const level = now ? queueLevel(reports) : null;
  const away = dist != null ? distanceText(dist) : distanceOf(m.building);
  const where = [m.floor ? `Floor ${m.floor}` : null, away].filter(Boolean).join(" · ");
  const open = el("button", { type: "button", class: "row-open" },
    el("span", { class: "name" }, starMark("microwave", m.id, m.area), icon(MICROWAVE_ICON), `${plural(m.count, "microwave", "microwaves")} · ${m.name}`),
    level != null ? el("span", { class: "status" }, el("span", { class: `when queue-${level}` }, level ? `Queue ${QUEUE_NAMES[level]}` : "No queue")) : null,
    where ? el("span", { class: "meta" }, where) : null);
  open.addEventListener("click", () => openPlace({ kind: "microwave", id: m.id, area: m.area }, { from, opener: open }));
  return el("li", { class: "room micro", "data-building": m.building, "data-microwave": m.id }, open);
}

/**
 * The microwaves (/api/spaces' `microwaves`, data/microwaves.json) by building, the nearest building first when the
 * position is known (lib.js microwaveGroups): each row a spot (microwaveItem), opening its own page.
 */
function renderMicrowaves(list, distances) {
  const box = $("#s-micro");
  const groups = microwaveGroups(list, distances);
  box.hidden = groups.length === 0;
  if (!groups.length) return;
  box.querySelector(".title").textContent = distances ? "Microwaves near you" : "Microwaves";
  box.querySelector(".count").textContent = groups.reduce((n, g) => n + g.count, 0);
  box.querySelector(".bgroups").replaceChildren(...groups.map(({ building, count, items }) => {
    const dist = distances?.get(building);
    const head = el("h3", { class: "bhead" }, el("span", {}, buildingLabel(building)), el("span", { class: "muted" },
      ` · ${plural(count, "microwave", "microwaves")}${dist != null ? ` · ${distanceText(dist)}` : ""}`));
    const rows = items.map((m) => microwaveItem(m, "list", { dist }));
    return el("section", { class: "bgroup", "data-building": building }, head, el("ul", {}, ...rows));
  }));
}

/**
 * The Eat tab's list: Compare menus and Find your meal, then your starred mensas and cafeterias, the mensas (nearest
 * first when the position is known, else the location's mensa order; open ones first, closed at the end in the same
 * order), the cafeterias and bars the same way (the server's order without a position), and the microwaves by building. No building filter: the whole location, and in Zentrum both
 * campuses' places.
 */
function renderEat(data, all) {
  const at = data.at;
  const stars = starIds();
  const distances = placeDistances();
  // Without a position, mensas follow the location's order (the Worker's `order`, data/overrides.json mensa_order).
  const sorted = (list, order = null) => sortPlaces(list, { distances, order });
  const openFirst = (list, order = null) => [...sorted(list.filter((s) => s.open), order), ...sorted(list.filter((s) => !s.open), order)];
  const yours = all.filter((s) => stars.has(s.id));
  const rest = all.filter((s) => !stars.has(s.id));
  $("#s-eat").hidden = !data.spaces.some((s) => s.menu);
  const ym = state.yourMeals;
  const meals = ym && state.mealPref && ym.area === state.area && ym.pref === state.mealPref && ym.group === state.priceGroup ? ym.map : null;
  fillCards("#s-your", openFirst(yours, data.order), at, null, meals);
  fillCards("#s-mensa", openFirst(rest.filter((s) => s.kind === "mensa"), data.order), at, distances ? "Mensas near you" : "Mensas", meals);
  fillCards("#s-cafe", openFirst(rest.filter((s) => s.kind !== "mensa")), at, null, meals);
  renderMicrowaves(data.microwaves ?? [], distances);
  // The tutorial's "a mensa card": the first serving now, else the first opening later today (lib.js tourFirstMensa).
  const cards = [...document.querySelectorAll("#s-your li.mcard, #s-mensa li.mcard")];
  const statusOf = (li) => ["food", "plain", "cafe", "closed"].find((c) => li.classList.contains(c)) ?? "";
  markFirstRow("first-mensa", cards[tourFirstMensa(cards.map(statusOf))] ?? null);
  return all.length || !$("#s-micro").hidden;
}

/**
 * "Your meal" for the Eat cards, while a food preference is starred: each listed mensa's top dish under it (lib.js
 * yourMeal) for the meal its card is about (cardMealOf: the current or next one), from the day's menus (/api/menus,
 * cached 10 minutes; at most three days: today's and the next ones with meals). The cards are drawn again only when the
 * dishes changed.
 */
async function loadYourMeals() {
  const data = state.spaces;
  const pref = state.mealPref;
  if (!pref || state.mode !== "mensa" || !data || data.area !== state.area) return;
  const area = state.area;
  const group = state.priceGroup;
  const picks = new Map(data.spaces.filter((s) => s.menu).map((s) => [s.id, cardMealOf(s, data.at)]));
  const dates = [...new Set([...picks.values()].filter(Boolean).map((p) => p.date))].sort().slice(0, 3);
  const days = new Map(await Promise.all(dates.map(async (date) => [date, await loadDay(area, date).catch(() => null)])));
  if (state.spaces !== data || state.mealPref !== pref || state.priceGroup !== group || state.mode !== "mensa") return;
  const map = new Map();
  for (const [id, pick] of picks) {
    const day = pick && days.get(pick.date);
    const place = day?.places.find((p) => p.id === id);
    const dish = place ? yourMeal(place, place.day?.meals.find((m) => m.meal === pick.meal)?.dishes ?? [], pref, group) : null;
    // Photos only for today's and tomorrow's dishes: the Worker serves no others (MEAL_IMAGE_DAYS).
    if (dish) map.set(id, { dish, photo: pick.date >= day.today && pick.date <= addDaysTo(day.today, 1) });
  }
  const sig = JSON.stringify([...map].map(([id, m]) => [id, m.dish.line, m.dish.name, m.photo]));
  const old = state.yourMeals;
  state.yourMeals = { area, pref, group, sig, map };
  if (!old || old.area !== area || old.pref !== pref || old.group !== group || old.sig !== sig) renderSpaces();
}

/** The food preference was starred, replaced or unstarred: the Eat cards and the You tab follow. */
function mealPrefChanged() {
  if (state.mode === "you") renderYou();
  else if (state.mode === "mensa" && state.spaces?.area === state.area) {
    renderSpaces(); // without a preference, or until the new one's dishes are worked out: the flagship dishes
    loadYourMeals();
  }
}

/** A small star before a starred place's name. */
function starMark(kind, id, area = state.area) {
  return isStarred(state.stars, { kind, id, area }) ? el("span", { class: "star-mark", "aria-label": "Starred", title: "Starred" }, "★") : null;
}

/** Star or unstar a place; everything showing stars follows at once. Returns toggleStar's answer. */
function setStar(place) {
  const res = toggleStar(state.stars, place);
  if (res.full) return res;
  state.stars = res.stars;
  savePrefs();
  starsChanged();
  accountStarsChanged(); // signed in: the account's copy follows (account.js)
  return res;
}

function starsChanged() {
  if (state.mode === "rooms") renderBuildings(state.roomBuildingList); // the chips: starred buildings first
  if (state.mode === "rooms" && mapView.data?.rooms && $("#g-long .bgroup")) renderMeet(mapView.data);
  else if (["study", "mensa"].includes(state.mode) && state.spaces?.area === state.area) renderSpaces();
  else if (state.mode === "you") renderYou();
  syncMap();
  syncStarButtons();
}

function fillSpaces(id, items, at, opts) {
  const group = $(id);
  group.hidden = items.length === 0;
  group.querySelector(".count").textContent = items.length;
  // The Zentrum partner's mensas keep their own area: stars and links use it.
  group.querySelector("ul").replaceChildren(...items.map((s) => spaceItem(s, at, "list", s.partner ? s.area : state.area, opts)));
}

/**
 * Study's rooms below the study spaces: computer rooms, seminar rooms, lecture halls free for STUDY_MIN_FREE minutes
 * or more (starred first, then in a starred building, then nearest, then longest free), STUDY_ROOMS_SHOWN each until
 * "All 23 computer rooms". Empty groups are left out (UZH has no computer rooms). Beyond the stored range one line
 * says where they are; while they load, nothing.
 */
function renderStudyRooms(picked) {
  const box = $("#s-rooms");
  const rooms = studyRoomsNow();
  if (rooms === undefined || state.mode !== "study") {
    box.hidden = true;
    return;
  }
  if (rooms === null) {
    box.hidden = false;
    box.replaceChildren(el("div", { class: "group" }, el("h2", {}, "Rooms"), el("p", { class: "muted" }, "Rooms this far ahead are in Meet.")));
    return;
  }
  const at = state.studyRooms.at;
  const opts = sortOptions();
  // A building drawn as part of a picked one (KOH in KOL) comes along: there's no other way to pick it.
  const parts = state.studyRooms.parts ?? {};
  const withParts = new Set([...picked, ...Object.keys(parts).filter((b) => picked.has(parts[b]))]);
  const groups = studyRoomGroups(rooms, STUDY_ROOM_TYPES, STUDY_MIN_FREE, withParts).filter((g) => g.rooms.length);
  box.hidden = groups.length === 0;
  box.replaceChildren(...groups.map(({ typecode, rooms: list }) => {
    const sorted = sortPlaces(list, opts);
    const all = state.studyExpanded.has(typecode) || sorted.length <= STUDY_ROOMS_SHOWN;
    const name = STUDY_ROOM_NAMES[typecode];
    const more = all ? null : el("button", { type: "button", class: "more-btn" }, `All ${sorted.length} ${name.toLowerCase()}`);
    more?.addEventListener("click", () => {
      state.studyExpanded.add(typecode);
      renderStudyRooms(picked);
    });
    return el("div", { class: "group", "data-types": typecode },
      el("h2", {}, `${name} `, el("span", { class: "count" }, String(sorted.length))),
      el("ul", {}, ...(all ? sorted : sorted.slice(0, STUDY_ROOMS_SHOWN)).map((r) => roomItem(r, at, "free"))), more);
  }));
  markFirstRow("first-study-room", box.querySelector("li"));
}

/** Building chips for the current tab: an optional filter, nothing picked shows every building. Eat has none. */
function renderSpaceBuildings(spaces) {
  if (state.mode === "mensa") return syncMap();
  const picked = state.spaceBuildings[state.mode];
  const counts = new Map();
  for (const s of spaces) counts.set(s.building, (counts.get(s.building) ?? 0) + 1);
  // Study's rooms free long enough count with their building's study spaces.
  if (state.mode === "study") for (const r of studyRoomsListed()) counts.set(r.building, (counts.get(r.building) ?? 0) + 1);
  const box = $("#buildings");
  syncMap();
  if (counts.size === 0) {
    box.replaceChildren(el("span", { class: "empty" }, state.mode === "mensa" ? "No mensas here." : "No study spaces here."));
    return;
  }
  const shown = new Set([...picked].filter((b) => counts.has(b)));
  box.replaceChildren(...buildingChips(counts, shown, (code) => {
    if (code == null) picked.clear();
    else picked.has(code) ? picked.delete(code) : picked.add(code);
    savePrefs();
    renderSpaces();
    renderFilterLine();
    renderPickedBar();
  }));
}

// The server sorts: open spaces with an estimate (least full first), open ones without, then closed ones.
function renderSpaces() {
  const data = state.spaces;
  const at = data.at;
  const all = data.spaces.filter(inTab);
  renderSpaceBuildings(all);
  const study = state.mode === "study";
  let anything;
  if (study) {
    // Picked buildings this tab has (study spaces or rooms free long enough).
    const available = new Set(all.map((s) => s.building));
    studyRoomsListed().forEach((r) => available.add(r.building));
    const picked = new Set([...state.spaceBuildings.study].filter((b) => available.has(b)));
    const inPicked = (s) => !picked.size || picked.has(s.building);
    const shown = all.filter(inPicked);
    const open = shown.filter((s) => s.open);
    // Each group: starred first, then in a starred building, then nearest, then the server's order (sortPlaces).
    const sorted = (list) => sortPlaces(list, sortOptions());
    fillSpaces("#s-library", sorted(open.filter((s) => s.category === "library")), at);
    fillSpaces("#s-open", sorted(open.filter((s) => s.category === "open")), at);
    // Mensas that are a study space right now, between their meal times. Their Menu button is left out here (the row
    // says until when they're a study space; the detail view has the menu).
    const mensaStudy = data.spaces.filter((s) => s.category === "mensa" && !s.partner && s.study && s.open && !s.meal && inPicked(s));
    fillSpaces("#s-mensa-study", sorted(mensaStudy), at, { menuButton: false });
    renderStudyRooms(picked);
    fillSpaces("#s-workspace", sorted(open.filter((s) => s.category === "workspace")), at);
    fillSpaces("#s-closed", sorted(shown.filter((s) => !s.open)), at);
    markFirstRow("first-space", $("#s-library:not([hidden]) li, #s-open:not([hidden]) li"));
    for (const id of ["#s-eat", "#s-your", "#s-mensa", "#s-cafe", "#s-micro"]) $(id).hidden = true;
    anything = shown.length || !$("#s-rooms").hidden;
  } else {
    for (const id of ["#s-library", "#s-open", "#s-mensa-study", "#s-rooms", "#s-workspace", "#s-closed"]) $(id).hidden = true;
    anything = renderEat(data, all);
  }

  const source = data.source === "uzh" ? "the UZH library's seat sensors" : "ETH";
  // The Eat tab doesn't show occupancy, so it leaves out where the estimates come from.
  const asof = data.fetched_at && study ? `Occupancy estimates provided by ${source} as of ${hhmm(data.fetched_at)}` : "";
  const when = state.now ? "" : `showing ${weekday(at)} ${day(at)} ${hhmm(at)}`;
  $("#asof").textContent = [asof, when].filter(Boolean).join(" · ");
  showMessage(anything ? null : study ? "No study spaces here." : "No mensas here.");
}

/** One request covers every study space and mensa of the area; the tabs and building chips filter it here. */
async function refreshSpaces() {
  if (navigator.onLine === false) {
    clearResults();
    showWarning([]);
    showMessage(OFFLINE_MSG);
    return;
  }
  const params = new URLSearchParams({ area: state.area });
  if (!state.now) {
    if (!state.date || !state.time) return;
    params.set("at", sharedTime());
  }
  const id = ++requestId;
  if (state.spaces?.area !== state.area) showMessage("Loading…");
  let data;
  try {
    data = await getJSON(`/api/spaces?${params}`);
  } catch (e) {
    if (id !== requestId) return;
    clearResults();
    showWarning([]);
    showMessage(e.message === "offline" ? OFFLINE_MSG : `Could not load study spaces: ${e.message}`);
    return;
  }
  if (id !== requestId || !["study", "mensa"].includes(state.mode)) return;
  state.spaces = { ...data, area: state.area };
  showWarning([]);
  renderSpaces();
  if (mapView.doc) {
    syncMicroLabels(); // the map's microwave labels take the same answer
    scheduleDraw();
  }
  loadYourMeals();
}

// --- the You tab: the starred places, with their status now ---

const you = { data: new Map(), loading: false }; // area -> { spaces, rooms, map } (null where a request failed)

/**
 * Load every area that has a star: /api/spaces for spaces, /api/map with the starred rooms' types for rooms, and for
 * buildings the map's counts (the rooms' answer has them; without starred rooms a plain /api/map).
 */
async function refreshYou() {
  showWarning([]);
  showMessage(null);
  $("#asof").textContent = "";
  renderYou();
  if (!state.stars.length) return;
  const id = ++requestId;
  you.loading = true;
  const loads = [...starsByArea(state.stars)].map(async ([area, list]) => {
    // Microwaves come with the spaces' answer.
    const spaces = list.some((s) => s.kind === "space" || s.kind === "microwave") ? getJSON(`/api/spaces?area=${encodeURIComponent(area)}`).catch(() => null) : null;
    const types = [...new Set(list.filter((s) => s.kind === "room").map((s) => s.typecode).filter(Boolean))];
    const q = new URLSearchParams({ area, rooms: "1" });
    if (types.length) q.set("types", types.join(","));
    const rooms = list.some((s) => s.kind === "room") ? getJSON(`/api/map?${q}`).catch(() => null) : null;
    const map = !list.some((s) => s.kind === "building") ? null : rooms ?? getJSON(`/api/map?area=${encodeURIComponent(area)}`).catch(() => null);
    return [area, { spaces: await spaces, rooms: await rooms, map: await map }];
  });
  const data = new Map(await Promise.all(loads));
  if (id !== requestId || state.mode !== "you") return;
  you.data = data;
  you.loading = false;
  renderYou();
}

// The You tab's groups, in order. A starred space whose category isn't known yet counts as a study space. "Your food
// preference" (the starred preset of Find your meal) sits between the places to study and the places to eat.
const YOU_GROUPS = [
  { title: "Rooms", has: (s) => s.kind === "room" },
  { title: "Libraries", has: (s) => s.kind === "space" && s.category === "library" },
  { title: "Study spaces", has: (s) => s.kind === "space" && !["mensa", "library", "workspace"].includes(s.category) },
  { title: "Workspaces", has: (s) => s.kind === "space" && s.category === "workspace" },
  { title: "Your food preference", pref: true },
  { title: "Mensas & cafeterias", has: (s) => s.kind === "space" && s.category === "mensa" },
  { title: "Microwaves", has: (s) => s.kind === "microwave" },
  { title: "Buildings", has: (s) => s.kind === "building" },
];

/** The starred food preference's row: its name and what it does; a click opens Find your meal with it applied. */
function mealPrefRow(pref) {
  const open = el("button", { type: "button", class: "row-open", "aria-haspopup": "dialog" },
    el("span", { class: "name" }, el("span", { class: "star-mark", "aria-label": "Starred", title: "Starred" }, "★"), mealPrefName(pref)),
    el("span", { class: "meta" }, mealPrefText(pref)));
  open.addEventListener("click", () => openMenu(null, open, null, { view: "search", pref }));
  return el("li", { class: "room pref" }, open);
}

function renderYou() {
  renderYouAccount(); // your check-in and your friends', above the places (checkin.js)
  const box = $("#you-places");
  if (!state.stars.length && !state.mealPref) {
    const go = (mode, text) => {
      const b = el("button", { type: "button", class: "chip" }, text);
      b.addEventListener("click", () => selectMode(mode));
      return b;
    };
    box.replaceChildren(el("div", { class: "you-empty" },
      el("p", {}, "Star a room, study space, mensa or building to keep it here."),
      el("div", { class: "chips" }, go("study", "Study"), go("rooms", "Meet"), go("mensa", "Eat")),
      state.starsSaved ? null : el("p", { class: "muted" }, "This browser doesn't let frooms save anything, so stars last only for this visit.")));
    return;
  }
  const areas = new Set(state.stars.map((s) => s.area));
  const areaName = (a) => state.areas?.areas.find((x) => x.area === a)?.name ?? a;
  // Stars of a space whose category isn't stored yet go by the loaded answer.
  const withCategory = state.stars.map((s) => {
    if (s.kind !== "space" || s.category) return s;
    const live = you.data.get(s.area)?.spaces?.spaces.find((x) => x.id === s.id);
    return live ? { ...s, category: live.category } : s;
  });
  const groups = YOU_GROUPS.map(({ title, has, pref }) => {
    if (pref) return state.mealPref ? el("div", { class: "group" }, el("h2", {}, title), el("ul", {}, mealPrefRow(state.mealPref))) : null;
    const list = withCategory.filter(has);
    if (!list.length) return null;
    const rows = [];
    for (const [area, inArea] of starsByArea(list)) {
      if (areas.size > 1) rows.push(el("li", { class: "you-area muted" }, areaName(area)));
      rows.push(...inArea.map((star) => youRow(star)));
    }
    return el("div", { class: "group" }, el("h2", {}, title, " ", el("span", { class: "count" }, String(list.length))), el("ul", {}, ...rows));
  }).filter(Boolean);
  const note = state.starsSaved ? [] : [el("p", { class: "message" }, "This browser doesn't let frooms save anything, so stars last only for this visit.")];
  box.replaceChildren(...note, ...groups);
}

/** A starred place's row: the list's row with its status now, or its stored name when it's gone or not loaded. */
function youRow(star) {
  const d = you.data.get(star.area);
  if (star.kind === "building") return buildingRow(star, d);
  if (star.kind === "microwave" && d?.spaces) {
    const m = (d.spaces.microwaves ?? []).find((x) => x.id === star.id);
    return m ? microwaveItem(m, "list", { now: true }) : goneRow(star);
  }
  if (star.kind === "space" && d?.spaces) {
    const s = d.spaces.spaces.find((x) => x.id === star.id);
    // The You tab is always now, so the reports show whatever time the other tabs are set to.
    if (s) return spaceItem(s, d.spaces.at, "list", star.area, { now: true });
    return goneRow(star);
  }
  if (star.kind === "room" && d?.rooms) {
    if (d.rooms.rooms === null) return pendingRow(star, "no data");
    const r = d.rooms.rooms.find((x) => x.room === star.id);
    if (r) return roomItem(r, d.rooms.at, roomLook(r), "list", star.area, { now: true });
    // Not in the answer: another type than asked for (an old star), or gone from the catalogue.
    return d.rooms.rooms.length ? goneRow(star) : pendingRow(star, "no data");
  }
  return pendingRow(star, you.loading || !d ? "…" : "couldn't load");
}

/**
 * A starred building's row: its code and full name, its distance, and what's in it now from the map's counts ("2 study
 * spaces open · 5 rooms free 2 h+"); a click opens its detail view.
 */
function buildingRow(star, d) {
  const code = star.id;
  const b = d?.map?.buildings.find((x) => x.building === code);
  const counts = [];
  if (b?.study.total) counts.push(`${b.study.open} study space${b.study.open === 1 ? "" : "s"} open`);
  if (b?.rooms?.total) counts.push(`${b.rooms.free} room${b.rooms.free === 1 ? "" : "s"} free ${durationText(d.map.min_free)}+`);
  const line = d?.map ? counts.join(" · ") || "Nothing open or free now" : you.loading || !d ? "…" : "couldn't load";
  const label = b?.label && b.label !== code ? b.label : null;
  const full = star.name !== code ? star.name : label;
  const dist = star.area === state.area ? distanceOf(code) : null;
  const open = el("button", { type: "button", class: "row-open" },
    el("span", { class: "name" }, starMark("building", code, star.area), code, full ? el("span", { class: "muted" }, ` · ${full}`) : null),
    dist ? el("span", { class: "status" }, el("span", { class: "when closed" }, dist)) : null,
    el("span", { class: "meta" }, line));
  open.addEventListener("click", () => openPlace({ kind: "building", id: code, area: star.area }, { opener: open }));
  const anything = (b?.study.open ?? 0) + (b?.rooms?.free ?? 0) > 0;
  return el("li", { class: `room building${anything ? " open" : ""}`, "data-building": code }, open);
}

function pendingRow(star, text) {
  const li = star.kind === "room"
    ? roomItem({ room: star.id, building: star.building, status: null }, null, "", "list", star.area)
    : spaceItem({ id: star.id, name: star.name, building: star.building, room: "", open: false, hours: [] }, null, "list", star.area);
  li.querySelector(".when, .status")?.replaceChildren(text);
  return li;
}

/** A starred place frooms no longer has: its stored name, "no longer listed", and a way to remove it. */
function goneRow(star) {
  const remove = el("button", { type: "button", class: "chip" }, "Remove");
  remove.addEventListener("click", () => setStar(star));
  return el("li", { class: "room gone" }, el("div", { class: "row-open" },
    el("span", { class: "name" }, el("span", { class: "star-mark" }, "★"), star.name),
    el("span", { class: "when" }, "no longer listed"),
    el("span", { class: "meta" }, remove)));
}

// --- menus ---
//
// One dialog for a mensa's menu (a day, or its week) and for comparing the mensas of a location. Opening it is a
// history entry, like the full map, so Back closes it. The data comes from /api/menu and /api/menus.

const TYPES = ["vegan", "vegetarian", "fish", "meat", "other"];
const TYPE_LABELS = { vegan: "Vegan", vegetarian: "Vegetarian", fish: "Fish", meat: "Meat", other: "Other" };
// The comparison's row labels on phones, where the columns need the room.
const TYPE_SHORT = { vegan: "VG", vegetarian: "VT", fish: "F", meat: "M", other: "O" };
const GROUP_LABELS = { student: "Student", internal: "Internal", external: "External" };
const DIET_LABELS = { all: "All", vegetarian: "Vegetarian", vegan: "Vegan" };
const DIET_TYPES = { all: TYPES, vegetarian: ["vegan", "vegetarian"], vegan: ["vegan"] };
const isMenuEntry = (st) => st?.frooms === "menu" && st.load === PAGE_LOAD;

const menuView = {
  view: "day", // day | week | compare | search
  place: null, // id of the place the panel was opened for (null: the comparison or the meal search from the list)
  back: null, // "search" while a day view was opened from the meal search (its foot leads back)
  slot: null, // { date, meal } shown
  weeks: new Map(), // `${place}|${monday}` -> promise of /api/menu
  days: new Map(), // `${area}|${date}` -> promise of /api/menus
  opener: null, // the button that opened the panel, focused again on close
  requestId: 0,
};

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDaysTo = (date, n) => {
  const d = new Date(date + "T12:00");
  d.setDate(d.getDate() + n);
  return isoDate(d);
};
const mondayOf = (date) => addDaysTo(date, -((new Date(date + "T12:00").getDay() + 6) % 7));
const dayName = (date, opts = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(date + "T12:00").toLocaleDateString("en-GB", opts);
const price = (p) => (p == null ? "" : p.toFixed(2));

/** The app's chosen time (now, or the picked date and time) as a date and "HH:MM". */
function chosenTime() {
  if (!state.now && state.date && state.time) return { date: state.date, time: state.time };
  return nowParts();
}

/**
 * The meal to show first: the first one with a menu that hasn't ended at the chosen time (lunch, then dinner if
 * there is one, then the next day with a menu). Without any, the chosen day's lunch (the panel says why it's empty).
 */
function defaultSlot(slots) {
  const { date, time } = chosenTime();
  const next = slots.find((s) => s.date > date || (s.date === date && s.to > time));
  return next ? { date: next.date, meal: next.meal } : { date, meal: "lunch" };
}

const slotKey = (s) => `${s.date}|${s.meal === "lunch" ? 0 : 1}`;

/**
 * ‹ Wed 4 Nov · Lunch ›: steps one meal at a time through the meals with a menu. Tapping the label opens a popover
 * with this week's and next week's days (weekends only when they have menus) and, when there's dinner, Lunch/Dinner.
 */
function mealStepper(slots, current, onChange) {
  const keys = slots.map(slotKey);
  const here = slotKey(current);
  const prev = [...slots].reverse().find((s) => slotKey(s) < here);
  const next = slots.find((s) => slotKey(s) > here);
  const step = (s, label, text) => {
    const b = el("button", { class: "step", type: "button", "aria-label": label }, text);
    if (s) b.addEventListener("click", () => onChange({ date: s.date, meal: s.meal }));
    else b.disabled = true;
    return b;
  };
  const labelText = `${dayName(current.date)} · ${MEAL_NAMES[current.meal]}`;
  const label = el("button", { class: "step-label", type: "button", "aria-expanded": "false", "aria-haspopup": "true" }, labelText);
  const pop = el("div", { class: "step-pop", hidden: "" });
  label.addEventListener("click", () => {
    pop.hidden = !pop.hidden;
    label.setAttribute("aria-expanded", String(!pop.hidden));
  });

  const today = chosenTime().date;
  const withMenu = (date) => slots.filter((s) => s.date === date);
  for (const monday of [mondayOf(today), addDaysTo(mondayOf(today), 7)]) {
    const row = el("div", { class: "step-days" });
    for (let i = 0; i < 7; i++) {
      const date = addDaysTo(monday, i);
      const has = withMenu(date);
      if (i >= 5 && !has.length) continue;
      const b = el("button", { type: "button", class: "chip" + (date === current.date ? " on" : ""), "aria-pressed": String(date === current.date) },
        dayName(date, { weekday: "short" }), el("small", {}, dayName(date, { day: "numeric" })));
      if (has.length) {
        b.addEventListener("click", () => onChange({ date, meal: has.some((s) => s.meal === current.meal) ? current.meal : has[0].meal }));
      } else b.disabled = true;
      row.append(b);
    }
    pop.append(row);
  }
  const meals = withMenu(current.date);
  if (meals.some((s) => s.meal === "dinner")) {
    pop.append(el("div", { class: "step-days" }, ...["lunch", "dinner"].map((meal) => {
      const on = meal === current.meal;
      const b = el("button", { type: "button", class: "chip" + (on ? " on" : ""), "aria-pressed": String(on) }, MEAL_NAMES[meal]);
      if (meals.some((s) => s.meal === meal)) b.addEventListener("click", () => onChange({ date: current.date, meal }));
      else b.disabled = true;
      return b;
    })));
  }
  if (!keys.length) label.disabled = true;
  return el("div", { class: "stepper" }, step(prev, "Previous meal", "‹"), label, step(next, "Next meal", "›"), pop);
}

/** A small switch of chips (price group, diet). */
function switcher(options, labels, current, onChange, aria) {
  return el("div", { class: "switch", role: "group", "aria-label": aria }, ...options.map((o) =>
    chip(labels[o], o === current, () => onChange(o))));
}

function typeMark(type) {
  return el("span", { class: `type ${type}`, title: TYPE_LABELS[type] }, TYPE_LABELS[type]);
}

/**
 * Allergens behind a tap. In the week view (`withNutrition`) the values per 100 g go in there too, as "Nutrition &
 * Allergens"; the day view keeps them on their own line.
 */
function allergens(dish, withNutrition = null) {
  if (!dish.allergens.length && !withNutrition) return null;
  const title = withNutrition ? (dish.allergens.length ? "Nutrition & Allergens" : "Nutrition") : "Allergens";
  return el("details", { class: "allergens" }, el("summary", {}, title),
    withNutrition ? el("p", { class: "dish-values" }, withNutrition) : null,
    dish.allergens.length ? el("p", {}, withNutrition ? `Allergens: ${dish.allergens.join(", ")}` : dish.allergens.join(", ")) : null);
}

/**
 * A UZH dish's climate rating behind a tap (food2050's, from Eaternity's CO₂ data); null for ETH's dishes, which have
 * none.
 */
function climateImpact(dish) {
  const text = climateText(dish);
  if (!text) return null;
  return el("details", { class: "allergens climate" }, el("summary", {}, "Climate impact"),
    el("p", {}, el("span", { class: `climate-mark ${dish.climate}`, "aria-hidden": "true" }), text),
    el("p", {}, "food2050's rating (low, medium or high) of how much the dish contributes to global warming, from Eaternity's CO₂ data."));
}

/**
 * One dish: its line, name, description, values per 100 g (when the source has them), price, type, allergens, its
 * climate rating (UZH's dishes), and its
 * photo (today's and tomorrow's dishes; a click opens it large in the lightbox). `week`: the week view's row, where the
 * values are inside the expandable "Nutrition & Allergens". `ctx` (ratings.js): where the dish is served, for its
 * rating at the bottom right.
 */
function dishRow(dish, withPhoto, { week = false, ctx = null } = {}) {
  const nutrition = nutritionText(dish);
  const desc = dishDesc(dish.desc);
  const img = withPhoto && dish.image != null
    ? el("img", { class: "photo", src: `/api/meal-image/${dish.image}`, alt: "", loading: "lazy", width: "96", height: "72" })
    : null;
  const photo = img ? el("button", { type: "button", class: "dish-photo", "aria-haspopup": "dialog", "aria-label": `${dish.name}: photo` }, img) : null;
  const row = el("li", { class: `dish rated-dish${photo ? " has-photo" : ""}` });
  img?.addEventListener("error", () => {
    photo.remove();
    row.classList.remove("has-photo");
  });
  photo?.addEventListener("click", () => openPhotoBox(dish, true, photo, ctx));
  row.append(...[photo,
    el("div", { class: "dish-main" },
      el("div", { class: "dish-top" }, el("span", { class: "line" }, dish.line), typeMark(dish.type)),
      el("div", { class: "dish-name" }, dish.name),
      desc ? el("div", { class: "dish-desc" }, desc) : null,
      nutrition && !week ? el("div", { class: "dish-nutrition" }, nutrition) : null,
      allergens(dish, week ? nutrition : null),
      climateImpact(dish)),
    el("div", { class: "dish-price" }, price(dish.price[state.priceGroup])),
    ratingSpot(ctx, dish)].filter(Boolean));
  return row;
}

/** Where a meal's dishes are served, for their ratings (ratings.js). */
const ratingCtx = (place, date, meal, today) => ({ place: place.id, placeName: place.name, facility: place.facility, date, meal, today });

/** Why a meal has no dishes. */
function emptyMeal(day, meal, date) {
  const when = date === chosenTime().date ? "today" : `on ${dayName(date, { weekday: "long" })}`;
  if (!day) return "Menu not published yet";
  if (!day.hours.length && !day.meals.length) return `Closed ${when}`;
  if (!day.meals.some((m) => m.meal === meal)) return `No ${meal} ${when}`;
  return "Menu not published yet";
}

const menuPanel = () => $("#menu-panel");

/** The place as the list knows it (for its status), if it's in the current answer. */
const listedPlace = (id) => state.spaces?.spaces.find((s) => s.id === id) ?? null;

/** The day view's invite for the meal it shows (the icon alone), if that meal has times that day. */
function panelInvite(data, slot) {
  const meal = data.days.find((d) => d.date === slot.date)?.meals.find((m) => m.meal === slot.meal);
  if (!meal) return null;
  return inviteBox(mealInviteControl(data.place, { meal: meal.meal, from: meal.from, to: meal.to, date: slot.date }, chosenAt(), null));
}

/** The panel's title, with an optional action (the meal invite) left of the close button. */
function panelHeader(title, sub, statusLines, action = null) {
  const close = el("button", { class: "panel-close", type: "button", "aria-label": "Close" }, "×");
  close.addEventListener("click", closeMenu);
  return el("div", { class: "panel-head" },
    el("div", { class: "panel-title" },
      el("h2", { id: "menu-title" }, title),
      sub ? el("div", { class: "muted" }, sub) : null,
      statusLines?.length ? el("div", { class: "status" }, ...statusLines.map((l, i) => el("span", { class: `${i ? "when2" : "when"} ${l.cls}` }, l.text))) : null),
    el("div", { class: "panel-actions" }, action, close));
}

/** A week of one place (cached per week). */
function loadWeek(place, monday) {
  const key = `${place}|${monday}`;
  if (!menuView.weeks.has(key)) {
    const p = getJSON(`/api/menu?${new URLSearchParams({ place, from: monday, days: "7" })}`);
    p.catch(() => menuView.weeks.delete(key));
    menuView.weeks.set(key, p);
  }
  return menuView.weeks.get(key);
}

/** Every place of an area on one day (cached). */
function loadDay(area, date) {
  const key = `${area}|${date}`;
  if (!menuView.days.has(key)) {
    const p = getJSON(`/api/menus?${new URLSearchParams({ area, date })}`);
    p.catch(() => menuView.days.delete(key));
    menuView.days.set(key, p);
  }
  return menuView.days.get(key);
}

function showPanelMessage(text) {
  menuPanel().replaceChildren(panelHeader("Menus"), el("p", { class: "panel-msg" }, text));
}

/** Render the panel's current view, after loading what it needs. */
async function renderMenu() {
  const id = ++menuView.requestId;
  const panel = menuPanel();
  panel.classList.toggle("wide", menuView.view !== "day");
  panel.classList.toggle("compare", ["compare", "search"].includes(menuView.view)); // the same fixed size
  panel.classList.toggle("search", menuView.view === "search");
  panel.setAttribute("aria-busy", "true");
  try {
    if (menuView.view === "compare") await renderCompare(id);
    else if (menuView.view === "search") await renderMealSearch(id);
    else await renderPlace(id);
  } catch (e) {
    if (id === menuView.requestId) showPanelMessage(e.message === "offline" ? "You're offline, and this menu isn't saved on this device." : `Could not load the menu: ${e.message}`);
  }
  if (id === menuView.requestId) panel.removeAttribute("aria-busy");
}

/** The day or week view of one place. */
async function renderPlace(id) {
  const place = menuView.place;
  if (!menuView.slot) {
    const first = await loadWeek(place, mondayOf(chosenTime().date));
    menuView.slot = defaultSlot(first.slots);
  }
  const data = await loadWeek(place, mondayOf(menuView.slot.date));
  if (id !== menuView.requestId) return;
  const slot = menuView.slot;
  const listed = listedPlace(place);
  const sub = [data.place.building + (data.place.floor ? ` ${data.place.floor}` : ""), data.place.kind === "cafe" ? "Café" : null].filter(Boolean).join(" · ");
  const status = listed && state.spaces ? describeSpace(listed, state.spaces.at) : null;
  const go = (s) => {
    menuView.slot = s;
    renderMenu();
  };
  const stepper = mealStepper(data.slots, slot, go);
  const groups = switcher(PRICE_GROUPS, GROUP_LABELS, state.priceGroup, (g) => {
    state.priceGroup = g;
    savePrefs();
    renderMenu();
  }, "Prices for");
  const toWeek = el("button", { class: "panel-link", type: "button" }, menuView.view === "week" ? "Day" : "Week");
  toWeek.addEventListener("click", () => {
    menuView.view = menuView.view === "week" ? "day" : "week";
    renderMenu();
  });
  const compare = el("button", { class: "panel-link", type: "button" }, "Compare with other mensas");
  compare.addEventListener("click", () => {
    menuView.view = "compare";
    renderMenu();
  });
  const toSearch = menuView.back === "search" ? el("button", { class: "panel-link", type: "button" }, "Back to Find your meal") : null;
  toSearch?.addEventListener("click", () => {
    Object.assign(menuView, { view: "search", place: null, back: null });
    renderMenu();
  });
  const body = menuView.view === "week" ? weekView(data, slot) : dayView(data, slot);
  menuPanel().replaceChildren(
    panelHeader(data.place.name, sub, status, menuView.view === "day" ? panelInvite(data, slot) : null),
    el("div", { class: "panel-tools" }, menuView.view === "day" ? stepper : weekNav(data, slot, go), groups),
    body,
    el("div", { class: "panel-foot" }, ...[toWeek, compare, toSearch].filter(Boolean)));
  if (menuView.view === "week") syncWeekButtons();
}

function dayView(data, slot) {
  const day = data.days.find((d) => d.date === slot.date) ?? null;
  const meal = day?.meals.find((m) => m.meal === slot.meal);
  const box = el("section", { class: "panel-body" });
  if (meal) box.append(el("p", { class: "meal-time muted" }, `${meal.name || MEAL_NAMES[meal.meal]} ${meal.from}–${meal.to}`));
  if (!meal?.dishes.length) {
    box.append(el("p", { class: "panel-msg" }, emptyMeal(day, slot.meal, slot.date)));
    return box;
  }
  // Photos only for today's and tomorrow's dishes: the Worker serves no others (MEAL_IMAGE_DAYS).
  const photos = slot.date >= data.today && slot.date <= addDaysTo(data.today, 1);
  const ctx = ratingCtx(data.place, slot.date, meal.meal, data.today);
  box.append(el("ul", { class: "dishes" }, ...meal.dishes.map((d) => dishRow(d, photos, { ctx }))));
  return box;
}

/** The week's days to show: Monday to Friday, and the weekend only if it has menus. */
function weekDays(data, monday) {
  return Array.from({ length: 7 }, (_, i) => addDaysTo(monday, i))
    .filter((date, i) => i < 5 || data.days.find((d) => d.date === date)?.meals.some((m) => m.dishes.length));
}

function weekNav(data, slot, go) {
  const monday = mondayOf(slot.date);
  const first = (from, to) => data.slots.find((s) => s.date >= from && s.date <= to);
  const prevWeek = data.slots.filter((s) => s.date < monday).at(-1);
  const nextWeek = first(addDaysTo(monday, 7), addDaysTo(monday, 13));
  const nav = (s, text, label) => {
    const b = el("button", { class: "step", type: "button", "aria-label": label }, text);
    if (s) b.addEventListener("click", () => go({ date: s.date, meal: s.meal }));
    else b.disabled = true;
    return b;
  };
  const days = weekDays(data, monday);
  const buttons = el("div", { class: "week-days", role: "group", "aria-label": "Days" }, ...days.map((date) => {
    const b = el("button", { type: "button", class: "chip", "data-date": date }, dayName(date, { weekday: "short" }));
    b.addEventListener("click", () => $(`#menu-panel .week-col[data-date="${date}"]`)?.scrollIntoView({ inline: "start", block: "nearest", behavior: "smooth" }));
    return b;
  }));
  return el("div", { class: "week-nav" },
    el("div", { class: "stepper" }, nav(prevWeek, "‹", "Previous week"), el("span", { class: "step-label static" }, `Week of ${dayName(monday)}`), nav(nextWeek, "›", "Next week")),
    buttons);
}

function weekView(data, slot) {
  const monday = mondayOf(slot.date);
  const cols = weekDays(data, monday).map((date) => {
    const day = data.days.find((d) => d.date === date) ?? null;
    const col = el("section", { class: "week-col", "data-date": date }, el("h3", {}, dayName(date, { weekday: "long", day: "numeric", month: "short" })));
    for (const meal of ["lunch", "dinner"]) {
      const m = day?.meals.find((x) => x.meal === meal);
      if (meal === "dinner" && !m) continue;
      col.append(el("h4", {}, MEAL_NAMES[meal], m ? el("span", { class: "muted" }, ` ${m.from}–${m.to}`) : null));
      col.append(m?.dishes.length
        ? el("ul", { class: "dishes" }, ...m.dishes.map((d) => dishRow(d, false, { week: true, ctx: ratingCtx(data.place, date, meal, data.today) })))
        : el("p", { class: "panel-msg" }, emptyMeal(day, meal, date)));
    }
    return col;
  });
  const scroller = el("div", { class: "week" }, ...cols);
  scroller.style.setProperty("--days", cols.length); // through the CSSOM: the CSP blocks inline style attributes
  requestAnimationFrame(() => scroller.querySelector(`[data-date="${slot.date}"]`)?.scrollIntoView({ inline: "start", block: "nearest" }));
  return scroller;
}

/** Phones show one day per screen: the day buttons follow the scrolling. */
function syncWeekButtons() {
  const scroller = $("#menu-panel .week");
  if (!scroller || !("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      document.querySelectorAll("#menu-panel .week-days .chip").forEach((b) => {
        const on = b.dataset.date === e.target.dataset.date;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      });
    }
  }, { root: scroller, threshold: 0.6 });
  scroller.querySelectorAll(".week-col").forEach((c) => io.observe(c));
}

/** The ids of the starred places (spaces and places with menus), in the order they were starred. */
const starredSpaceIds = () => state.stars.filter((s) => s.kind === "space").map((s) => s.id);

/**
 * The location's mensas in the chips' order: starred, then nearest, else in the location's order (`order`, the
 * Worker's: data/overrides.json mensa_order; Irchel and Oerlikon have none, so theirs are alphabetical).
 */
function compareMensas(mensas, order) {
  return compareOrder(mensas, { starred: starredSpaceIds(), distances: placeDistances(), order: order ?? [] });
}

/**
 * The mensas to compare, in the order they were picked: the remembered ones (per area), else your starred mensas, one
 * star with Polymensa (or the Obere Mensa), or Polymensa and the Obere Mensa (lib.js compareDefault); the one the panel
 * was opened from goes at the end if it's missing. A newly picked mensa is always added on the right.
 */
function comparePlaces(mensas, order) {
  const byId = new Map(mensas.map((p) => [p.id, p]));
  const picked = (state.compare[state.area] ?? []).filter((id) => byId.has(id));
  if (!picked.length) picked.push(...compareDefault(mensas, { starred: starredSpaceIds(), order: order ?? [] }));
  picked.splice(MAX_COMPARE);
  // The mensa the panel was opened from takes the last column when all are taken.
  if (menuView.place && byId.has(menuView.place) && !picked.includes(menuView.place)) picked.splice(MAX_COMPARE - 1, 1, menuView.place);
  return picked.map((id) => byId.get(id));
}

/** At most this many mensas side by side: more don't fit a phone's width. */
const MAX_COMPARE = 3;

const cheapest = (a, b) => (a.price[state.priceGroup] ?? Infinity) - (b.price[state.priceGroup] ?? Infinity);

async function renderCompare(id) {
  if (!menuView.slot) {
    const first = await loadDay(state.area, chosenTime().date);
    menuView.slot = defaultSlot(first.slots);
  }
  const slot = menuView.slot;
  const data = await loadDay(state.area, slot.date);
  if (id !== menuView.requestId) return;
  const mensas = compareMensas(data.places.filter((p) => p.kind === "mensa"), data.order);
  const shown = comparePlaces(mensas, data.order);
  const shownIds = new Set(shown.map((p) => p.id));
  const toggle = (pid) => {
    // In the order they were picked: a new one goes at the end, on the right.
    const next = shownIds.has(pid) ? shown.map((p) => p.id).filter((x) => x !== pid) : [...shown.map((p) => p.id), pid];
    state.compare[state.area] = next;
    if (!next.length) delete state.compare[state.area];
    savePrefs();
    renderMenu();
  };
  // Starred mensas first, a thin bar, then the rest; without any star on this campus a grey "Star mensas" hint
  // stands where they would be (no link: the stars are on each mensa's view).
  const starredHere = new Set(starredSpaceIds());
  const nStarred = mensas.filter((p) => starredHere.has(p.id)).length;
  const lead = nStarred ? [] : [el("span", { class: "chip compare-hint" }, "Star mensas")];
  const bar = () => el("span", { class: "compare-sep", "aria-hidden": "true" }, "|");
  const placeChips = el("div", { class: "chips compare-places", role: "group", "aria-label": "Mensas" },
    ...lead, ...mensas.flatMap((p, i) => {
      const c = chip(p.name, shownIds.has(p.id), () => toggle(p.id));
      // Full: the others can't be added until one is taken away.
      if (!shownIds.has(p.id) && shown.length >= MAX_COMPARE) {
        c.disabled = true;
        c.title = `Up to ${MAX_COMPARE} mensas: take one away first`;
      }
      // The bar goes before the first mensa that isn't starred (after the hint when nothing is).
      return i === nStarred && i < mensas.length ? [bar(), c] : [c];
    }));
  const go = (s) => {
    menuView.slot = s;
    renderMenu();
  };
  const diet = switcher(DIETS, DIET_LABELS, state.diet, (d) => {
    state.diet = d;
    savePrefs();
    renderMenu();
  }, "Diet");
  const groups = switcher(PRICE_GROUPS, GROUP_LABELS, state.priceGroup, (g) => {
    state.priceGroup = g;
    savePrefs();
    renderMenu();
  }, "Prices for");
  const back = menuView.place ? el("button", { class: "panel-link", type: "button" }, "Back to the menu") : null;
  back?.addEventListener("click", () => {
    menuView.view = "day";
    renderMenu();
  });
  const areaName = state.areas?.areas.find((a) => a.area === state.area)?.name ?? state.area;
  menuPanel().replaceChildren(...[ // replaceChildren would show a null as the text "null"
    panelHeader("Compare menus", areaName),
    el("div", { class: "panel-tools" }, mealStepper(data.slots, slot, go), diet, groups),
    placeChips,
    shown.length >= MAX_COMPARE ? el("p", { class: "panel-note muted compare-limit" }, `Up to ${MAX_COMPARE} mensas at a time. Tap one to take it away.`) : null,
    shown.length ? compareTable(shown, slot, data.today) : el("p", { class: "panel-msg" }, "Pick up to 3 mensas to compare."),
    el("div", { class: "panel-foot" }, back)].filter(Boolean));
}

/** Places as columns, dish types as rows, the cheapest dish first in each cell. */
function compareTable(places, slot, today) {
  const types = DIET_TYPES[state.diet];
  // Photos only for today's and tomorrow's dishes: the Worker serves no others (MEAL_IMAGE_DAYS).
  const photos = !!today && slot.date >= today && slot.date <= addDaysTo(today, 1);
  const head = [el("div", { class: "cmp-corner" }), ...places.map((p) => {
    const meal = p.day?.meals.find((m) => m.meal === slot.meal);
    const none = !meal?.dishes.length;
    const whose = p.area !== state.area ? `${universityOf(p.area)} · ` : "";
    // The name opens the mensa's day view at the chosen meal; its "Compare with other mensas" comes back here.
    const name = el("button", { class: "cmp-name", type: "button", "aria-label": `${p.name}: open its menu` }, p.name);
    name.addEventListener("click", () => {
      Object.assign(menuView, { place: p.id, view: "day", back: null });
      renderMenu();
    });
    return el("div", { class: "cmp-head" }, name, el("span", { class: "muted" }, whose + (none ? "No menu" : `${meal.from}–${meal.to}`)));
  })];
  const rows = types.flatMap((type) => {
    const cells = places.map((p) => (p.day?.meals.find((m) => m.meal === slot.meal)?.dishes ?? []).filter((d) => d.type === type).sort(cheapest));
    // A row without any dish is left out on phones (style.css), where every row costs room.
    const empty = cells.every((dishes) => !dishes.length) ? " empty" : "";
    const mark = el("span", { class: `type ${type}`, title: TYPE_LABELS[type] },
      el("span", { class: "long" }, TYPE_LABELS[type]), el("span", { class: "short", "aria-hidden": "true" }, TYPE_SHORT[type]));
    return [
      el("div", { class: `cmp-type${empty}` }, mark),
      ...cells.map((dishes, i) => el("div", { class: `cmp-cell${empty}` },
        ...dishes.map((d) => compareDish(d, photos, ratingCtx(places[i], slot.date, slot.meal, today))))),
    ];
  });
  // Below the last row: an invite for this meal at each mensa (the icon alone; its menu opens upwards).
  const invites = [el("div", { class: "cmp-type cmp-invite" }), ...places.map((p) => {
    const meal = p.day?.meals.find((m) => m.meal === slot.meal);
    const box = meal ? inviteBox(mealInviteControl(p, { meal: meal.meal, from: meal.from, to: meal.to, date: slot.date }, chosenAt(), null), true) : null;
    return el("div", { class: "cmp-cell cmp-invite" }, box);
  })];
  const grid = el("div", { class: "cmp" }, ...head, ...rows, ...invites);
  markTour(grid.querySelector(".cmp-dish"), "dish");
  grid.style.setProperty("--cols", places.length); // through the CSSOM: the CSP blocks inline style attributes
  return el("div", { class: "cmp-scroll" }, grid);
}

// --- Find your meal: the meal search (the menu panel's "search" view) ---

const SORT_LABELS = { near: "Nearest", price: "Price", protein: "Protein", carbs: "Carbs", kcal: "Calories", climate: "Climate impact" };

// The search's sort and filters, kept while the page is open: the starred food preference's when there is one, else
// Nearest with a position and Price without.
let mealSearch = null;

function searchChoice() {
  if (!mealSearch) {
    const pref = state.mealPref;
    mealSearch = { sort: pref?.sort ?? (placeDistances() ? "near" : "price"), filters: new Set(pref?.filters ?? []), dir: pref?.dir ?? null };
  }
  return mealSearch;
}

/** Star, replace or unstar the food preference (one at a time). */
function setMealPref(pref) {
  state.mealPref = pref;
  savePrefs();
  mealPrefChanged();
}

/**
 * The presets, one row: each a pill with its name (a click applies it) and a star (a click makes it the food
 * preference, or takes it away again). A named preset is a sort without filters; "Your selection" is whatever the sort
 * and filters are now, on whenever they are no named preset, and starred as that preset when they are one. With another
 * selection starred, its name applies the starred one and its star replaces it with the current one.
 */
function presetRow(q, rerender) {
  const filters = cleanMealFilters([...q.filters]);
  const current = presetMatching(q.sort, filters, q.dir);
  const starred = state.mealPref;
  const sameAsStarred = !!starred && starred.sort === q.sort && starred.filters.join() === filters.join() && sortDir(starred.sort, starred.dir) === sortDir(q.sort, q.dir);
  const apply = (pref) => {
    q.sort = pref.sort;
    q.filters = new Set(pref.filters);
    q.dir = pref.dir ?? null;
  };
  const pills = [...Object.keys(MEAL_PRESETS), CUSTOM_PRESET].map((key) => {
    const custom = key === CUSTOM_PRESET;
    const def = presetOf(key);
    const on = current === key;
    const isStar = custom ? starred?.preset === CUSTOM_PRESET && sameAsStarred : starred?.preset === key;
    const label = def?.name ?? "Your selection";
    const name = el("button", { type: "button", class: "preset-name", "aria-pressed": String(on) }, label);
    name.addEventListener("click", () => {
      if (!custom) apply(def);
      else if (starred?.preset === CUSTOM_PRESET) apply(starred);
      rerender();
    });
    const star = el("button", { type: "button", class: "preset-star", "aria-pressed": String(isStar),
      "aria-label": isStar ? `${label}: no longer your food preference` : `${label}: make it your food preference`,
      title: isStar ? "Your food preference" : "Make it your food preference" }, isStar ? "★" : "☆");
    star.addEventListener("click", () => {
      if (isStar) setMealPref(null);
      else if (!custom) {
        apply(def);
        setMealPref(cleanMealPref({ preset: key }));
      } else setMealPref(cleanMealPref({ preset: current, sort: q.sort, filters, dir: q.dir }));
      rerender();
    });
    return el("span", { class: `preset${on ? " on" : ""}${isStar ? " starred" : ""}` }, name, star);
  });
  return markTour(el("div", { class: "chips presets", role: "group", "aria-label": "Presets" }, ...pills), "meal-presets");
}

/**
 * One result: the photo (a click opens the lightbox), the type mark and line, the name, the values, the mensa, the price.
 * The first three (`rank` 1 to 3) are larger, with their place in front.
 */
function mealRow(dish, sort, photos, distances, rank = 0, today = null) {
  const p = dish.place;
  const img = photos && dish.image != null ? el("img", { src: `/api/meal-image/${dish.image}`, alt: "", loading: "lazy", width: rank ? "96" : "72", height: rank ? "72" : "54" }) : null;
  const thumb = img ? el("button", { type: "button", class: "meal-photo", "aria-haspopup": "dialog", "aria-label": `${dish.name}: photo` }, img) : null;
  img?.addEventListener("error", () => thumb.remove());
  const name = el("button", { type: "button", class: "meal-name dish-name", "aria-haspopup": "dialog" }, dish.name);
  for (const b of [thumb, name]) b?.addEventListener("click", () => openPhotoBox(dish, photos, b, ratingCtx(p, menuView.slot.date, menuView.slot.meal, today)));
  const dist = distances?.get(p.building);
  const where = [p.area !== state.area ? universityOf(p.area) : null, dist != null ? distanceText(dist) : null].filter(Boolean).join(" · ");
  const place = el("button", { type: "button", class: "meal-place", "aria-label": `${p.name}: open its menu` }, p.name);
  place.addEventListener("click", () => {
    Object.assign(menuView, { place: p.id, view: "day", back: "search" });
    countUse("menu_open");
    renderMenu();
  });
  const values = nutritionText(dish, sort);
  return el("li", { class: `dish meal-row${rank ? ` top top-${rank}` : ""}` },
    rank ? el("span", { class: "meal-rank", "aria-label": `Number ${rank}` }, `${rank}.`) : null,
    thumb,
    el("div", { class: "dish-main" },
      el("div", { class: "dish-top" }, typeMark(dish.type), el("span", { class: "line" }, dish.line)),
      name,
      el("div", { class: "meal-where" }, place, where ? el("span", { class: "muted" }, ` · ${where}`) : null),
      values ? el("div", { class: "meal-values" }, values) : null),
    el("div", { class: "dish-price" }, price(dish.price[state.priceGroup])));
}

/**
 * Find your meal: the dishes of every place of the location (in Zentrum both campuses') for one meal, filtered and
 * sorted (lib.js rankDishes). The same window and size as the comparison, the same meal stepper; below it the sort
 * chips, the filter chips and the presets, then the results. Dishes without a value for the sort come last, under a
 * thin line.
 */
async function renderMealSearch(id) {
  if (!menuView.slot) {
    const first = await loadDay(state.area, chosenTime().date);
    menuView.slot = defaultSlot(first.slots);
  }
  const slot = menuView.slot;
  const data = await loadDay(state.area, slot.date);
  if (id !== menuView.requestId) return;
  const distances = placeDistances();
  const q = searchChoice();
  const rerender = () => renderMenu();
  const go = (s) => {
    menuView.slot = s;
    renderMenu();
  };
  const groups = switcher(PRICE_GROUPS, GROUP_LABELS, state.priceGroup, (g) => {
    state.priceGroup = g;
    savePrefs();
    renderMenu();
  }, "Prices for");
  // A sort that's on turns around when tapped again; its arrow says which way it goes (up: lowest first, down: highest).
  const sorts = el("div", { class: "chips", role: "group", "aria-label": "Sort by" }, ...MEAL_SORTS.map((key) => {
    const on = q.sort === key;
    const dir = sortDir(key, q.dir);
    const c = chip(key === "near" && !distances ? "Nearest (allow location)" : SORT_LABELS[key], on, () => {
      if (on && dir) q.dir = dir === "asc" ? "desc" : "asc";
      else {
        q.sort = key;
        q.dir = null;
      }
      // Without a position, Nearest asks for it; the results are sorted again when it arrives (distancesChanged).
      if (key === "near" && !distances && mapView.locate === "off") locateTapped();
      rerender();
    });
    if (on && dir) {
      const up = dir === "asc";
      c.append(el("span", { class: `sort-dir${up ? " up" : ""}`, "aria-hidden": "true" }, up ? "↑" : "↓"));
      c.setAttribute("aria-label", `${SORT_LABELS[key]}: ${dir === "asc" ? "lowest" : "highest"} first, tap to turn around`);
    }
    return c;
  }));
  const filters = el("div", { class: "chips", role: "group", "aria-label": "Filter" }, ...MEAL_FILTERS.map((key) =>
    chip(MEAL_FILTER_LABELS[key], q.filters.has(key), () => {
      q.filters.has(key) ? q.filters.delete(key) : q.filters.add(key);
      rerender();
    })));
  const row = (label, chips) => el("div", { class: "search-row" }, el("span", { class: "label" }, label), chips);

  const dishes = data.places.flatMap((p) => (p.day?.meals.find((m) => m.meal === slot.meal)?.dishes ?? []).map((d) => ({ ...d, place: p })));
  const { ranked, rest } = rankDishes(dishes, { sort: q.sort, filters: [...q.filters], distances, priceGroup: state.priceGroup, dir: q.dir });
  // Photos only for today's and tomorrow's dishes: the Worker serves no others (MEAL_IMAGE_DAYS).
  const photos = !!data.today && slot.date >= data.today && slot.date <= addDaysTo(data.today, 1);
  const item = (d, i = -1) => mealRow(d, q.sort, photos, distances, i >= 0 && i < 3 ? i + 1 : 0, data.today);
  const restLine = rest.length ? el("li", { class: "meal-rest" }, q.sort === "price" ? "No price" : q.sort === "climate" ? "No climate rating" : "No nutrition data") : null;
  const when = `${dayName(slot.date, { weekday: "long" })}'s ${slot.meal}`;
  const results = ranked.length || rest.length
    ? el("ul", { class: "dishes meal-results" }, ...[...ranked.map((d, i) => item(d, i)), restLine, ...rest.map((d) => item(d))].filter(Boolean))
    : el("p", { class: "panel-msg" }, dishes.length ? "No dish matches these filters." : `No menus for ${when} yet.`);
  const allergenNote = q.filters.has("glutenfree") || q.filters.has("lactosefree")
    ? el("p", { class: "panel-note muted" }, "Gluten-free and lactose-free go by the allergens the mensas list. Ask at the counter if it matters.") : null;
  const areaName = state.areas?.areas.find((a) => a.area === state.area)?.name ?? state.area;
  const scroll = menuPanel().querySelector(".meal-scroll")?.scrollTop ?? 0;
  const body = el("div", { class: "meal-scroll" }, ...[
    el("div", { class: "search-tools" }, row("Sort", sorts), row("Filter", filters), row("Presets", presetRow(q, rerender))),
    allergenNote,
    results].filter(Boolean));
  menuPanel().replaceChildren(
    panelHeader("Find your meal", areaName),
    el("div", { class: "panel-tools" }, mealStepper(data.slots, slot, go), groups),
    body);
  body.scrollTop = scroll;
}

/** A dish in the comparison: its line, then the name with the price right after it. A click opens its photo. */
function compareDish(dish, withPhoto, ctx = null) {
  const b = el("button", { class: "cmp-dish", type: "button", "aria-haspopup": "dialog" },
    el("span", { class: "line" }, dish.line),
    el("span", { class: "cmp-dish-text" }, el("span", { class: "dish-name" }, dish.name), " ", el("span", { class: "dish-price" }, price(dish.price[state.priceGroup]))));
  b.addEventListener("click", () => openPhotoBox(dish, withPhoto, b, ctx));
  return b;
}

/**
 * The dish's lightbox, over the comparison: the photo (today's and tomorrow's dishes) at up to 90 % of the viewport,
 * the name, the description, the values per 100 g (when there are any) and the allergens, and with `ctx` its rating
 * (ratings.js); ✕, a click on the backdrop or Escape closes it, and the focus goes back to the dish.
 */
function openPhotoBox(dish, withPhoto, opener, ctx = null) {
  const box = $("#photo-box");
  const desc = dishDesc(dish.desc);
  const close = el("button", { class: "photo-close", type: "button", "aria-label": "Close" }, "×");
  close.addEventListener("click", () => box.close());
  const photo = withPhoto && dish.image != null ? el("img", { class: "photo-big", src: `/api/meal-image/${dish.image}`, alt: "" }) : null;
  photo?.addEventListener("error", () => photo.remove());
  box.replaceChildren(...[close, photo].filter(Boolean),
    el("div", { class: "photo-text" },
      el("span", { class: "line" }, dish.line),
      el("h3", { id: "photo-title" }, dish.name, " ", el("span", { class: "dish-price" }, price(dish.price[state.priceGroup]))),
      desc ? el("p", {}, desc) : null,
      nutritionText(dish) ? el("p", { class: "muted photo-nutrition" }, nutritionText(dish)) : null,
      dish.allergens.length ? el("p", { class: "muted" }, `Allergens: ${dish.allergens.join(", ")}`) : null,
      ratingSpot(ctx, dish, { big: true })));
  box.classList.toggle("text-only", !photo);
  photoOpener = opener;
  box.showModal();
  close.focus();
}

let photoOpener = null;

function initPhotoBox() {
  const box = $("#photo-box");
  box.addEventListener("click", (e) => {
    if (e.target === box) box.close();
  });
  box.addEventListener("close", () => {
    photoOpener?.focus();
    photoOpener = null;
  });
}

/**
 * Open the panel for a place's menu, or (place null) the comparison of the current location's mensas or, with `view`
 * "search", the meal search (with `pref`, a food preference, applied), at `slot` ({ date, meal }) or the next meal.
 */
function openMenu(place, opener, slot = null, { view = null, pref = null } = {}) {
  const panel = menuPanel();
  menuView.place = place;
  menuView.view = place ? "day" : view === "search" ? "search" : "compare";
  menuView.back = null;
  menuView.slot = slot;
  menuView.opener = opener ?? null;
  if (pref) mealSearch = { sort: pref.sort, filters: new Set(pref.filters), dir: pref.dir ?? null };
  if (menuView.view === "day") countUse("menu_open");
  else if (menuView.view === "search") countUse("meal_search");
  closeInviteMenus();
  showPanelMessage("Loading…");
  if (!panel.open) {
    panel.showModal();
    history.pushState({ frooms: "menu", load: PAGE_LOAD }, "");
  }
  renderMenu();
}

/** Close the panel; with its history entry on top, through Back, so the entry goes too. */
function closeMenu() {
  if (!menuPanel().open) return;
  if (isMenuEntry(history.state)) history.back(); // popstate closes it
  else menuPanel().close();
}

function initMenu() {
  const panel = menuPanel();
  initPhotoBox();
  // A click on the backdrop lands on the dialog itself.
  panel.addEventListener("click", (e) => {
    if (e.target === panel) closeMenu();
  });
  // Escape: close through history too.
  panel.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeMenu();
  });
  panel.addEventListener("close", () => {
    // Closed without going through closeMenu (the browser closes it on a repeated Escape): drop its history entry too.
    if (isMenuEntry(history.state)) history.back();
    if ($("#photo-box").open) $("#photo-box").close(); // Back with the lightbox open closes both
    if ($("#meal-rating").open) $("#meal-rating").close();
    menuView.requestId++;
    clearMealRatings(); // fetched once per open panel
    menuView.opener?.focus();
    menuView.opener = null;
    loadYourMeals(); // the price group may have changed in the panel: "Your meal" on the cards follows
  });
  window.addEventListener("popstate", () => {
    if (panel.open && !isMenuEntry(history.state)) panel.close();
  });
  // Reloaded with the panel open: this entry is a plain list entry now.
  if (history.state?.frooms === "menu") history.replaceState(null, "");
  $("#compare-btn").addEventListener("click", (e) => openMenu(null, e.currentTarget));
  $("#meal-search-btn").addEventListener("click", (e) => openMenu(null, e.currentTarget, null, { view: "search" }));
  // Menus change during the day; ask again after a while.
  setInterval(() => {
    menuView.weeks.clear();
    menuView.days.clear();
  }, 10 * 60 * 1000);
  initRatings();
}

// --- feedback ---

/** What the sender had open, stored with their feedback. */
function feedbackContext() {
  const ctx = { mode: state.mode, area: state.area, buildings: pickedBuildings(), screen: `${innerWidth}x${innerHeight}` };
  if (state.mode === "rooms") {
    ctx.types = [...(state.types ?? [])];
    if (state.minSeats) ctx.minSeats = state.minSeats;
  }
  if (!state.now) ctx.at = sharedTime();
  const p = placesView.current;
  if (p && !AREALESS.has(p.kind)) ctx.open = `${p.kind}:${p.id}`;
  return ctx;
}

/**
 * What "Report a bug" picked (bugs.js describeBugElement, or null when skipped) while the dialog is in its bug mode;
 * undefined otherwise.
 */
let feedbackBug;

/**
 * The feedback dialog; "Report a problem" on a place picks "Wrong room info" and names the place. `opts.bug` ("Report a
 * bug", bugs.js): the bug mode, with the picked element (null: skipped), no categories and the reward line.
 */
function openFeedback(category = null, about = null, opts = {}) {
  const dialog = $("#feedback");
  const form = $("#feedback-form");
  const bugMode = opts.bug !== undefined;
  feedbackBug = bugMode ? opts.bug : undefined;
  $("#feedback-title").textContent = bugMode ? "Report a bug" : "Send feedback";
  form.querySelector(".feedback-cats").hidden = bugMode;
  const bugBox = form.querySelector(".feedback-bug");
  bugBox.hidden = !bugMode;
  if (bugMode) {
    bugBox.querySelector(".feedback-bug-what").textContent = bugElementLine(opts.bug);
    const reward = bugBox.querySelector(".feedback-bug-reward");
    if (accountReady()) {
      reward.textContent = `+${CRED_POINTS.bug} street cred once we've checked your report.`;
    } else {
      const signIn = el("button", { type: "button", class: "link-btn" }, "Sign in");
      signIn.addEventListener("click", () => {
        dialog.close();
        openAccountView("signin", $("#account"));
      });
      reward.replaceChildren(signIn, ` to earn ${CRED_POINTS.bug} street cred for bug reports. You can send it without, too.`);
    }
  }
  form.hidden = false;
  dialog.querySelector(".feedback-done").hidden = true;
  const error = dialog.querySelector(".feedback-error");
  error.textContent = "";
  error.hidden = true;
  // "Report a person" (a friend's row in Friends) is offered only while signed in.
  $("#feedback-person").hidden = !(typeof accountReady === "function" && accountReady()) && category !== "person";
  if (category) form.querySelector(`input[name=category][value="${category}"]`).checked = true;
  form.elements.message.placeholder = bugMode ? "What's wrong, and what did you expect instead?"
    : category === "person" ? `What happened with ${about}? frooms gets their username with your report.`
    : about ? `What's wrong with ${about}? For example: shown as free, but it was locked.` : "What happened, or what would you like to see?";
  if (category === "person" && about && !form.elements.message.value.includes(`@${about}`)) form.elements.message.value = `About @${about}: `;
  dialog.showModal();
}

function initFeedback() {
  const dialog = $("#feedback");
  const form = $("#feedback-form");
  const error = dialog.querySelector(".feedback-error");
  const done = dialog.querySelector(".feedback-done");
  const send = form.querySelector(".feedback-send");
  const showError = (text) => {
    error.textContent = text;
    error.hidden = !text;
  };

  $("#feedback-open").addEventListener("click", () => openFeedback());
  // "Pick again": back to the picker; the text written so far stays.
  form.querySelector(".feedback-bug-again").addEventListener("click", () => {
    dialog.close();
    startBugReport();
  });
  dialog.querySelectorAll(".feedback-close").forEach((b) => b.addEventListener("click", () => dialog.close()));
  // A click on the dialog element itself (not its contents) is a click on the backdrop beside it.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    if (!data.get("category")) return showError("Pick what it's about.");
    if (!String(data.get("message")).trim()) return showError("Please write a few words.");
    if (!form.elements.email.checkValidity()) return showError("That email address doesn't look right.");
    // The tutorial sends nothing (plans/PLAN_TUTORIAL.md, section 6); the text stays for after it.
    if (tourActive()) return showError(`${TOUR_NOT_SENT} Exit the tutorial to send your feedback.`);
    showError("");
    send.disabled = true;
    send.textContent = "Sending…";
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: data.get("category"),
          message: data.get("message"),
          email: data.get("email"),
          website: data.get("website"),
          context: feedbackBug ? { ...feedbackContext(), picked: feedbackBug } : feedbackContext(),
          ...(feedbackBug !== undefined ? { bug: true } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || `The server answered ${res.status}`);
      form.reset();
      form.hidden = true;
      done.querySelector(".feedback-done-text").replaceChildren(...(body.bug === "pending"
        ? [el("strong", {}, "Reward pending."), ` Thanks! Once we've checked your report, ${CRED_POINTS.bug} street cred land on your account. You'll see it under Street cred.`]
        : [el("strong", {}, "Thanks!"), " Your feedback is in."]));
      done.hidden = false;
      done.querySelector("button").focus();
      credEarned(body.cred);
    } catch (err) {
      showError(navigator.onLine ? `${err.message}.` : "You're offline. Your text is still here, try again once you're back online.");
    } finally {
      send.disabled = false;
      send.textContent = "Send";
    }
  });
}

// --- init ---

// --- usage counters (plans/PLAN_ADMIN_STATS.md, 5.5): daily totals, no identifier, one beacon when the page is hidden ---

const STATS_STORE = "frooms.stats";
const STATS_INSTALL = "frooms.stats.install"; // the local date the installed app was last counted (never sent)
const STATS_GAP_MS = 60_000;
let statsMemory = { c: {} }; // when local storage fails
let statsSentAt = 0;

function readStats() {
  try {
    return cleanStats(JSON.parse(localStorage.getItem(STATS_STORE) ?? "null"));
  } catch {
    return cleanStats(statsMemory);
  }
}

function writeStats(stored) {
  statsMemory = stored;
  try {
    localStorage.setItem(STATS_STORE, JSON.stringify(stored));
  } catch { /* kept in memory */ }
}

/**
 * One more of `key` (lib.js STATS_KEYS), sent with the next beacon. While the tutorial runs only its own counters
 * count: the tabs it switches and the places it opens aren't the person's use.
 */
function countUse(key) {
  if (tourActive() && !key.startsWith("tutorial_")) return;
  writeStats(addStat(readStats(), key));
}

/** The beacon: when the page is hidden, at most once a minute, only when something was counted. */
function sendStats() {
  const body = statsBody(readStats());
  if (!body || Date.now() - statsSentAt < STATS_GAP_MS || !navigator.sendBeacon) return;
  if (navigator.sendBeacon("/api/stats", new Blob([body], { type: "text/plain" }))) {
    statsSentAt = Date.now();
    writeStats({ c: {} });
  }
}

function initStats() {
  countUse("load");
  if (matchMedia("(display-mode: standalone)").matches || navigator.standalone === true) {
    try {
      const today = isoDate(new Date());
      if (localStorage.getItem(STATS_INSTALL) !== today) {
        localStorage.setItem(STATS_INSTALL, today);
        countUse("install");
      }
    } catch { /* not counted without storage: it would count every load */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") sendStats();
  });
  window.addEventListener("pagehide", sendStats);
}

/** The tabs' counter keys (selectMode's modes). */
const TAB_STATS = { study: "tab_study", rooms: "tab_meet", mensa: "tab_eat", you: "tab_you" };

async function init() {
  initStats();
  loadPrefs();
  sheet.init();
  renderModes();
  initMap();
  initMenu();
  initFeedback();
  initCampusMenu();
  initPlaces();
  initAccount();
  initFriends();
  initCred();
  initCheckin();
  initFriendsMap();
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => {
    if (placesView.current) {
      // A tab closes the detail view (its entry goes, so Back doesn't bring it back).
      history.replaceState(null, "", "/");
      closePlace();
    }
    if (b.dataset.mode !== state.mode && TAB_STATS[b.dataset.mode]) countUse(TAB_STATS[b.dataset.mode]);
    selectMode(b.dataset.mode);
  }));
  // Arrow keys move between the tabs (role=tablist).
  $("#tabs").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const tabs = [...document.querySelectorAll("#tabs button")];
    const i = tabs.indexOf(document.activeElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  });
  $("#filter-line").addEventListener("click", () => ($("#sheet-filters").hidden ? openFilters() : closeFilters()));
  $("#filters-done").addEventListener("click", closeFilters);
  // The You tab's footer: About and Contact open as views (account.js), as from the account menu.
  $("#about-open").addEventListener("click", (e) => openAccountView("about", e.currentTarget));
  $("#tutorial-open").addEventListener("click", () => tourLoad());
  $("#contact-open").addEventListener("click", (e) => openAccountView("contact", e.currentTarget));
  try {
    const [areas, dates] = await Promise.all([getJSON("/api/areas"), getJSON("/api/dates")]);
    state.areas = areas;
    if (!areas.areas.some((a) => a.area === state.area)) state.area = areas.default;
    renderAreas();
    renderMapAreas();
    state.dates = dates;
  } catch (e) {
    showMessage(e.message === "offline" ? OFFLINE_MSG : `Could not reach the app server: ${e.message}`);
    window.addEventListener("online", () => location.reload(), { once: true });
    return;
  }

  $("#min-seats").value = state.minSeats;
  $("#min-seats").addEventListener("change", (e) => {
    state.minSeats = e.target.value;
    savePrefs();
    renderTypes();
    refresh();
  });
  // Now off by its chip: the current time stays as the chosen one until the pickers change it.
  $("#now-toggle").addEventListener("click", () => setNow(!state.now));
  $("#date-btn").addEventListener("click", (e) => openPicker("date", e.detail === 0));
  $("#time-btn").addEventListener("click", (e) => openPicker("time", e.detail === 0));
  watchOutsidePress();
  document.addEventListener("click", closeInviteMenus);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeInviteMenus());
  window.addEventListener("online", refresh);
  window.addEventListener("offline", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.now) refresh();
  });
  if (state.sharedAt) {
    state.date = state.sharedAt.slice(0, 10);
    state.time = state.sharedAt.slice(11, 16);
    setNow(false, false);
  } else {
    setNow(true, false);
  }
  getJSON("/og/backgrounds.json").then((d) => {
    shareBackgrounds = { count: d.count || 1, uzh: d.uzh ?? [] };
    mealBackgrounds = { count: d.meals || 1, uzh: d.uzh_meals ?? [] };
  }).catch(() => { /* keep the defaults */ });
  // Which mensas have a photo of their own (static/mensa-photos/index.json, made by scripts/make_mensa_photos.py).
  getJSON("/mensa-photos/index.json").then((ids) => {
    state.mensaPhotos = new Set(Array.isArray(ids) ? ids : []);
    if (state.mode === "mensa" && state.spaces?.area === state.area) renderSpaces();
  }).catch(() => { /* the cards show the dishes' photos or the tiles */ });
  try {
    await loadArea();
  } catch (e) {
    showMessage(`Could not load rooms: ${e.message}`);
  }
  await openPendingPlace();
  tourFromUrl();
  showTourOffer();
  startAccount(); // after the first list: a visitor without an account waits for nothing
}

// --- the tutorial (static/tutorial.js, plans/PLAN_TUTORIAL.md): loaded only when it starts ---

/** What the guarded actions say instead of sending while the tutorial runs (sendReport, feedback, invites, accountFetch). */
const TOUR_NOT_SENT = "In the tutorial nothing is sent.";
/** Set by tutorial.js while the tour runs; the sending points ask tourActive() at click time. */
let tourRunning = false;
const tourActive = () => tourRunning;
let tourScript = null; // the loading of tutorial.js, once

/**
 * Start the tutorial: `opts` { journey, step } (lib.js parseTourParam's shape), nothing for the welcome screen.
 * tutorial.js is added to the page the first time (like map.js's edit.js) and its tourStart() called.
 */
function tourLoad(opts = {}) {
  dropTourOffer(); // started: the first-visit window has done its job
  tourScript ??= new Promise((resolve, reject) => {
    const s = el("script", { src: "/tutorial.js" });
    s.addEventListener("load", resolve);
    s.addEventListener("error", reject);
    document.head.append(s);
  });
  return tourScript.then(() => tourStart(opts), () => {
    tourScript = null;
    showNotice(navigator.onLine === false ? "The tutorial needs a connection the first time." : "The tutorial couldn't load. Please try again.");
  });
}

/** ?tutorial, ?tutorial=food and &step=3 (posters, QR codes, the sign-in's way back): started once, then taken out of the address. */
function tourFromUrl() {
  const asked = parseTourParam(location.search);
  if (!asked) return;
  const q = new URLSearchParams(location.search);
  q.delete("tutorial");
  q.delete("step");
  history.replaceState(history.state, "", `${location.pathname}${q.size ? `?${q}` : ""}${location.hash}`);
  tourLoad(asked);
}

/**
 * The first-visit window in the middle of the screen (plans/PLAN_TUTORIAL.md, section 5), on a plain first load in this
 * browser (state.tourOffer): "Take the tour" on the left, "Skip" on the right as the main button. Skip (also Escape or
 * a click beside the window) opens the account menu with its Tutorial ringed and "Find it here any time" beside it
 * (tourOfferPoint). Either way, or the tour started elsewhere, it never shows again (`seenOffer` in the tour's stored
 * progress).
 */
function showTourOffer() {
  const dialog = $("#tour-offer");
  if (!state.tourOffer || tourRunning || !dialog || dialog.open) return;
  const take = el("button", { type: "button", class: "confirm-no" }, "Take the tour");
  const skip = el("button", { type: "button", class: "confirm-yes" }, "Skip");
  take.addEventListener("click", () => {
    dialog.close("tour");
    tourLoad();
  });
  skip.addEventListener("click", () => dialog.close("skip"));
  dialog.onclick = (e) => {
    if (e.target === dialog) dialog.close("skip");
  };
  dialog.addEventListener("close", () => {
    const skipped = dialog.returnValue !== "tour";
    dropTourOffer();
    if (skipped) tourOfferPoint();
  }, { once: true });
  fill(dialog, el("div", { class: "confirm-form" },
    el("h2", { id: "tour-offer-title" }, "New to ", wordmarkText(), "?"),
    el("div", { class: "confirm-buttons tour-offer-buttons" }, take, skip)));
  dialog.returnValue = "";
  dialog.showModal();
  skip.focus();
}

/**
 * After Skip: the account menu open, a fog around it, the blue ring on its Tutorial and "Find it here any time" beside
 * it (the tutorial's look, drawn here since tutorial.js isn't loaded). The next click or key anywhere closes all of it.
 */
function tourOfferPoint() {
  const target = () => document.querySelector('#account-menu [data-tour="menu-tutorial"]');
  openAccountMenu({ focus: false });
  if (!target()) return closeAccountMenu();
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("class", "tour-fog");
  svg.setAttribute("aria-hidden", "true");
  const fog = document.createElementNS(svgNs, "path");
  fog.setAttribute("fill-rule", "evenodd");
  fog.setAttribute("class", "tour-shade");
  const ring = document.createElementNS(svgNs, "rect");
  ring.setAttribute("class", "tour-ring");
  ring.setAttribute("rx", "10");
  svg.append(fog, ring);
  const tag = el("div", { class: "tour-tag", role: "status" }, "Find it here any time");
  const node = el("div", { class: "tour tour-point", popover: "manual" }, svg, tag);
  document.body.append(node);
  try {
    node.showPopover();
  } catch {
    node.classList.add("shown"); // no popovers in this browser: a plain fixed layer
  }
  const PAD = 6;
  const GAP = 12;
  let frame = 0;
  const draw = () => {
    frame = requestAnimationFrame(draw);
    const item = target();
    const menu = $("#account-menu");
    if (!item || menu.hidden) return done();
    const vw = innerWidth;
    const vh = innerHeight;
    const m = menu.getBoundingClientRect();
    const i = item.getBoundingClientRect();
    // The hole: the menu and the account button it hangs from.
    const a = $("#account").getBoundingClientRect();
    const hx = Math.min(m.left, a.left);
    const hy = Math.min(m.top, a.top);
    const [x, y, w, h, r] = [hx - PAD, hy - PAD, Math.max(m.right, a.right) - hx + 2 * PAD, Math.max(m.bottom, a.bottom) - hy + 2 * PAD, 16];
    fog.setAttribute("d", `M0 0H${vw}V${vh}H0Z M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`);
    ring.setAttribute("x", String(i.left - 2));
    ring.setAttribute("y", String(i.top - 2));
    ring.setAttribute("width", String(i.width + 4));
    ring.setAttribute("height", String(i.height + 4));
    // Left of the menu, level with Tutorial (on two lines if it must, as on phones); where even that doesn't fit, below
    // the menu (or above it).
    const room = m.left - PAD - GAP - 8;
    tag.style.maxWidth = `${Math.max(110, Math.min(260, room))}px`;
    let tw = tag.offsetWidth;
    let th = tag.offsetHeight;
    let side = "left";
    let left = m.left - PAD - GAP - tw;
    let top = i.top + i.height / 2 - th / 2;
    if (left < 8) {
      tag.style.maxWidth = `${vw - 16}px`;
      tw = tag.offsetWidth;
      th = tag.offsetHeight;
      left = Math.max(8, Math.min(vw - tw - 8, m.right - tw));
      top = m.bottom + PAD + GAP;
      side = "below";
      if (top + th > vh - 8) {
        top = Math.max(8, m.top - PAD - GAP - th);
        side = "above";
      }
    }
    tag.style.left = `${Math.round(left)}px`;
    tag.style.top = `${Math.round(Math.max(8, Math.min(vh - th - 8, top)))}px`;
    tag.dataset.side = side;
  };
  const abort = new AbortController();
  const done = () => {
    cancelAnimationFrame(frame);
    abort.abort();
    node.remove();
    closeAccountMenu();
  };
  const swallow = (e) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  node.addEventListener("click", swallow, { signal: abort.signal });
  document.addEventListener("keydown", (e) => {
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    swallow(e);
  }, { capture: true, signal: abort.signal });
  draw();
}

/** The first-visit window goes (if it's open), and never shows again in this browser. */
function dropTourOffer() {
  const dialog = $("#tour-offer");
  if (dialog?.open) dialog.close("tour");
  if (!state.tourOffer) return;
  state.tourOffer = false;
  try {
    const t = cleanTour(JSON.parse(localStorage.getItem(TOUR_STORE) ?? "null"));
    t.seenOffer = true;
    localStorage.setItem(TOUR_STORE, JSON.stringify(t));
  } catch { /* storage unavailable: gone for this visit */ }
}

/** The place the page was opened for (its address, or an invite), with the invite's sentence. */
async function openPendingPlace() {
  const pending = state.pendingPlace;
  state.pendingPlace = null;
  if (!pending) return;
  const { place, invite } = pending;
  let banner = null;
  let meal = null;
  // A link without its location (older invites): look the place up.
  if (!place.area && place.kind !== "building") {
    const found = await findPlace(place.kind, place.id).catch(() => null);
    if (found && found.area !== state.area) await selectArea(found.area, { save: false });
    place.area = found?.area ?? state.area;
  }
  if (invite) {
    const listed = place.kind === "space" ? (await loadSpaces().catch(() => null))?.spaces.find((x) => x.id === place.id) : null;
    banner = inviteTitle(invite, listed && { name: listed.name, category: listed.category, kind: listed.menu ? "mensa" : listed.kind }, isoDate(new Date()));
    if (invite.meal && listed?.menu) meal = invite.meal;
  }
  await openPlace(place, { from: "url", banner, meal, save: !invite });
}

/** The notice above the list (an unknown place's address), gone with the next change of tab. */
function showNotice(text) {
  $("#notice").textContent = text ?? "";
  $("#notice").hidden = !text;
}

// --- the search index (/api/index): every room, space and building of all five locations ---

let indexLoad = null;
function loadIndex() {
  indexLoad ??= getJSON("/api/index").catch((e) => {
    indexLoad = null;
    throw e;
  });
  return indexLoad;
}

/** A room's or space's location from the index: { area } or null. */
async function findPlace(kind, id) {
  const ix = await loadIndex();
  const row = (kind === "room" ? ix.rooms : ix.spaces).find((r) => r[0] === id);
  return row ? { area: row[1] } : null;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* offline shell is optional */ });
}

init();
