"use strict";

// The campus map: every ETH building that has study spaces, lecture halls or seminar rooms.
// A building OSM has no outline for (UZH's Y03, Y04, Y16) is label only: it shows where static/map/pins.json puts it,
// and not at all without a pin. Each label shows the
// open study spaces and the rooms free for at least two hours from the chosen time (/api/map).
// The campus drawing (static/map/<area>.json, made by scripts/make_map.py from OpenStreetMap) is in metres; the
// SVG's viewBox does the panning and zooming, and the labels are HTML placed on top. Loaded before app.js and uses
// its helpers (state, el, $, getJSON, hhmm, day, untilLabel, filterList, pickedBuildings, …) only once the page is
// running.
//
// Two layouts:
// - full (phones, narrow windows): the map fills the frame behind the top bar and the results sheet (sheet.js);
//   only the part between them is visible (visibleBox). Tapping a building opens its sheet.
// - side (wide windows): next to the list. Clicking a building filters the list to it instead of opening a sheet.

const SVG_NS = "http://www.w3.org/2000/svg";
// Scale in px per metre: below this only building codes are shown, above it the counts too.
const CARD_SCALE = 0.75;
const MAX_SCALE = 6;
const FIT_PADDING_M = 70;
// A pointer that moves less than this (px) between down and up is a tap, not a drag.
const TAP_SLOP = 6;
// Must match MAP_MIN_FREE_MINUTES in worker/config.ts: how long a room must stay free to count, outside Meet.
const MAP_MIN_FREE = 120;
// /api/map is asked again for the same area and time only after this long.
const MAP_DATA_MAX_AGE_MS = 60 * 1000;
const WIDE = matchMedia("(min-width: 1000px)");
// Marks this page load's history entries (the floor view's, the menu panel's). An entry from before a reload (the
// browser keeps its state) must not count as open, or Back would land on it and leave it open.
const PAGE_LOAD = `${Date.now()}-${Math.random()}`;
const isMapEntry = (st) => st?.frooms === "map" && st.load === PAGE_LOAD;

// The tab buttons in index.html use the same three icons (and the map's layer buttons all four).
const BOOK_ICON = "M2 3.2C3.8 2.4 6 2.4 8 3.6v9.6C6 12 3.8 12 2 12.8zM14 3.2C12.2 2.4 10 2.4 8 3.6v9.6c2-1.2 4.2-1.2 6-.4z";
const DOOR_ICON = "M3.5 14V2.5h9V14M2 14h12M10 8.2v.1";
/** A microwave on the 16-unit grid (app.js MICROWAVE_ICON is the same on 24). */
const MICROWAVE_ICON_16 = "M2 3.7h12v8.6H2zM4 5.7h6v4.6H4zM12 6v.3M12 8v.3";
const MENSA_ICON = "M3.5 2v3.8a1.75 1.75 0 0 0 3.5 0V2M5.25 2v12M12 14V2c-1.6 1-2.3 3-2.3 5.6 0 .8.5 1.4 1.3 1.4h1";
// A cup of coffee, for the cafeterias.
const CUP_ICON = "M3 6h8v3.5A3.5 3.5 0 0 1 7.5 13h-1A3.5 3.5 0 0 1 3 9.5zM11 7.2h.9a1.7 1.7 0 0 1 0 3.4H11M5.5 2v2M8.5 2v2";
/** An eye: the floor plan buttons. */
const VIEW_ICON = "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z";
/** An entrance on a floor plan: two parallel arrows pointing in (east, turned by the entrance's direction), each with
 * only the outer half of its head. */
const ENTRANCE_ICON = "M1.5 5.5h13L11 2M1.5 10.5h13L11 14";
// Stairs and lifts on the floor plans (placed in the edit mode, ?edit: static/edit.js).
const STAIRS_ICON = "M2 13.5h3.5v-3h3v-3h3v-3H14";
const LIFT_ICON = "M3 1.5h10v13H3zM6 6.5l2-2 2 2M6 9.5l2 2 2-2";

const mapView = {
  area: null,
  doc: null, // the campus drawing
  data: null, // the last /api/map answer, with its area
  summary: new Map(), // building -> summary
  selected: null, // the building of the place in the detail view (static/places.js), highlighted
  selectedMensa: false, // the highlight goes to the building's mensa labels
  places: new Map(), // mensa or cafeteria id -> its state on the map (from the summary)
  pins: {}, // area -> { buildings: { code: [x, y] }, places: { id: [x, y] } }, from static/map/pins.json
  myPins: {}, // pin mode: this browser's own pins, the same shape (null: back on its building)
  pinSelected: null, // pin mode: the picked label's pin key
  picked: new Set(), // the list's buildings in the current tab, highlighted
  pickedKey: "",
  unmarked: false, // a tap beside the buildings cleared the map's highlights; the list keeps its buildings
  hover: null, // the building of the list item under the mouse (side layout)
  saved: new Map(), // area -> the map's last position, with the list's buildings at the time
  peeked: false, // a building's sheet moved the results sheet down to peek: back to half when it closes
  dataKey: "", // area and time of the last /api/map answer
  loadedAt: 0,
  cx: 0, // view centre (m)
  cy: 0,
  scale: 1, // px per metre
  width: 0, // container size (px)
  height: 0,
  labels: new Map(), // building code, or "place:<id>" for a mensa or cafeteria -> label element
  frame: 0,
  requestId: 0,
  docs: new Map(), // area -> promise of the campus drawing
  // "Near you": the position is kept in memory only, never stored or sent.
  locate: "off", // "off", "wait" (asked, no position yet) or "on"
  watch: null, // the geolocation watch, while the map is in view
  me: null, // { lat, lon, acc } the last position
  goToMe: false, // a tap on the locate button waits for a position to go to
  pendingLocate: false, // switched to the campus they're on: centre on them once its drawing is in
  nearAt: null, // where the person was when "Near you" was last filled ([x, y])
  nearMessage: null, // instead of the list: why there's none (location blocked, not on a campus, …)
  links: [], // this campus's buttons to the others: { link, node, arrow }
  handoff: null, // switching between the Zentrum maps: { from: [lat, lon], scale, target } for the next drawing
  glide: 0, // the running pan's id; bumped to stop it
  overview: null, // the land between the campuses (static/map/overview.json), once loaded
  flight: null, // flying to another campus: a promise, settled on landing (or when a gesture stops it)
  stopFlight: null, // while flyTo runs: stops it where it is (interruptFlight)
  campuses: new Map(), // area -> campus drawing: all of them are drawn, the selected one (`doc`) active
  region: null, // the region's tiles: static/map/region/index.json, once loaded
  world: null, // the drawing's parts: { overview, tiles, buildings: area -> <g> } (drawWorld)
  campusTags: new Map(), // area -> its campus tag
  shownTags: new Set(), // the campuses whose tags are in view now (their edge buttons hide)
  bounds: null, // how far the view may go (m): all the campuses, in the selected one's metres
  floorIndex: null, // area -> buildings with floor plans, and `levels` (static/map/floors/index.json)
  noteText: null, // the map note under a flashed one (flashNote)
  flashUntil: 0,
  micro: { area: null, list: null, loading: false }, // the location's microwaves (/api/spaces), for their labels
  microLabels: new Map(), // building -> its microwave label (the total, zoomed out)
  microSpots: new Map(), // microwave id -> its own marker (zoomed in)
  floor: null, // the floor view: { code, doc, level, chosen, detail, picked, back, focus } (see openFloors)
};

// --- drawing ---

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function smallIcon(d) {
  const svg = svgEl("svg", { viewBox: "0 0 16 16", class: "map-ic", "aria-hidden": "true" });
  svg.append(svgEl("path", { d }));
  return svg;
}

/** The committed pins (static/map/pins.json), once; none if it can't be loaded. */
let pinsLoad = null;
function loadPins() {
  pinsLoad ??= getJSON("/map/pins.json").catch(() => ({}));
  return pinsLoad;
}

function loadCampus(area) {
  if (!mapView.docs.has(area)) {
    const p = getJSON(`/map/${area}.json`);
    p.catch(() => mapView.docs.delete(area)); // try again next time
    mapView.docs.set(area, p);
  }
  return mapView.docs.get(area);
}

/** The overview, once; none if it can't be loaded (the campus maps work without it). */
let overviewLoad = null;
function loadOverview() {
  overviewLoad ??= getJSON("/map/overview.json").then((ov) => (mapView.overview = ov), () => null);
  return overviewLoad;
}

/** The campuses with a drawing: all of them are on the map at once, one of them active (the selected one). */
const MAP_AREAS = ["Z", "UZ", "H", "UI", "UO"];

/** Every campus drawing, once (area -> doc); a campus that can't be loaded is left out. */
let campusesLoad = null;
function loadCampuses() {
  campusesLoad ??= Promise.all(MAP_AREAS.map((a) => loadCampus(a).then((doc) => [a, doc], () => null)))
    .then((list) => new Map(list.filter(Boolean)));
  campusesLoad.then((m) => { if (m.size < MAP_AREAS.length) campusesLoad = null; }); // try the rest next time
  return campusesLoad;
}

// --- the region: one map around all the campuses, in square tiles loaded as they come into view ---

/** The region's index (static/map/region/index.json), once; none if it can't be loaded (then only the overview). */
let regionLoad = null;
function loadRegion() {
  regionLoad ??= getJSON("/map/region/index.json").then((r) => (mapView.region = r), () => {
    regionLoad = null; // try again next time
    return null;
  });
  return regionLoad;
}

/** Tiles this far (m) beyond the view are loaded first, so panning finds them ready; the rest follow (prefetchTiles). */
const TILE_MARGIN_M = 250;
/** Tiles fetched at once while prefetching the rest of the region. */
const TILE_PREFETCH = 4;
/** The tiles' layers, bottom to top: each tile adds its part to every layer, so roads and houses join across tiles. */
const TILE_LAYERS = ["ground", "green", "water", "river", "plaza", "case-service", "service", "case-minor", "minor", "case-major", "major", "foot", "rail", "funicular", "other", "eth"];

/** The tiles' drawing: one group per layer, in the region's metres. */
function tilesLayer() {
  const g = svgEl("g", { class: "map-tiles", "aria-hidden": "true" });
  const layers = new Map(TILE_LAYERS.map((name) => [name, svgEl("g")]));
  g.append(...layers.values());
  return { g, layers, loaded: new Map() };
}

/**
 * Load the tiles in and around the view. They show at every zoom (only the land between the campuses has them, see
 * make_map.py), so once those are in, the rest are fetched too: zooming out or panning never waits for them.
 */
function syncTiles() {
  const reg = mapView.region;
  const tiles = mapView.world?.tiles;
  if (!reg || !tiles) return;
  const [ox, oy] = offsetOf(mapView.doc, reg); // the region's metres + this = the view's
  const hw = mapView.width / mapView.scale / 2;
  const hh = mapView.height / mapView.scale / 2;
  const box = [mapView.cx - hw - ox, mapView.cy - hh - oy, mapView.cx + hw - ox, mapView.cy + hh - oy];
  const loads = tilesInView(reg, box, TILE_MARGIN_M).filter((key) => !tiles.loaded.has(key)).map(loadTile);
  tiles.prefetch ??= Promise.allSettled(loads).then(prefetchTiles); // once, after the view's own
}

/** Fetch a tile and draw it (once; tried again later if it fails). */
function loadTile(key) {
  const tiles = mapView.world.tiles;
  const load = getJSON(`/map/region/${key}.json`).then((tile) => {
    if (mapView.world?.tiles === tiles) drawTile(key, tile);
  }, () => tiles.loaded.delete(key));
  tiles.loaded.set(key, load);
  return load;
}

/** The region's other tiles, a few at a time in the background (one try each; those in view are tried again). */
function prefetchTiles() {
  const tiles = mapView.world?.tiles;
  if (!tiles) return;
  const queue = mapView.region.tiles.filter((key) => !tiles.loaded.has(key));
  const next = () => {
    const key = queue.shift();
    if (key === undefined || mapView.world?.tiles !== tiles) return;
    (tiles.loaded.get(key) ?? loadTile(key)).then(next, next);
  };
  for (let i = 0; i < TILE_PREFETCH; i++) next();
}

/**
 * Add a tile to the drawing: its part of each layer. Its `ground` (the inner zone, where the detail is complete) covers
 * the overview under it; where the detail thins out, the overview shows through.
 */
function drawTile(key, tile) {
  const { layers } = mapView.world.tiles;
  for (const [name, d] of Object.entries(tile.layers)) {
    if (["service", "minor", "major"].includes(name)) layers.get(`case-${name}`).append(svgEl("path", { d, class: `l-case l-${name}` }));
    layers.get(name)?.append(svgEl("path", { d, class: `l-${name}` }));
  }
}

/**
 * A campus's buildings and landmarks, in its university's colours: tappable while it's the `active` campus, paler and
 * a tap to switch to it while `inactive`, highlighted but not tappable while it's being flown to (`flight`).
 */
function buildingsLayer(doc) {
  const g = svgEl("g", { class: `map-buildings inactive ${uniOf(doc.area)}`, "data-area": doc.area });
  for (const [code, b] of Object.entries(doc.buildings)) {
    if (b.outline === false) continue; // label only
    g.append(svgEl("path", { d: b.d, class: "map-building", "data-code": code }));
  }
  for (const lm of doc.landmarks) if (lm.type === "dome") g.append(domeGlyph(lm));
  return g;
}

/** ETH's campuses and UZH's: their buildings and labels have the university's colours. */
const UZH_AREAS = new Set(["UZ", "UI", "UO"]);
const uniOf = (area) => (UZH_AREAS.has(area) ? "uzh" : "eth");

/** Where another campus's drawing goes in this one's metres: [dx, dy]. */
const offsetOf = (doc, other) => gpsToMap(doc.origin, ...other.origin);
const shiftBounds = (b, [dx, dy]) => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
const unionBounds = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const shiftPoint = ([x, y], [dx, dy]) => [x + dx, y + dy];


/** The overview: a light map of the whole region, seen zoomed out and wherever its tiles aren't loaded yet. */
function overviewLayer() {
  const ov = mapView.overview;
  if (!ov) return null;
  const g = svgEl("g", { class: "map-overview", "aria-hidden": "true" });
  for (const name of ["green", "water", "river", "major", "rail"]) {
    const d = ov.layers[name];
    if (!d) continue;
    if (name === "major") g.append(svgEl("path", { d, class: "l-case l-major" }));
    g.append(svgEl("path", { d, class: `l-${name}` }));
  }
  return g;
}

/**
 * Draw the map once per page: the overview, the region's tiles (filled in as they're needed), then every campus's
 * buildings (setActive puts it all in place around the selected campus).
 */
function drawWorld() {
  const svg = $("#map-svg");
  mapView.world = {
    overview: overviewLayer(),
    tiles: mapView.region ? tilesLayer() : null,
    buildings: new Map([...mapView.campuses].map(([area, doc]) => [area, buildingsLayer(doc)])),
  };
  const { overview, tiles, buildings } = mapView.world;
  svg.replaceChildren(...[selectionGradient(), overview, tiles?.g, ...buildings.values()].filter(Boolean));
}

/** The selected building's fill: a slight diagonal gradient, its colours from the CSS (--map-sel-from, --map-sel-to). */
function selectionGradient() {
  const grad = svgEl("linearGradient", { id: "map-sel-grad", x1: "0", y1: "0", x2: "1", y2: "1" });
  grad.append(svgEl("stop", { offset: "0", class: "sel-from" }), svgEl("stop", { offset: "1", class: "sel-to" }));
  const defs = svgEl("defs");
  defs.append(grad);
  return defs;
}

/**
 * Make `area` the active campus: the drawing goes into its metres (the view's), its buildings go on top and light up;
 * the others' go pale. The view may go anywhere over the region (else over all the campuses).
 */
function setActive(area) {
  const doc = mapView.campuses.get(area);
  const { overview, tiles, buildings } = mapView.world;
  mapView.doc = doc;
  let bounds = doc.bounds;
  for (const [a, other] of mapView.campuses) {
    const off = offsetOf(doc, other);
    const g = buildings.get(a);
    g.setAttribute("transform", `translate(${off[0]} ${off[1]})`);
    bounds = unionBounds(bounds, shiftBounds(other.bounds, off));
    g.classList.toggle("active", a === area);
    g.classList.toggle("inactive", a !== area);
    g.classList.remove("flight");
  }
  const reg = mapView.region;
  mapView.bounds = reg ? shiftBounds(reg.bounds, offsetOf(doc, reg)) : bounds;
  if (overview) overview.setAttribute("transform", `translate(${offsetOf(doc, mapView.overview).join(" ")})`);
  if (tiles) tiles.g.setAttribute("transform", `translate(${offsetOf(doc, reg).join(" ")})`);
  // Its buildings over the others' (Zentrum's two campuses are close together).
  const groups = [...$("#map-svg").querySelectorAll(":scope > .map-buildings")];
  if (groups.at(-1) !== buildings.get(area)) groups.at(-1).after(buildings.get(area));

  const box = $("#map-labels");
  box.dataset.uni = uniOf(area);
  mapView.labels = new Map();
  for (const code of Object.keys(doc.buildings)) {
    mapView.labels.set(code, el("button", { type: "button", class: "map-label", "data-code": code }));
  }
  box.replaceChildren(...mapView.labels.values());
  renderCampusTags();
}

