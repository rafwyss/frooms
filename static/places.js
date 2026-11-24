"use strict";

// One detail view per place, in the results sheet: a room, a study space, library, workspace, mensa or cafeteria, a
// building, a microwave spot, "Near you", and the account's views (static/account.js: kind "account"). Each has its own address (/?room=HG+E+33.1&area=Z, /?space=MMB79&area=Z, /?building=HG&area=Z, /?microwave=MW-MM-1&area=Z; lib.js)
// and a history entry, so Back returns to the list where it was. Opening a place from another one replaces the entry
// (Back always goes to the list), except a building's or Near you's rows, which stack. The floor view's entries sit
// above a place's. Loaded after map.js and before app.js; uses their helpers once the page is running.

const placesView = {
  current: null, // { kind, id, area } shown, or null (the list)
  depth: 0, // place entries this page pushed (Back from the first one returns to the list)
  listScroll: 0, // the list's scroll position when the first place opened
  opener: null, // the element that opened it (focus returns there)
  requestId: 0,
  banner: null, // an invite's sentence, shown above the status
  section: null, // a section the next building view scrolls to ("microwaves")
  data: null, // the room's /api/room answer
  reportPanel: null, // the reports' control open in the view: "report" or null (closed)
  logOpen: false, // the report log is open
  toList: false, // placeToList's Back is on its way
};

/** Replace a box's contents, leaving out what doesn't apply (null). */
const fill = (box, ...nodes) => box.replaceChildren(...nodes.filter((x) => x != null));

/** Views without an area or an address of their own: Near you and the account's (sign-in, profile, friends, …). */
const AREALESS = new Set(["near", "account"]);

const isPlaceEntry = (st) => st?.frooms === "place" && st.load === PAGE_LOAD;
const samePlace = (a, b) => !!a && !!b && a.kind === b.kind && a.id === b.id && (a.area ?? null) === (b.area ?? null);

/**
 * Open a place's detail view. `kind` is room, space, building or near. Options: `from` "list" (the default), "place"
 * (from another place: replaces its entry), "stack" (a building's or Near you's row: a new entry), "url" (the page
 * was loaded on its address), "floor" (a shape on the floor plan: no entry, the floor view's is on top), "history"
 * (Back or Forward); `banner` an invite's sentence; `meal` opens that meal's menu (an invite); `opener` the element
 * clicked.
 */
async function openPlace(place, { from = "list", banner = null, meal = null, opener = null, save = true, section = null } = {}) {
  showNotice(null);
  // The other Zentrum campus's mensas are listed with this campus's: they open here, keeping their own area.
  // Their microwaves too (both Zentrum campuses list Zentrum's).
  const partnerList = state.spaces?.area === state.area && place.area === ZENTRUM_PARTNER[state.area];
  const partner = partnerList && (place.kind === "space" ? state.spaces.spaces.some((s) => s.id === place.id && s.partner)
    : place.kind === "microwave" && (state.spaces.microwaves ?? []).some((m) => m.id === place.id && m.area === place.area));
  if (!AREALESS.has(place.kind) && place.area && place.area !== state.area && !partner) {
    await selectArea(place.area, { save });
  }
  const p = { kind: place.kind, id: place.id, area: AREALESS.has(place.kind) ? null : partner ? place.area : state.area };
  if (p.kind === "room" || p.kind === "space") countUse("place_open");
  const wasOpen = !!placesView.current;
  if (!wasOpen) {
    placesView.listScroll = $("#sheet-body").scrollTop;
    placesView.opener = opener ?? (document.activeElement !== document.body ? document.activeElement : null);
    const li = placesView.opener?.closest?.("li[data-room], li[data-space]");
    placesView.openerKey = li ? (li.dataset.room ? `data-room="${CSS.escape(li.dataset.room)}"` : `data-space="${CSS.escape(li.dataset.space)}"`) : null;
  }
  const url = AREALESS.has(p.kind) ? location.pathname + location.search : placeUrl(p);
  const entry = { frooms: "place", load: PAGE_LOAD, place: p };
  if (from === "list" || (from === "stack" && wasOpen)) {
    history.pushState(entry, "", url);
    placesView.depth++;
  } else if (from === "search" && isSearchEntry(history.state)) {
    history.replaceState(entry, "", url); // the search's entry becomes the place's: Back goes to the list
    placesView.depth++;
  } else if (from === "search") {
    history.pushState(entry, "", url);
    placesView.depth++;
  } else if (from === "place" || from === "url") {
    history.replaceState(entry, "", url);
    if (from === "url") placesView.depth = 0;
  } // "floor" and "history": no change
  placesView.banner = banner;
  placesView.section = section; // a building's view scrolls to it once drawn ("microwaves", from the map's label)
  showPlace(p);
  if (meal) {
    sheet.snap("full");
    openMenu(p.id, null, { date: chosenTime().date, meal });
  }
}

/** Show the view (without touching the history). */
function showPlace(p) {
  placesView.current = p;
  placesView.starMeta = null;
  placesView.reportPanel = null;
  placesView.logOpen = false;
  syncStarButtons();
  document.getElementById("sheet").classList.add("detail-open");
  $("#detail").hidden = false;
  $("#sheet-back").hidden = false;
  $("#filter-line").hidden = true;
  $("#sheet-title").hidden = false;
  closeFilters();
  closeInviteMenus();
  // The account's views are forms and lists: the whole sheet on phones (not "Friends in HG", from the map).
  if (layout() === "full" && p.kind === "account" && !p.id.startsWith("friendsat:")) sheet.snap("full");
  else if (layout() === "full" && sheet.current() !== "full") sheet.snap("half");
  $("#sheet-body").scrollTop = 0;
  // The map shows the place's building.
  const code = p.kind === "building" ? p.id : null;
  markPlaceBuilding(code);
  renderPlaceView();
}

/** Highlight the building of the place on the map and bring it into view (unknown yet for rooms and spaces). */
function markPlaceBuilding(code) {
  mapView.selected = code;
  mapView.selectedMensa = false;
  if (!mapView.doc) return;
  fillLabels();
  if (code) revealBuilding(code);
  scheduleDraw();
}

/** Back to the list, where it was. */
function closePlace() {
  if (!placesView.current) return;
  placesView.current = null;
  placesView.banner = null;
  placesView.requestId++;
  placesView.depth = 0;
  document.getElementById("sheet").classList.remove("detail-open");
  $("#detail").hidden = true;
  $("#detail").replaceChildren();
  $("#sheet-back").hidden = true;
  placesView.starMeta = null;
  syncStarButtons();
  if (mapView.floor?.picked) closeFloorPick();
  markPlaceBuilding(null);
  renderModes(); // the list's head and title again
  $("#sheet-body").scrollTop = placesView.listScroll;
  // Focus goes back to the row that opened it (the list may have been drawn again meanwhile: the same place's row).
  const opener = placesView.opener;
  const key = placesView.openerKey;
  placesView.opener = null;
  placesView.openerKey = null;
  const again = opener?.isConnected ? opener : key ? document.querySelector(`#sheet-body li[${key}] .row-open`) : null;
  again?.focus({ preventScroll: true });
}

/** The back button and Escape: one level back. */
function placeBack() {
  if (!placesView.current) return;
  if (isPlaceEntry(history.state) && placesView.depth > 0) history.back(); // popstate shows what's below
  else {
    // Opened on its own address (or the entry is gone): the list, at the plain address.
    history.replaceState(null, "", "/");
    closePlace();
  }
}

/**
 * Leave every place view at once, back to the tab's list as it was (a click on the map beside the buildings): Back
 * over all the view's entries, or the plain address when it was opened on its own. The account's views stay (they
 * aren't about a place on the map); false when there was nothing to leave.
 */
function placeToList() {
  const p = placesView.current;
  if (!p || p.kind === "account") return false;
  const depth = isPlaceEntry(history.state) ? placesView.depth : 0;
  if (depth > 0) {
    placesView.toList = true; // the popstate closes the view whatever entry it lands on
    history.go(-depth);
  } else {
    history.replaceState(null, "", "/");
    closePlace();
  }
  return true;
}

