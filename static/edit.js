"use strict";

// The edit mode (/?edit): Raffaele's tool for what the floor plans and the map can't know. Loaded only with ?edit
// (static/map.js initMap); it includes pin mode (labels and microwaves can be dragged as in ?pins).
//
// - Corners: tap a room, study space or place on a floor plan, then drag its corners. A tap on a corner picks it (with
//   "Add to selection" on, or Shift held, it's added); "Box select" (or Shift-drag) picks every corner in a rectangle;
//   a drag on a picked corner moves all picked ones. Delete corners, add a corner after the picked one, undo, reset.
// - Entrance, Stairs, Lift: tap the plan to add one there; tap one to pick it, drag it, delete it. An entrance points
//   into the building at right angles to the nearest outer wall, like the traced ones; main or side.
// - Microwave: tap the campus map or a plan to add one there (name and count from the panel's fields).
//
// Every change shows at once (the loaded plan is changed in place) and is kept in this browser (localStorage) until it
// is sent: "Copy edits" gives one JSON with the edits and the moved pins, which scripts/apply_edits.py writes into
// data/floors/edits/, the floor plans, data/microwaves.json and static/map/pins.json. Nothing is sent anywhere by the
// page itself.

const EDIT_KEY = "frooms-edits";
const EDIT_TOOLS = [
  ["move", "Move map"], ["corners", "Corners"], ["entrance", "Entrance"], ["stairs", "Stairs"], ["lift", "Lift"], ["microwave", "Microwave"],
];
const EDIT_HANDLE_PX = 7; // a corner's radius on screen
const EDIT_UNDO_MAX = 60;

const editView = {
  tool: "move",
  data: { floors: {}, microwaves: [] }, // what's changed: floors[building][level] = { shapes, entrances, stairs, lifts }
  room: null, // corners: the shape being edited (its key)
  picked: new Set(), // corners: "ring:index"
  additive: false, // corners: taps add to the selection
  boxMode: false, // corners: a drag draws a selection box instead of moving the map
  box: null, // the selection box being drawn: { x0, y0, x1, y1, base }
  item: null, // entrance, stairs, lift, microwave: the picked one { kind, index } / { kind: "microwave", id }
  newMain: true, // entrance: a new one is a main entrance
  undo: [],
  drag: null,
  collapsed: false, // the panel shows only its tools
};

function editLoad() {
  try {
    const d = JSON.parse(localStorage.getItem(EDIT_KEY) || "null");
    if (d && typeof d === "object") editView.data = { floors: d.floors ?? {}, microwaves: d.microwaves ?? [] };
  } catch { /* none kept */ }
}

function editSave() {
  try {
    localStorage.setItem(EDIT_KEY, JSON.stringify(editView.data));
  } catch { /* storage unavailable: the edits last until the page reloads */ }
  editPanel();
}

// --- shapes as rings of corners ---

