"use strict";

// Checking in (plans/PLAN_ACCOUNTS.md, sections 8.6 and 8.7): the round check-in button (bottom right above the tabs on
// phones, in the top bar on wide windows; decision 12), the "Check in" view (the places around you, a search), the
// "Checked in!" window with the end time and the invite, "Check in here" in a place's view, and the You tab's running
// check-in with check-out. A check-in sends the place that was picked, never a position: the position only picks the
// buildings, on this device. Loaded after friends.js.

const checkinView = { query: "", expanded: new Set(), sending: null, error: "" };

const CHECKIN_ICON = "M12 2.5a6.5 6.5 0 0 1 6.5 6.5c0 4.6-6.5 12.5-6.5 12.5S5.5 13.6 5.5 9A6.5 6.5 0 0 1 12 2.5zM9 9.2l2.1 2.1L15.2 7";
const CHECKOUT_ICON = "M10 4H5.5v16H10M15 8l4 4-4 4M19 12H9.5";
const TICK_ICON = "M5 12.5l4.5 4.5L19 7.5";

/** The person's running check-in, or null (one that ran out counts as none). */
const myCheckin = () => (accountReady() && runningCheckin(account.me.checkin, Date.now()) ? account.me.checkin : null);

// --- the button ---

/**
 * Check in, or while a check-in runs Check out (red, the check-out icon; it asks first). The CSS hides it during search
 * and over a place's view.
 */
function syncCheckinButton() {
  const b = $("#checkin-btn");
  const c = myCheckin();
  const label = c ? `Check out of ${c.name}` : "Check in";
  b.classList.toggle("out", !!c);
  b.setAttribute("aria-label", label);
  b.title = c ? "Check out" : "Check in";
  b.replaceChildren(icon(c ? CHECKOUT_ICON : CHECKIN_ICON));
  b.classList.toggle("offline", navigator.onLine === false);
}

// --- the view ---

accountViews.checkin = (box) => {
  $("#sheet-title").textContent = "Check in";
  if (!accountReady()) {
    return fill(box,
      el("p", { class: "signin-lead" }, "Check in where you study, and your friends on frooms see it: the place you pick, since when and until when. It ends by itself after 3 hours, or when you say."),
      signedIn() ? accountLink("Finish setting up your account", "welcome") : signInBlock());
  }
  // The search field stays while the rest is drawn again.
  if (!box.querySelector("#checkin-search")) {
    const input = el("input", { id: "checkin-search", type: "search", placeholder: "Room, study space or mensa", "aria-label": "Search for the place to check in to", autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "search" });
    input.value = checkinView.query;
    input.addEventListener("input", () => {
      checkinView.query = input.value;
      if (input.value.trim()) ensureSearchIndex();
      drawCheckinPlaces();
    });
    fill(box, el("div", { class: "friends-search" }, input), el("div", { id: "checkin-places", class: "checkin-places" }));
    loadSpaces().then(drawCheckinPlaces, drawCheckinPlaces);
    // The list reads the shared search index (places.js searchIndex): kept there when it arrives, then drawn.
    loadIndex().then((ix) => {
      searchIndex ??= ix;
      drawCheckinPlaces();
    }, () => {
      searchLoad.failed = true;
      drawCheckinPlaces();
    });
  }
  drawCheckinPlaces();
};

const checkinShown = () => placesView.current?.kind === "account" && placesView.current.id === "checkin";

/** A place to check in to: its name and a line, and a round check button at the end. */
function checkinRow(place, source, sub = "") {
  const mine = myCheckin();
  const here = mine && mine.kind === place.kind && mine.place === place.id && mine.area === place.area;
  const b = el("button", { type: "button", class: `check-btn${here ? " on" : ""}`, "aria-label": here ? `Checked in to ${place.name}: change the end time` : `Check in to ${place.name}` }, icon(here ? TICK_ICON : CHECKIN_ICON));
  b.disabled = checkinView.sending !== null;
  b.addEventListener("click", () => (here ? openUntilDialog() : checkIn(place, source)));
  return el("li", { class: "checkin-row" },
    el("span", { class: "person-text" }, el("span", { class: "person-user" }, place.name), sub ? el("span", { class: "person-name muted" }, sub) : null),
    b);
}