function onPlacePopState() {
  const st = history.state;
  if (placesView.toList) {
    placesView.toList = false;
    // Landing on a place's entry: the view was first opened on its own address, so that entry becomes the plain one.
    if (isPlaceEntry(st)) history.replaceState(null, "", "/");
    return closePlace();
  }
  if (isPlaceEntry(st)) {
    placesView.depth = Math.max(0, placesView.depth - 1);
    if (!samePlace(st.place, placesView.current)) showPlace(st.place);
    return;
  }
  if (st?.frooms === "map" || st?.frooms === "menu" || isSearchEntry(st)) return; // the floor view's, menu's or search's
  closePlace();
}

/** Reload what the view shows (the list refreshed, or a star changed). */
function refreshPlace() {
  if (placesView.current) renderPlaceView();
}

// --- the views ---

/** Draw the current view; `reuse` keeps the room's last answer (after a report: no new request, only the redraw). */
async function renderPlaceView({ reuse = false } = {}) {
  const p = placesView.current;
  const id = ++placesView.requestId;
  const box = $("#detail");
  if (p.kind === "near") return renderNearView(box);
  if (p.kind === "account") return renderAccountView(box, p);
  $("#sheet-title").textContent = p.kind === "building" ? buildingLabel(p.id) : p.kind === "microwave" ? "Microwaves" : p.id;
  if (!box.firstChild || box.dataset.key !== `${p.kind}|${p.id}`) fill(box, el("p", { class: "muted detail-loading" }, "Loading…"));
  box.dataset.key = `${p.kind}|${p.id}`;
  try {
    if (p.kind === "room") await renderRoomView(box, p, id, reuse);
    else if (p.kind === "space") await renderSpaceView(box, p, id);
    else if (p.kind === "microwave") await renderMicrowaveView(box, p, id);
    else await renderBuildingView(box, p, id);
  } catch (e) {
    if (id !== placesView.requestId) return;
    if (/404|Unknown/.test(e.message)) {
      // An address of a place frooms doesn't have (any more): the list, with a short note.
      if (isPlaceEntry(history.state) && placesView.depth > 0) history.back();
      else history.replaceState(null, "", "/");
      closePlace();
      showNotice(`frooms doesn't know ${p.id} (any more).`);
      return;
    }
    fill(box, el("p", { class: "message" }, e.message === "offline" ? OFFLINE_MSG : `Could not load it: ${e.message}`));
  }
}

/** The status in large type, with an invite's sentence above it. */
function detailHead(lines, sub) {
  return el("div", { class: "detail-head", "data-tour": "place-status" },
    placesView.banner ? el("p", { class: "invite-banner" }, placesView.banner) : null,
    el("div", { class: "detail-status" }, ...lines.map((l, i) => el("span", { class: `${i ? "when2" : "when"} ${l.cls}` }, l.text))),
    sub ? el("div", { class: "detail-sub muted" }, sub) : null);
}

/** The row of actions at the bottom of the view: only those that apply. */
function actionBar(...actions) {
  return el("div", { class: "detail-actions" }, ...actions.filter(Boolean).flat());
}

/**
 * A room's or place's actions at the bottom of the view, in three rows of two: Official info and Show on floor (or on
 * campus); Report a problem and Report occupancy; Star
 * and Invite (and Check in: three). Only those that apply; one alone in its row takes the whole row. Checked in there,
 * `checkin` is a pair, Checked in and the round Check out, which takes a narrow cell at the row's end.
 */
function actionGrid({ official = null, show = null, problem = null, occupancy = null, star = null, invite = null, checkin = null }) {
  const [report, rate] = Array.isArray(occupancy) ? occupancy : [occupancy];
  markTour(invite, "invite");
  const [starButton, starNote] = star ?? [];
  const [checkinButton, checkoutButton] = Array.isArray(checkin) ? checkin : [checkin];
  const rows = [[official, show], [problem, report, rate], [starButton, invite, checkinButton, checkoutButton]];
  // Twelve columns: a row's buttons share them equally (6 + 6, 4 + 4 + 4, or one across); Check out takes 2 and
  // Checked in what's left over (Star 3, Invite 3, Checked in 4, Check out 2).
  // data-row: the tutorial's "What you can do" goes through the rows one by one (tutorial.js tourActionRow).
  const cells = rows.flatMap((row, r) => {
    const items = row.filter(Boolean);
    const spans = actionSpans(items.length, checkoutButton && items.includes(checkoutButton) ? items.indexOf(checkinButton) : -1);
    return items.map((item, i) => el("div", { class: `action-cell span-${spans[i]}${i && i === items.length - 1 ? " right" : ""}`, "data-row": String(r + 1) }, item));
  });
  return el("div", { class: "detail-actions grid", "data-tour": "place-actions" }, ...cells, starNote ?? null);
}

function actionButton(text, iconPath, onClick, cls = "") {
  const b = el("button", { type: "button", class: `detail-action ${cls}`.trim() }, iconPath ? icon(iconPath) : null, el("span", {}, text));
  b.addEventListener("click", onClick);
  return b;
}

function officialLink(href) {
  if (!href) return null;
  return el("a", { class: "detail-action", href, target: "_blank", rel: "noopener" }, icon(INFO_ICON), el("span", {}, "Official info"));
}

/** Show on floor, when the building has floor plans (never otherwise, so the page works without them). */
function planButton(building, focus) {
  if (!hasFloors(building)) return null;
  return actionButton("Show on floor", null, () => {
    if (layout() === "full") sheet.snap("half");
    if (mapView.floor) {
      if (mapView.floor.code === building) pickFloor(focus, true);
      else switchFloors(building).then(() => pickFloor(focus, true));
    } else openFloors(building, focus);
  }, "plan");
}

/**
 * Show on campus: the campus map with the building in the middle of its visible part, zoomed in a little (leaving the
 * floor view first, and on phones lowering the sheet to half so the map shows). `layer`: the map filter to turn on so
 * the place's own label shows ("mensa" or "cafe").
 */
function campusButton(building, layer = null, text = "Show on campus") {
  if (!building) return null;
  return actionButton(text, null, () => {
    if (layout() === "full") sheet.snap("half");
    const inFloors = !!mapView.floor;
    if (inFloors) closeFloors();
    if (layer && state.mapLayer !== layer) {
      state.mapLayer = layer;
      savePrefs();
      renderMapLayers();
    }
    markPlaceBuilding(building);
    // After the sheet has moved (and the floor view's Back has run): fly there.
    setTimeout(() => {
      if (!anchorOf(building)) return;
      const from = { cx: mapView.cx, cy: mapView.cy, scale: mapView.scale };
      fitTo([building], CAMPUS_SHOW_SCALE);
      const to = { cx: mapView.cx, cy: mapView.cy, scale: mapView.scale };
      Object.assign(mapView, from);
      flyTo(to.cx, to.cy, to.scale);
    }, inFloors || layout() === "full" ? 350 : 0);
  }, "campus");
}

/** How far "Show on campus" zooms in (px per metre): a building and its neighbours. */
const CAMPUS_SHOW_SCALE = 1;

/** Mensas, cafeterias and microwaves show on the campus; rooms and study spaces on their floor, or on the campus without plans. */
const showButton = (building, focus, kind = null) => (!kind && hasFloors(building) ? planButton(building, focus) : campusButton(building, kind));

function reportButton(name) {
  return markTour(actionButton("Report a problem", null, () => openFeedback("wrong-info", name), "report"), "problem");
}

const PLAN_ICON = "M4 4h16v16H4zM4 12h7M11 4v16M15 12h5";

// Room: free or busy until, seats, type, equipment (when known), today's bookings.