/** "M1 2 3 4 5 6ZM…" -> [[[1, 2], [3, 4], [5, 6]], …] */
function editRings(d) {
  return String(d ?? "").split("M").filter((s) => s.trim()).map((s) => {
    const n = (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const ring = [];
    for (let i = 0; i + 1 < n.length; i += 2) ring.push([n[i], n[i + 1]]);
    return ring;
  }).filter((r) => r.length);
}

const editPath = (rings) => rings.map((r) => `M${r.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")}Z`).join("");

// --- the floor being edited ---

const editFloor = () => (mapView.floor?.doc ? mapView.floor : null);
const editLevel = () => (editFloor() ? currentLevel() : null);

/** This level's record of changes, made on first use. */
function editRecord() {
  const f = editFloor();
  const lv = editLevel();
  const b = (editView.data.floors[f.code] ??= {});
  return (b[lv.level] ??= {});
}

/** The shape of a key on the level: a room, study space or place (its own shape, not "space": …). */
function editShape(lv, key) {
  for (const group of [lv.rooms, lv.spaces, lv.places]) if (group?.[key]?.d) return group[key];
  return null;
}

/** Put the kept edits into a freshly loaded plan (once per load). */
function editApply() {
  const f = mapView.floor;
  if (!f?.doc || f.doc.editApplied) return;
  f.doc.editApplied = true;
  const edits = editView.data.floors[f.code] ?? {};
  for (const lv of f.doc.levels) {
    const e = edits[lv.level];
    if (!e) continue;
    for (const [key, d] of Object.entries(e.shapes ?? {})) {
      const shape = editShape(lv, key);
      if (shape) shape.d = d;
    }
    if (e.entrances) lv.entrances = e.entrances.map((x) => ({ ...x }));
    if (e.stairs) lv.stairs = e.stairs.map((p) => [...p]);
    if (e.lifts) lv.lifts = e.lifts.map((p) => [...p]);
  }
}

/** Remember the state before a change, for Undo. */
function editSnapshot() {
  editView.undo.push(JSON.stringify({ data: editView.data, level: editLevel() ? { code: editFloor().code, level: editLevel().level, lv: editLevel() } : null }));
  if (editView.undo.length > EDIT_UNDO_MAX) editView.undo.shift();
}

function editUndo() {
  const last = editView.undo.pop();
  if (!last) return;
  const { data, level } = JSON.parse(last);
  editView.data = data;
  const f = editFloor();
  if (level && f?.code === level.code) {
    const lv = f.doc.levels.find((l) => l.level === level.level);
    if (lv) Object.assign(lv, level.lv);
  }
  editView.picked.clear();
  editView.item = null;
  editSave();
  editRedraw();
}

// --- positions ---

const editPx = ([x, y]) => [(x - mapView.cx) * mapView.scale + mapView.width / 2, (y - mapView.cy) * mapView.scale + mapView.height / 2];

/** A pointer position in map metres, unrounded (corners move smoothly; they're rounded when written). */
function editMetres(clientX, clientY) {
  const rect = $("#map-view").getBoundingClientRect();
  return [mapView.cx + (clientX - rect.left - mapView.width / 2) / mapView.scale, mapView.cy + (clientY - rect.top - mapView.height / 2) / mapView.scale];
}

const editRound = ([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10];

/** The way into the building at `at`: at right angles to the nearest edge of the level's outline, pointing inside. */
function editEntranceDir(lv, at) {
  let best = null;
  for (const ring of editRings(lv.outline)) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / len2));
      const d = Math.hypot(at[0] - (a[0] + t * dx), at[1] - (a[1] + t * dy));
      if (!best || d < best.d) best = { d, nx: -dy, ny: dx };
    }
  }
  if (!best) return 0;
  const len = Math.hypot(best.nx, best.ny) || 1;
  let [nx, ny] = [best.nx / len, best.ny / len];
  // Inside is where a step along the normal lands in the outline.
  const probe = [at[0] + nx * 1.5, at[1] + ny * 1.5];
  const inside = editRings(lv.outline).reduce((n, r) => n + (editInside(probe, r) ? 1 : 0), 0) % 2 === 1;
  if (!inside) [nx, ny] = [-nx, -ny];
  return Math.round((Math.atan2(ny, nx) * 180) / Math.PI);
}