/** A dome seen from above: a disc with ribs and a lantern. */
function domeGlyph({ x, y, r }) {
  const g = svgEl("g", { class: "map-dome", "aria-hidden": "true" });
  g.append(svgEl("circle", { cx: x, cy: y, r }));
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    g.append(svgEl("line", { x1: x + Math.cos(a) * r * 0.28, y1: y + Math.sin(a) * r * 0.28, x2: x + Math.cos(a) * r, y2: y + Math.sin(a) * r }));
  }
  g.append(svgEl("circle", { cx: x, cy: y, r: r * 0.28, class: "lantern" }));
  return g;
}

// --- campus tags: one large tag per campus not selected (and per campus when zoomed far out) ---

/** Zoomed out further than this (px per metre), the selected campus's labels give way to its campus tag too. */
const CAMPUS_TAG_SCALE = 0.22;

/** Make the campus tags (when the campus is set up, and again once the campus names are in). */
function renderCampusTags() {
  const names = new Map((state.areas?.areas ?? []).map((a) => [a.area, a.name]));
  for (const node of mapView.campusTags?.values() ?? []) node.remove();
  mapView.campusTags = new Map();
  if (PIN_MODE || !mapView.doc) return;
  for (const area of mapView.campuses.keys()) {
    const name = names.get(area) ?? area;
    const node = el("button", { type: "button", class: `map-label campus ${uniOf(area)}`, "data-area": area, "aria-label": `Switch to ${name}` },
      el("span", { class: "code" }, name));
    mapView.campusTags.set(area, node);
  }
  $("#map-labels").append(...mapView.campusTags.values());
}

/** Where a campus's tag goes (the active campus's metres): Zentrum's on HG and KOL, others amid their buildings. */
function campusTagAt(area) {
  if (MAIN_BUILDING[area]) return gpsToMap(mapView.doc.origin, ...CAMPUS_POINTS[MAIN_BUILDING[area]]);
  const doc = mapView.campuses.get(area);
  const pts = Object.values(doc.buildings).filter((b) => b.outline !== false).map((b) => [b.x, b.y]);
  const xs = pts.map(([x]) => x);
  const ys = pts.map(([, y]) => y);
  return shiftPoint([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2], offsetOf(mapView.doc, doc));
}

/** Zoomed out so far that the selected campus shows as its tag too. */
const campusesOnly = () => !PIN_MODE && !mapView.floor && mapView.scale < CAMPUS_TAG_SCALE;

/** A campus tag or another campus's building was tapped: switch to it; the selected campus's tag zooms to it. */
function campusTapped(area) {
  if (mapView.flight) return;
  if (area !== state.area) return switchCampus(area);
  stopGlide();
  fitCampus();
  scheduleDraw();
}

// --- layers: what the map shows (the buttons below the zoom buttons) ---

/** The filter buttons, top to bottom: at most one is on (none: the building labels show their codes alone). Study
 * spaces and rooms are counts on the building labels; mensas and cafeterias replace the building labels with labels of
 * their own. Saved with the other choices (state.mapLayer, app.js). */
const LAYERS = [
  { key: "study", icon: BOOK_ICON, name: "Study spaces", short: "Study spaces" },
  { key: "rooms", icon: DOOR_ICON, name: "Seminar rooms and lecture halls", short: "Free rooms" },
  { key: "mensa", icon: MENSA_ICON, name: "Mensas", short: "Mensas & more" },
  { key: "cafe", icon: CUP_ICON, name: "Cafeterias", short: "Cafeterias" },
];

const layerOn = (key) => state.mapLayer === key;

/** Mensas or cafeterias: their labels, and no building labels. */
const placeFilter = () => layerOn("mensa") || layerOn("cafe");

function renderMapLayers() {
  syncLayersToggle();
  if (mapView.floor) return renderLevelButtons();
  $("#map-layers").setAttribute("aria-label", "Show on the map");
  $("#map-layers").replaceChildren(...LAYERS.map(({ key, icon, name, short }) => {
    const on = layerOn(key);
    const b = el("button", { type: "button", class: `layer ${key}`, "aria-pressed": String(on), title: `${on ? "Hide" : "Show"} ${name.toLowerCase()}`, "aria-label": name, "data-tour": `layer-${key}` },
      el("span", { class: "layer-name", "aria-hidden": "true" }, short), smallIcon(icon));
    b.addEventListener("click", () => {
      state.mapLayer = on ? null : key; // one at a time: this one replaces the others
      savePrefs();
      renderMapLayers();
      fillLabels();
      scheduleDraw();
    });
    return b;
  }));
}

/**
 * The filters' names: shown (expanded) or not (only the icons, as narrow as the zoom buttons). The handle left of them
 * switches with a tap, or with a drag: to the right collapses, to the left expands. Not in the floor view, whose level
 * buttons have no names. Remembered (state.mapLayersOpen).
 */
function syncLayersToggle() {
  const open = state.mapLayersOpen && !mapView.floor;
  const box = $(".map-layers-box");
  box.classList.toggle("open", open);
  box.classList.toggle("floor", !!mapView.floor);
  const t = $("#map-layers-toggle");
  t.hidden = !!mapView.floor;
  t.setAttribute("aria-expanded", String(open));
  t.setAttribute("aria-label", open ? "Hide the filters' names" : "Show the filters' names");
}

function setLayersOpen(open) {
  if (state.mapLayersOpen === open) return;
  state.mapLayersOpen = open;
  savePrefs();
  syncLayersToggle();
}

function initLayersToggle() {
  const t = $("#map-layers-toggle");
  let drag = null; // { x, id, moved }
  t.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, id: e.pointerId, moved: false };
    t.setPointerCapture(e.pointerId);
  });
  t.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) < 16) return;
    drag.moved = true;
    setLayersOpen(dx < 0);
  });
  const end = () => {
    if (drag?.moved) t.dataset.dragged = "1"; // the click that follows a drag does nothing
    drag = null;
  };
  t.addEventListener("pointerup", end);
  t.addEventListener("pointercancel", end);
  t.addEventListener("click", () => {
    if (t.dataset.dragged) return delete t.dataset.dragged;
    setLayersOpen(!state.mapLayersOpen);
  });
  syncLayersToggle();
}

// --- mensas and cafeterias: a label each, on its own pin (else on its building), under their filter only ---

/**
 * Whether a mensa or cafeteria gets a label: under its own filter, always, closed ones too (grey, with a closed badge).
 * With either Zentrum campus selected, both campuses' places show.
 */
const placeShown = (m) => layerOn(m.kind);

/**
 * Places that go first, in this order: the location's mensas in our order (/api/map's `order`, data/overrides.json
 * `mensa_order`, lib.js placeLabelOrder). They stack on their building (each below the one before) and the others give
 * way to them: Polymensa before Polysnack before Dozentenfoyer near HG, the Obere Mensa above the Untere Mensa in MEN.
 */
const placesFirst = () => mapView.data?.order ?? [];

/** A building's own mensas and cafeterias that are study spaces right now: they count with its study spaces. */
const studyPlaces = (s) => (s?.partner ? 0 : (s?.mensas ?? []).filter((m) => m.state === "study").length);

const KIND_ICON = { mensa: MENSA_ICON, cafe: CUP_ICON };
/** A cross: a closed place's badge. */
const CLOSED_ICON = "M4.5 4.5l7 7M11.5 4.5l-7 7";

/** The icon in a place's corner: what it is right now. */
const stateIcon = (m) => (m.state === "food" ? MENSA_ICON : m.state === "study" ? BOOK_ICON : m.state === "closed" ? CLOSED_ICON : KIND_ICON[m.kind]);

/** "Serving food until 14:00", "Study space until 17:30", "Open until 16:00" or "Closed". */
function placeLine(m) {
  if (m.state === "closed") return "Closed";
  const what = { food: "Serving food", study: "Study space", open: "Open" }[m.state];
  return m.until ? `${what} until ${hhmm(m.until)}` : what;
}

/**
 * How a mensa or cafeteria shows on the map: its state, and whether as a cafeteria (brown, a cup). An open cafeteria
 * shows as one, even while it's a study space too (Einstein & Zweistein).
 */
function placeLook(m) {
  const cafe = m.kind === "cafe" && (m.state === "open" || m.state === "study");
  return { state: cafe ? "open" : m.state, kind: m.kind };
}

/** A label for each mensa and cafeteria (made once per area, filled on every update). */
function addPlaceLabels() {
  for (const [code, s] of mapView.summary) {
    // The other Zentrum campus's mensas, on its plain buildings (not in pin mode: their pins are that campus's).
    const partner = !mapView.doc.buildings[code] && s.partner && !PIN_MODE && !!partnerAnchor(code);
    if (!mapView.doc.buildings[code] && !partner) continue;
    for (const m of s.mensas ?? []) {
      const key = `place:${m.id}`;
      if (mapView.labels.has(key)) continue;
      const node = el("button", { type: "button", class: "map-label mensa place", "data-code": code, "data-place": m.id, ...(partner ? { "data-area": ZENTRUM_PARTNER[mapView.area] } : {}) });
      mapView.labels.set(key, node);
      $("#map-labels").append(node);
    }
  }
}

function fillPlaceLabel(node, m) {
  if (!m) return node.classList.add("off");
  const look = placeLook(m);
  for (const name of ["food", "study", "open", "closed"]) node.classList.toggle(name, look.state === name);
  node.classList.toggle("cafe", m.kind === "cafe");
  const name = placeName(node.dataset.code, m);
  node.replaceChildren(el("span", { class: "code" }, name), el("span", { class: "badge" }, smallIcon(stateIcon(look))));
  node.setAttribute("aria-label", `${name}${name === m.name ? "" : ` (${m.name})`}, ${m.kind === "cafe" ? "cafeteria" : "mensa"}: ${placeLine(m)}`);
}

/** A place's name on the map: its building's own name if the building is known by it (Poly for Mensa Polyterrasse). */
function placeName(code, m) {
  const s = mapView.summary.get(code);
  return s?.place === m.id && s.label ? s.label : m.name;
}

// --- microwaves: under the mensa filter, a marker each where they are; zoomed out one round label per building ---

/**
 * The location's microwaves (/api/spaces' `microwaves`, data/microwaves.json): the list's answer when it's this
 * campus's (Eat, or a view that loaded it), else asked for once per campus while the mensa filter is on, a floor plan
 * is open or in pin mode. Null until known.
 */
function mapMicrowaves() {
  if (state.spaces?.area === mapView.area) return state.spaces.microwaves ?? [];
  const m = mapView.micro;
  if (m.area === mapView.area) return m.list;
  if (!(layerOn("mensa") || mapView.floor || PIN_MODE) || m.loading) return null;
  const area = mapView.area;
  m.loading = true;
  getJSON(`/api/spaces?area=${encodeURIComponent(area)}`)
    .then((d) => Object.assign(m, { area, list: d.microwaves ?? [] }), () => Object.assign(m, { area, list: [] }))
    .finally(() => {
      m.loading = false;
      if (mapView.area === area && mapView.doc) {
        syncMicroLabels();
        if (mapView.floor?.doc) drawFloor(); // its level's microwaves
        scheduleDraw();
      }
    });
  return null;
}

/**
 * Where a microwave entry is (map metres): its pin (pin mode: this browser's; static/map/pins.json `microwaves`), else
 * its `at`; with `onBuilding`, else its building's anchor. Null if none.
 */
function microAt(m, onBuilding = true) {
  return pinFor("microwaves", m.id) ?? m.at ?? (onBuilding ? anchorOf(m.building) : null);
}

/** A microwave glyph (24-unit grid) with a count as a badge. */
function microGlyph(n) {
  const glyph = svgEl("svg", { viewBox: "0 0 24 24", class: "map-ic", "aria-hidden": "true" });
  glyph.append(svgEl("path", { d: MICROWAVE_ICON }));
  return [glyph, el("span", { class: "badge" }, String(n))];
}

/**
 * The microwaves' labels on this campus: a marker per entry (`spot`, at microAt) and one round label per building with
 * its total, for when the markers would pile up (placeLabels picks which, lib.js microwaveSpots).
 */
function syncMicroLabels() {
  const counts = new Map();
  const here = (mapMicrowaves() ?? []).filter((m) => mapView.doc.buildings[m.building]);
  for (const m of here) counts.set(m.building, (counts.get(m.building) ?? 0) + m.count);
  const ids = new Set(here.map((m) => m.id));
  for (const [id, node] of mapView.microSpots) {
    if (ids.has(id) && node.isConnected) continue;
    node.remove();
    mapView.microSpots.delete(id);
  }
  for (const m of here) {
    let node = mapView.microSpots.get(m.id);
    if (!node) {
      node = el("button", { type: "button", class: "map-label micro spot off", "data-code": m.building, "data-microwave": m.id });
      mapView.microSpots.set(m.id, node);
      $("#map-labels").prepend(node); // under the other labels
    }
    const text = `${plural(m.count, "microwave", "microwaves")} · ${m.name}${m.floor ? `, floor ${m.floor}` : ""} (${buildingLabel(m.building)})`;
    node.replaceChildren(...microGlyph(m.count));
    node.setAttribute("aria-label", text);
    node.title = text;
  }
  for (const [code, node] of mapView.microLabels) {
    if (counts.has(code) && node.isConnected) continue;
    node.remove();
    mapView.microLabels.delete(code);
  }
  for (const [code, n] of counts) {
    let node = mapView.microLabels.get(code);
    if (!node) {
      node = el("button", { type: "button", class: "map-label micro off", "data-code": code, "data-micro": "" });
      mapView.microLabels.set(code, node);
      $("#map-labels").append(node);
    }
    node.replaceChildren(...microGlyph(n));
    node.setAttribute("aria-label", `${plural(n, "microwave", "microwaves")} in ${buildingLabel(code)}`);
    node.title = `${plural(n, "microwave", "microwaves")} in ${buildingLabel(code)}`;
  }
}

/** A microwave label: a spot's marker opens its page; a building's total its view, scrolled to its microwaves. */
function openMicrowaves(code, spot = null) {
  const m = spot ? (mapMicrowaves() ?? []).find((x) => x.id === spot) : null;
  if (m) return openPlace({ kind: "microwave", id: m.id, area: m.area });
  openPlace({ kind: "building", id: code, area: state.area }, { section: "microwaves" });
}

/** Our own name for a building (data/overrides.json, e.g. Poly for MM), else its code. */
const buildingLabel = (code) => mapView.summary.get(code)?.label ?? code;

/**
 * Fill the labels: a building shows the count of the filter that's on (the code alone with none, or while nothing is
 * loaded), greyed when it has nothing open or free; mensas and cafeterias show their state.
 */
function fillLabels() {
  if (mapView.doc) addPlaceLabels();
  if (mapView.doc) syncMicroLabels();
  // The other Zentrum campus's places are marked `partner` (their buildings are).
  mapView.places = new Map([...mapView.summary.values()].flatMap((s) => (s.mensas ?? []).map((m) => [m.id, s.partner ? { ...m, partner: true } : m])));
  for (const node of mapView.labels.values()) {
    const code = node.dataset.code;
    const s = mapView.summary.get(code);
    if (node.dataset.place !== undefined) {
      fillPlaceLabel(node, mapView.places.get(node.dataset.place));
      continue;
    }
    const parts = [el("span", { class: "code" }, buildingLabel(code))];
    let any = false;
    if (s) {
      const open = s.study.open + studyPlaces(s);
      const study = layerOn("study") && (s.study.total || open)
        ? el("span", { class: "n" + (open ? "" : " zero"), "data-mode": "study", title: `Study spaces in ${code}` }, smallIcon(BOOK_ICON), String(open),
          s.study.open && s.study.best?.occupancy ? el("i", { class: `occ-dot ${s.study.best.occupancy.status}` }) : null)
        : null;
      const rooms = !layerOn("rooms") || (s.rooms !== null && !s.rooms.total)
        ? null
        : s.rooms === null
          ? el("span", { class: "n zero", "data-mode": "rooms", title: `Rooms in ${code}` }, smallIcon(DOOR_ICON), "–")
          : el("span", { class: "n" + (s.rooms.free ? " ok" : " zero"), "data-mode": "rooms", title: `Rooms in ${code}` }, smallIcon(DOOR_ICON), String(s.rooms.free));
      if (study || rooms) parts.push(el("span", { class: "nums" }, study, rooms));
      any = (layerOn("study") && open > 0) || (layerOn("rooms") && !!s.rooms && s.rooms.free > 0);
    }
    // Greyed: nothing open or free under the filter that's on (not with none, nor while the numbers are loading).
    const counting = layerOn("study") || layerOn("rooms");
    node.classList.toggle("dim", counting && !!s && !any);
    node.replaceChildren(...parts);
    node.setAttribute("aria-label", labelText(code, s));
  }
  markBuildings();
}