async function renderRoomView(box, p, id, reuse = false) {
  const q = new URLSearchParams({ room: p.id, area: p.area });
  if (!state.now) q.set("at", sharedTime());
  const data = reuse && placesView.data?.room?.room === p.id ? placesView.data : await getJSON(`/api/room?${q}`);
  if (id !== placesView.requestId) return;
  placesView.data = data;
  const r = data.room;
  const at = data.at;
  markPlaceBuilding(r.building);
  const cls = roomLook(r, "closed");
  const meta = [r.seats != null ? `${r.seats} seats` : null, r.type, distanceOf(r.building)].filter(Boolean).join(" · ");
  const note = details(r, at);
  const equipment = equipmentText(r.equipment); // from ETH's room details; nothing while unknown
  const uzh = university() === "UZH";
  const bookings = data.bookings.map((b) => {
    const now = b.from <= at && at < b.to;
    const what = b.kind === "closed" ? "Building closed" : uzh || !b.title ? "booked" : b.title;
    return el("li", { class: `booking ${b.kind}${now ? " now" : ""}` },
      el("span", { class: "bk-time" }, `${hhmm(b.from)}–${day(b.to) !== day(b.from) ? "24:00" : hhmm(b.to)}`),
      el("span", { class: "bk-what" }, what), now ? el("span", { class: "bk-now" }, "now") : null);
  });
  const heading = state.now ? "Today's bookings" : `Bookings on ${weekday(at)} ${day(at).slice(8, 10)}.${day(at).slice(5, 7)}.`;
  const invite = r.status === "free" || cls === "soon" ? inviteControl(() => inviteText(r, at), () => inviteUrl(r), { labels: "Invite" }) : null;
  // Reports are about now, and about rooms whose row shows them (free or busy, not "no data"), unless the building is
  // closed (nobody is in to see it).
  const reportable = state.now && (r.status === "free" || r.status === "managed" || (r.status === "busy" && r.current_kind !== "closed"));
  const reports = reportsOf("room", r.room, p.area, r.reports);
  fill(box,
    detailHead([{ text: describe(r, at), cls }], meta),
    markTour(scheduleBar(r.blocks, at, true, !!r.managed_by), "schedule-bar"),
    note ? el("p", { class: "muted detail-note" }, note) : null,
    equipment ? el("p", { class: "muted detail-note" }, equipment) : null,
    el("section", { class: "detail-part" },
      el("h3", {}, heading),
      bookings.length ? el("ul", { class: "bookings" }, ...bookings)
        : el("p", { class: "muted" }, r.status === "free" ? "Nothing booked." : r.status === "managed" ? `Nothing booked at ETH. ${r.managed_by}'s own bookings aren't shown.` : "No booking data for this day.")),
    reportsSection(p, reports, state.now ? null : "No reports for future times.", { reportable }),
    actionGrid({ official: officialLink(r.eth_url), show: showButton(r.building, r.room), problem: reportButton(r.room),
      occupancy: reportable ? reportActions(p) : null, star: starAction(p, { name: r.room, building: r.building, typecode: r.typecode }),
      invite: invite ? inviteBox(invite, true) : null, checkin: checkinAction({ kind: "room", id: r.room, area: p.area, name: r.room }) }));
}

// --- the reports section and "usually this full" ---

const REPORT_LOG_URL = (p) => `/api/reports?${new URLSearchParams({ place_kind: p.kind, place: p.id, area: p.area })}`;

/**
 * "frooms users' occupancy reports": the control to report (when `reportable` and opened by its action, or when you
 * reported this place in the past 2 hours), the past 2 hours as "[•••] full 5×, [••] crowded 2×" (only the levels
 * reported) and, for a space with frooms' estimate, "[•••] full: about 85 % (3 reports, past 2 hours)"; a "Report
 * log" button lists the past 4 hours from /api/reports in a small box that scrolls. With `note` (a future time: "No
 * reports for future times."; a closed space) only that line shows. `estimate`: frooms' live estimate, if any.
 */
function reportsSection(p, summary, note, { reportable = false, estimate = null } = {}) {
  const parts = [el("h3", {}, "frooms users' occupancy reports")];
  if (note) return el("section", { class: "detail-part reports", "data-tour": "report-log" }, ...parts, el("p", { class: "muted" }, note));
  if (reportable) {
    const now = Date.now();
    const mine = myReportOf(state.myReports, reportKey(p), estimate != null ? "pct" : "level", now);
    if (!placesView.reportPanel && mine) placesView.reportPanel = "report";
    if (placesView.reportPanel === "report") parts.push(reportControls(p, estimate));
  }
  // Percentages: "[•••] full: about 85 % (3 reports, past 2 hours)", the mannequins and word of the level it makes.
  const pct = summary?.n_pct ? summary.pct : null;
  if (pct != null) {
    const level = pctLevel(pct);
    parts.push(el("p", { class: "report-levels" }, el("span", { class: "report-level" }, people(level, true), ` ${REPORT_LEVELS[level]}`),
      `: ${fullText(pct)} (${plural(summary.n_pct, "report", "reports")}, past 2 hours)`));
  }
  // Levels: "[•••] full 5×, [••] crowded 2× in the past 2 hours".
  const levels = reportedLevels(summary);
  if (levels.length) {
    parts.push(el("p", { class: "report-levels" },
      ...levels.flatMap(({ level, count }, i) => [i ? ", " : null, el("span", { class: "report-level" }, people(level, true), ` ${REPORT_LEVELS[level]} ${count}×`)]),
      " in the past 2 hours"));
  } else if (pct == null) parts.push(el("p", { class: "muted" }, "No reports in the past 2 hours."));
  const log = el("div", { class: "report-log", id: "report-log", hidden: "" });
  const button = el("button", { type: "button", class: "sheet-link", "aria-expanded": "false", "aria-controls": "report-log" }, "Report log");
  const load = async () => {
    fill(log, el("p", { class: "muted" }, "Loading…"));
    try {
      const data = await getJSON(REPORT_LOG_URL(p), { fresh: signedIn() });
      if (!log.isConnected) return;
      const msg = el("p", { class: "report-vote-msg", role: "status" });
      if (data.reports.length) fill(log, el("ul", {}, ...data.reports.map((r) => reportLogRow(r, msg))), msg);
      else fill(log, el("p", { class: "muted" }, "No reports in the past 4 hours."));
    } catch (e) {
      fill(log, el("p", { class: "muted" }, e.message === "offline" ? "You're offline." : "Couldn't load the log."));
    }
  };
  const show = (open) => {
    log.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    placesView.logOpen = open;
    if (open) load();
  };
  button.addEventListener("click", () => show(log.hidden));
  // Redrawn after a report: an open log stays open, with the new report in it.
  if (placesView.logOpen) queueMicrotask(() => show(true));
  return el("section", { class: "detail-part reports", id: "reports-section", "data-tour": "report-log" }, ...parts, button, log);
}

// --- reporting (now only): Report occupancy (a level, or a percentage for spaces with frooms' estimate) ---

const REPORT_BUTTON_NAMES = ["Free", "Crowded", "Full"];
const clock = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The view's action "Report occupancy" (a microwave's "Report queue"): it opens the reports' control. */
function reportActions(p, estimate = null, text = "Report occupancy") {
  const toggle = (panel) => {
    placesView.reportPanel = placesView.reportPanel === panel ? null : panel;
    renderPlaceView({ reuse: true }).then(() => {
      const section = document.getElementById("reports-section");
      if (!section || !placesView.reportPanel) return;
      // To the section's top: "nearest" would leave the control behind the sticky action row.
      section.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      section.querySelector(".report-control button, .report-control input")?.focus({ preventScroll: true });
    });
  };
  const report = markTour(actionButton(text, null, () => toggle("report"), "report-occ"), "report");
  report.setAttribute("aria-expanded", String(placesView.reportPanel === "report"));
  report.setAttribute("aria-controls", "reports-section");
  return [report];
}

/**
 * Send, then redraw the view from the answer (no new request) and put the focus back on the control's counterpart.
 * `msg` shows "Sending…" and then the error, if any.
 */
async function submitReport(p, kind, value, estimate, controls, msg, focusSel) {
  controls.forEach((c) => (c.disabled = true));
  msg.textContent = "Sending…";
  try {
    await sendReport(p, kind, value, estimate);
  } catch (e) {
    controls.forEach((c) => (c.disabled = false));
    msg.textContent = e.message;
    msg.classList.add("error");
    return;
  }
  if (!samePlace(placesView.current, p)) return;
  placesView.justSent = kind;
  await renderPlaceView({ reuse: true });
  placesView.justSent = null;
  document.querySelector(`#reports-section ${focusSel}`)?.focus({ preventScroll: true });
}