/** The spaces and rooms of a building in the current area, for the check-in view. */
function placesInBuilding(code, spaces, index) {
  const parts = mapView.data?.parts ?? {};
  const drawn = (b) => parts[b] ?? b;
  const own = (spaces?.spaces ?? []).filter((s) => s.building === code && !s.partner);
  const study = own.filter((s) => s.category !== "mensa").map((s) => ({ kind: "space", id: s.id, area: state.area, name: s.name, category: s.category, sub: [s.category === "library" ? "Library" : s.category === "workspace" ? "Workspace" : "Study space", s.room].filter(Boolean).join(" · ") }));
  const eat = own.filter((s) => s.category === "mensa").map((s) => ({ kind: "space", id: s.id, area: state.area, name: s.name, category: "mensa", sub: [s.kind === "cafe" ? "Cafeteria" : "Mensa", s.room].filter(Boolean).join(" · ") }));
  const rooms = (index?.rooms ?? []).filter((r) => r[1] === state.area && drawn(roomBuilding(r[0])) === code)
    .map((r) => ({ kind: "room", id: r[0], area: r[1], name: r[0], sub: r[3] != null ? `${r[3]} seats` : "" }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { study, rooms, eat };
}

/** The buildings around the person: the one they're in, else the three nearest with something to check in to. */
function buildingsAround(here, spaces, index) {
  const inside = buildingAt(here);
  if (inside) return { inside, codes: [inside] };
  const has = (code) => {
    const p = placesInBuilding(code, spaces, index);
    return p.study.length + p.rooms.length + p.eat.length > 0;
  };
  const codes = Object.keys(mapView.doc?.buildings ?? {})
    .map((code) => ({ code, at: anchorOf(code) }))
    .filter((b) => b.at)
    .map((b) => ({ code: b.code, d: Math.hypot(b.at[0] - here[0], b.at[1] - here[1]) }))
    .sort((a, b) => a.d - b.d)
    .filter((b) => has(b.code))
    .slice(0, 3)
    .map((b) => b.code);
  return { inside: null, codes };
}

const CHECKIN_ROOMS_SHOWN = 6;

function drawCheckinPlaces() {
  const out = document.getElementById("checkin-places");
  if (!out || !checkinShown() || !accountReady()) return;
  const parts = [];
  const mine = myCheckin();
  if (checkinView.error) parts.push(el("p", { class: "message warning", role: "alert" }, checkinView.error));
  if (mine) parts.push(el("p", { class: "message" }, `You're checked in to ${mine.name} (${checkinWhen(mine, Date.now())}). Checking in somewhere else moves it there.`));
  const q = checkinView.query.trim();
  const spaces = state.spaces?.area === state.area ? state.spaces : null;
  if (q) {
    if (!searchIndex) {
      parts.push(el("p", { class: "muted" }, searchLoad.failed ? "Search needs a connection." : "Loading…"));
      return fill(out, ...parts);
    }
    const found = searchPlaces(searchIndex, q, { area: state.area, stars: state.stars }).filter((r) => r.kind !== "building").slice(0, 20);
    const areaName = (a) => state.areas?.areas.find((x) => x.area === a)?.name ?? a;
    parts.push(found.length
      ? el("section", { class: "detail-part" }, el("h3", {}, "Places"), el("ul", { class: "people-list" }, ...found.map((r) => checkinRow(
        { kind: r.kind, id: r.id, area: r.area, name: r.name, category: r.group === "Mensas & cafeterias" ? "mensa" : r.kind === "space" ? "open" : null },
        "search", [r.kind === "space" && r.room ? r.room : null, r.kind === "room" && r.seats != null ? `${r.seats} seats` : null, areaName(r.area)].filter(Boolean).join(" · ")))))
      : el("p", { class: "muted" }, `Nothing on frooms matches “${q}”. A check-in is always a listed room, study space or mensa.`));
    fill(out, ...parts);
    return markTour(out.querySelector(".checkin-row"), "checkin-place");
  }
  const here = mapView.nearMessage ? null : meOn(mapView.doc);
  if (!here) {
    const allow = el("button", { type: "button", class: "pill primary" }, "Allow location");
    allow.addEventListener("click", () => {
      mapView.nearMessage = null;
      locateQuietly();
      drawCheckinPlaces();
    });
    const waiting = mapView.locate === "wait";
    const elsewhere = mapView.me && !mapView.nearMessage ? `You aren't on ${state.areas?.areas.find((a) => a.area === state.area)?.name ?? "this campus"}. Search for the place, or switch campus.` : null;
    parts.push(el("section", { class: "detail-part" },
      el("h3", {}, "Around you"),
      el("p", {}, mapView.nearMessage ?? elsewhere ?? (waiting ? "Finding where you are…" : "Allow location to see what's around you.")),
      !waiting && !elsewhere && !mapView.nearMessage ? allow : null));
  } else {
    const index = searchIndex;
    if (!index || !spaces) {
      if (!index) ensureSearchIndex();
      parts.push(el("p", { class: "muted" }, "Loading…"));
    } else {
      const { inside, codes } = buildingsAround(here, spaces, index);
      if (inside) parts.push(el("p", { class: "detail-sub muted" }, `You're in ${buildingLabel(inside)}`));
      else if (codes.length) parts.push(el("p", { class: "detail-sub muted" }, "The buildings nearest to you"));
      for (const code of codes) {
        const { study, rooms, eat } = placesInBuilding(code, spaces, index);
        const all = checkinView.expanded.has(code) || rooms.length <= CHECKIN_ROOMS_SHOWN;
        const more = all ? null : el("button", { type: "button", class: "more-btn" }, `All ${rooms.length} rooms in ${code}`);
        more?.addEventListener("click", () => {
          checkinView.expanded.add(code);
          drawCheckinPlaces();
        });
        const sub = (title, list) => (list.length ? [el("h4", {}, title), el("ul", { class: "people-list" }, ...list.map((p) => checkinRow(p, "nearby", p.sub)))] : []);
        parts.push(el("section", { class: "detail-part checkin-building" },
          el("h3", {}, buildingLabel(code), code !== buildingLabel(code) ? el("span", { class: "muted" }, ` · ${code}`) : null, inside ? null : el("span", { class: "muted" }, ` · ${distanceOf(code) ?? ""}`)),
          ...sub("Study spaces and libraries", study),
          ...sub("Rooms", all ? rooms : rooms.slice(0, CHECKIN_ROOMS_SHOWN)), more,
          ...sub("Mensas and cafeterias", eat)));
      }
      if (!codes.length) parts.push(el("p", { class: "muted" }, "Nothing on frooms around you: search for the place."));
    }
  }
  parts.push(el("p", { class: "muted small near-privacy" }, "Your location only picks the buildings, on this device: frooms never sends or stores it. A check-in sends the place you pick."));
  fill(out, ...parts);
  markTour(out.querySelector(".checkin-row"), "checkin-place"); // the tutorial's "Pick a place"
}

// --- checking in, the end time and checking out ---

/** POST /api/checkin, then the "Checked in!" window. `place`: { kind, id, area, name, category? }. */
async function checkIn(place, source) {
  if (!accountReady()) return openAccountView("checkin");
  if (checkinView.sending) return;
  checkinView.sending = place;
  checkinView.error = "";
  drawCheckinPlaces();
  try {
    const r = await accountFetch("POST", "/api/checkin", { kind: place.kind, place: place.id, area: place.area, source });
    account.me.checkin = r.checkin;
    accountChanged();
    openUntilDialog({ welcome: true, place });
    credEarned(r.cred);
  } catch (e) {
    checkinView.error = errorText(e);
    if (!checkinShown()) flashAccountNote(checkinView.error);
  } finally {
    checkinView.sending = null;
    drawCheckinPlaces();
  }
}

/** An invite for the place checked in to: "I'm in HG E 33.1, come join me!" with the place's link. */
function checkinInvite(c, category) {
  const url = () => {
    const q = c.kind === "room" ? new URLSearchParams({ room: c.place, area: c.area }) : new URLSearchParams({ space: c.place, area: c.area, mode: category === "mensa" ? "mensa" : "study" });
    q.set("bg", randomBackground({ area: c.area }));
    return `${location.origin}/share?${q}`;
  };
  const text = () => (c.kind === "room" ? `I'm in ${c.name}, come join me!` : category === "mensa" ? `Join me at ${c.name}!` : `I'm at ${c.name}, come join me!`);
  return inviteBox(inviteControl(text, url, { labels: "Invite friends", kind: "checkin" }));
}

/**
 * What the check-in window asks about `place` right after checking in: { kind: "level" } (free, crowded, full) or, for
 * an open space with frooms' live estimate, { kind: "pct", estimate } (the slider, starting at it); null when there's
 * nothing to report (a space the list says is closed). Rooms always: whoever checks in is there to see it.
 */
function checkinAsk(place) {
  if (!place || (place.kind !== "room" && place.kind !== "space")) return null;
  if (place.kind === "room") return { kind: "level", estimate: null };
  // The list's answer, when it has the place (the Zentrum partner's mensas carry their own area).
  const s = state.spaces?.spaces.find((x) => x.id === place.id && (x.area ?? state.spaces.area) === place.area) ?? null;
  if (s && state.now && !s.open) return null;
  const estimate = s && state.now && s.occupancy ? s.occupancy.pct : null;
  return estimate != null ? { kind: "pct", estimate } : { kind: "level", estimate: null };
}

/**
 * The check-in window's first steps (plans: report in the same interaction): "How full is it right now?" with the
 * place view's choices (Free, Crowded, Full, or the slider and Send); it sends at once (app.js sendReport, the same report the place's view shows as yours, with its ✕ to take
 * it back) and has Skip. "All reports" opens the place's view at its reports. `next()` goes on to the end time.
 */
function checkinReportStep(place, ask, next) {
  const p = { kind: place.kind, id: place.id, area: place.area };
  const msg = el("p", { class: "report-msg", role: "status", tabindex: "-1" });
  const skip = el("button", { type: "button", class: "done-btn checkin-skip" }, "Skip");
  skip.addEventListener("click", next);
  const all = el("button", { type: "button", class: "sheet-link checkin-reports-link" }, "All reports");
  all.addEventListener("click", () => {
    $("#checkin-dialog").close();
    openPlace(p, { from: placesView.current ? "place" : "list" }).then(async () => {
      for (let i = 0; i < 60 && !document.getElementById("reports-section"); i++) await new Promise((r) => requestAnimationFrame(r));
      document.getElementById("reports-section")?.scrollIntoView({ block: "start" });
    });
  });
  const send = async (kind, value, controls) => {
    controls.forEach((c) => (c.disabled = true));
    msg.classList.remove("error");
    msg.textContent = "";
    try {
      await sendReport(p, kind, value, ask.estimate);
    } catch (e) {
      controls.forEach((c) => (c.disabled = false));
      msg.textContent = e.message;
      msg.classList.add("error");
      return;
    }
    next();
  };
  const mine = myReportOf(state.myReports, reportKey(p), ask.kind, Date.now());
  let controls;
  let body;
  let question;
  if (ask.kind === "pct") {
    question = `How full is it right now? frooms says ${fullText(ask.estimate)}.`;
    const start = mine ? mine.value : sliderStart(ask.estimate);
    const value = el("output", { class: "report-pct", for: "checkin-slider" }, `${start} %`);
    const slider = el("input", { type: "range", id: "checkin-slider", min: "0", max: "100", step: "5", value: String(start), "aria-label": "How full it is, in percent" });
    slider.addEventListener("input", () => (value.textContent = `${slider.value} %`));
    const go = el("button", { type: "button", class: "report-send" }, "Send");
    controls = [slider, go];
    go.addEventListener("click", () => send("pct", Number(slider.value), controls));
    body = [el("div", { class: "report-slider" }, slider, value), go];
  } else {
    question = "How full is it right now?";
    controls = [0, 1, 2].map((level) => {
      const on = mine?.value === level;
      const b = el("button", { type: "button", class: `report-choice ${REPORT_LEVELS[level]}${on ? " on" : ""}`, "aria-pressed": String(on) },
        people(level, true), el("span", {}, REPORT_BUTTON_NAMES[level]));
      b.addEventListener("click", () => send("level", level, controls));
      return b;
    });
    body = [el("div", { class: "report-choices", role: "group", "aria-label": question }, ...controls)];
  }
  if (mine) msg.textContent = ask.kind === "pct" ? `You reported ${mine.value} % at ${clock(mine.at)}.` : `You reported ${REPORT_LEVELS[mine.value]} at ${clock(mine.at)}.`;
  const remove = mine ? removeMineButton(p, ask.kind, controls, msg, () => next(true)) : null;
  return {
    nodes: [el("div", { class: "report-control checkin-report" },
      el("p", { class: "report-ask" }, question), ...body, mineLine(msg, remove)),
    el("div", { class: "checkin-buttons" }, all, skip)],
    first: controls[0],
  };
}

/**
 * The window after checking in ("Checked in!", the place, the invite), and for changing the end time later: 1 h, 2 h,
 * 3 h (from now) or a time on the time wheel (picker.js timeWheel, as the meal invite's), within the next 12 hours;
 * "Friends see until when you stay". A chip is a PATCH at once; the wheel's is sent 600 ms after it last settled, or
 * when the window closes. Opened from a place's view (not the welcome), it has Check out beside Done.
 */
function openUntilDialog({ welcome = false, place = null } = {}) {
  const c = myCheckin();
  if (!c) return;
  const dialog = $("#checkin-dialog");
  const opened = Date.now();
  const msg = el("p", { class: "form-error", role: "alert" });
  const chips = CHECKIN_HOURS.map((h) => {
    const b = el("button", { type: "button", class: "chip", "aria-pressed": "false" }, `${h} h`);
    b.addEventListener("click", () => {
      clearTimeout(wheelTimer);
      wheelTimer = 0;
      pending = null;
      setUntil(opened + h * 3600_000);
    });
    return b;
  });
  // The end time as a button; a click opens the wheel below the row.
  const timeBtn = el("button", { type: "button", class: "time-btn", "aria-expanded": "false", "aria-controls": "until-wheel" });
  const holder = el("div", { class: "picker until-wheel", id: "until-wheel", hidden: "" });
  let wheel = null;
  let wheelTimer = 0; // the PATCH waiting for the wheel to stay put
  let pending = null; // the end time it will send
  const send = () => {
    clearTimeout(wheelTimer);
    wheelTimer = 0;
    if (pending == null) return;
    const t = pending;
    pending = null;
    if (t !== myCheckin()?.until) setUntil(t);
  };
  const showWheel = (open) => {
    holder.hidden = !open;
    timeBtn.setAttribute("aria-expanded", String(open));
    if (open && !wheel) {
      wheel = timeWheel({
        value: clockOf(myCheckin()?.until ?? Date.now()),
        step: 5,
        allowed: (t) => untilClamp(t, Date.now()),
        onChange: (t) => {
          msg.textContent = "";
          pending = untilAt(t, Date.now());
          timeBtn.textContent = t;
          markChips(null);
          clearTimeout(wheelTimer);
          wheelTimer = setTimeout(send, 600);
        },
        onClose: () => {
          wheel.finish();
          send();
          showWheel(false);
          timeBtn.focus();
        },
      });
      holder.append(wheel);
    }
    if (open) wheel.focusDrum();
    else wheel?.finish();
  };
  timeBtn.addEventListener("click", () => showWheel(holder.hidden));
  const markChips = (h) => chips.forEach((b, i) => {
    const on = CHECKIN_HOURS[i] === h;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  const sync = () => {
    const cur = myCheckin();
    if (!cur) return;
    markChips(untilHours(cur.until, opened));
    when.textContent = checkinWhen(cur, Date.now());
    if (wheelTimer) return; // the wheel's own change is still on its way: leave the wheel where the finger put it
    timeBtn.textContent = clockOf(cur.until);
    timeBtn.setAttribute("aria-label", `Until ${clockOf(cur.until)}: pick another time`);
    wheel?.setValue(clockOf(cur.until));
  };
  const setUntil = async (until) => {
    msg.textContent = "";
    try {
      const r = await accountFetch("PATCH", "/api/checkin", { until });
      account.me.checkin = r.checkin;
      accountChanged();
      sync();
    } catch (e) {
      msg.textContent = errorText(e);
    }
  };
  const when = el("p", { class: "muted" });
  const done = el("button", { type: "button", class: "done-btn" }, "Done");
  done.addEventListener("click", () => dialog.close());
  // From a place's view: Check out at the bottom left (it asks first, in its own window).
  const out = welcome ? null : el("button", { type: "button", class: "checkout-link" }, icon(CHECKOUT_ICON), el("span", {}, "Check out"));
  out?.addEventListener("click", () => {
    dialog.close();
    checkOut();
  });
  const head = [
    welcome ? el("div", { class: "checked-in" }, el("span", { class: "tick", "aria-hidden": "true" }, icon(TICK_ICON)), el("h2", { id: "checkin-title" }, "Checked in!"))
      : el("h2", { id: "checkin-title" }, "Until when?"),
    el("p", { class: "checkin-place" }, c.name, c.building && !c.name.startsWith(c.building) ? el("span", { class: "muted" }, ` · ${c.building}`) : null),
  ];
  const main = [
    when,
    el("div", { class: "field" }, el("span", { class: "label" }, "Until"),
      el("div", { class: "row until-row" }, ...chips, timeBtn), holder),
    el("p", { class: "muted small" }, "Friends see until when you stay. It ends by itself then."),
    msg,
    welcome ? el("div", { class: "field" }, el("span", { class: "label" }, "Invite friends"), checkinInvite(c, place?.category)) : null,
    el("div", { class: "checkin-buttons" }, out, done)].filter(Boolean);
  const box = el("div", { class: "checkin-box" });
  // Right after checking in: first how full it is, with Skip, then the end time and invite.
  const ask = welcome ? checkinAsk(place) : null;
  const stages = ask ? ["report", "main"] : ["main"];
  let at = 0;
  const draw = (focus = true) => {
    const stage = stages[at];
    if (stage === "main") {
      box.replaceChildren(...head, ...main);
      if (focus) done.focus();
      return;
    }
    // A removed report keeps the step (`stay`): the choices come back to be picked again.
    const step = checkinReportStep(place, ask, (stay = false) => {
      if (!stay) at++;
      draw();
    });
    box.replaceChildren(...head, ...step.nodes);
    if (focus) step.first?.focus();
  };
  dialog.replaceChildren(box);
  draw(false);
  dialog.onclick = (e) => {
    if (e.target === dialog) dialog.close();
  };
  dialog.addEventListener("close", () => {
    // A wheel still gliding lands first, and a change not sent yet goes now.
    wheel?.finish();
    send();
    closeInviteMenus();
    // A report sent here shows as yours in the place's view behind.
    if (placesView.current && placesView.current.kind !== "account") renderPlaceView({ reuse: true });
    if (welcome && checkinShown()) placeBack();
  }, { once: true });
  sync();
  dialog.showModal();
  draw();
}

async function checkOut() {
  const c = myCheckin();
  if (!c) return;
  const ok = await askConfirm({ title: "Check out?", body: [`From ${c.name}. Your friends stop seeing it.`], yes: "Yes", no: "Cancel" });
  if (!ok) return;
  try {
    await accountFetch("DELETE", "/api/checkin");
    account.me.checkin = null;
  } catch (e) {
    flashAccountNote(errorText(e));
  }
  accountChanged();
}

/**
 * "Check in here" in a room's, study space's or mensa's view (not a building's). Checked in there: "Checked in" (it
 * opens the end time) and a round red Check out beside it, as in the You tab (actionGrid takes the pair).
 */
function checkinAction(place) {
  const mine = myCheckin();
  const here = mine && mine.kind === place.kind && mine.place === place.id && mine.area === place.area;
  // "Check in" fits a row of three on a phone; screen readers hear "Check in here".
  const b = actionButton(here ? "Checked in" : "Check in", null, () => {
    if (!accountReady()) return openAccountView("checkin");
    if (here) return openUntilDialog();
    checkIn(place, "place");
  }, `checkin-action${here ? " on" : ""}`);
  b.prepend(icon(here ? TICK_ICON : CHECKIN_ICON));
  markTour(b, "checkin-action");
  b.setAttribute("aria-label", here ? `Checked in to ${place.name}: change the end time` : `Check in here, to ${place.name}`);
  if (!here) return b;
  const out = el("button", { type: "button", class: "detail-action checkout-action", "aria-label": `Check out of ${place.name}`, title: "Check out" }, icon(CHECKOUT_ICON));
  out.addEventListener("click", checkOut);
  return [b, out];
}

// --- the You tab: your check-in (and, from friends.js's phase on, your friends') ---

/** The You tab's top: your running check-in with its times and check-out, or a line about signing in. */
function renderYouAccount() {
  const box = $("#you-account");
  if (!box) return;
  const parts = [];
  const c = myCheckin();
  if (c) {
    const open = el("button", { type: "button", class: "row-open checkin-open" }, el("span", { class: "name" }, `Checked in to ${c.name}`));
    open.addEventListener("click", () => openPlace({ kind: c.kind, id: c.place, area: c.area }, { opener: open }));
    const times = el("button", { type: "button", class: "checkin-times", "aria-label": `${checkinWhen(c, Date.now())}: change the end time` }, checkinWhen(c, Date.now()));
    times.addEventListener("click", () => openUntilDialog());
    const out = el("button", { type: "button", class: "checkout-btn", "aria-label": "Check out", title: "Check out" }, icon(CHECKOUT_ICON));
    out.addEventListener("click", checkOut);
    parts.push(el("div", { class: "group" }, el("h2", {}, "Your check-in"),
      el("ul", {}, el("li", { class: "room my-checkin" }, open, times, out))));
  }
  if (typeof friendsHereSection === "function") parts.push(friendsHereSection());
  else if (!accountReady() && account.status === "out") parts.push(youSignInLine());
  fill(box, ...parts);
}

/** Signed out, one line in the You tab. */
function youSignInLine() {
  const a = el("a", { href: loginUrl() }, "Sign in with edu-ID");
  return el("p", { class: "you-signin" }, a, " to see where your friends study.");
}

/** The running check-in's place, as last drawn ("" for none). */
let checkinKey = "";

/** Run `fn` at the running check-in's end (it stops showing then without anyone doing anything). */
let checkinEndTimer = 0;
function watchCheckinEnd() {
  clearTimeout(checkinEndTimer);
  const c = accountReady() ? account.me.checkin : null;
  if (!c) return;
  const wait = c.until - Date.now();
  if (wait <= 0) return;
  checkinEndTimer = setTimeout(() => {
    accountChanged();
  }, Math.min(wait + 500, 2 ** 31 - 1));
}

function initCheckin() {
  $("#checkin-btn").addEventListener("click", () => {
    if (myCheckin()) return checkOut();
    if (placesView.current?.kind === "account" && placesView.current.id === "checkin") return;
    openAccountView("checkin");
  });
  account.listeners.push(() => {
    syncCheckinButton();
    watchCheckinEnd();
    if (state.mode === "you") renderYouAccount();
    if (checkinShown()) renderPlaceView();
    // A place's view shows "Check in here" or "Checked in": drawn again when the check-in changed.
    const c = myCheckin();
    const key = c ? `${c.kind}|${c.area}|${c.place}` : "";
    const p = placesView.current;
    if (key !== checkinKey && p && (p.kind === "room" || p.kind === "space")) renderPlaceView({ reuse: true });
    checkinKey = key;
  });
  window.addEventListener("online", syncCheckinButton);
  window.addEventListener("offline", syncCheckinButton);
  syncCheckinButton();
}