/** The list's buildings are highlighted on the map, unless a tap beside the buildings cleared that. */
const isMarked = (code) => !mapView.unmarked && mapView.picked.has(code);

/** Highlight the open building, the list's buildings and the one under the mouse in the list. */
function markBuildings() {
  const mark = (node, code) => {
    node.classList.toggle("selected", code === mapView.selected || isMarked(code));
    node.classList.toggle("hover", code === mapView.hover);
  };
  // Place labels light up for the open sheet of the building's mensas, or in the Mensas tab; building labels as usual.
  for (const node of mapView.labels.values()) {
    const code = node.dataset.code;
    if (node.dataset.place !== undefined) {
      node.classList.toggle("selected", (code === mapView.selected && (mapView.selectedMensa || placeFilter())) || (state.mode === "mensa" && isMarked(code)));
      node.classList.toggle("hover", false);
    } else mark(node, code);
  }
  for (const path of document.querySelectorAll("#map-svg .map-buildings.active .map-building")) mark(path, path.dataset.code);
  for (const path of document.querySelectorAll("#map-svg .map-buildings.inactive .map-building.selected, #map-svg .map-buildings.inactive .map-building.hover")) {
    path.classList.remove("selected", "hover");
  }
}

function labelText(code, s) {
  if (!s) return code;
  const bits = [s.label ?? code];
  const open = s.study.open + studyPlaces(s);
  if (layerOn("study") && (s.study.total || open)) bits.push(`${open} study space${open === 1 ? "" : "s"} open`);
  if (layerOn("rooms") && s.rooms?.total) bits.push(`${s.rooms.free} room${s.rooms.free === 1 ? "" : "s"} free for ${freeFor_()} or more`);
  return bits.join(", ");
}

// --- pin mode (?pins): drag the labels to where they belong and copy their positions for static/map/pins.json ---

// The edit mode (?edit, static/edit.js: microwaves, entrances, stairs, lifts and room corners) includes pin mode.
const EDIT_MODE = new URLSearchParams(location.search).has("edit");
const PIN_MODE = EDIT_MODE || new URLSearchParams(location.search).has("pins");
// The edit mode's hooks into the map's gestures (set by static/edit.js): `down(e)` may take a press for itself (a box
// selection) and returns true then; `tap(target, e)` may take a tap (placing something) and returns true then.
const editHooks = { down: null, tap: null };
const PINS_KEY = "frooms-pins"; // this browser's own pins, until they're copied into static/map/pins.json

/** A label's pin key: "buildings:HG", "places:F10" or "microwaves:MW-MM-1". */
const pinKey = (node) => (node.dataset.microwave !== undefined ? `microwaves:${node.dataset.microwave}`
  : node.dataset.place !== undefined ? `places:${node.dataset.place}` : `buildings:${node.dataset.code}`);

function loadMyPins() {
  try {
    return JSON.parse(localStorage.getItem(PINS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveMyPins() {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(mapView.myPins));
  } catch { /* storage unavailable: the pins last until the page reloads */ }
}

/**
 * Where a label goes (map metres), if it's pinned: this browser's pin in pin mode (null: back on its building), else
 * the committed one (static/map/pins.json); otherwise it sits on its building.
 */
function pinOf(node) {
  const [kind, id] = pinKey(node).split(":");
  return pinFor(kind, id, node.dataset.area);
}

/** A label's pin, in the active campus's metres; `area`: another campus's label (a Zentrum partner's mensa). */
function pinFor(kind, id, area = null) {
  if (area && area !== mapView.area) {
    // Its own campus's pin, moved into this campus's frame.
    const pin = mapView.pins[area]?.[kind]?.[id];
    const other = mapView.campuses.get(area);
    return pin && other ? shiftPoint(pin, offsetOf(mapView.doc, other)) : null;
  }
  const mine = PIN_MODE ? mapView.myPins[mapView.area]?.[kind] : undefined;
  if (mine && id in mine) return mine[id];
  return mapView.pins[mapView.area]?.[kind]?.[id] ?? null;
}

/** A building without an outline in OSM (make_map.py's `not_on_map`): only a label, and only where a pin puts it. */
const labelOnly = (code) => mapView.doc.buildings[code]?.outline === false;

/**
 * Where a building is on the map (metres), for fitting and moving the view: its label anchor, or a label-only
 * building's pin (null without one: it isn't on the map).
 */
function anchorOf(code) {
  const b = mapView.doc.buildings[code];
  if (!b) return partnerAnchor(code);
  return labelOnly(code) ? pinFor("buildings", code) : [b.x, b.y];
}

/** Where another campus's building is, in the active campus's metres (its pin if it has no outline). */
function anchorIn(area, code) {
  const other = mapView.campuses.get(area);
  const b = other?.buildings?.[code];
  if (!b) return null;
  const at = b.outline === false ? mapView.pins[area]?.buildings?.[code] : [b.x, b.y];
  return at ? shiftPoint(at, offsetOf(mapView.doc, other)) : null;
}

/** A building of the other Zentrum campus (for its mensas): where it is in this campus's frame. */
const partnerAnchor = (code) => (ZENTRUM_PARTNER[mapView.area] ? anchorIn(ZENTRUM_PARTNER[mapView.area], code) : null);

/** Pin mode: the area's label-only buildings that have no pin yet, to place. */
const unplaced = () => (mapView.doc ? Object.keys(mapView.doc.buildings).filter((c) => labelOnly(c) && !anchorOf(c)).sort() : []);

function setMyPin(key, value) {
  const [kind, id] = key.split(":");
  const area = (mapView.myPins[mapView.area] ??= {});
  (area[kind] ??= {})[id] = value;
  saveMyPins();
}

/** A pointer position on the view, in map metres. */
function toMetres(clientX, clientY) {
  const rect = $("#map-view").getBoundingClientRect();
  return [
    Math.round((mapView.cx + (clientX - rect.left - mapView.width / 2) / mapView.scale) * 10) / 10,
    Math.round((mapView.cy + (clientY - rect.top - mapView.height / 2) / mapView.scale) * 10) / 10,
  ];
}

function labelName(key) {
  if (key.startsWith("microwaves:")) {
    const m = (mapMicrowaves() ?? []).find((x) => x.id === key.slice(11));
    return m ? `Microwaves ${m.name}` : key.slice(11);
  }
  const node = [...mapView.labels.values()].find((n) => pinKey(n) === key);
  return node?.querySelector(".code")?.textContent ?? key.split(":")[1];
}

/**
 * The pin mode panel: the picked label, back on its building, the label-only buildings still to place, and the pins
 * to copy.
 */
function renderPinPanel() {
  const box = $("#map-pins");
  if (!box) return;
  const key = mapView.pinSelected;
  // A label-only building has no building to go back to: without its pin it leaves the map (and is offered again).
  const off = key?.startsWith("buildings:") && mapView.doc && labelOnly(key.split(":")[1]);
  const micro = key?.startsWith("microwaves:");
  const back = el("button", { type: "button" }, off ? "Take off the map" : micro ? "Back where it was" : "Back on its building");
  back.disabled = !key;
  back.addEventListener("click", () => {
    const [kind, id] = key.split(":");
    // null overrides a committed pin, so the label really goes back; without one, just forget this browser's pin.
    if (mapView.pins[mapView.area]?.[kind]?.[id]) setMyPin(key, null);
    else {
      delete mapView.myPins[mapView.area]?.[kind]?.[id];
      saveMyPins();
    }
    if (off) mapView.pinSelected = null;
    renderPinPanel();
    scheduleDraw();
  });
  // Dropped at the centre of the view, picked, ready to drag.
  const place = unplaced().map((code) => {
    const b = el("button", { type: "button" }, `Place ${code} on map`);
    b.addEventListener("click", () => {
      mapView.pinSelected = `buildings:${code}`;
      setMyPin(mapView.pinSelected, [Math.round(mapView.cx * 10) / 10, Math.round(mapView.cy * 10) / 10]);
      renderPinPanel();
      scheduleDraw();
    });
    return b;
  });
  const text = JSON.stringify(mapView.myPins);
  const out = el("textarea", { readonly: "", rows: "3", "aria-label": "Pins to send" }, text);
  const copy = el("button", { type: "button" }, "Copy pins");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = "Copied";
    } catch {
      out.select();
    }
  });
  const clear = el("button", { type: "button" }, "Clear my pins");
  clear.addEventListener("click", () => {
    mapView.myPins = {};
    saveMyPins();
    renderPinPanel();
    scheduleDraw();
  });
  const count = Object.values(mapView.myPins).flatMap((a) => Object.values(a ?? {}).flatMap((k) => Object.keys(k ?? {}))).length;
  box.replaceChildren(...[
    el("b", {}, "Pin mode"),
    el("p", {}, key ? `${labelName(key)}: drag it, or ${off ? "take it off the map" : micro ? "put it back where it was" : "put it back on its building"}.` : "Drag a label to where it belongs; tap one to pick it."),
    el("div", { class: "pin-actions" }, back, copy, clear),
    place.length ? el("p", {}, "No outline on the map, not placed yet:") : null,
    place.length ? el("div", { class: "pin-actions" }, ...place) : null,
    el("p", { class: "muted" }, `${count} pin${count === 1 ? "" : "s"} moved. Copy them and send them to us.`),
    out].filter(Boolean)); // replaceChildren would write a null as "null"
}

// --- view: pan, zoom, label placement ---

function measure() {
  const box = $("#map-view").getBoundingClientRect();
  mapView.width = box.width;
  mapView.height = box.height;
}

/** The zoom at which fitCampus shows the whole campus (px per metre). */
function campusScale() {
  const pts = Object.keys(mapView.doc.buildings).map(anchorOf).filter(Boolean);
  const xs = pts.map(([x]) => x);
  const ys = pts.map(([, y]) => y);
  const w = Math.max(...xs) - Math.min(...xs) + 2 * FIT_PADDING_M;
  const h = Math.max(...ys) - Math.min(...ys) + 2 * FIT_PADDING_M;
  const b = frameBox();
  return clampScale(Math.min(MAX_SCALE, (b.x1 - b.x0) / w, (b.y1 - b.y0) / h));
}

/** Zoom so that every labelled building fits (label-only ones without a pin aren't on the map). */
function fitCampus() {
  fitTo(Object.keys(mapView.doc.buildings).filter((code) => !labelOnly(code)));
}

/**
 * The part of the map view that's visible (px, relative to the view): on phones between the top bar and the results
 * sheet (at full height, as if it were at half: the map is out of sight then, and moving it would only be undone).
 */
function visibleBox() {
  const box = frameBox();
  // Never smaller than a strip, so the maths below stays sane.
  if (box.y1 - box.y0 < 80) box.y1 = Math.min(mapView.height, box.y0 + 80);
  if (box.x1 - box.x0 < 80) box.x1 = Math.min(mapView.width, box.x0 + 80);
  return box;
}

/** The part of the view between the top bar and the results sheet (phones), or all of it (wide). */
function frameBox() {
  const box = { x0: 0, y0: 0, x1: mapView.width, y1: mapView.height };
  if (layout() !== "full" || !mapView.width) return box;
  const top = $("#map-view").getBoundingClientRect().top;
  box.y0 = Math.max(0, sheet.frameTop() - top);
  box.y1 = Math.max(box.y0 + 80, Math.min(box.y1, sheet.mapBottom() - top));
  return box;
}

/** Centre the visible box on (x, y) metres at the current scale. */
function centreVisibleOn(x, y) {
  const b = visibleBox();
  mapView.cx = x - ((b.x0 + b.x1) / 2 - mapView.width / 2) / mapView.scale;
  mapView.cy = y - ((b.y0 + b.y1) / 2 - mapView.height / 2) / mapView.scale;
}