/**
 * Report occupancy. Without frooms' estimate: three big buttons Free, Crowded, Full with their mannequins; one click
 * sends it. With the estimate: a slider 0 to 100 % in 5 % steps starting at it, and Send. Your report of the past 2
 * hours shows pressed with "You reported crowded at 14:05"; another click changes it (the Worker replaces it).
 */
function reportControls(p, estimate) {
  const kind = estimate != null ? "pct" : "level";
  const mine = myReportOf(state.myReports, reportKey(p), kind, Date.now());
  const msg = el("p", { class: "report-msg", role: "status", tabindex: "-1" });
  if (placesView.justSent === kind) msg.textContent = "Thanks, counted for 2 hours.";
  else if (placesView.justSent === `removed-${kind}`) msg.textContent = "Removed.";
  else if (mine) msg.textContent = kind === "pct" ? `You reported ${mine.value} % at ${clock(mine.at)}.` : `You reported ${REPORT_LEVELS[mine.value]} at ${clock(mine.at)}.`;
  if (kind === "level") {
    const buttons = [0, 1, 2].map((level) => {
      const on = mine?.value === level;
      const b = el("button", { type: "button", class: `report-choice ${REPORT_LEVELS[level]}${on ? " on" : ""}`, "aria-pressed": String(on), "data-level": String(level) },
        people(level, true), el("span", {}, REPORT_BUTTON_NAMES[level]));
      b.addEventListener("click", () => submitReport(p, "level", level, null, buttons, msg, `[data-level="${level}"]`));
      return b;
    });
    return el("div", { class: "report-control", "data-tour": "report-choices" },
      el("p", { class: "report-ask" }, "How full is it right now?"),
      el("div", { class: "report-choices", role: "group", "aria-label": "How full is it right now?" }, ...buttons),
      mineLine(msg, mine ? removeMineButton(p, kind, buttons, msg) : null));
  }
  const start = mine ? mine.value : sliderStart(estimate);
  const value = el("output", { class: "report-pct", for: "report-slider" }, `${start} %`);
  const slider = el("input", { type: "range", id: "report-slider", min: "0", max: "100", step: "5", value: String(start), "aria-label": "How full it is, in percent" });
  slider.addEventListener("input", () => (value.textContent = `${slider.value} %`));
  const send = el("button", { type: "button", class: "report-send" }, mine ? "Send again" : "Send");
  send.addEventListener("click", () => submitReport(p, "pct", Number(slider.value), estimate, [slider, send], msg, ".report-send"));
  return el("div", { class: "report-control", "data-tour": "report-choices" },
    el("p", { class: "report-ask" }, `How full is it right now? frooms says ${fullText(estimate)}.`),
    el("div", { class: "report-slider" }, slider, value), send,
    mineLine(msg, mine ? removeMineButton(p, kind, [slider, send], msg) : null));
}

/**
 * The round red ✕ beside "You reported crowded at 14:05": removes your report (app.js removeMyReport), with the street
 * cred it earned; `after` runs once it's gone (the place's view: drawn again with the control still open; the check-in
 * window: its own redraw). `msg` shows any error.
 */
function removeMineButton(p, kind, controls, msg, after = null) {
  const b = removeButton("Remove my report", async () => {
    const all = [...controls, b];
    all.forEach((c) => (c.disabled = true));
    msg.classList.remove("error");
    try {
      await removeMyReport(p, kind);
    } catch (e) {
      all.forEach((c) => (c.disabled = false));
      msg.textContent = e.message;
      msg.classList.add("error");
      return;
    }
    if (after) return after();
    if (!samePlace(placesView.current, p)) return;
    placesView.justSent = `removed-${kind}`;
    await renderPlaceView({ reuse: true });
    placesView.justSent = null;
    document.querySelector("#reports-section .report-msg")?.focus({ preventScroll: true });
  });
  return b;
}

/** Your report's line ("You reported crowded at 14:05") with its ✕, or the message alone. */
const mineLine = (msg, remove) => (remove ? el("div", { class: "report-mine" }, msg, remove) : msg);

/**
 * One line of the log: "14:05 [•••] full" or "14:05 [••] about 70 %" (the level the percentage makes), always without who sent it. A trusted
 * reporter's line (20 👍 received) has the round frooms icon before the time and a faint tint. At the end, where sign-in
 * is on: 👍 and 👎 with their counts, buttons when signed in (your choice pressed, a second click removes it), plain
 * counts when signed out, "You" on your own report. `msg` says when a vote fails.
 */
function reportLogRow(r, msg) {
  const at = new Date(r.at);
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const what = r.kind === "queue" ? [QUEUE_NAMES[r.value] ?? ""] : r.kind === "level" ? [people(r.value, true), " ", REPORT_LEVELS[r.value]] : [people(pctLevel(r.value), true), " ", fullText(r.value)];
  const row = el("li", { class: r.trusted ? "trusted" : "" });
  if (r.trusted) {
    row.append(el("img", { class: "trusted-mark", src: "/icons/trusted.svg", alt: "Trusted reporter", title: "Trusted reporter", width: "18", height: "18" }));
  }
  row.append(el("span", { class: "bk-time" }, time), el("span", { class: "report-what" }, ...what));
  if (typeof r.up === "number") row.append(reportVotes(r, row, msg));
  return row;
}

const VOTE_NAMES = { 1: "Accurate", [-1]: "Not accurate" };

/** The end of a log line: "You", the counts, or the two vote buttons. */
function reportVotes(r, row, msg) {
  if (r.mine) return el("span", { class: "report-votes report-you" }, "You");
  const count = (n) => el("span", { class: "vote-n" }, String(n));
  if (r.vote === undefined || !accountReady()) {
    return el("span", { class: "report-votes", "aria-label": `${r.up} accurate, ${r.down} not accurate` },
      el("span", { class: "vote-count", "aria-hidden": "true" }, "👍", count(r.up)), el("span", { class: "vote-count", "aria-hidden": "true" }, "👎", count(r.down)));
  }
  const buttons = [1, -1].map((v) => {
    const on = r.vote === v;
    const b = el("button", { type: "button", class: `vote-btn${on ? " on" : ""}`, "aria-pressed": String(on),
      "aria-label": `${VOTE_NAMES[v]} (${v === 1 ? r.up : r.down})`, title: VOTE_NAMES[v] }, v === 1 ? "👍" : "👎", count(v === 1 ? r.up : r.down));
    b.addEventListener("click", async () => {
      buttons.forEach((x) => (x.disabled = true));
      msg.textContent = "";
      try {
        const res = await accountFetch("POST", "/api/reports/vote", { id: r.id, up: on ? null : v === 1 });
        credEarned(res.cred);
        const next = reportLogRow({ ...r, ...res.report }, msg);
        row.replaceWith(next);
        next.querySelector(`.vote-btn:nth-of-type(${v === 1 ? 1 : 2})`)?.focus();
      } catch (e) {
        buttons.forEach((x) => (x.disabled = false));
        msg.textContent = errorText(e);
      }
    });
    return b;
  });
  return el("span", { class: "report-votes", role: "group", "aria-label": "Is this report accurate?" }, ...buttons);
}

/**
 * "Usually this full": the day's curve from the Worker's `usual` (one thin navy bar per quarter hour, 07:00 to 22:00,
 * the chosen time's amber) and "Usually about 55 % full at this time", or "Not enough data yet" while the history is
 * too short. Shown for the chosen time, future or not (it's the history, not a report).
 */
function usualSection(usual, at) {
  const slot = slotOfTime(hhmm(at));
  const curve = usual?.curve ?? [];
  const bars = el("div", { class: "usual-bars", "aria-hidden": "true" });
  for (let i = BAR_FROM / 15; i < BAR_TO / 15; i++) {
    const v = curve[i];
    const bar = el("i", { class: `${v == null ? "none" : ""}${i === slot ? " now" : ""}`.trim() });
    if (v != null) bar.style.height = `${Math.max(v, 3)}%`;
    bars.append(bar);
  }
  const ticks = el("div", { class: "sched-ticks", "aria-hidden": "true" }, ...[7, 10, 13, 16, 19, 22].map((h) => {
    const t = el("span", {}, String(h).padStart(2, "0"));
    t.style.left = `${barNeedle(`${String(h).padStart(2, "0")}:00`)}%`;
    return t;
  }));
  const text = usual?.pct == null ? "Not enough data yet." : `Usually ${fullText(usual.pct)} at this time.`;
  return el("section", { class: "detail-part usual", "data-tour": "usual" }, el("h3", {}, "Usually this full"), bars, ticks, el("p", {}, text),
    el("p", { class: "muted usual-note" }, "From the past two months' readings (half) and the past week's (half) on this weekday."));
}