function editInside([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// --- drawing: the overlay with corners and the picked marks, the panel ---

function editRedraw() {
  if (mapView.floor?.doc) drawFloor();
  scheduleDraw();
}

/** The overlay over the map: the edited shape's corners, the picked item's ring, the selection box. */
function editOverlay() {
  const layer = $("#edit-layer");
  if (!layer) return;
  const nodes = [];
  const lv = editLevel();
  if (editView.tool === "corners" && lv && editView.room) {
    const shape = editShape(lv, editView.room);
    if (shape) {
      editRings(shape.d).forEach((ring, r) => ring.forEach((p, i) => {
        const [px, py] = editPx(p);
        if (px < -20 || py < -20 || px > mapView.width + 20 || py > mapView.height + 20) return;
        const key = `${r}:${i}`;
        const h = el("span", { class: `edit-corner${editView.picked.has(key) ? " on" : ""}`, "data-corner": key });
        h.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px) translate(-50%, -50%)`;
        nodes.push(h);
      }));
    }
  }
  if (lv && ["entrance", "stairs", "lift"].includes(editView.tool)) {
    const list = editView.tool === "entrance" ? (lv.entrances ?? []).map((e) => e.at) : (editView.tool === "stairs" ? lv.stairs : lv.lifts) ?? [];
    list.forEach((at, i) => {
      const [px, py] = editPx(at);
      const on = editView.item?.kind === editView.tool && editView.item.index === i;
      const h = el("span", { class: `edit-item${on ? " on" : ""}`, "data-item": String(i) });
      h.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px) translate(-50%, -50%)`;
      nodes.push(h);
    });
  }
  if (editView.box) {
    const { x0, y0, x1, y1 } = editView.box;
    const b = el("span", { class: "edit-box" });
    b.style.transform = `translate(${Math.min(x0, x1)}px, ${Math.min(y0, y1)}px)`;
    b.style.width = `${Math.abs(x1 - x0)}px`;
    b.style.height = `${Math.abs(y1 - y0)}px`;
    nodes.push(b);
  }
  layer.replaceChildren(...nodes);
}

/** How many things are changed: shapes, entrance lists, stairs and lift lists, microwaves, moved pins. */
function editCount() {
  let n = editView.data.microwaves.length;
  for (const levels of Object.values(editView.data.floors)) {
    for (const e of Object.values(levels)) n += Object.keys(e.shapes ?? {}).length + (e.entrances ? 1 : 0) + (e.stairs ? 1 : 0) + (e.lifts ? 1 : 0);
  }
  const pins = Object.values(mapView.myPins ?? {}).flatMap((a) => Object.values(a ?? {}).flatMap((k) => Object.keys(k ?? {}))).length;
  return { edits: n, pins };
}

/** What "Copy edits" gives: the edits and this browser's pins, for scripts/apply_edits.py. */
const editExport = () => JSON.stringify({ frooms_edits: 1, floors: editView.data.floors, microwaves: editView.data.microwaves, pins: mapView.myPins ?? {} });

function editButton(text, onClick, { on = false, disabled = false } = {}) {
  const b = el("button", { type: "button", class: on ? "on" : "", "aria-pressed": String(on) }, text);
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

function editPanel() {
  const box = $("#edit-panel");
  if (!box) return;
  const lv = editLevel();
  const tools = el("div", { class: "edit-tools" }, ...EDIT_TOOLS.map(([key, name]) => editButton(name, () => {
    editView.tool = key;
    editView.item = null;
    if (key !== "corners") {
      editView.room = null;
      editView.picked.clear();
    }
    editPanel();
    scheduleDraw();
  }, { on: editView.tool === key })));
  const head = el("button", { type: "button", class: "edit-head", "aria-expanded": String(!editView.collapsed) }, editView.collapsed ? "Edit mode ▸" : "Edit mode ▾");
  head.addEventListener("click", () => {
    editView.collapsed = !editView.collapsed;
    editPanel();
  });
  const parts = [head, tools];
  if (editView.collapsed) return box.replaceChildren(...parts);
  const where = lv ? `${editFloor().code}, floor ${lv.level}` : null;
  const needPlan = (what) => el("p", {}, `Open a building's floor plans to ${what}.`);
  const t = editView.tool;
  if (t === "move") parts.push(el("p", {}, "Move the map, or drag labels and microwaves as in pin mode. Pick a tool to edit."));
  else if (t === "corners") {
    if (!lv) parts.push(needPlan("edit its rooms"));
    else if (!editView.room) parts.push(el("p", {}, `${where}: tap a room to edit its corners.`));
    else {
      const rings = editRings(editShape(lv, editView.room)?.d);
      const total = rings.reduce((n, r) => n + r.length, 0);
      parts.push(el("p", {}, `${editView.room}: ${total} corners, ${editView.picked.size} picked. Drag a picked corner to move them all.`));
      parts.push(el("div", { class: "edit-row" },
        editButton("Box select", () => { editView.boxMode = !editView.boxMode; editPanel(); }, { on: editView.boxMode }),
        editButton("Add to selection", () => { editView.additive = !editView.additive; editPanel(); }, { on: editView.additive }),
        editButton("Select all", () => { editView.picked = new Set(rings.flatMap((r, ri) => r.map((_, i) => `${ri}:${i}`))); editPanel(); scheduleDraw(); }),
        editButton("Clear", () => { editView.picked.clear(); editPanel(); scheduleDraw(); }, { disabled: !editView.picked.size })));
      parts.push(el("div", { class: "edit-row" },
        editButton("Delete corners", editDeleteCorners, { disabled: !editView.picked.size }),
        editButton("Add corner after", editAddCorner, { disabled: editView.picked.size !== 1 }),
        editButton("Reset room", editResetRoom),
        editButton("Done", () => { editView.room = null; editView.picked.clear(); editPanel(); scheduleDraw(); })));
    }
  } else if (["entrance", "stairs", "lift"].includes(t)) {
    const name = { entrance: "an entrance", stairs: "stairs", lift: "a lift" }[t];
    if (!lv) parts.push(needPlan(`add ${name}`));
    else {
      parts.push(el("p", {}, `${where}: tap the plan to add ${name}, tap one to pick it, drag it to move it.`));
      const row = [];
      if (t === "entrance") {
        const it = editView.item?.kind === "entrance" ? lv.entrances?.[editView.item.index] : null;
        if (it) row.push(editButton(it.main ? "Make it a side entrance" : "Make it a main entrance", () => {
          editSnapshot();
          it.main = !it.main;
          editRecord().entrances = lv.entrances;
          editSave();
          editRedraw();
        }));
        else row.push(editButton("New: main", () => { editView.newMain = true; editPanel(); }, { on: editView.newMain }),
          editButton("New: side", () => { editView.newMain = false; editPanel(); }, { on: !editView.newMain }));
      }
      row.push(editButton("Delete", editDeleteItem, { disabled: editView.item?.kind !== t }));
      parts.push(el("div", { class: "edit-row" }, ...row));
    }
  } else if (t === "microwave") {
    parts.push(el("p", {}, lv ? `${where}: tap the plan where the microwaves are.` : "Tap the map where the microwaves are, or open a floor plan to place them on a floor."));
    const name = el("input", { id: "edit-micro-name", type: "text", placeholder: "Name (e.g. Corridor)", value: editView.microName ?? "" });
    name.addEventListener("input", () => { editView.microName = name.value; });
    const count = el("input", { id: "edit-micro-count", type: "number", min: "1", max: "20", value: String(editView.microCount ?? 1), "aria-label": "How many" });
    count.addEventListener("input", () => { editView.microCount = Math.max(1, Number(count.value) || 1); });
    parts.push(el("div", { class: "edit-row" }, name, count));
    const mine = editView.data.microwaves;
    if (mine.length) {
      parts.push(el("div", { class: "edit-row" }, ...mine.map((m) => editButton(`✕ ${m.name} (${m.count})`, () => {
        editSnapshot();
        editView.data.microwaves = mine.filter((x) => x !== m);
        editSave();
        syncMicroLabels();
        editRedraw();
      }))));
    }
  }
  const { edits, pins } = editCount();
  const out = el("textarea", { id: "edit-out", readonly: "", rows: "2", "aria-label": "Edits to send" }, editExport());
  const copy = editButton("Copy edits", async () => {
    try {
      await navigator.clipboard.writeText(editExport());
      copy.textContent = "Copied";
    } catch {
      out.select();
    }
  });
  const clear = editButton("Clear all", () => {
    editView.data = { floors: {}, microwaves: [] };
    mapView.myPins = {};
    saveMyPins();
    editSave();
    location.reload(); // the plans as they were
  });
  parts.push(el("div", { class: "edit-row" }, editButton("Undo", editUndo, { disabled: !editView.undo.length }), copy, clear),
    el("p", { class: "muted" }, `${edits} change${edits === 1 ? "" : "s"} and ${pins} moved pin${pins === 1 ? "" : "s"}, kept in this browser. Copy them and send them over.`), out);
  box.replaceChildren(...parts);
}

// --- corners ---

function editSetRings(rings) {
  const lv = editLevel();
  const shape = editShape(lv, editView.room);
  shape.d = editPath(rings);
  (editRecord().shapes ??= {})[editView.room] = shape.d;
}

function editDeleteCorners() {
  const lv = editLevel();
  const rings = editRings(editShape(lv, editView.room)?.d);
  const next = rings.map((r, ri) => r.filter((_, i) => !editView.picked.has(`${ri}:${i}`)));
  if (next.some((r, ri) => r.length < 3 && rings[ri].length >= 3)) return flashNote("A shape needs 3 corners at least");
  editSnapshot();
  editSetRings(next);
  editView.picked.clear();
  editSave();
  editRedraw();
}

function editAddCorner() {
  const [key] = editView.picked;
  const [ri, i] = key.split(":").map(Number);
  const rings = editRings(editShape(editLevel(), editView.room)?.d);
  const r = rings[ri];
  const a = r[i];
  const b = r[(i + 1) % r.length];
  editSnapshot();
  r.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  editSetRings(rings);
  editView.picked = new Set([`${ri}:${i + 1}`]);
  editSave();
  editRedraw();
}

/** Back to the traced shape: reload the plan's file for it. */
async function editResetRoom() {
  const f = editFloor();
  const lv = editLevel();
  const key = editView.room;
  try {
    const doc = await getJSON(`/map/floors/${f.code}.json`);
    const orig = editShape(doc.levels.find((l) => l.level === lv.level) ?? { rooms: {} }, key);
    if (!orig) return;
    editSnapshot();
    editShape(lv, key).d = orig.d;
    delete editRecord().shapes?.[key];
    editView.picked.clear();
    editSave();
    editRedraw();
  } catch (e) {
    flashNote(`Couldn't load the plan: ${e.message}`);
  }
}

// --- pressing and tapping ---

/** A press on a corner or a picked item starts its drag; in box mode (or with Shift) a press on the plan starts a box. */
function editDown(e) {
  if (editView.tool === "move") return false;
  const corner = e.target.closest?.(".edit-corner");
  const item = e.target.closest?.(".edit-item");
  if (corner) {
    const key = corner.dataset.corner;
    if (!editView.picked.has(key)) {
      if (!(editView.additive || e.shiftKey)) editView.picked.clear();
      editView.picked.add(key);
    } else if (editView.additive || e.shiftKey) {
      editView.picked.delete(key);
      editPanel();
      scheduleDraw();
      return true;
    }
    editStartDrag(e, "corners");
    return true;
  }
  if (item) {
    editView.item = { kind: editView.tool, index: Number(item.dataset.item) };
    editStartDrag(e, "item");
    return true;
  }
  if (editView.tool === "corners" && editView.room && (editView.boxMode || e.shiftKey)) {
    const rect = $("#map-view").getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    editView.box = { x0: x, y0: y, x1: x, y1: y, base: e.shiftKey || editView.additive ? new Set(editView.picked) : new Set() };
    editStartDrag(e, "box");
    return true;
  }
  return false;
}

function editStartDrag(e, kind) {
  const start = editMetres(e.clientX, e.clientY);
  editView.drag = { kind, last: start, moved: false, x: e.clientX, y: e.clientY, snapped: false };
  const move = (ev) => {
    const d = editView.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 4) return;
    if (!d.moved && kind !== "box") editSnapshot();
    d.moved = true;
    const now = editMetres(ev.clientX, ev.clientY);
    const dx = now[0] - d.last[0];
    const dy = now[1] - d.last[1];
    d.last = now;
    if (kind === "corners") editMoveCorners(dx, dy);
    else if (kind === "item") editMoveItem(now);
    else {
      const rect = $("#map-view").getBoundingClientRect();
      editView.box.x1 = ev.clientX - rect.left;
      editView.box.y1 = ev.clientY - rect.top;
      editBoxPick();
    }
    scheduleDraw();
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    const d = editView.drag;
    editView.drag = null;
    editView.box = null;
    if (d?.moved && kind !== "box") editSave();
    editPanel();
    scheduleDraw();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  editPanel();
  scheduleDraw();
}

function editMoveCorners(dx, dy) {
  const lv = editLevel();
  const rings = editRings(editShape(lv, editView.room)?.d);
  for (const key of editView.picked) {
    const [ri, i] = key.split(":").map(Number);
    const p = rings[ri]?.[i];
    if (p) { p[0] += dx; p[1] += dy; }
  }
  editSetRings(rings);
  // Only this shape's path changes: no need to draw the whole level on every move.
  const path = document.querySelector(`#map-floor path[data-floor="${CSS.escape(editView.room)}"]`);
  path?.setAttribute("d", editShape(lv, editView.room).d);
}

function editMoveItem(at) {
  const lv = editLevel();
  const { kind, index } = editView.item;
  const p = editRound(at);
  if (kind === "entrance") {
    lv.entrances[index] = { ...lv.entrances[index], at: p, dir: editEntranceDir(lv, p) };
    editRecord().entrances = lv.entrances;
  } else {
    const list = kind === "stairs" ? lv.stairs : lv.lifts;
    list[index] = p;
    editRecord()[kind === "stairs" ? "stairs" : "lifts"] = list;
  }
  drawFloor();
}

function editBoxPick() {
  const { x0, y0, x1, y1, base } = editView.box;
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const picked = new Set(base);
  editRings(editShape(editLevel(), editView.room)?.d).forEach((ring, ri) => ring.forEach((p, i) => {
    const [px, py] = editPx(p);
    if (px >= ax && px <= bx && py >= ay && py <= by) picked.add(`${ri}:${i}`);
  }));
  editView.picked = picked;
}

/** A tap the edit mode takes: a shape to edit (corners), a new entrance, stairs, lift or microwave where it was. */
function editTap(target, e) {
  const t = editView.tool;
  if (t === "move") return false;
  const lv = editLevel();
  if (t === "corners") {
    if (!lv) return false;
    // The shape under the tap, also when its label is on top of it.
    const path = target.closest?.("#map-floor path[data-floor]")
      ?? document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.matches?.("#map-floor path[data-floor]"));
    if (!path) return true; // beside the shapes: nothing (no room view while editing)
    editView.room = path.dataset.floor;
    editView.picked.clear();
    editPanel();
    scheduleDraw();
    return true;
  }
  const at = editRound(editMetres(e.clientX, e.clientY));
  if (t === "microwave") {
    const building = mapView.floor?.code ?? buildingAtPoint(at);
    if (!building) {
      flashNote("Tap inside a building");
      return true;
    }
    editSnapshot();
    const n = editView.data.microwaves.length + 1;
    editView.data.microwaves.push({ id: `MW-NEW-${Date.now().toString(36)}-${n}`, area: mapView.area, building, name: (editView.microName || "Microwaves").trim(), count: editView.microCount ?? 1, place: null, floor: lv?.level ?? null, at });
    editSave();
    syncMicroLabels();
    editRedraw();
    return true;
  }
  if (!lv) return false;
  editSnapshot();
  if (t === "entrance") {
    lv.entrances = [...(lv.entrances ?? []), { at, dir: editEntranceDir(lv, at), main: editView.newMain }];
    editRecord().entrances = lv.entrances;
    editView.item = { kind: "entrance", index: lv.entrances.length - 1 };
  } else {
    const field = t === "stairs" ? "stairs" : "lifts";
    lv[field] = [...(lv[field] ?? []), at];
    editRecord()[field] = lv[field];
    editView.item = { kind: t, index: lv[field].length - 1 };
  }
  editSave();
  editRedraw();
  return true;
}

function editDeleteItem() {
  const lv = editLevel();
  const { kind, index } = editView.item ?? {};
  if (!lv || !kind) return;
  editSnapshot();
  if (kind === "entrance") {
    lv.entrances = lv.entrances.filter((_, i) => i !== index);
    editRecord().entrances = lv.entrances;
  } else {
    const field = kind === "stairs" ? "stairs" : "lifts";
    lv[field] = lv[field].filter((_, i) => i !== index);
    editRecord()[field] = lv[field];
  }
  editView.item = null;
  editSave();
  editRedraw();
}

/** The building whose outline holds a point on the campus map, else the nearest one's anchor within 40 m. */
function buildingAtPoint(at) {
  for (const [code, b] of Object.entries(mapView.doc?.buildings ?? {})) {
    if (b.d && editRings(b.d).reduce((n, r) => n + (editInside(at, r) ? 1 : 0), 0) % 2 === 1) return code;
  }
  let best = null;
  for (const code of Object.keys(mapView.doc?.buildings ?? {})) {
    const a = anchorOf(code);
    const d = a ? Math.hypot(a[0] - at[0], a[1] - at[1]) : Infinity;
    if (d < 40 && (!best || d < best.d)) best = { code, d };
  }
  return best?.code ?? null;
}

// --- set-up: wrap the map's drawing, add the overlay and the panel ---

function initEdit() {
  editLoad();
  document.body.classList.add("edit-mode");
  $("#map-view").append(el("div", { id: "edit-layer", class: "edit-layer" }), el("div", { id: "edit-panel", class: "edit-ui edit-panel" }));
  const baseDrawView = drawView;
  drawView = function editDrawView() {
    baseDrawView();
    editOverlay();
  };
  const baseDrawFloor = drawFloor;
  drawFloor = function editDrawFloor() {
    editApply();
    baseDrawFloor();
  };
  // The new microwaves show like the others (and can be dragged as pins).
  const baseMicrowaves = mapMicrowaves;
  mapMicrowaves = function editMicrowaves() {
    const list = baseMicrowaves();
    const mine = editView.data.microwaves.filter((m) => m.area === mapView.area);
    return list ? [...list, ...mine] : mine.length ? mine : list;
  };
  editHooks.down = editDown;
  editHooks.tap = editTap;
  // A floor view that opened before this script arrived gets its edits now.
  if (mapView.floor?.doc) drawFloor();
  if (mapView.doc) syncMicroLabels();
  // Phones: the sheet goes down to its head, so the map has the room.
  if (layout() === "full") sheet.snap("peek");
  editPanel();
  scheduleDraw();
  // The panel follows the floor view (open, level, building).
  new MutationObserver(() => editPanel()).observe($("#map-floor-title"), { childList: true, characterData: true, subtree: true });
}

initEdit();