/** Zoom so that these buildings fit into the visible part, but no further in than `maxScale`. */
function fitTo(codes, maxScale = MAX_SCALE) {
  if (!mapView.width || !mapView.height) return; // hidden; the ResizeObserver fits once it's shown
  const pts = codes.map(anchorOf).filter(Boolean);
  if (!pts.length) return fitCampus();
  const xs = pts.map(([x]) => x);
  const ys = pts.map(([, y]) => y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const w = x1 - x0 + 2 * FIT_PADDING_M;
  const h = y1 - y0 + 2 * FIT_PADDING_M;
  const b = visibleBox();
  mapView.scale = clampScale(Math.min(maxScale, (b.x1 - b.x0) / w, (b.y1 - b.y0) / h));
  centreVisibleOn((x0 + x1) / 2, (y0 + y1) / 2);
  clampCentre();
}

// --- layouts ---

const layout = () => (WIDE.matches ? "side" : "full");

function applyLayout() {
  const lay = layout();
  const view = $("#map-view");
  for (const name of ["full", "side"]) view.classList.toggle(name, name === lay);
  syncFloorButton();
  syncLocating();
}

/** Where the map looks, e.g. after loading a campus: where it was last time, unless the list's buildings changed. */
function placeView() {
  const saved = mapView.saved.get(mapView.area);
  if (saved && saved.key === mapView.pickedKey) {
    Object.assign(mapView, { cx: saved.cx, cy: saved.cy, scale: saved.scale });
    mapView.scale = clampScale(mapView.scale);
    clampCentre();
  } else if (mapView.picked.size) fitTo([...mapView.picked], 2.5);
  else fitCampus();
}

/** Remember where the map was, with the list's buildings at the time. */
function saveView() {
  if (!mapView.doc) return;
  const { cx, cy, scale, pickedKey } = mapView;
  mapView.saved.set(mapView.area, { cx, cy, scale, key: pickedKey });
}

/** Called by app.js whenever the list's buildings or tab change. */
function syncMap() {
  const picked = pickedBuildings();
  const key = [...picked].sort().join(",");
  const changed = key !== mapView.pickedKey;
  if (changed) mapView.unmarked = false;
  mapView.picked = new Set(picked);
  mapView.pickedKey = key;
  syncFloorButton();
  if (!mapView.doc) return;
  markBuildings();
  if (!changed) return;
  ensureVisible(picked);
  scheduleDraw();
}

/** Move the map (zooming out if needed) so that these buildings are in the visible part. */
function ensureVisible(codes) {
  if (!mapView.width) return;
  const margin = 40;
  const b = visibleBox();
  const inView = codes.every((code) => {
    const at = anchorOf(code);
    if (!at) return true;
    const px = (at[0] - mapView.cx) * mapView.scale + mapView.width / 2;
    const py = (at[1] - mapView.cy) * mapView.scale + mapView.height / 2;
    return px > b.x0 + margin && px < b.x1 - margin && py > b.y0 + margin && py < b.y1 - margin;
  });
  if (!inView) fitTo(codes, mapView.scale);
}

function setHover(code) {
  if (code === mapView.hover) return;
  mapView.hover = code;
  markBuildings();
}

/**
 * Side layout: clicking a building filters the list to it, in a tab that has it (Shift, Ctrl or ⌘ adds it); a building
 * with neither study spaces nor rooms (one with only a mensa) opens its view instead (Eat has no building filter).
 */
function pickFromMap(code, add) {
  const s = mapView.summary.get(code);
  // Study's free rooms count too while Study is open: a building with only rooms to study in stays in Study.
  const hasStudy = (s ? s.study.total > 0 : spaceBuildingsOf("study")?.has(code)) || (state.mode === "study" && !!spaceBuildingsOf("study")?.has(code));
  const hasRooms = state.areaBuildings.includes(code);
  let mode;
  if (state.mode === "study" && hasStudy) mode = "study";
  else if (state.mode === "rooms" && hasRooms) mode = "rooms";
  else if (hasStudy) mode = "study";
  else if (hasRooms) mode = "rooms";
  else return openPlace({ kind: "building", id: code, area: state.area }, { from: placeFrom() });
  filterList(mode, code, add);
}

/** The furthest zoom out: the visible part exactly filled by the drawn area, never showing beyond it. */
function minScale() {
  const [x0, y0, x1, y1] = mapView.bounds;
  const b = frameBox();
  return Math.max((b.x1 - b.x0) / (x1 - x0), (b.y1 - b.y0) / (y1 - y0));
}

const clampScale = (s) => Math.min(mapView.floor ? FLOOR_MAX_SCALE : MAX_SCALE, Math.max(minScale(), s));

/** Keep the visible part of the view inside the drawn area (under the sheet and the top bar it may go beyond). */
function clampCentre() {
  const [x0, y0, x1, y1] = mapView.bounds;
  const b = frameBox();
  const s = mapView.scale;
  const ox = ((b.x0 + b.x1) / 2 - mapView.width / 2) / s;
  const oy = ((b.y0 + b.y1) / 2 - mapView.height / 2) / s;
  const hw = Math.min((b.x1 - b.x0) / s / 2, (x1 - x0) / 2);
  const hh = Math.min((b.y1 - b.y0) / s / 2, (y1 - y0) / 2);
  mapView.cx = Math.min(x1 - hw, Math.max(x0 + hw, mapView.cx + ox)) - ox;
  mapView.cy = Math.min(y1 - hh, Math.max(y0 + hh, mapView.cy + oy)) - oy;
}

function scheduleDraw() {
  if (!mapView.frame) mapView.frame = requestAnimationFrame(drawView);
}

function drawView() {
  mapView.frame = 0;
  if (!mapView.doc || !mapView.width) return;
  const { cx, cy, scale, width, height } = mapView;
  const w = width / scale;
  const h = height / scale;
  $("#map-svg").setAttribute("viewBox", `${cx - w / 2} ${cy - h / 2} ${w} ${h}`);
  const view = $("#map-view");
  view.classList.toggle("cards", scale >= CARD_SCALE);
  view.classList.toggle("close", scale >= 2.2);
  syncTiles();
  markBuildings(); // whether a building or its places take the highlight depends on the zoom
  placeLabels();
  placeFriendBubbles(); // friends' check-ins (friends.js), above the labels and never hidden by them
  if (mapView.floor) placeFloorLabels();
  syncFloorButton(); // under its building's label, which may just have moved
  drawMe();
  placeLinks();
}

/**
 * Position the labels and hide those overlapping a more important one (selected, then bigger buildings). When a label
 * overlaps just one other, the two move apart sideways instead, if that's a small step and clears both (e.g. ETZ and
 * GLC when zoomed out); zoomed in they no longer overlap and sit on their buildings again. Under the mensa or cafeteria
 * filter only their labels show: each on its pin, else on its building, stacked below the building's others.
 */
function placeLabels() {
  const { cx, cy, scale, width, height } = mapView;
  const isPlace = (node) => node.dataset.place !== undefined;
  const showPlaces = placeFilter();
  const all = [...mapView.labels.values()];
  for (const node of all) {
    // A label-only building without a pin isn't on the map, and neither are its places without pins of their own.
    const nowhere = !pinOf(node) && !anchorOf(node.dataset.code);
    const off = nowhere || (PIN_MODE
      ? isPlace(node) && !mapView.places.has(node.dataset.place) // pin mode: every label, to drag it
      : isPlace(node) ? !showPlaces || !mapView.places.has(node.dataset.place) || !placeShown(mapView.places.get(node.dataset.place)) : showPlaces);
    node.classList.toggle("off", off);
  }
  const far = campusesOnly();
  if (far) for (const node of all) node.classList.add("off");
  const buildings = all.filter((n) => !isPlace(n) && !n.classList.contains("off")).sort((a, b) => priority(b) - priority(a));
  const shownPlaces = all.filter((n) => isPlace(n) && !n.classList.contains("off"));
  const places = placeLabelOrder(shownPlaces.map((n) => n.dataset.place), placesFirst()).map((i) => shownPlaces[i]);
  const order = [...places, ...buildings];
  const placed = []; // { box, node, px, py, moved }
  const last = new Map(); // building -> box of the last place label stacked on it
  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  const boxAt = (px, py, w, h) => [px - w / 2, py - h / 2, px + w / 2, py + h / 2];
  // Labels may run off the map's edges.
  const outside = (box, px, py) => px < -60 || py < -40 || px > width + 60 || py > height + 40;
  const put = (node, px, py) => {
    node.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px) translate(-50%, -50%)`;
  };
  // The person's dot: a building label on it moves down to sit just below it, so neither hides the other.
  const me = !PIN_MODE ? meOnMap() : null;
  const meBox = me ? boxAt((me[0] - cx) * scale + width / 2, (me[1] - cy) * scale + height / 2, 20, 20) : null;
  // The campus tags first, so they win: every campus but the selected one (that one too when zoomed far out).
  mapView.shownTags = new Set();
  const vis = visibleBox();
  for (const [area, node] of mapView.campusTags ?? []) {
    const off = area === mapView.area && !far;
    node.classList.toggle("off", off);
    if (off) continue;
    const [ax, ay] = campusTagAt(area);
    const px = (ax - cx) * scale + width / 2;
    const py = (ay - cy) * scale + height / 2;
    put(node, px, py);
    const w = node.offsetWidth + 4;
    const h = node.offsetHeight + 4;
    // On the campus, else just below a campus tag it would cover (zoomed out, Zentrum's two meet); only where it's
    // fully in the visible part (not under the top bar or the sheet), else the edge buttons lead there.
    const hit = placed.find((o) => overlaps(boxAt(px, py, w, h), o.box));
    const spots = hit ? [[hit.px, hit.box[3] + h / 2 + 1], [hit.px, hit.box[1] - h / 2 - 1]] : [[px, py]];
    const fits = ([x, y]) => {
      const b = boxAt(x, y, w, h);
      return b[0] >= vis.x0 && b[1] >= vis.y0 && b[2] <= vis.x1 && b[3] <= vis.y1 && !placed.some((o) => overlaps(b, o.box));
    };
    const spot = spots.find(fits);
    node.classList.toggle("hidden", !spot);
    if (!spot) continue;
    const [x, y] = spot;
    const box = boxAt(x, y, w, h);
    put(node, x, y);
    placed.push({ box, node, px: x, py: y, moved: true });
    mapView.shownTags.add(area);
  }
  for (const node of order) {
    const code = node.dataset.code;
    const pin = pinOf(node);
    const [ax, ay] = pin ?? anchorOf(code);
    const px = (ax - cx) * scale + width / 2;
    let py = (ay - cy) * scale + height / 2;
    put(node, px, py);
    // Size without the transform; offsetWidth ignores it.
    const w = node.offsetWidth + 4;
    const h = node.offsetHeight + 4;
    if (meBox && !isPlace(node) && overlaps(boxAt(px, py, w, h), meBox)) {
      py = meBox[3] + h / 2;
      put(node, px, py);
    }
    node.classList.toggle("pinned", PIN_MODE && !!pin);
    node.classList.toggle("pin-selected", PIN_MODE && pinKey(node) === mapView.pinSelected);
    if (PIN_MODE && (!isPlace(node) || pin)) {
      // Every label where its pin (or building) says, none hidden, so each can be dragged; unpinned places stack below.
      node.classList.remove("hidden");
      placed.push({ box: boxAt(px, py, w, h), node, px, py, moved: true });
      continue;
    }
    if (isPlace(node) && pin) {
      // A pinned place sits on its pin, unless that's taken.
      const box = boxAt(px, py, w, h);
      const hidden = outside(box, px, py) || placed.some((o) => overlaps(box, o.box));
      node.classList.toggle("hidden", hidden);
      if (!hidden) placed.push({ box, node, px, py, moved: true });
      continue;
    }
    if (isPlace(node)) {
      // On its building, or below the last place label stacked there (then above or beside the first one).
      const first = last.get(`${code}:first`);
      const below = last.get(code);
      const x = first ? (first[0] + first[2]) / 2 : px;
      const y = first ? (first[1] + first[3]) / 2 : py;
      const spots = below
        // 1 px apart: exactly touching boxes can count as overlapping after floating-point rounding.
        ? [[x, below[3] + h / 2 + 1], [x, first[1] - h / 2 - 1], [first[2] + w / 2 + 1, y], [first[0] - w / 2 - 1, y]]
        : [[px, py]];
      const spot = spots.find(([x, y]) => {
        const bx = boxAt(x, y, w, h);
        return !outside(bx, x, y) && !placed.some((o) => overlaps(bx, o.box));
      }) ?? (PIN_MODE ? spots[0] : undefined); // pin mode hides nothing
      node.classList.toggle("hidden", !spot);
      if (spot) {
        put(node, ...spot);
        const box = boxAt(...spot, w, h);
        placed.push({ box, node, px: spot[0], py: spot[1], moved: true });
        if (spot === spots[0]) last.set(code, box);
        if (!first) last.set(`${code}:first`, box);
      }
      continue;
    }
    let box = boxAt(px, py, w, h);
    let hidden = outside(box, px, py);
    const hits = hidden ? [] : placed.filter((o) => overlaps(box, o.box));
    if (hits.length === 1 && !hits[0].moved) {
      const o = hits[0];
      const side = Math.sign(px - o.px) || 1; // this label goes to the side its building is on
      const d = (side > 0 ? o.box[2] - box[0] : box[2] - o.box[0]) + 2;
      const ow = o.box[2] - o.box[0];
      if (d <= Math.max(w, ow)) {
        const mine = boxAt(px + (side * d) / 2, py, w, h);
        const theirs = boxAt(o.px - (side * d) / 2, o.py, ow, o.box[3] - o.box[1]);
        const clear = (bx) => !placed.some((p) => p !== o && overlaps(bx, p.box));
        if (!overlaps(mine, theirs) && clear(mine) && clear(theirs) && !outside(mine, px, py) && !outside(theirs, o.px, o.py)) {
          o.box = theirs;
          o.moved = true;
          put(o.node, o.px - (side * d) / 2, o.py);
          put(node, px + (side * d) / 2, py);
          box = mine;
          placed.push({ box, node, px, py, moved: true });
          node.classList.remove("hidden");
          continue;
        }
      }
    }
    hidden = hidden || hits.length > 0;
    node.classList.toggle("hidden", hidden);
    if (!hidden) placed.push({ box, node, px, py, moved: false });
  }
  // Microwaves, under the mensa filter. Zoomed in, each entry is its own marker where it is (never hidden by the
  // labels: just beside one it would cover); pin mode shows them all, to drag. Where a building's markers would pile up,
  // its round label with the total instead: below its mensa labels (or on the building without one), placed last, so
  // it's the first to hide where labels crowd.
  const microList = (mapMicrowaves() ?? []).filter((m) => mapView.microSpots.has(m.id));
  const spotted = PIN_MODE ? new Set(microList.map((m) => m.building)) : microwaveSpots(microList.map((m) => ({ building: m.building, at: microAt(m) })), scale);
  for (const m of microList) {
    const node = mapView.microSpots.get(m.id);
    const at = microAt(m);
    const off = !at || (!PIN_MODE && (!layerOn("mensa") || far || !spotted.has(m.building)));
    node.classList.toggle("off", off);
    if (off) continue;
    const px = (at[0] - cx) * scale + width / 2;
    const py = (at[1] - cy) * scale + height / 2;
    const w = node.offsetWidth + 4;
    const h = node.offsetHeight + 4;
    // Beside a label it would cover (pin mode: exactly on its pin, to drag it).
    const spot = PIN_MODE ? [px, py] : besideBoxes(px, py, w, h, placed.map((o) => o.box));
    put(node, ...spot);
    placed.push({ box: [spot[0] - w / 2, spot[1] - h / 2, spot[0] + w / 2, spot[1] + h / 2], node, px: spot[0], py: spot[1], moved: true });
    node.classList.remove("hidden");
    node.classList.toggle("pinned", PIN_MODE && !!pinFor("microwaves", m.id));
    node.classList.toggle("pin-selected", PIN_MODE && pinKey(node) === mapView.pinSelected);
  }
  for (const [code, node] of mapView.microLabels) {
    const anchor = anchorOf(code);
    const off = !layerOn("mensa") || far || PIN_MODE || !anchor || spotted.has(code);
    node.classList.toggle("off", off);
    if (off) continue;
    const px = (anchor[0] - cx) * scale + width / 2;
    const py = (anchor[1] - cy) * scale + height / 2;
    put(node, px, py);
    const w = node.offsetWidth + 4;
    const h = node.offsetHeight + 4;
    const first = last.get(`${code}:first`);
    const below = last.get(code);
    const spots = below
      ? [[(below[0] + below[2]) / 2, below[3] + h / 2 + 1], [first[2] + w / 2 + 1, (first[1] + first[3]) / 2], [first[0] - w / 2 - 1, (first[1] + first[3]) / 2]]
      : [[px, py], [px, py + h + 1]];
    const spot = spots.find(([x, y]) => {
      const bx = boxAt(x, y, w, h);
      return !outside(bx, x, y) && !placed.some((o) => overlaps(bx, o.box));
    });
    node.classList.toggle("hidden", !spot);
    if (!spot) continue;
    put(node, ...spot);
    placed.push({ box: boxAt(...spot, w, h), node, px: spot[0], py: spot[1], moved: true });
  }
}

function priority(node) {
  const code = node.dataset.code;
  if (code === mapView.selected || isMarked(code)) return Infinity;
  const b = mapView.doc.buildings[code];
  // Greyed buildings give way to those with something open or free.
  return (node.classList.contains("dim") ? 0 : 1e8) + b.size;
}

/** Zoom by `factor` keeping the map point under (px, py) in place. */
function zoomAt(factor, px, py) {
  interruptFlight();
  stopGlide();
  const s0 = mapView.scale;
  const s1 = clampScale(s0 * factor);
  const mx = mapView.cx + (px - mapView.width / 2) / s0;
  const my = mapView.cy + (py - mapView.height / 2) / s0;
  mapView.cx = mx - (px - mapView.width / 2) / s1;
  mapView.cy = my - (py - mapView.height / 2) / s1;
  mapView.scale = s1;
  clampCentre();
  scheduleDraw();
}

function setupGestures() {
  const view = $("#map-view");
  const pointers = new Map();
  let start = null; // the first pointer's down position, to tell taps from drags
  let pinch = null;
  let dragging = null; // pin mode: the label being dragged

  view.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".map-tools, .map-top, .map-pins, .map-links, .map-floors-open, .edit-ui")) return;
    interruptFlight(); // a drag or pinch during a flight to another campus stops it where it is, and starts from there
    stopGlide();
    view.setPointerCapture(e.pointerId);
    if (editHooks.down?.(e)) return;
    const label = PIN_MODE ? e.target.closest(".map-label") : null;
    if (label) {
      dragging = { node: label, key: pinKey(label), x: e.clientX, y: e.clientY, moved: false };
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) start = { x: e.clientX, y: e.clientY, moved: false, target: e.target };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: mapView.scale, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      start.moved = true;
    }
  });

  view.addEventListener("pointermove", (e) => {
    if (dragging) {
      if (!dragging.moved && Math.hypot(e.clientX - dragging.x, e.clientY - dragging.y) < TAP_SLOP) return;
      dragging.moved = true;
      mapView.pinSelected = dragging.key;
      setMyPin(dragging.key, toMetres(e.clientX, e.clientY));
      scheduleDraw();
      return;
    }
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const now = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, now);
    if (pointers.size === 1) {
      if (!start.moved && Math.hypot(now.x - start.x, now.y - start.y) < TAP_SLOP) return;
      start.moved = true;
      mapView.cx -= (now.x - prev.x) / mapView.scale;
      mapView.cy -= (now.y - prev.y) / mapView.scale;
      clampCentre();
      scheduleDraw();
    } else if (pointers.size === 2 && pinch) {
      // Like Google Maps: the two fingers zoom around their midpoint and pan the map as the midpoint moves.
      const [a, b] = [...pointers.values()];
      const rect = view.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      mapView.cx -= (mid.x - pinch.mid.x) / mapView.scale;
      mapView.cy -= (mid.y - pinch.mid.y) / mapView.scale;
      pinch.mid = mid;
      const factor = (pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.dist / mapView.scale;
      zoomAt(factor, mid.x - rect.left, mid.y - rect.top);
    }
  });

  const end = (e) => {
    if (dragging) {
      mapView.pinSelected = dragging.key; // a tap picks the label, a drag moves it
      dragging = null;
      renderPinPanel();
      scheduleDraw();
      return;
    }
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0 && start && !start.moved && e.type === "pointerup" && mapView.doc && !editHooks.tap?.(start.target, e)) tap(start.target, e);
    if (pointers.size === 0) start = null;
  };
  view.addEventListener("pointerup", end);
  view.addEventListener("pointercancel", end);

  view.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = view.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  view.addEventListener("dblclick", (e) => {
    if (e.target.closest(".map-tools, .map-top, .map-label, .friend-bubble, .floor-label, .floor-link, .floor-tag, .map-pins, .map-links, .map-floors-open")) return;
    const rect = view.getBoundingClientRect();
    zoomAt(2, e.clientX - rect.left, e.clientY - rect.top);
  });

  // Keyboard: labels are buttons, so Tab reaches them; Enter or Space opens the building.
  view.addEventListener("keydown", (e) => {
    const floorLink = e.target.closest?.(".floor-link");
    if (floorLink && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      switchFloors(floorLink.dataset.link, floorLink.dataset.level);
      return;
    }
    const floorTag = e.target.closest?.(".floor-tag.plans");
    if (floorTag && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      switchFloors(floorTag.dataset.tag);
      return;
    }
    const floorLabel = e.target.closest?.(".floor-label");
    if (floorLabel && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      pickFloor(floorLabel.dataset.floor);
      return;
    }
    const friendBubble = e.target.closest?.(".friend-bubble");
    if (friendBubble && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      return openFriendsAt(friendBubble.dataset.keys);
    }
    const label = e.target.closest?.(".map-label");
    if (label && !PIN_MODE && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      if (label.classList.contains("micro")) return openMicrowaves(label.dataset.code, label.dataset.microwave);
      if (label.classList.contains("campus")) return campusTapped(label.dataset.area);
      selectBuilding(label.dataset.code, e.shiftKey || e.metaKey || e.ctrlKey, label.dataset.place ?? null);
    }
  });

  $("#map-zoom-in").addEventListener("click", () => zoomAt(1.6, mapView.width / 2, mapView.height / 2));
  $("#map-zoom-out").addEventListener("click", () => zoomAt(1 / 1.6, mapView.width / 2, mapView.height / 2));
  $("#map-fit").addEventListener("click", () => {
    if (mapView.flight) return;
    stopGlide();
    mapView.floor ? fitFloor() : fitCampus();
    scheduleDraw();
  });

  new ResizeObserver(() => {
    if (!mapView.doc) return;
    const firstSize = !mapView.width;
    measure();
    if (firstSize) placeView();
    else {
      mapView.scale = clampScale(mapView.scale);
      clampCentre();
    }
    scheduleDraw();
  }).observe(view);
}

function tap(target, e) {
  if (mapView.floor) return floorTap(target);
  if (PIN_MODE && target.closest?.(".map-label")) return;
  const friends = target.closest?.(".friend-bubble")?.dataset.keys;
  if (friends) return openFriendsAt(friends);
  const micro = target.closest?.(".map-label.micro");
  if (micro) return openMicrowaves(micro.dataset.code, micro.dataset.microwave);
  // Another campus's tag or building switches to it; the selected campus's own tag zooms to it.
  const campus = target.closest?.(".map-label.campus, .map-buildings.inactive")?.dataset.area;
  if (campus) return campusTapped(campus);
  const code = target.closest?.("[data-code]")?.dataset.code;
  const place = target.closest?.(".map-label")?.dataset.place ?? null;
  // Side layout: the study-space and room counts on a label open that tab, filtered to the building.
  const mode = target.closest?.(".n[data-mode]")?.dataset.mode;
  const add = e.shiftKey || e.metaKey || e.ctrlKey;
  if (code && mode && layout() === "side") {
    remark();
    if (!add) clearPickedBuildings({ keep: code, render: false }); // another building: Study's and Meet's picks reset
    filterList(mode, code, add);
  } else if (code) selectBuilding(code, add, place);
  else {
    // Beside the buildings: a place's view closes, back to the tab's list, and the buildings picked in Study and
    // Meet are reset; with nothing to reset only the highlights go (the You tab's starred buildings).
    const left = placeToList();
    if (!clearPickedBuildings() && !left) unmark();
  }
}

/** Picking a building on the map highlights the list's buildings again. */
function remark() {
  mapView.unmarked = false;
  scheduleDraw(); // brings back the floor plans button, if the list stays the same
}

/** A tap beside the buildings on a phone (or in the You tab): stop highlighting the list's buildings, leaving the list as it is. */
function unmark() {
  if (!mapView.picked.size || mapView.unmarked) return;
  mapView.unmarked = true;
  markBuildings();
  syncFloorButton();
  scheduleDraw();
}

// --- a building or place on the map opens its detail view (static/places.js) ---

/**
 * A building (or one of its mensas' labels, `place`) was picked: on phones its detail view opens in the sheet; on
 * wide windows the list is filtered to it (Shift, Ctrl or ⌘ adds it). A mensa's label opens its view everywhere, and
 * so does a building in the Eat tab, which has no building filter.
 */
function selectBuilding(code, add = false, place = null) {
  remark();
  // The other Zentrum campus's mensa: its own view, over this campus's list.
  if (place && mapView.summary.get(code)?.partner) return openPlace({ kind: "space", id: place, area: ZENTRUM_PARTNER[state.area] }, { from: placeFrom() });
  if (place) return openPlace({ kind: "space", id: place, area: state.area }, { from: placeFrom() });
  // A building that isn't picked in the lists: Study's and Meet's picks reset (wide windows then pick it alone).
  if (!add) clearPickedBuildings({ keep: code });
  if (layout() === "side" && state.mode !== "mensa") return pickFromMap(code, add);
  openPlace({ kind: "building", id: code, area: state.area }, { from: placeFrom() });
}

/** From the map, a place replaces the one shown (Back still returns to the list). */
const placeFrom = () => (placesView.current ? "place" : "list");

/** Move the map so the building is in its visible part. */
function revealBuilding(code) {
  const at = anchorOf(code);
  if (at) revealPoint(at);
}

/** Move the map so this point (metres) is in its visible part (not under the sheet or the top bar). */
function revealPoint(at) {
  if (layout() === "full" && sheet.current() === "full") return; // the map is out of sight
  const free = visibleBox();
  const px = (at[0] - mapView.cx) * mapView.scale + mapView.width / 2;
  const py = (at[1] - mapView.cy) * mapView.scale + mapView.height / 2;
  const margin = 50;
  if (px > free.x0 + margin && px < free.x1 - margin && py > free.y0 + margin && py < free.y1 - margin) return;
  const tx = (free.x0 + free.x1) / 2;
  const ty = (free.y0 + free.y1) / 2;
  mapView.cx += (px - tx) / mapView.scale;
  mapView.cy += (py - ty) / mapView.scale;
  clampCentre();
}

/** Stop highlighting the picked building (the detail view stays). */
function closeSheet() {
  if (!mapView.selected) return;
  mapView.selected = null;
  mapView.selectedMensa = false;
  fillLabels();
  scheduleDraw();
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "3 h 10 min" from `at` until `iso`, or null when there's no end. */
function freeFor(iso, at) {
  if (!iso) return null;
  const min = Math.round((Date.parse(iso) - Date.parse(at)) / 60000);
  const h = Math.floor(min / 60);
  return h ? `${h} h${min % 60 ? ` ${min % 60} min` : ""}` : `${min} min`;
}

function freeLine(r, at) {
  if (!r.free_until || day(r.free_until) !== day(at)) return el("span", { class: "ok-t" }, "free rest of day");
  return el("span", {}, el("span", { class: "ok-t" }, `free until ${hhmm(r.free_until)}`), ` · ${freeFor(r.free_until, at)}`);
}

/** "About 40 % full · open until 20:00" for a study space. */
function studyLine(space, at) {
  const occ = space.occupancy
    ? el("span", {}, el("i", { class: `occ-dot ${space.occupancy.status}` }), el("span", { class: `occ-t ${space.occupancy.status}` }, ` about ${space.occupancy.pct} % full`), " · ")
    : "";
  const until = space.until && day(space.until) === day(at) ? `open until ${hhmm(space.until)}` : "open";
  return el("span", {}, occ, until);
}

// --- campus buttons: arrows to the neighbouring campuses ---
//
// The two Zentrum maps overlap, so each has a button on the other's main building (UZH Zentrum on KOL, ETH Zentrum on
// HG): it moves with the map and, while that building is out of view, waits at the edge (in the corner) nearest it.
// Tapping it pans smoothly from here to that building on the other map. The other buttons sit at the edge of the view
// in their campus's direction and are hidden once zoomed in.

/** Where the buttons point (lat, lon): HG's and KOL's labels, and the middle of the other campus files. */
const CAMPUS_POINTS = {
  HG: [47.37671, 8.54774],
  KOL: [47.37479, 8.54835],
  IFW: [47.38024, 8.54459],
  CHN: [47.37918, 8.5486],
  ZENTRUM: [47.37575, 8.54805], // between HG and KOL
  H: [47.40809, 8.50866],
  UI: [47.39829, 8.54967],
  UO: [47.4126, 8.54473],
};

/**
 * Per campus, its buttons: `on` a building of the other map (CAMPUS_POINTS), always shown; at the edge `toward` a
 * point, or `along` the way from one of this map's buildings to another (from ETH Zentrum, Hönggerberg lies the way
 * from HG to IFW and Irchel from HG to CHN). `to` is one campus, or several side by side.
 */
const CAMPUS_LINKS = {
  Z: [{ to: ["H"], along: ["HG", "IFW"] }, { to: ["UI"], along: ["HG", "CHN"] }],
  UZ: [{ to: ["H"], along: ["HG", "IFW"] }, { to: ["UI"], along: ["HG", "CHN"] }],
  UI: [{ to: ["Z", "UZ"], toward: "ZENTRUM" }, { to: ["H"], toward: "H" }, { to: ["UO"], toward: "UO" }],
  H: [{ to: ["UI"], toward: "UI" }, { to: ["Z"], toward: "HG" }],
  UO: [{ to: ["UI"], toward: "UI" }],
};

/**
 * The edge buttons are hidden once zoomed in this much further than the whole-campus view, but never below
 * LINK_HIDE_SCALE (px per metre): small campuses (Hönggerberg) already fill the screen zoomed in.
 */
const LINK_HIDE_ZOOM = 1.6;
const LINK_HIDE_SCALE = 1.2;
const ARROW_ICON = "M2.5 8h11M9 3.5 13.5 8 9 12.5";

/** Make this campus's buttons (on loading it, and again once the campus names are in). */
function renderLinks() {
  const names = new Map((state.areas?.areas ?? []).map((a) => [a.area, a.name]));
  mapView.links = (CAMPUS_LINKS[mapView.area] ?? []).map((link) => {
    const arrow = smallIcon(ARROW_ICON);
    arrow.classList.add("arrow");
    const buttons = link.to.map((area) => {
      const n = friendsOnCampus(area);
      const b = el("button", { type: "button", "aria-label": `Switch to ${names.get(area) ?? area}${n ? `, ${plural(n, "friend", "friends")} checked in there` : ""}` }, names.get(area) ?? area, friendsBadge(area) ?? "");
      b.addEventListener("click", () => switchCampus(area));
      return b;
    });
    const node = el("div", { class: "map-link" + (link.on ? " on-building" : "") }, arrow, ...buttons);
    return { link, node, arrow };
  });
  $("#map-links").replaceChildren(...mapView.links.map((l) => l.node));
}

/**
 * The part of the map view the buttons may use (px): below the location bar, above the notes, the logo and the sheet.
 * `tools` is the zoom and layer column, which the buttons step around.
 */
function linkArea() {
  const view = $("#map-view").getBoundingClientRect();
  const m = 8;
  const vis = visibleBox();
  const a = { x0: vis.x0 + m, y0: vis.y0 + m, x1: vis.x1 - m, y1: vis.y1 - m };
  for (const node of [$("#map-note"), $(".map-attrib")]) {
    const r = node.getBoundingClientRect();
    if (r.height) a.y1 = Math.min(a.y1, r.top - view.top - m);
  }
  const t = $(".map-tools").getBoundingClientRect();
  a.tools = { x0: t.left - view.left - m, y1: t.bottom - view.top + m };
  return a;
}

/** Place the buttons for the current view (from drawView). */
function placeLinks() {
  const box = $("#map-links");
  box.hidden = PIN_MODE || !mapView.links?.length;
  if (box.hidden) return;
  const { cx, cy, scale, width, height, doc } = mapView;
  const toPx = ([x, y]) => [(x - cx) * scale + width / 2, (y - cy) * scale + height / 2];
  const area = linkArea();
  const placed = [];
  const hideFrom = Math.max(LINK_HIDE_SCALE, campusScale() * LINK_HIDE_ZOOM);
  for (const { link, node, arrow } of mapView.links) {
    // Hidden zoomed in, and while the campus's own tag is in view (that's where to tap then).
    node.hidden = (!link.on && scale >= hideFrom) || link.to.every((a) => mapView.shownTags.has(a));
    if (node.hidden) continue;
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    // Where the button's centre may go.
    const r = { x0: area.x0 + w / 2, y0: area.y0 + h / 2, x1: Math.max(area.x0 + w / 2, area.x1 - w / 2), y1: Math.max(area.y0 + h / 2, area.y1 - h / 2) };
    let px;
    let py;
    let angle = null; // the arrow's direction; none while the button sits on its building
    if (link.on) {
      const [tx, ty] = toPx(gpsToMap(doc.origin, ...CAMPUS_POINTS[link.on]));
      px = Math.min(r.x1, Math.max(r.x0, tx));
      py = Math.min(r.y1, Math.max(r.y0, ty));
      if (px !== tx || py !== ty) angle = Math.atan2(ty - py, tx - px);
    } else {
      // From the middle of the free area, out to its edge in the campus's direction.
      const c = [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
      let d;
      if (link.along) {
        // A direction, the same on both Zentrum maps.
        const [a, b] = link.along.map((p) => gpsToMap(doc.origin, ...CAMPUS_POINTS[p]));
        d = [b[0] - a[0], b[1] - a[1]];
      } else {
        const [tx, ty] = toPx(gpsToMap(doc.origin, ...CAMPUS_POINTS[link.toward]));
        d = [tx - c[0], ty - c[1]];
      }
      const reach = (dv, lo, hi, cv) => (dv > 0 ? (hi - cv) / dv : dv < 0 ? (lo - cv) / dv : Infinity);
      const t = Math.min(reach(d[0], r.x0, r.x1, c[0]), reach(d[1], r.y0, r.y1, c[1]));
      px = c[0] + t * d[0];
      py = c[1] + t * d[1];
      angle = Math.atan2(d[1], d[0]);
    }
    // Beside the zoom and layer buttons, not under them.
    if (px + w / 2 > area.tools.x0 && py - h / 2 < area.tools.y1) px = Math.max(r.x0, area.tools.x0 - w / 2);
    // Clear of the buttons placed before it: along the edge it's on.
    for (const o of placed) {
      if (Math.abs(px - o.px) >= (w + o.w) / 2 + 4 || Math.abs(py - o.py) >= (h + o.h) / 2 + 4) continue;
      const side = px <= r.x0 + 1 || px >= r.x1 - 1;
      if (side) py = Math.min(r.y1, Math.max(r.y0, py >= o.py ? o.py + (h + o.h) / 2 + 4 : o.py - (h + o.h) / 2 - 4));
      else px = Math.min(r.x1, Math.max(r.x0, px >= o.px ? o.px + (w + o.w) / 2 + 4 : o.px - (w + o.w) / 2 - 4));
    }
    placed.push({ px, py, w, h });
    node.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px) translate(-50%, -50%)`;
    node.classList.toggle("at", angle === null);
    // The arrow points up, down, left or right, whichever is closest: easier to read than a slant.
    if (angle !== null) arrow.style.transform = `rotate(${Math.round(angle / (Math.PI / 2)) * 90}deg)`;
  }
}