// Study space, library, mensa or cafeteria.

/** The area's spaces at the chosen time: the list's answer, else asked for. */
async function loadSpaces() {
  if (state.spaces?.area === state.area) return state.spaces;
  const params = new URLSearchParams({ area: state.area });
  if (!state.now) params.set("at", sharedTime());
  const data = await getJSON(`/api/spaces?${params}`);
  state.spaces = { ...data, area: state.area };
  return state.spaces;
}

async function renderSpaceView(box, p, id) {
  const data = await loadSpaces();
  if (id !== placesView.requestId) return;
  const s = data.spaces.find((x) => x.id === p.id);
  if (!s) throw new Error("Unknown place");
  const at = data.at;
  $("#sheet-title").textContent = s.name;
  markPlaceBuilding(s.building);
  const mensa = s.category === "mensa";
  // The tab that fits it (an address or a search result can open it from anywhere).
  if (state.mode !== "you" && (mensa ? state.mode !== "mensa" : state.mode !== "study")) switchModeQuietly(mensa ? "mensa" : "study");
  const status = describeSpace(s, at);
  const sub = [s.room, s.seats != null ? `${s.seats} seats` : null, s.card24h ? "24 h with ETH card" : null, distanceOf(s.building)].filter(Boolean).join(" · ");
  const meals = (s.meals_today ?? []).map((m) => `${MEAL_NAMES[m.meal]} ${m.from}–${m.to}`);
  let menu = null;
  if (s.menu) {
    menu = el("button", { class: "menu-btn detail-menu", type: "button", "aria-haspopup": "dialog" }, icon(MENU_ICON), state.now ? "Today's menu" : "Menu");
    menu.addEventListener("click", () => openMenu(s.id, menu));
  }
  const meal = s.menu ? inviteMeal(s, at) : null;
  const invite = meal ? mealInviteControl(s, meal, at) : s.open ? inviteControl(() => spaceInviteText(s, at), () => spaceInviteUrl(s, mensa ? "mensa" : "study"), { labels: "Invite" }) : null;
  // Reports are about now and about open places; the estimate's bar is navy, the mannequins beside it are the reports.
  const live = state.now && s.open;
  const reports = reportsOf("space", s.id, p.area, s.reports);
  const level = live ? reportLevel(reports) : null;
  const gauge = s.occupancy ? occupancyBar(s.occupancy, "div", live ? { level } : {})
    : !state.now && s.usual?.pct != null ? occupancyBar({ pct: s.usual.pct }, "div", { prefix: "usually " }) : null;
  const reported = live && s.occupancy ? reportedLine(reports) : null;
  // A live estimate makes the report a percentage (a slider starting at it).
  const estimate = live && s.occupancy ? s.occupancy.pct : null;
  fill(box,
    detailHead(status, sub),
    gauge,
    reported ? el("p", { class: "detail-note reported-note" }, reported) : null,
    menu,
    s.notice ? el("p", { class: "detail-note" }, s.notice) : null,
    meals.length ? el("section", { class: "detail-part" }, el("h3", {}, "Meal times today"), el("p", {}, meals.join(" · "))) : null,
    s.hours?.length ? el("section", { class: "detail-part" }, el("h3", {}, "Opening hours"), ...s.hours.map((h) => el("p", {}, h))) : null,
    reportsSection(p, reports, !state.now ? "No reports for future times." : !s.open ? "No reports while it's closed." : null, { reportable: live, estimate }),
    // Spaces with a sensor: the history's curve (`usual` once the Worker has rows; a sensor without any yet says so).
    s.usual || s.occupancy ? usualSection(s.usual, at) : null,
    actionGrid({ official: officialLink(s.info_url), show: showButton(s.building, s.id, mensa ? (s.kind === "cafe" ? "cafe" : "mensa") : null), problem: reportButton(s.name),
      occupancy: live ? reportActions(p, estimate) : null, star: starAction(p, { name: s.name, building: s.building, category: s.category }),
      invite: invite ? inviteBox(invite, true) : null, checkin: checkinAction({ kind: "space", id: s.id, area: p.area, name: s.name, category: s.category }) }));
}

/** Change the tab behind a detail view (its list loads underneath) without leaving the view. */
function switchModeQuietly(mode) {
  carryBuildings(state.mode, mode);
  state.mode = mode;
  renderModes();
  syncMap();
  refresh();
  // renderModes shows the list's head: the view keeps its own.
  $("#filter-line").hidden = true;
  $("#sheet-title").hidden = false;
}

// Building: its study spaces, rooms free for the duration, mensas and cafeterias; each opens its own view.

async function renderBuildingView(box, p, id) {
  const code = p.id;
  const [spaces] = await Promise.all([loadSpaces().catch(() => null)]);
  if (id !== placesView.requestId) return;
  const b = mapView.doc?.buildings[code];
  const s = mapView.summary.get(code);
  const at = spaces?.at ?? mapView.data?.at;
  if (!b && !s && !spaces?.spaces.some((x) => x.building === code) && !state.areaBuildings.includes(code)) throw new Error("Unknown building");
  $("#sheet-title").textContent = buildingLabel(code);
  const own = (spaces?.spaces ?? []).filter((x) => x.building === code);
  const study = own.filter((x) => x.category !== "mensa");
  const eat = own.filter((x) => x.category === "mensa");
  const parts = [];
  if (b?.name) parts.push(el("p", { class: "detail-sub muted" }, [b.name, distanceOf(code)].filter(Boolean).join(" · ")));
  const friendsHere = friendsInBuilding(code); // "Friends here: anna_k, zoe.m" (friends.js)
  if (friendsHere) parts.push(friendsHere);
  if (hasFloors(code)) {
    const plans = el("button", { type: "button", class: "sheet-link floors-link" }, smallIcon(VIEW_ICON), "Floor plans");
    plans.addEventListener("click", () => {
      if (layout() === "full") sheet.snap("half");
      openFloors(code);
    });
    parts.push(plans);
  }
  if (study.length) {
    const open = study.filter((x) => x.open);
    parts.push(el("section", { class: "detail-part" },
      el("h3", {}, smallIcon(BOOK_ICON), ` ${plural(open.length, "study space open", "study spaces open")}`),
      el("ul", { class: "rows" }, ...[...open, ...study.filter((x) => !x.open)].map((x) => spaceItem(x, at, "stack")))));
  }
  // Rooms: Meet's list has every room of the area; otherwise the map's summary (the two free longest).
  const listed = state.mode === "rooms" && mapView.data?.rooms ? mapView.data.rooms.filter((r) => r.building === code) : null;
  // Buildings drawn as part of this one (KOH in KOL): their rooms in a small section of their own, whatever their state,
  // since they can't be picked on the map.
  const partCodes = Object.keys(mapView.data?.parts ?? {}).filter((b) => mapView.data.parts[b] === code);
  if (listed?.length || s?.rooms?.total || state.areaBuildings.includes(code)) {
    const part = [el("h3", {}, smallIcon(DOOR_ICON), " Rooms")];
    if (listed) {
      const long = listed.filter(longEnough);
      part[0].append(` · ${long.length} free ${durationText(state.duration)}+`);
      part.push(el("ul", { class: "rows" }, ...long.slice(0, 5).map((r) => roomItem(r, mapView.data.at, "free", "stack"))));
      if (!long.length) part.push(el("p", { class: "muted" }, `No room here is free for ${durationText(state.duration)} or more.`));
    } else if (s?.rooms) {
      part[0].append(` · ${s.rooms.free} free ${freeFor_()}+`);
      const best = [s.rooms.best_seminar, s.rooms.best_hall].filter(Boolean)
        .map((r) => ({ ...r, building: code, status: "free", minutes: r.free_until ? Math.round((Date.parse(r.free_until) - Date.parse(mapView.data.at)) / 60000) : null }));
      if (best.length) part.push(el("ul", { class: "rows" }, ...best.map((r) => roomItem(r, mapView.data.at, "free", "stack"))));
      else part.push(el("p", { class: "muted" }, `No room here is free for ${freeFor_()} or more.`));
      if (s.rooms.unknown) part.push(el("p", { class: "muted" }, `${plural(s.rooms.unknown, "room", "rooms")} not loaded yet.`));
    } else if (mapView.data && !mapView.data.rooms && s && s.rooms === null) {
      part.push(el("p", { class: "muted" }, "Room bookings are only known about a month ahead."));
    }
    part.push(listButton(`All rooms in ${code}`, "rooms", code));
    parts.push(el("section", { class: "detail-part" }, ...part));
  }
  for (const other of partCodes) {
    const own = (mapView.data?.rooms ?? studyRoomsNow() ?? []).filter((r) => r.building === other);
    if (!own.length) continue;
    parts.push(el("section", { class: "detail-part part-building" },
      el("h3", {}, smallIcon(DOOR_ICON), ` ${other}`, el("span", { class: "muted" }, ` · connected to ${code}`)),
      el("ul", { class: "rows" }, ...own.map((r) => roomItem(r, mapView.data.at, roomLook(r, "closed"), "stack")))));
  }
  if (eat.length) {
    parts.push(el("section", { class: "detail-part" },
      el("h3", {}, smallIcon(MENSA_ICON), " Mensas & cafeterias"),
      el("ul", { class: "rows" }, ...eat.map((x) => spaceItem(x, at, "stack")))));
  }
  const micro = (spaces?.microwaves ?? []).filter((m) => m.building === code);
  if (micro.length) parts.push(microwavesPart(micro));
  if (!study.length && !eat.length && !parts.some((x) => x.tagName === "SECTION")) parts.push(el("p", { class: "muted" }, "Nothing on frooms in this building."));
  // Its star: starred buildings come first among the chips and in Study and Meet, and are listed in You.
  fill(box, ...parts, actionBar(starAction(p, { name: b?.name || code, building: code }), hasFloors(code) ? planButton(code, null) : null, reportButton(buildingLabel(code))));
  if (placesView.section === "microwaves") {
    placesView.section = null;
    // Phones: the whole sheet, since the section is at the end and a half sheet can't scroll that far.
    if (layout() === "full") sheet.snap("full");
    // After the snap has laid the sheet out: the section's head at the top of the sheet's scroll area.
    requestAnimationFrame(() => {
      const body = $("#sheet-body");
      const section = document.getElementById("microwaves-section");
      if (section) body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
    });
  }
}