/** Switch campus from a button (the map flies there: flyMapTo). */
function switchCampus(area) {
  selectArea(area);
}

/** The new campus's drawing is in: a flight's handoff takes the view as it is now (in the old campus's metres). */
function settleHandoff() {
  const h = mapView.handoff;
  if (!h?.live) return;
  mapView.handoff = { from: mapToGps(h.live.origin, mapView.cx, mapView.cy), scale: mapView.scale, flown: true };
}

/** Just after landing (the new campus drawn): the view where the flight ended, in the new campus's metres. */
function finishHandoff(doc) {
  const h = mapView.handoff;
  mapView.handoff = null;
  const [x, y] = gpsToMap(doc.origin, ...h.from);
  Object.assign(mapView, { cx: x, cy: y, scale: clampScale(h.scale) });
  clampCentre();
  scheduleDraw();
}

// --- flying to another campus ---
//
// The campuses are separate maps, but they share one frame (their `origin`s), and the overview fills the land between
// them. Switching campus while the map is in view (a campus button, the location bar or the list) flies there: zoom
// out, across the overview, and in on the other campus, which is drawn beside this one for the flight. On landing the
// switch finishes as usual (the list follows the selected campus all along). The two Zentrum campuses are one map:
// switching between them doesn't fly. The map stays as it is until the other campus's numbers are in, then swaps in
// one go: its buildings light up with their labels, and the view jumps to its main building (HG, KOL) if that isn't
// in view already (zentrumSwap).

/** The other Zentrum campus, drawn with this one, and the building a switch to it flies to. */
const ZENTRUM_PARTNER = { Z: "UZ", UZ: "Z" };
const MAIN_BUILDING = { Z: "HG", UZ: "KOL" };
/** How fast flights go: 1 is about 1.1 s plus 1 s per 3 km, at most 2.6 s (1.5 felt too fast). */
const FLIGHT_SPEED = 1;
/** A switch to HG or KOL lands at least this far zoomed in (px per metre). */
const MAIN_BUILDING_SCALE = 1.2;

/** Called by app.js's selectArea before the new campus loads. */
function flyMapTo(area) {
  const fromDoc = mapView.doc;
  const doc = mapView.campuses.get(area);
  if (!fromDoc || !doc || area === mapView.area || PIN_MODE || mapView.flight) return;
  saveView();
  closeSheet();
  if (ZENTRUM_PARTNER[mapView.area] === area) return; // no flight: refreshMapNow swaps them at once
  mapView.flight = (async () => {
    // Already drawn: its buildings light up, this campus's go pale, and off there.
    const { buildings } = mapView.world;
    buildings.get(mapView.area).classList.replace("active", "inactive");
    buildings.get(area).classList.replace("inactive", "flight");
    $("#map-view").classList.add("flying");
    const [ox, oy] = offsetOf(fromDoc, doc);
    const land = wholeCampus(doc);
    // Landed, or stopped by a drag (interruptFlight): either way the new campus takes over from wherever the view is
    // once its drawing is in (settleHandoff), which may be further along the drag by then.
    await flyTo(ox + land.cx, oy + land.cy, land.scale);
    mapView.handoff = { live: fromDoc, flown: true };
  })();
  mapView.flight.finally(() => (mapView.flight = null));
}