/** A building's microwaves: a row per spot (app.js microwaveItem), each opening the spot's page. */
function microwavesPart(list) {
  const total = list.reduce((n, m) => n + m.count, 0);
  return el("section", { class: "detail-part", id: "microwaves-section" },
    el("h3", {}, smallIcon(MICROWAVE_ICON_16), ` ${plural(total, "microwave", "microwaves")}`),
    el("ul", { class: "rows" }, ...list.map((m) => microwaveItem(m, "stack"))));
}

// A microwave spot (data/microwaves.json): its queue as reported, where it is, and three actions: Find on campus,
// Report queue and Star. No check-in, no invite.

async function renderMicrowaveView(box, p, id) {
  const data = await loadSpaces();
  if (id !== placesView.requestId) return;
  const m = (data.microwaves ?? []).find((x) => x.id === p.id && x.area === p.area);
  if (!m) throw new Error("Unknown place");
  $("#sheet-title").textContent = microwaveName(m);
  markPlaceBuilding(m.building);
  if (state.mode !== "you" && state.mode !== "mensa") switchModeQuietly("mensa");
  const reports = reportsOf("microwave", m.id, m.area, m.reports);
  const level = state.now ? queueLevel(reports) : null;
  const status = !state.now ? { text: "Queue reports are about now", cls: "closed" }
    : level == null ? { text: "No queue reported", cls: "closed" }
    : { text: level ? `Queue ${QUEUE_NAMES[level]}` : "No queue", cls: `queue-${level}` };
  const sub = [plural(m.count, "microwave", "microwaves"), buildingLabel(m.building), m.floor ? `floor ${m.floor}` : null, distanceOf(m.building)].filter(Boolean).join(" · ");
  const space = m.place ? data.spaces.find((x) => x.id === m.place) : null;
  let at = null;
  if (space) {
    at = el("button", { type: "button", class: "sheet-link" }, `At ${space.name} →`);
    at.addEventListener("click", () => openPlace({ kind: "space", id: space.id, area: m.area }, { from: "stack" }));
  }
  fill(box,
    detailHead([status], sub),
    at,
    queueSection(p, reports),
    actionGrid({ show: campusButton(m.building, "mensa", "Find on campus"),
      occupancy: state.now ? reportActions(p, null, "Report queue") : null,
      star: starAction(p, { name: microwaveName(m), building: m.building }) }));
}

/**
 * "Queue reports": the control to report (opened by Report queue, or when you reported this spot in the past 2
 * hours): four buttons Free, ~5 min, ~10 min, 15 min+, one click sends it; the past 2 hours as "about 10 min 2×, no
 * queue 1×"; and the report log, as for rooms and spaces (reportsSection).
 */
function queueSection(p, summary) {
  const parts = [el("h3", {}, "Queue reports")];
  if (!state.now) return el("section", { class: "detail-part reports" }, ...parts, el("p", { class: "muted" }, "No reports for future times."));
  const mine = myReportOf(state.myReports, reportKey(p), "queue", Date.now());
  if (!placesView.reportPanel && mine) placesView.reportPanel = "report";
  if (placesView.reportPanel === "report") {
    const msg = el("p", { class: "report-msg", role: "status", tabindex: "-1" });
    if (placesView.justSent === "queue") msg.textContent = "Thanks, counted for 2 hours.";
    else if (placesView.justSent === "removed-queue") msg.textContent = "Removed.";
    else if (mine) msg.textContent = `You reported ${QUEUE_NAMES[mine.value]} at ${clock(mine.at)}.`;
    const buttons = QUEUE_BUTTONS.map((text, level) => {
      const on = mine?.value === level;
      const b = el("button", { type: "button", class: `report-choice queue-${level}${on ? " on" : ""}`, "aria-pressed": String(on), "data-level": String(level) }, el("span", {}, text));
      b.addEventListener("click", () => submitReport(p, "queue", level, null, buttons, msg, `[data-level="${level}"]`));
      return b;
    });
    parts.push(el("div", { class: "report-control" },
      el("p", { class: "report-ask" }, "How long is the queue right now?"),
      el("div", { class: "report-choices queue", role: "group", "aria-label": "How long is the queue right now?" }, ...buttons),
      mineLine(msg, mine ? removeMineButton(p, "queue", buttons, msg) : null)));
  }
  const queues = reportedQueues(summary);
  parts.push(queues.length
    ? el("p", { class: "report-levels" }, queues.map(({ level, count }) => `${QUEUE_NAMES[level]} ${count}×`).join(", "), " in the past 2 hours")
    : el("p", { class: "muted" }, "No reports in the past 2 hours."));
  // The log and its votes work as for rooms and spaces: reportsSection's, without its own summary lines.
  const shared = reportsSection(p, null, null);
  const log = [...shared.children].filter((n) => n.matches("button.sheet-link, .report-log"));
  return el("section", { class: "detail-part reports", id: "reports-section" }, ...parts, ...log);
}

/** A link from a building to a list filtered to it. */
function listButton(text, mode, code) {
  const a = el("button", { type: "button", class: "sheet-link" }, `${text} →`);
  a.addEventListener("click", () => {
    history.replaceState(null, "", "/");
    closePlace();
    filterList(mode, code);
    if (layout() === "full") sheet.snap("half");
  });
  return a;
}

// Near you: the nearest buildings with an open study space, and with a room free long enough.

function renderNearView(box) {
  $("#sheet-title").textContent = "Near you";
  const here = mapView.nearMessage ? null : meOn(mapView.doc);
  const inside = here ? buildingAt(here) : null;
  const at = mapView.data?.at;
  const parts = [];
  if (inside) parts.push(el("p", { class: "detail-sub muted" }, `You're in ${buildingLabel(inside)}`));
  if (mapView.nearMessage) parts.push(el("p", { class: "message" }, mapView.nearMessage));
  else if (!here) parts.push(el("p", { class: "muted" }, "Finding where you are…"));
  else if (!at) parts.push(el("p", { class: "muted" }, "Loading…"));
  else {
    mapView.nearAt = here;
    const near = nearby(mapView.data.buildings, anchorOf, here, { inside });
    if (mapView.me.acc > ROUGH_FIX_M) parts.push(el("p", { class: "muted" }, `Your location is only known to about ${distanceText(mapView.me.acc)}, so the distances are rough.`));
    if (!state.now) parts.push(el("p", { class: "muted" }, `For ${weekday(at)} ${hhmm(at)}.`));
    parts.push(el("section", { class: "detail-part" },
      el("h3", {}, smallIcon(BOOK_ICON), " Open study spaces"),
      near.study.length
        ? el("ul", { class: "rows" }, ...near.study.map(({ code, dist, space }) => nearRow(code, dist, space.category === "library" ? "Library" : space.category === "workspace" ? "Workspace" : "Study space", space.name, studyLine(space, at))))
        : el("p", { class: "muted" }, "No study space here is open.")));
    const roomsKnown = mapView.data.buildings.some((x) => x.rooms);
    parts.push(el("section", { class: "detail-part" },
      el("h3", {}, smallIcon(DOOR_ICON), ` Rooms free ${freeFor_()}+`),
      near.rooms.length
        ? el("ul", { class: "rows" }, ...near.rooms.map(({ code, dist, free, room }) => nearRow(code, dist, plural(free, "room free", "rooms free"), room.room, freeLine(room, at))))
        : el("p", { class: "muted" }, roomsKnown ? `No room here is free for ${freeFor_()} or more.` : "Room bookings are only known about a month ahead.")));
  }
  const stop = mapView.locate === "off" ? null : el("button", { type: "button", class: "sheet-link" }, "Stop showing my location");
  stop?.addEventListener("click", () => {
    stopLocating();
    placeBack();
  });
  parts.push(el("div", { class: "detail-links" }, stop), el("p", { class: "muted near-privacy" }, "Your location stays on this device: frooms never sends or stores it."));
  fill(box, ...parts);
  box.dataset.key = "near|";
}

/** A row of Near you: distance and building, then the suggestion; it opens the building. */
function nearRow(code, dist, kind, title, line) {
  const b = el("button", { type: "button", class: "row-open" },
    el("span", { class: "kicker" }, el("span", { class: "dist" }, distanceText(dist)), ` · ${buildingLabel(code)} · ${kind}`),
    el("span", { class: "name" }, title),
    el("span", { class: "meta" }, line));
  b.addEventListener("click", () => openPlace({ kind: "building", id: code, area: state.area }, { from: "stack" }));
  return el("li", { class: "room near" }, b);
}

/** Near you is open: fill it again (a new position, or the numbers arrived). */
const nearShown = () => placesView.current?.kind === "near";

// --- stars: rooms, study spaces, mensas, cafeterias and buildings ---

/**
 * The star button in the action row (the head has one too): "Star" / "Starred". `meta` is what the You tab needs to
 * show the place before its data arrives: name, building, a room's type, a space's category.
 */
function starAction(p, meta) {
  placesView.starMeta = { kind: p.kind, id: p.id, area: p.area, ...meta };
  syncStarButtons();
  const b = el("button", { type: "button", class: "detail-action star-btn", "aria-pressed": "false", "data-tour": "star" }, el("span", { class: "star-glyph", "aria-hidden": "true" }, "☆"), el("span", { class: "star-text" }, "Star"));
  b.addEventListener("click", toggleCurrentStar);
  return [b, el("span", { class: "star-note", role: "status" })];
}

function toggleCurrentStar() {
  const meta = placesView.starMeta;
  if (!meta) return;
  const res = setStar(meta);
  const note = $("#detail .star-note");
  if (note) note.textContent = res.full ? `You can star up to ${MAX_STARS} places.` : "";
  syncStarButtons();
}

/** The star buttons of the open view (head and action row) show whether it's starred. */
function syncStarButtons() {
  const p = placesView.current;
  const meta = placesView.starMeta;
  const can = !!p && STAR_KINDS.includes(p.kind) && !!meta && meta.id === p.id && meta.kind === p.kind;
  const on = can && isStarred(state.stars, meta);
  const head = $("#sheet-star");
  head.hidden = !can;
  head.setAttribute("aria-pressed", String(on));
  head.setAttribute("aria-label", on ? "Starred: click to unstar" : "Star this place");
  head.textContent = on ? "★" : "☆";
  for (const b of document.querySelectorAll("#detail .star-btn")) {
    b.setAttribute("aria-pressed", String(on));
    b.querySelector(".star-glyph").textContent = on ? "★" : "☆";
    b.querySelector(".star-text").textContent = on ? "Starred" : "Star";
  }
}

// --- search: rooms, study spaces, mensas and buildings of all five locations (lib.js searchPlaces, /api/index) ---

const isSearchEntry = (st) => st?.frooms === "search" && st.load === PAGE_LOAD;
const searchOpen = () => !$("#search").hidden;

// Usage counters (app.js countUse): a search counts once typing has stopped for 1.5 s with at least 2 characters, or
// when a result is picked; each text once while search is open. Never the text itself.
const searchStats = { timer: 0, counted: new Set() };

function countSearch(minChars = 1) {
  clearTimeout(searchStats.timer);
  const text = $("#search-input").value.trim().toLowerCase();
  if (text.length < minChars || searchStats.counted.has(text)) return;
  searchStats.counted.add(text);
  countUse("search");
}

function countSearchSoon() {
  clearTimeout(searchStats.timer);
  searchStats.timer = setTimeout(() => countSearch(2), 1500);
}

/** A result of the search was opened (a place, a person or a "Go to"): it counts, and so does its search. */
function countSearchPick() {
  countSearch();
  countUse("search_pick");
}

function openSearch() {
  const input = $("#search-input");
  if (searchOpen()) return input.focus({ preventScroll: true });
  history.pushState({ frooms: "search", load: PAGE_LOAD }, "");
  $("#search").hidden = false;
  document.getElementById("sheet").classList.add("searching");
  $("#search-open").setAttribute("aria-expanded", "true");
  // Full height at once, without the snap's slide: the field is already at the top when it takes the focus, so the
  // browser has no reason to scroll the page up to it when the keyboard comes in. The focus stays in the click
  // (iOS opens the keyboard only for a focus made there, not one after the slide).
  sheet.snap("full", false);
  input.value = "";
  searchStats.counted.clear();
  input.focus({ preventScroll: true });
  watchViewport(true);
  ensureSearchIndex();
  renderSearch();
}

/**
 * While search is open on a phone the keyboard covers the page's lower part: the search view ends at the top of the
 * keyboard (the visual viewport's bottom), so its last results can be scrolled to, and a page pan the browser made to
 * show the field is undone. Wide windows and a closed search: no limit.
 */
function fitSearchView() {
  const view = $("#search");
  const vv = window.visualViewport;
  if (!vv || !searchOpen() || WIDE.matches) {
    view.style.maxHeight = "";
    return;
  }
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  const top = view.getBoundingClientRect().top;
  view.style.maxHeight = `${Math.max(120, Math.round(vv.offsetTop + vv.height - top))}px`;
}

function watchViewport(on) {
  const vv = window.visualViewport;
  if (vv) for (const type of ["resize", "scroll"]) vv[on ? "addEventListener" : "removeEventListener"](type, fitSearchView);
  fitSearchView();
}

/** Close it: through Back when its entry is on top (`viaHistory`: Back was pressed already). */
function closeSearch(viaHistory = false) {
  if (!searchOpen()) return;
  if (!viaHistory && isSearchEntry(history.state)) return history.back(); // popstate closes it
  $("#search").hidden = true;
  watchViewport(false);
  document.getElementById("sheet").classList.remove("searching");
  $("#search-open").setAttribute("aria-expanded", "false");
  if (layout() === "full") sheet.snap("half");
  $("#search-open").focus({ preventScroll: true });
}