/**
 * Switching to the other Zentrum campus (`area`), just before the swap: where the view will be, as a handoff. It stays
 * where it is if `area`'s main building is in the visible part, else it moves there (zoomed in at least so far).
 */
function zentrumSwap(area) {
  const fromDoc = mapView.doc;
  const [tx, ty] = gpsToMap(fromDoc.origin, ...CAMPUS_POINTS[MAIN_BUILDING[area]]);
  const { cx, cy, scale, width, height } = mapView;
  const px = (tx - cx) * scale + width / 2;
  const py = (ty - cy) * scale + height / 2;
  const vis = visibleBox();
  const inView = px >= vis.x0 && px <= vis.x1 && py >= vis.y0 && py <= vis.y1;
  mapView.handoff = inView
    ? { from: mapToGps(fromDoc.origin, cx, cy), scale, flown: true }
    : { from: mapToGps(fromDoc.origin, tx, ty), scale: Math.min(MAX_SCALE, Math.max(scale, MAIN_BUILDING_SCALE)), flown: true };
}

/** The view of a whole campus (its own metres), as fitCampus would show it. */
function wholeCampus(doc) {
  const pts = Object.values(doc.buildings).filter((b) => b.outline !== false).map((b) => [b.x, b.y]);
  const xs = pts.map(([x]) => x);
  const ys = pts.map(([, y]) => y);
  const [bx0, by0, bx1, by1] = doc.bounds;
  // Fitted into the visible part (phones: between the top bar and the sheet), centred there.
  const box = frameBox();
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const least = Math.max(w / (bx1 - bx0), h / (by1 - by0));
  const scale = Math.min(MAX_SCALE, Math.max(least, Math.min(w / (Math.max(...xs) - Math.min(...xs) + 2 * FIT_PADDING_M), h / (Math.max(...ys) - Math.min(...ys) + 2 * FIT_PADDING_M))));
  const hw = Math.min(w / scale / 2, (bx1 - bx0) / 2);
  const hh = Math.min(h / scale / 2, (by1 - by0) / 2);
  const ox = ((box.x0 + box.x1) / 2 - mapView.width / 2) / scale;
  const oy = ((box.y0 + box.y1) / 2 - mapView.height / 2) / scale;
  return {
    cx: Math.min(bx1 - hw, Math.max(bx0 + hw, (Math.min(...xs) + Math.max(...xs)) / 2)) - ox,
    cy: Math.min(by1 - hh, Math.max(by0 + hh, (Math.min(...ys) + Math.max(...ys)) / 2)) - oy,
    scale,
  };
}

/**
 * Fly to (x, y) at `scale`, outside the usual limits: zoomed out in the middle far enough to see both ends, and
 * moving along slowly where zoomed in, quickly where zoomed out. Resolves with "landed" on arrival, also when stopGlide
 * cuts it short (it jumps to the end), or with "stopped" when a gesture interrupts it (interruptFlight: the view stays
 * where the last frame put it).
 */
function flyTo(x, y, scale) {
  const from = { cx: mapView.cx, cy: mapView.cy, scale: mapView.scale };
  const id = ++mapView.glide;
  const land = () => {
    Object.assign(mapView, { cx: x, cy: y, scale });
    scheduleDraw();
    return "landed";
  };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve(land());
  const dist = Math.hypot(x - from.cx, y - from.cy);
  const a = Math.log(from.scale);
  const b = Math.log(scale);
  const mid = Math.log((Math.min(mapView.width, mapView.height) * 0.8) / (dist + 300)); // both ends in view
  const dip = Math.max(0, (a + b) / 2 - mid);
  const ms = Math.min(2600, 1100 + dist / 3) / FLIGHT_SPEED;
  return new Promise((resolve) => {
    const start = performance.now();
    let stopped = false;
    mapView.stopFlight = () => {
      stopped = true;
      mapView.stopFlight = null;
      resolve("stopped");
    };
    const step = (now) => {
      if (stopped) return;
      if (id !== mapView.glide) {
        mapView.stopFlight = null;
        return resolve(land());
      }
      const t = Math.min(1, (now - start) / ms);
      const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2; // ease in and out
      mapView.cx = from.cx + (x - from.cx) * e;
      mapView.cy = from.cy + (y - from.cy) * e;
      mapView.scale = Math.exp(a + (b - a) * e - dip * Math.sin(Math.PI * t));
      scheduleDraw();
      if (t < 1) requestAnimationFrame(step);
      else {
        mapView.stopFlight = null;
        resolve("landed");
      }
    };
    requestAnimationFrame(step);
  });
}

/** Stops the running pan or flight by jumping to its end (for a pan or flight the page itself replaces). */
const stopGlide = () => mapView.glide++;

/**
 * A gesture during a flight (flyTo) stops it where it is: the zoom comes back within the map's limits, and the
 * gesture moves the map from there. The switch to the other campus still completes (flyMapTo). False without one.
 */
function interruptFlight() {
  if (!mapView.stopFlight) return false;
  mapView.stopFlight();
  mapView.scale = clampScale(mapView.scale);
  clampCentre();
  scheduleDraw();
  return true;
}

// --- near you: the person's position, and the nearest open study spaces and free rooms (helpers in geo.js) ---
//
// Only after a click on the locate button, or on load when the browser says the permission is granted already. The
// position stays in memory on the device: it's never stored or sent, and the browser is asked for it only while the
// page is visible.

/** Positions this rough (m) or worse get a note that the distances are rough, and no "you're in <building>". */
const ROUGH_FIX_M = 60;
/** "Near you" is filled again when the person has moved this far (m). */
const NEAR_REFILL_M = 25;

/** The buildings' distances for the lists, and where the person was when they were worked out. */
const distances = { from: null, area: null, map: null };

/**
 * Metres from the person to each building of this campus (straight line to its label anchor; 0 for the building
 * they're in), or null when the position is unknown or not on this campus. Worked out again after moving
 * NEAR_REFILL_M. Buildings only: indoor GPS has no floor (CHOICES.md).
 */
function placeDistances() {
  const here = meOn(mapView.doc);
  if (!here) return null;
  if (distances.from && distances.area === mapView.area && Math.hypot(here[0] - distances.from[0], here[1] - distances.from[1]) <= NEAR_REFILL_M) return distances.map;
  const inside = buildingAt(here);
  const map = new Map();
  for (const code of Object.keys(mapView.doc.buildings)) {
    const at = anchorOf(code);
    if (at) map.set(code, code === inside ? 0 : Math.hypot(at[0] - here[0], at[1] - here[1]));
  }
  Object.assign(distances, { from: here, area: mapView.area, map });
  return map;
}

/** Where the person is on this campus drawing ([x, y] in metres), or null when not on it (or unknown). */
function meOn(doc) {
  if (!mapView.me || !doc?.origin) return null;
  const p = gpsToMap(doc.origin, mapView.me.lat, mapView.me.lon);
  return distanceToBounds(doc.bounds, p) === 0 ? p : null;
}

/** The building the person is in, when the position is exact enough to tell. */
function buildingAt([x, y]) {
  if (mapView.me.acc > ROUGH_FIX_M) return null;
  for (const path of document.querySelectorAll("#map-svg .map-buildings.active .map-building")) {
    try {
      if (path.isPointInFill(new DOMPoint(x, y))) return path.dataset.code;
    } catch {
      return null; // an older browser without isPointInFill(DOMPoint)
    }
  }
  return null;
}

function renderLocateButton() {
  const b = $("#map-locate");
  b.classList.toggle("wait", mapView.locate === "wait");
  b.setAttribute("aria-pressed", String(mapView.locate === "on"));
}

/** Ask the browser for the position while the person wants it and the map is in view; stop otherwise. */
function syncLocating() {
  const want = mapView.locate !== "off" && document.visibilityState === "visible";
  if (want && mapView.watch === null) {
    mapView.watch = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  } else if (!want && mapView.watch !== null) {
    navigator.geolocation.clearWatch(mapView.watch);
    mapView.watch = null;
  }
}

/** The locate button: start, or go back to the person and show what's near them. */
function locateTapped() {
  if (!("geolocation" in navigator)) return showNear("This browser can't tell the map where you are.");
  mapView.goToMe = true;
  if (mapView.locate === "on" && mapView.me) return goToMe();
  mapView.locate = "wait";
  renderLocateButton();
  syncLocating();
}

/**
 * Ask for the position without going there or opening Near you (search's "… near you": the lists sort by distance
 * once it's known). Nothing when it's on or on its way already.
 */
function locateQuietly() {
  if (!("geolocation" in navigator) || mapView.locate !== "off") return;
  mapView.locate = "wait";
  renderLocateButton();
  syncLocating();
}

function stopLocating() {
  mapView.locate = "off";
  mapView.me = null;
  distances.from = null;
  distancesChanged();
  mapView.goToMe = false;
  mapView.pendingLocate = false;
  syncLocating();
  renderLocateButton();
  scheduleDraw();
}

function onFix(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  mapView.me = { lat, lon, acc: accuracy };
  mapView.locate = "on";
  renderLocateButton();
  scheduleDraw();
  // The lists sort by distance: again once the person has moved a bit.
  const at = meOn(mapView.doc);
  const sorted = distances.from;
  if (at && (!sorted || Math.hypot(at[0] - sorted[0], at[1] - sorted[1]) > NEAR_REFILL_M)) {
    distances.from = null;
    distancesChanged();
  }
  // The check-in view lists the buildings around the person: drawn once the position is in.
  if (!mapView.goToMe && checkinShown()) drawCheckinPlaces();
  if (mapView.goToMe) return goToMe();
  // Walking around: fill the list again once they've moved a bit.
  const here = meOn(mapView.doc);
  if (nearShown() && !mapView.nearMessage && here && (!mapView.nearAt || Math.hypot(here[0] - mapView.nearAt[0], here[1] - mapView.nearAt[1]) > NEAR_REFILL_M)) refreshPlace();
}

function onFixError(err) {
  if (mapView.me && err.code !== err.PERMISSION_DENIED) return; // keep the last position; the watch goes on
  const denied = err.code === err.PERMISSION_DENIED;
  mapView.locate = "off";
  mapView.goToMe = false;
  syncLocating();
  renderLocateButton();
  const why = denied
    ? "Location is blocked for frooms. Allow it in your browser's settings to see what's near you."
    : "Couldn't find where you are. Try again in a moment, or near a window.";
  // In the check-in view the message shows there (Near you would take its place).
  if (checkinShown()) {
    mapView.nearMessage = why;
    return drawCheckinPlaces();
  }
  showNear(why);
}

/** Centre the map on the person and show "Near you"; switch to the campus they're on first, if it's another one. */
async function goToMe() {
  mapView.goToMe = false;
  if (!mapView.doc) {
    mapView.pendingLocate = true; // refreshMap goes on once the drawing is in
    return;
  }
  const here = meOn(mapView.doc);
  if (here) return showNearAt(here);
  // Not on this campus: on another one? (Their drawings are in the service worker's cache, so this is quick.)
  const areas = state.areas?.primary ?? [];
  const docs = (await Promise.all(areas.map((a) => loadCampus(a).then((d) => [a, d], () => null)))).filter(Boolean);
  if (!mapView.me) return; // stopped meanwhile
  const away = docs.map(([area, d]) => ({ area, d: distanceToBounds(d.bounds, gpsToMap(d.origin, mapView.me.lat, mapView.me.lon)) }))
    .sort((a, b) => a.d - b.d)[0];
  if (away?.d === 0) {
    mapView.pendingLocate = true;
    return selectArea(away.area);
  }
  const name = state.areas.areas.find((a) => a.area === away?.area)?.name ?? "";
  showNear(away ? `You're ${distanceText(away.d)} from the nearest campus${name ? `, ${name}` : ""}. Near you shows what's free once you're on one.` : "You're not on a campus.");
}

/** Open "Near you" and move the map onto the person (zoomed in far enough for the counts). */
function showNearAt(here) {
  stopGlide();
  showNear(null);
  mapView.scale = clampScale(Math.max(mapView.scale, 1.6));
  centreVisibleOn(here[0], here[1]);
  clampCentre();
  revealPoint(here);
  scheduleDraw();
}

/** Open "Near you" in the sheet: the list, or `message` instead. */
function showNear(message) {
  mapView.nearMessage = message;
  if (nearShown()) return refreshPlace();
  openPlace({ kind: "near" }, { from: placeFrom() });
}

/** How far the glow reaches, in multiples of the position's accuracy: it fades out past it instead of ending there. */
const GLOW_REACH = 1.6;
/** The glow's smallest radius (m), so a very exact position still shows a little halo around the dot. */
const GLOW_MIN_M = 4;

/**
 * The person on the map: a dot (above the labels), and a blue glow for how exact the position is (in metres, below
 * the labels): strongest where the browser puts them, fading out past the accuracy radius. Inside buildings GPS is
 * often off by tens of metres, so this shows where they might be rather than a hard circle.
 */
/** The person's position on the map (the selected campus's metres), anywhere over the campuses; else null. */
function meOnMap() {
  if (!mapView.me || !mapView.doc?.origin || !mapView.bounds) return null;
  const p = gpsToMap(mapView.doc.origin, mapView.me.lat, mapView.me.lon);
  return distanceToBounds(mapView.bounds, p) === 0 ? p : null;
}

function drawMe() {
  const here = meOnMap();
  const svg = $("#map-svg");
  let glow = svg.querySelector(".map-me-acc");
  if (!glow) {
    glow = svgEl("g", { class: "map-me-acc" });
    const grad = svgEl("radialGradient", { id: "map-me-glow" });
    // Roughly a bell curve: the accuracy radius is at 1 / GLOW_REACH = 0.625.
    for (const [offset, opacity] of [[0, 0.62], [0.12, 0.55], [0.3, 0.36], [0.5, 0.18], [0.625, 0.11], [0.8, 0.04], [1, 0]]) {
      grad.append(svgEl("stop", { offset, "stop-opacity": opacity }));
    }
    const defs = svgEl("defs");
    defs.append(grad);
    glow.append(defs, svgEl("circle", { fill: "url(#map-me-glow)" }));
  }
  // Last in the drawing, so it also lies over a floor plan (drawn after it).
  if (svg.lastElementChild !== glow) svg.append(glow);
  const dot = $("#map-me");
  glow.style.display = here ? "" : "none";
  dot.hidden = !here;
  if (!here) return;
  const circle = glow.querySelector("circle");
  circle.setAttribute("cx", here[0]);
  circle.setAttribute("cy", here[1]);
  circle.setAttribute("r", Math.max(mapView.me.acc * GLOW_REACH, GLOW_MIN_M));
  const px = (here[0] - mapView.cx) * mapView.scale + mapView.width / 2;
  const py = (here[1] - mapView.cy) * mapView.scale + mapView.height / 2;
  dot.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px) translate(-50%, -50%)`;
}

// --- floor plans: a building's levels, with each room, study space and place coloured by its state ---
//
// static/map/floors/index.json lists the buildings that have floor plans; static/map/floors/<code>.json (made by
// scripts/make_floors.py from ETH's plans) has each level's outline, a neutral shape for everything else, and a shape
// with a label point per lecture hall, seminar room, study space and place, in the campus's metres. The floor view
// draws one level over the campus (faded), with the level buttons in place of the layer buttons. It's a history entry,
// so Back returns to the campus map with the building selected again. The states come from /api/map with `building`.

// Zoomed in this far (px per metre), labels show until when as well.
const FLOOR_DETAIL_SCALE = 7;
const FLOOR_MAX_SCALE = 16;
const FLOOR_PADDING_M = 6;

/**
 * The floor plans are off until ETH agrees to publish them (CLAUDE.md, "Floor plans"): no building has any then, so
 * nothing opens the floor view (its buttons, links and tags, Back into one, ?edit's plans), and the index isn't
 * fetched. static/.assetsignore keeps static/map/floors/ off every upload meanwhile. Turning them on takes both.
 */
const FLOOR_PLANS = false;

let floorIndexLoad = null;
/** Which buildings have floor plans, per area; none if it can't be loaded (the map works without). */
function loadFloorIndex() {
  if (!FLOOR_PLANS) return Promise.resolve({});
  floorIndexLoad ??= getJSON("/map/floors/index.json").then((ix) => (mapView.floorIndex = ix), () => ({}));
  return floorIndexLoad;
}

const hasFloors = (code) => FLOOR_PLANS && !!mapView.floorIndex?.[mapView.area]?.includes(code);

const floorEntry = (st) => isMapEntry(st) && st.floor;

/** The level a room or space path is on ("HG E 3" -> "E"; a gallery "HG EO 27.1" is drawn on E). */
const levelOfPath = (path) => (path.split(" ")[1] ?? "").charAt(0);
/** The room's floor and number, as its label on the plan: "HG E 33.1" -> "E 33.1". */
const roomNumber = (path) => path.split(" ").slice(1).join(" ");

/** Open `code`'s floor plans; `focus` is a room path or space id to start on (its level, and its sheet). */
async function openFloors(code, focus = null) {
  if (mapView.floor || !hasFloors(code)) return;
  mapView.floor = { code, doc: null, level: null, chosen: false, detail: null, picked: null, focus };
  history.pushState({ frooms: "map", load: PAGE_LOAD, floor: code }, "");
  document.body.classList.add("floor-open");
  $("#map-view").classList.add("floor-mode");
  renderFloorChrome();
  let doc;
  try {
    doc = await getJSON(`/map/floors/${code}.json`);
  } catch (e) {
    mapNote(`Could not load the floor plans: ${e.message}`);
    return closeFloors();
  }
  if (mapView.floor?.code !== code) return;
  mapView.floor.doc = doc;
  const focusLevel = focus ? (focus.includes(" ") ? levelOfPath(focus) : doc.levels.find((l) => l.spaces[focus] || l.places[focus])?.level) : null;
  setLevel(focusLevel ?? bestLevel(), !!focusLevel);
  fitFloor();
  refreshMap(); // the building's detail
  if (focus) pickFloor(focus, true);
}

/** Leave the floor view. `fromHistory`: Back was pressed (the entry is gone already). */
function closeFloors(fromHistory = false) {
  const f = mapView.floor;
  if (!f) return;
  if (!fromHistory && floorEntry(history.state)) {
    history.back(); // popstate comes back here
    return;
  }
  mapView.floor = null;
  document.body.classList.remove("floor-open");
  $("#map-view").classList.remove("floor-mode", "floor-close");
  $("#map-svg").querySelector("#map-floor")?.remove();
  $("#map-floor-labels").replaceChildren();
  renderFloorChrome();
  renderMapLayers();
  scheduleDraw();
}

/** The level with the most free rooms and open study spaces; E (or the first) when there's no data yet. */
function bestLevel() {
  const { doc, detail } = mapView.floor;
  const levels = doc.levels.map((l) => l.level);
  const fallback = levels.includes("E") ? "E" : levels[0];
  if (!detail) return fallback;
  const score = (lv) => detail.rooms.filter((r) => r.floor === lv && r.free).length + detail.spaces.filter((s) => s.floor === lv && s.open).length;
  const best = [...levels].sort((a, b) => score(b) - score(a))[0];
  return score(best) ? best : fallback;
}

/** Whether a level has something free or open right now (its button gets a dot). */
function levelHasFree(lv) {
  const d = mapView.floor?.detail;
  return !!d && (d.rooms.some((r) => r.floor === lv && r.free) || d.spaces.some((s) => s.floor === lv && s.open));
}

function setLevel(level, chosen = true) {
  const f = mapView.floor;
  f.level = level;
  f.chosen ||= chosen;
  if (f.picked && !floorItem(f.picked)) closeFloorPick();
  drawFloor();
  renderMapLayers();
  renderFloorChrome();
  scheduleDraw();
}

const currentLevel = () => mapView.floor?.doc?.levels.find((l) => l.level === mapView.floor.level);

/** Show the whole level. */
function fitFloor() {
  const lv = currentLevel();
  if (!lv || !mapView.width) return;
  const nums = (lv.outline.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0);
  const ys = nums.filter((_, i) => i % 2 === 1);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  mapView.cx = (x0 + x1) / 2;
  mapView.cy = (y0 + y1) / 2;
  mapView.scale = clampScale(Math.min(mapView.width / (x1 - x0 + 2 * FLOOR_PADDING_M), mapView.height / (y1 - y0 + 2 * FLOOR_PADDING_M)));
  clampCentre();
}

/** One room's, space's or place's state from the detail, as the floor view shows it. */
function floorItem(key) {
  const f = mapView.floor;
  const lv = currentLevel();
  if (!lv) return null;
  const d = f.detail;
  if (lv.rooms[key]) {
    const r = d?.rooms.find((x) => x.room === key);
    const look = !r || !["free", "busy", "managed"].includes(r.status) ? "nodata" : r.status === "busy" ? "busy" : r.status === "managed" ? "managed" : r.free ? "free" : "soon";
    return { kind: "room", key, shape: lv.rooms[key], data: r ?? null, look };
  }
  if (lv.spaces[key]) {
    const s = d?.spaces.find((x) => x.id === key);
    return { kind: "space", key, shape: lv.spaces[key], data: s ?? null, look: !s ? "nodata" : s.open ? "open" : "closed" };
  }
  if (lv.places[key]?.d) {
    // A further shape of a place (Zweistein beside Einstein) shows that place's state, under its own name.
    const shape = lv.places[key];
    const id = shape.of ?? key;
    const found = d?.places.find((x) => x.id === id) ?? mapView.places.get(id);
    const m = found && shape.name ? { ...found, name: shape.name } : found;
    return { kind: "place", key, shape, data: m ?? null, look: !m ? "nodata" : m.state === "closed" ? "closed" : "open" };
  }
  return null;
}

/** The places drawn as part of a study space (CafeBar in the HG Lobby): space id -> places. */
function placesIn(lv) {
  const out = new Map();
  for (const [id, p] of Object.entries(lv.places)) {
    if (!p.space) continue;
    const m = mapView.floor.detail?.places.find((x) => x.id === id) ?? mapView.places.get(id);
    if (m) out.set(p.space, [...(out.get(p.space) ?? []), m]);
  }
  return out;
}

const ROOM_ICON = { free: "M3 8.5 6.5 12 13 4.5", busy: "M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2zM4.5 8h7", soon: "M3 8.5 6.5 12 13 4.5", nodata: "M5.5 6a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.6-.8 1.1v.7M8 12.4v.1" };

/** Draw the current level (shapes in the SVG, labels as HTML). */
function drawFloor() {
  const f = mapView.floor;
  const lv = currentLevel();
  const svg = $("#map-svg");
  svg.querySelector("#map-floor")?.remove();
  if (!lv) return;
  const g = svgEl("g", { id: "map-floor" });
  g.append(svgEl("path", { d: lv.outline, class: "floor-outline" }));
  if (lv.other) g.append(svgEl("path", { d: lv.other, class: "floor-other", "fill-rule": "evenodd" }));
  const labels = [];
  const inside = placesIn(lv);
  const keys = [...Object.keys(lv.rooms), ...Object.keys(lv.spaces), ...Object.keys(lv.places)];
  for (const key of keys) {
    const it = floorItem(key);
    if (!it) continue;
    const cls = `floor-${it.kind} ${it.look}${f.picked === key ? " picked" : ""}`;
    g.append(svgEl("path", { d: it.shape.d, class: cls, "fill-rule": "evenodd", "data-floor": key }));
    labels.push(floorLabel(it, inside.get(key) ?? []));
  }
  for (const e of lv.entrances ?? []) labels.push(entranceMark(e));
  for (const at of lv.stairs ?? []) labels.push(featureMark("stairs", at));
  for (const at of lv.lifts ?? []) labels.push(featureMark("lift", at));
  for (const m of mapMicrowaves() ?? []) {
    const at = m.building === f.code && m.floor === lv.level ? microAt(m, false) : null;
    if (at) labels.push(microMark(m, at));
  }
  for (const link of lv.links ?? []) labels.push(linkButton(link, f.level));
  svg.append(g);
  $("#map-floor-labels").replaceChildren(...labels);
}

/** An entrance: arrows pointing into the building, larger for main entrances. Not tappable. */
function entranceMark(e) {
  const icon = smallIcon(ENTRANCE_ICON);
  icon.style.transform = `rotate(${e.dir}deg)`;
  const node = el("span", { class: `floor-entrance${e.main ? " main" : ""}`, title: e.main ? "Main entrance" : "Entrance" }, icon);
  node.dataset.x = e.at[0];
  node.dataset.y = e.at[1];
  return node;
}

/** Stairs or a lift: a small icon where it is. Not tappable, always shown (like the entrances). */
function featureMark(kind, at) {
  const name = kind === "lift" ? "Lift" : "Stairs";
  const node = el("span", { class: `floor-feature ${kind}`, title: name, role: "img", "aria-label": name }, smallIcon(kind === "lift" ? LIFT_ICON : STAIRS_ICON));
  node.dataset.x = at[0];
  node.dataset.y = at[1];
  return node;
}

/** Microwaves on the plan, where they are (microAt): a microwave with the count. Not tappable, always shown (beside a
 * label they'd cover: placeFloorLabels). */
function microMark(m, at) {
  const text = `${plural(m.count, "microwave", "microwaves")} · ${m.name}`;
  const node = el("span", { class: "floor-micro", title: text, role: "img", "aria-label": text }, ...microGlyph(m.count));
  node.dataset.x = at[0];
  node.dataset.y = at[1];
  return node;
}

/** Where the level connects to another building with floor plans: switches to that building, on `link.level` when the
 * two name their floors differently (CLA D is LEE F), else on the same level. */
function linkButton(link, current) {
  const level = link.level ?? current;
  const icon = smallIcon(ARROW_ICON);
  const to = anchorOf(link.to);
  if (to) icon.style.transform = `rotate(${Math.round((Math.atan2(to[1] - link.at[1], to[0] - link.at[0]) * 180) / Math.PI)}deg)`;
  const node = el("button", { type: "button", class: "floor-link", "aria-label": `Go to ${buildingLabel(link.to)}, level ${level}` }, icon, link.to);
  node.dataset.link = link.to;
  node.dataset.level = level;
  node.dataset.x = link.at[0];
  node.dataset.y = link.at[1];
  return node;
}

/**
 * Into another building's floor plans. A link button names its level (the same one, or CLA D's LEE F); from the title's
 * menu or a click on the building's outline or tag it's the level as far above or below street level (lib.js
 * matchLevel). `keepCamera`: the map stays where it is (a click on the map: the building is in view, and the person moves
 * the map themselves); else the new plan is framed (the title's menu and the keyboard, where it may be off screen).
 * Back still returns to the campus.
 */
async function switchFloors(code, toLevel = null, { keepCamera = false } = {}) {
  const f = mapView.floor;
  closeFloorMenu();
  if (!f || !hasFloors(code) || code === f.code) return;
  const from = { code: f.code, level: f.level };
  let doc;
  try {
    doc = await getJSON(`/map/floors/${code}.json`);
  } catch (e) {
    return mapNote(`Could not load the floor plans: ${e.message}`);
  }
  if (mapView.floor !== f) return;
  closeFloorPick();
  const shown = doc.levels.map((l) => l.level);
  const level = toLevel && shown.includes(toLevel) ? toLevel : matchLevel(from.code, from.level, code, mapView.floorIndex?.levels, shown);
  Object.assign(f, { code, doc, detail: null, picked: null, focus: null, chosen: true });
  f.level = shown.includes(level) ? level : shown[0];
  flashNote(`${from.code} ${from.level} → ${code} ${f.level}`);
  if (floorEntry(history.state)) history.replaceState({ ...history.state, floor: code }, "");
  drawFloor();
  if (!keepCamera) fitFloor();
  renderMapLayers();
  renderFloorChrome();
  scheduleDraw();
  refreshMap(); // the new building's detail
}

/** A label: icon and short name; zoomed in also a second line (until when, how full). */
function floorLabel(it, extra) {
  const at = mapView.data?.at;
  let icon, name, line;
  if (it.kind === "room") {
    icon = ROOM_ICON[it.look];
    name = roomNumber(it.key);
    const r = it.data;
    line = !r ? "no data" : it.look === "busy" ? (r.until ? `booked until ${hhmm(r.until)}` : "booked")
      : it.look === "nodata" ? "no data"
      : !r.until || (at && day(r.until) !== day(at)) ? "free rest of day" : `free until ${hhmm(r.until)}`;
  } else if (it.kind === "space") {
    icon = BOOK_ICON;
    const s = it.data;
    name = s?.name ?? it.key;
    line = !s ? "" : !s.open ? "closed" : s.occupancy != null ? `${s.occupancy}% full` : "open";
  } else {
    const m = it.data;
    icon = KIND_ICON[m?.kind] ?? MENSA_ICON;
    name = m?.name ?? it.key;
    line = m ? placeLine(m) : "";
  }
  const node = el("button", { type: "button", class: `floor-label ${it.kind} ${it.look}`, "data-floor": it.key },
    el("span", { class: "fl-name" }, smallIcon(icon), name),
    line ? el("span", { class: "fl-line" }, line) : null,
    ...extra.map((m) => el("span", { class: `fl-line fl-place ${m.state}` }, smallIcon(KIND_ICON[m.kind]), `${m.name}: ${placeLine(m)}`)));
  node.dataset.x = it.shape.at[0];
  node.dataset.y = it.shape.at[1];
  node.dataset.prio = it.kind === "place" ? 3 : it.kind === "room" ? 2 : 1;
  return node;
}

/**
 * The floor view's tags: every other building of the campus has a small tag with its code at its label's anchor,
 * muted; those with floor plans are buttons that switch to them (floorTap). Made once per open building.
 */
function renderFloorTags() {
  const box = $("#map-floor-tags");
  const f = mapView.floor;
  box.hidden = !f;
  const key = f && mapView.doc ? `${mapView.area}|${f.code}` : "";
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  if (!key) return box.replaceChildren();
  const codes = Object.keys(mapView.doc.buildings).filter((c) => c !== f.code && anchorOf(c));
  box.replaceChildren(...codes.map((code) => {
    const node = hasFloors(code)
      ? el("button", { type: "button", class: "floor-tag plans", "aria-label": `${buildingLabel(code)} floor plans`, title: `${buildingLabel(code)} floor plans` }, smallIcon(VIEW_ICON), code)
      : el("span", { class: "floor-tag", "aria-hidden": "true" }, code);
    node.dataset.tag = code;
    return node;
  }));
}

/**
 * Place the tags around the plan: those with plans first, then the bigger buildings; one that would overlap a placed
 * label, a button or another tag is hidden. `placed`: the boxes taken already (the plan's labels and the buttons).
 */
function placeFloorTags(placed) {
  const { cx, cy, scale, width, height } = mapView;
  const size = (n) => (n.classList.contains("plans") ? 1e9 : 0) + (mapView.doc.buildings[n.dataset.tag]?.size ?? 0);
  const tags = [...$("#map-floor-tags").children].sort((a, b) => size(b) - size(a));
  const vis = visibleBox();
  for (const node of tags) {
    const [ax, ay] = anchorOf(node.dataset.tag) ?? [NaN, NaN];
    const px = (ax - cx) * scale + width / 2;
    const py = (ay - cy) * scale + height / 2;
    node.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px) translate(-50%, -50%)`;
    const w = node.offsetWidth + 4;
    const h = node.offsetHeight + 4;
    const box = [px - w / 2, py - h / 2, px + w / 2, py + h / 2];
    // Only wholly in the visible part (phones: not under the top bar or the sheet).
    const off = !(box[0] >= vis.x0 && box[1] >= vis.y0 && box[2] <= vis.x1 && box[3] <= vis.y1);
    const hit = !off && placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    node.classList.toggle("hidden", off || hit);
    if (!off && !hit) placed.push(box);
  }
}

/** Place the floor labels; those that would overlap a placed one are hidden (places first, then rooms, then spaces). */
function placeFloorLabels() {
  const { cx, cy, scale, width, height } = mapView;
  $("#map-view").classList.toggle("floor-close", scale >= FLOOR_DETAIL_SCALE);
  const all = [...$("#map-floor-labels").children];
  // Entrances are small and sit on the outer wall: always shown, and labels may cover them. Microwaves: below.
  const marks = (n) => n.classList.contains("floor-entrance") || n.classList.contains("floor-micro") || n.classList.contains("floor-feature");
  for (const node of all.filter((n) => n.classList.contains("floor-entrance") || n.classList.contains("floor-feature"))) {
    const px = (node.dataset.x - cx) * scale + width / 2;
    const py = (node.dataset.y - cy) * scale + height / 2;
    node.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px) translate(-50%, -50%)`;
  }
  // The links to the next building first: they're never hidden by a label.
  const prio = (n) => (n.dataset.link ? 9 : +n.dataset.prio);
  const nodes = all.filter((n) => !marks(n))
    .sort((a, b) => prio(b) - prio(a) || (a.dataset.floor === mapView.floor?.picked ? -1 : 0));
  // The bar on top and the buttons on the right count as taken: labels don't hide under them.
  const view = $("#map-view").getBoundingClientRect();
  const placed = ["#map-floor-close", "#map-floor-title", ".map-tools"].map((sel) => {
    const r = $(`#map-view ${sel}`)?.getBoundingClientRect();
    return r && r.width ? [r.left - view.left, r.top - view.top, r.right - view.left, r.bottom - view.top] : null;
  }).filter(Boolean);
  for (const node of nodes) {
    const px = (node.dataset.x - cx) * scale + width / 2;
    const py = (node.dataset.y - cy) * scale + height / 2;
    node.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px) translate(-50%, -50%)`;
    const w = node.offsetWidth + 2;
    const h = node.offsetHeight + 2;
    const box = [px - w / 2, py - h / 2, px + w / 2, py + h / 2];
    const off = px < -80 || py < -40 || px > width + 80 || py > height + 40;
    const hit = placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    const keep = node.dataset.link !== undefined || node.dataset.floor === mapView.floor?.picked;
    node.classList.toggle("hidden", off || (hit && !keep));
    if (!off && (!hit || keep)) placed.push(box);
  }
  // Microwaves: always shown, where they are or just beside the label they'd cover (Einstein's sit on its label).
  for (const node of all.filter((n) => n.classList.contains("floor-micro"))) {
    const w = node.offsetWidth + 2;
    const h = node.offsetHeight + 2;
    const [px, py] = besideBoxes((node.dataset.x - cx) * scale + width / 2, (node.dataset.y - cy) * scale + height / 2, w, h, placed);
    node.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px) translate(-50%, -50%)`;
    placed.push([px - w / 2, py - h / 2, px + w / 2, py + h / 2]);
  }
  // Then the other buildings' tags, around what the plan shows (never over its labels).
  placeFloorTags(placed);
}