/** The building names of the campus drawings loaded so far, for search ("area|code" -> name). */
function buildingNames() {
  const names = new Map();
  if (mapView.doc) for (const [code, b] of Object.entries(mapView.doc.buildings)) if (b.name) names.set(`${state.area}|${code}`, b.name);
  return names;
}

let searchIndex = null;
const searchLoad = { running: false, failed: false };

/**
 * Load the index unless it's here or on its way; when it arrives (or fails) the results are drawn again, so a query
 * typed before it came is searched without another keystroke. After a failure the next keystroke tries again.
 */
function ensureSearchIndex() {
  if (searchIndex || searchLoad.running) return;
  searchLoad.running = true;
  searchLoad.failed = false;
  loadIndex().then((ix) => { searchIndex = ix; }, () => { searchLoad.failed = true; }).finally(() => {
    searchLoad.running = false;
    renderSearch();
    drawCheckinPlaces();
  });
}

function renderSearch() {
  if (!searchOpen()) return;
  const box = $("#search-results");
  const q = $("#search-input").value;
  const areaName = (a) => state.areas?.areas.find((x) => x.area === a)?.name ?? a;
  // Things rather than names ("rooms", "library", "vegan"): their results first, without waiting for the index.
  const intents = q.trim() ? searchIntents(q, { areas: state.areas?.areas ?? [] }) : [];
  // Signed in: friends and other people too (friends.js; "More people" comes from /api/people, 400 ms after typing).
  const people = q.trim() ? peopleSearchGroup(q) : null;
  const goTo = intents.length ? el("section", { class: "search-group go-to" }, el("h2", {}, "Go to"), el("ul", {}, ...intents.map((r) => {
    const b = el("button", { type: "button", class: "search-hit intent" },
      el("span", { class: "hit-name" }, r.title), el("span", { class: "hit-sub muted" }, r.sub));
    b.addEventListener("click", () => runIntent(r.go));
    return el("li", {}, b);
  }))) : null;
  let results;
  if (!q.trim()) {
    // An empty field: the starred places.
    results = state.stars.map((s) => ({ kind: s.kind, id: s.id, area: s.area, name: s.name, room: null, group: "Starred" }));
    if (!results.length) return fill(box, el("p", { class: "muted search-hint" }, "Type a room (HG E 33.1), a building (CAB), a name (Polyterrasse) or what you're after (library, rooms, vegan, microwave, tutorial)."));
  } else if (!searchIndex) {
    return fill(box, goTo, people, el("p", { class: "muted" }, searchLoad.failed ? "Search needs a connection." : "Loading…"));
  } else {
    results = searchPlaces(searchIndex, q, { area: state.area, stars: state.stars, names: buildingNames() });
    if (!results.length && !goTo && !people) return fill(box, el("p", { class: "muted" }, `Nothing on frooms matches “${q.trim()}”.`));
  }
  // "Go to" leads when the query is one of its words ("library") or nothing else matches; after the places otherwise
  // ("Mensa Polyterrasse" is the place first), so Enter opens the likelier one.
  const goFirst = !!goTo && (intents[0].rank === 0 || !results.length);
  const groups = [...new Set(results.map((r) => r.group))].map((g) => {
    const rows = results.filter((r) => r.group === g).map((r) => {
      const b = el("button", { type: "button", class: "search-hit" },
        el("span", { class: "hit-name" }, starMark(r.kind, r.id, r.area), r.name),
        el("span", { class: "hit-sub muted" }, [r.kind === "space" && r.room ? r.room : null, r.kind === "microwave" ? `Microwaves in ${r.room}` : null, r.kind === "room" && r.seats != null ? `${r.seats} seats` : null, areaName(r.area)].filter(Boolean).join(" · ")));
      b.addEventListener("click", () => chooseResult(r));
      return el("li", {}, b);
    });
    return el("section", { class: "search-group" }, el("h2", {}, g), el("ul", {}, ...rows));
  });
  fill(box, ...(goFirst ? [goTo, ...groups, people] : [...groups, people, goTo]));
}

/** The tab's own map filter, for a "Go to" result that names none. */
const TAB_LAYERS = { study: "study", rooms: "rooms", mensa: "mensa" };

/**
 * A "Go to" result (lib.js searchIntents): close search (and a place's view) and do what it says: a tab with its
 * filters and map filter, scrolled to its section, sorted by distance (`near`: the position is asked for if needed);
 * Find your meal with a sort and filters; the comparison; a location; the campus menu; the whole campus; Near you.
 */
function runIntent(go) {
  countSearchPick();
  if (isSearchEntry(history.state)) history.replaceState(null, "");
  closeSearch(true);
  if (placesView.current) {
    history.replaceState(null, "", "/");
    closePlace();
  }
  if (go.area) return selectArea(go.area);
  if (go.campusMenu) return setTimeout(() => $("#campus").click(), 0); // after this click has reached the document
  if (go.fit) {
    fitCampus();
    return scheduleDraw();
  }
  if (go.nearView) return locateTapped();
  if (go.tour) return tourLoad(go.tour === true ? {} : { journey: go.tour }); // the tutorial: its welcome screen, or a journey
  if (go.compare) {
    selectMode("mensa");
    return openMenu(null, null);
  }
  if (go.meal) {
    selectMode("mensa");
    return openMenu(null, null, null, { view: "search", pref: go.meal });
  }
  if (!go.tab) return;
  let changed = false;
  if (go.tab === "rooms" && go.types) {
    state.types = new Set(go.types);
    changed = true;
  }
  const layer = go.layer ?? TAB_LAYERS[go.tab] ?? null;
  if (layer && state.mapLayer !== layer) {
    state.mapLayer = layer;
    renderMapLayers();
    fillLabels();
    scheduleDraw();
  }
  savePrefs();
  if (state.mode !== go.tab) selectMode(go.tab);
  else if (changed) refresh();
  if (changed && state.typeList) renderTypes();
  if (go.near) locateQuietly();
  if (go.section) setTimeout(() => $(`#${go.section}`)?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }), 400);
}

/** A result opens its detail view (switching location if needed); Back from there goes to the list. */
const chooseResult = (r) => openFromSearch({ kind: r.kind, id: r.id, area: r.area });

/** Close search and open a place, or an account view (a person: { kind: "account", id: "person:raffi" }). */
function openFromSearch(place) {
  countSearchPick();
  $("#search").hidden = true;
  watchViewport(false);
  document.getElementById("sheet").classList.remove("searching");
  $("#search-open").setAttribute("aria-expanded", "false");
  if (placesView.current) {
    // Searching from a detail view: the result replaces it.
    if (isSearchEntry(history.state)) history.replaceState({ frooms: "place", load: PAGE_LOAD, place: placesView.current }, "");
    return openPlace(place, { from: "place" });
  }
  openPlace(place, { from: "search" });
}

function initSearch() {
  $("#search-open").addEventListener("click", openSearch);
  $("#search-back").addEventListener("click", () => closeSearch());
  $("#search-input").addEventListener("input", () => {
    ensureSearchIndex();
    searchPeopleToo($("#search-input").value);
    renderSearch();
    countSearchSoon();
  });
  $("#search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#search-results .search-hit")?.click();
  });
  window.addEventListener("popstate", () => {
    if (searchOpen() && !isSearchEntry(history.state)) closeSearch(true);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !searchOpen() || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    closeSearch();
  }, true);
  if (history.state?.frooms === "search") history.replaceState(null, "");
}

// --- set-up ---

function initPlaces() {
  $("#sheet-back").addEventListener("click", placeBack);
  $("#sheet-star").addEventListener("click", toggleCurrentStar);
  initSearch();
  window.addEventListener("popstate", onPlacePopState);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || !placesView.current) return;
    if (document.querySelector("dialog[open]") || document.querySelector(".invite-menu:not([hidden])")) return;
    e.preventDefault();
    placeBack();
  });
  // Reloaded on a place entry from before: the page opens it from its address (app.js).
  if (history.state?.frooms === "place") history.replaceState(null, "");
}