/** The bar on top (back to the campus, building and level) and the wide layout's button to open the plans. */
function renderFloorChrome() {
  const f = mapView.floor;
  $("#map-floor-close").hidden = !f;
  $("#map-floor-title").hidden = !f;
  $("#map-floor-labels").hidden = !f;
  renderFloorTags();
  if (f) {
    const title = $("#map-floor-title");
    title.textContent = `${buildingLabel(f.code)} · level ${f.level ?? ""}`;
    title.setAttribute("aria-label", `${buildingLabel(f.code)}, level ${f.level ?? ""}: other buildings' floor plans`);
  } else closeFloorMenu();
  syncFloorButton();
}

/** The campus's buildings with floor plans (code and name, the open one marked): picking one switches to it. */
function floorMenu() {
  const f = mapView.floor;
  const menu = $("#map-floor-menu");
  if (!f) return;
  const codes = (mapView.floorIndex?.[mapView.area] ?? []).filter((c) => mapView.doc?.buildings[c]);
  menu.replaceChildren(...codes.map((code) => {
    const name = mapView.doc.buildings[code]?.name;
    const label = buildingLabel(code);
    const b = el("button", { type: "button", role: "menuitemradio", "aria-checked": String(code === f.code) },
      el("span", { class: "code" }, code), label !== code ? `${label} ` : "", name ? el("span", { class: "muted" }, name) : null);
    b.addEventListener("click", () => {
      if (code === f.code) return closeFloorMenu(true);
      switchFloors(code);
      $("#map-floor-title").focus({ preventScroll: true });
    });
    return b;
  }));
  menu.hidden = false;
  $("#map-floor-title").setAttribute("aria-expanded", "true");
  (menu.querySelector("[aria-checked=true]") ?? menu.firstElementChild)?.focus({ preventScroll: true });
}

function closeFloorMenu(focus = false) {
  const menu = $("#map-floor-menu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $("#map-floor-title").setAttribute("aria-expanded", "false");
  if (focus) $("#map-floor-title").focus({ preventScroll: true });
}

/**
 * Wide layout: a button to open the floor plans of the one building the list shows, if it has plans. It sits just
 * below the building's label, and goes away with a click beside the buildings (like the highlight).
 */
function syncFloorButton() {
  const btn = $("#map-floors-open");
  const picked = [...mapView.picked];
  const code = layout() === "side" && !mapView.floor && !mapView.unmarked && picked.length === 1 && hasFloors(picked[0]) ? picked[0] : null;
  btn.hidden = !code;
  if (!code) return;
  btn.replaceChildren(smallIcon(VIEW_ICON), "Floor plan");
  btn.setAttribute("aria-label", `${buildingLabel(code)} floor plan`);
  btn.dataset.code = code;
  placeFloorButton(btn, code);
}

/** Put the floor plans button under the building's label (or its middle, when the label is hidden). */
function placeFloorButton(btn, code) {
  if (!mapView.doc || !mapView.width) return;
  const label = mapView.labels.get(code);
  let x, y;
  if (label && !label.classList.contains("hidden") && !label.classList.contains("off")) {
    const box = label.getBoundingClientRect();
    const view = $("#map-view").getBoundingClientRect();
    x = box.left + box.width / 2 - view.left;
    y = box.bottom - view.top + 6;
  } else {
    const at = anchorOf(code);
    if (!at) return;
    x = (at[0] - mapView.cx) * mapView.scale + mapView.width / 2;
    y = (at[1] - mapView.cy) * mapView.scale + mapView.height / 2 + 14;
  }
  btn.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translateX(-50%)`;
}

/** Level buttons, top floor at the top, in place of the layer buttons. */
function renderLevelButtons() {
  const f = mapView.floor;
  const levels = f.doc ? [...f.doc.levels].reverse().map((l) => l.level) : [];
  $("#map-layers").setAttribute("aria-label", "Level");
  $("#map-layers").replaceChildren(...levels.map((lv) => {
    const b = el("button", { type: "button", class: "level" + (levelHasFree(lv) ? " has-free" : ""), "aria-pressed": String(lv === f.level), "aria-label": `Level ${lv}` }, lv);
    b.addEventListener("click", () => setLevel(lv));
    return b;
  }));
}

/** New detail from /api/map: recolour, and go to the best level unless one was chosen. */
function floorDetail(detail) {
  const f = mapView.floor;
  if (!f) return;
  f.detail = detail ?? { rooms: [], spaces: [], places: [] };
  if (!f.doc) return;
  if (!f.chosen && !f.focus) {
    const lv = bestLevel();
    if (lv !== f.level) {
      f.level = lv;
      fitFloor();
    }
  }
  drawFloor();
  renderMapLayers();
  renderFloorChrome();
  scheduleDraw();
}

/** A tap in the floor view: a shape or label opens its detail view, anything else stops highlighting it. */
function floorTap(target) {
  const node = target.closest?.(".floor-link");
  if (node) return switchFloors(node.dataset.link, node.dataset.level, { keepCamera: true });
  // Another building with plans, on the faded campus around this one (its outline or its tag): its plans, on the
  // matching level, without moving the map.
  const other = target.closest?.(".floor-tag.plans")?.dataset.tag ?? target.closest?.(".map-buildings.active .map-building")?.dataset.code;
  if (other && other !== mapView.floor.code && hasFloors(other)) return switchFloors(other, null, { keepCamera: true });
  const key = target.closest?.("[data-floor]")?.dataset.floor;
  if (key) pickFloor(key);
  else closeFloorPick();
}

/**
 * Highlight a room, study space or place on the plan and show its detail view (`shown`: the view is open already,
 * e.g. "Show on plan").
 */
function pickFloor(key, shown = false) {
  const it = floorItem(key);
  if (!it) return;
  mapView.floor.picked = key;
  drawFloor();
  revealPoint(it.shape.at);
  scheduleDraw();
  if (shown) return;
  const kind = it.kind === "room" ? "room" : "space";
  const id = it.kind === "place" ? (it.shape.of ?? key) : key;
  openPlace({ kind, id, area: state.area }, { from: placesView.current ? "floor" : "list" });
}

function closeFloorPick() {
  const f = mapView.floor;
  if (!f?.picked) return;
  f.picked = null;
  drawFloor();
  scheduleDraw();
}

// --- data ---

function mapNote(text) {
  mapView.noteText = text;
  if (mapView.flashUntil > Date.now()) return; // shown when the flash ends
  showNote(text);
}

function showNote(text) {
  $("#map-note").textContent = text;
  $("#map-note").hidden = !text;
}

/** A note for a moment ("HG F → CAB G" after switching buildings), then the map's own note again. */
function flashNote(text, ms = 1000) {
  mapView.noteText ??= $("#map-note").textContent;
  mapView.flashUntil = Date.now() + ms;
  showNote(text);
  setTimeout(() => {
    if (Date.now() >= mapView.flashUntil) showNote(mapView.noteText ?? "");
  }, ms);
}

/** How long the map's rooms are free for: "2 h", or Meet's duration ("1 h"). */
const freeFor_ = () => durationText(mapView.data?.min_free ?? MAP_MIN_FREE);

/**
 * /api/map's query: Meet asks for its duration and the list of rooms too (one request feeds both); Study asks for
 * its rooms (computer rooms, seminar rooms, lecture halls) but keeps the map's 2 hours: the list picks the rooms free
 * for STUDY_MIN_FREE from the answer's minutes.
 */
function mapParams() {
  const params = new URLSearchParams({ area: state.area });
  if (mapView.floor) params.set("building", mapView.floor.code);
  if (!state.now) params.set("at", sharedTime());
  if (state.mode === "rooms") {
    params.set("rooms", "1");
    params.set("min_free", String(state.duration));
    params.set("types", wantedTypes().join(","));
    if (state.minSeats) params.set("min_seats", state.minSeats);
    if (equipOn()) params.set("equip", "screen");
  } else if (state.mode === "study") {
    params.set("rooms", "1");
    params.set("types", STUDY_ROOM_TYPES.join(","));
  }
  return params;
}

/** Called by app.js when the campuses are known or another is picked: the campus buttons and tags show their names. */
function renderMapAreas() {
  if (!mapView.doc) return;
  renderLinks();
  renderCampusTags();
  scheduleDraw();
}

/**
 * Called by app.js's refresh(): load the campus drawing when the location changed, then the numbers. Resolves to
 * { data } (the /api/map answer, which in Meet has the list's rooms too), { error }, or null when a newer call took
 * over. The numbers are asked for at once, while the drawing loads.
 */
function refreshMap() {
  const load = refreshMapNow();
  mapView.latest = load;
  return load;
}

async function refreshMapNow() {
  const area = state.area;
  if (!area) return null;
  const id = ++mapView.requestId;
  if (mapView.area !== area && mapView.flight) {
    await mapView.flight; // land first
    if (id !== mapView.requestId) return null;
  }
  // The other Zentrum campus: no flight, the swap waits for its numbers (below) and then happens in one go.
  const swap = mapView.area !== area && !!mapView.doc && ZENTRUM_PARTNER[mapView.area] === area && !PIN_MODE;
  if (mapView.area !== area && mapView.floor) closeFloors(); // before the numbers are asked for (no building in them)
  // The numbers, unless the last answer is for the same question and recent.
  const offline = navigator.onLine === false;
  const timeMissing = !state.now && (!state.date || !state.time);
  const params = timeMissing ? null : mapParams();
  const key = params?.toString() ?? "";
  const fresh = mapView.area === area && params && key === mapView.dataKey && Date.now() - mapView.loadedAt < MAP_DATA_MAX_AGE_MS;
  const dataLoad = offline || !params || fresh ? null : getJSON(`/api/map?${params}`).then((data) => ({ data }), (e) => ({ error: e.message }));
  mapView.early = { area, key, load: dataLoad };
  if (swap) {
    await dataLoad;
    if (id !== mapView.requestId) return null;
    zentrumSwap(area);
  }
  if (mapView.area !== area) {
    if (!mapView.handoff?.flown) saveView();
    mapView.area = area;
    mapView.doc = null;
    mapView.data = null;
    mapView.dataKey = "";
    mapView.summary = new Map();
    mapView.selected = null;
    mapView.selectedMensa = false;
    $("#map-labels").replaceChildren();
    mapView.labels = new Map();
    mapView.campusTags = new Map();
    mapView.links = [];
    $("#map-links").replaceChildren();
    stopGlide();
    mapView.pinSelected = null;
    mapNote("");
  }
  if (!mapView.doc) {
    try {
      const [doc, pins, , , campuses] = await Promise.all([loadCampus(area), loadPins(), loadOverview(), loadFloorIndex(), loadCampuses(), loadRegion()]);
      if (id !== mapView.requestId) return null;
      settleHandoff(); // before anything moves the view into the new campus's metres
      mapView.pins = pins;
      document.body.classList.remove("no-map");
      campuses.set(area, doc);
      if (!mapView.world || campuses.size > mapView.campuses.size || (mapView.region && !mapView.world.tiles)) {
        mapView.campuses = campuses;
        const floor = $("#map-svg #map-floor");
        drawWorld();
        if (floor) $("#map-svg").append(floor);
      }
      setActive(area);
      renderLinks();
      renderPinPanel(); // pin mode: this area's label-only buildings to place
      measure();
      placeView();
      if (mapView.handoff) finishHandoff(doc);
      $("#map-view").classList.remove("flying");
      $("#map-missing").hidden = true;
      if (mapView.pendingLocate) {
        // Switched to the campus they're on (or the locate button was tapped before the drawing was in).
        mapView.pendingLocate = false;
        mapView.goToMe = true;
        if (mapView.me) goToMe();
      }
    } catch (e) {
      if (id !== mapView.requestId) return null;
      if (e.message === "HTTP 404") {
        // No map for this location: leave it out (the list still gets its numbers).
        document.body.classList.add("no-map");
      } else {
        $("#map-missing").hidden = false;
        $("#map-missing").textContent = e.message === "offline" ? OFFLINE_MSG : `Could not load the map: ${e.message}`;
      }
    }
  }
  fillLabels();
  // Now, not on the next frame: a campus just drawn in its own metres must never be shown through the last campus's
  // view (after landing in Zentrum it would jump by a few hundred metres for a frame or two).
  drawView();
  if (offline) {
    mapNote("Offline: no numbers");
    return { error: "offline" };
  }
  if (!params) return null;
  if (fresh) return { data: mapView.data };
  const res = await dataLoad;
  if (id !== mapView.requestId) return null;
  if (res.error) {
    mapNote(res.error === "offline" ? "Offline: no numbers" : `Could not load the numbers: ${res.error}`);
    return res;
  }
  const data = res.data;
  mapView.data = data;
  mapView.dataKey = key;
  mapView.loadedAt = Date.now();
  mapView.summary = new Map(data.buildings.map((b) => [b.building, b]));
  fillLabels();
  if (mapView.floor && data.detail) floorDetail(data.detail);
  if (nearShown() || placesView.current?.kind === "building") refreshPlace();
  else if (placesView.current) markPlaceBuilding(mapView.selected);
  scheduleDraw();

  const asof = data.fetched_at ? `as of ${asOfLabel(data.fetched_at)}${data.stale ? `, ${staleNote()}` : ""}` : "";
  const when = state.now ? "" : `${weekday(data.at)} ${hhmm(data.at)}`;
  mapNote([`Rooms: free ${freeFor_()}+`, when, asof].filter(Boolean).join(" · "));
  return res;
}

function initMap() {
  initLayersToggle();
  // The edit mode's own script, only for ?edit (nobody else downloads it).
  if (EDIT_MODE) document.head.append(el("script", { src: "/edit.js", defer: "" }));
  renderMapLayers();
  if (PIN_MODE) {
    mapView.myPins = loadMyPins();
    document.body.classList.add("pin-mode");
    $("#map-view").append(el("div", { id: "map-pins", class: "map-pins" }));
    renderPinPanel();
  }
  setupGestures();
  applyLayout();
  $("#map-locate").addEventListener("click", locateTapped);
  // Never a prompt on load: the position is used at once only if the browser already allows it (CHOICES.md).
  navigator.permissions?.query({ name: "geolocation" }).then((p) => {
    if (p.state !== "granted" || mapView.locate !== "off" || !("geolocation" in navigator)) return;
    mapView.locate = "wait";
    renderLocateButton();
    syncLocating();
  }).catch(() => { /* older browsers: only after a click on the locate button */ });
  document.addEventListener("visibilitychange", syncLocating);
  $("#map-floor-close").addEventListener("click", () => closeFloors());
  $("#map-floor-title").addEventListener("click", (e) => {
    e.stopPropagation();
    if ($("#map-floor-menu").hidden) floorMenu();
    else closeFloorMenu();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.(".map-floor-box")) closeFloorMenu();
  });
  // Escape closes the menu first (the floor view's own Escape below skips a handled one).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#map-floor-menu").hidden) {
      e.preventDefault();
      closeFloorMenu(true);
    }
  });
  // The menu's items: Up and Down move between them (wrapping), Home and End to the ends; Tab still works.
  $("#map-floor-menu").addEventListener("keydown", (e) => {
    const items = [...e.currentTarget.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (to === undefined || !items.length) return;
    e.preventDefault();
    items[(to + items.length) % items.length].focus({ preventScroll: true });
  });
  $("#map-floors-open").addEventListener("click", (e) => openFloors(e.currentTarget.dataset.code));
  // Reloaded while a floor view was open: the page shows the campus, so this entry is a plain one now.
  if (history.state?.frooms === "map") history.replaceState(null, "");
  window.addEventListener("popstate", () => {
    if (mapView.floor && !floorEntry(history.state)) closeFloors(true);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || !mapView.floor || document.querySelector("dialog[open]")) return;
    // A detail view from the plan closes first (places.js), then the highlight, then the floor view.
    if (placesView.current && mapView.floor.picked) return;
    e.preventDefault();
    if (mapView.floor.picked) closeFloorPick();
    else closeFloors();
  });
  // The results sheet moved: the campus buttons, notes and labels keep clear of it.
  sheet.onChange(() => scheduleDraw());
  WIDE.addEventListener("change", () => {
    applyLayout();
    measure();
    if (mapView.doc) placeView();
    scheduleDraw();
  });
  // Side layout: the building of the room or study space under the mouse lights up on the map.
  for (const id of ["#results", "#space-results", "#you", "#detail"]) {
    const list = $(id);
    list.addEventListener("mouseover", (e) => setHover(e.target.closest(".room")?.dataset.building ?? null));
    list.addEventListener("mouseleave", () => setHover(null));
  }
}
