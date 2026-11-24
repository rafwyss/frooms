"use strict";

// Meal ratings on the page (plans/PLAN_STREET_CRED.md, section 10): the average at the bottom right of each dish (the
// menu panel's day and week views, and the dish's lightbox) with "Rate" beside it, the window that shows a dish's
// ratings (Ø, then taste, portion size and value for money as bars from a common 0 line) and the same window to rate
// it, with bars to drag or values to type. The maths and colours are in lib.js (dishKey, ratingAverage, snapRating,
// ratingColour); the Worker's side is worker/ratings.ts. Loaded after checkin.js, before app.js; it uses app.js's
// helpers (el, $, icon) only when called.
//
// A dish's place in the page is its `ctx`: { place, placeName, facility, date, meal, today } (the menu's place id,
// name and facility, the dish's date and meal, and today in Zurich as the Worker said).

const mealRatings = {
  cache: new Map(), // `${place}|${date}` -> promise of { key: summary } (null: none to show, e.g. sign-in off)
  dialog: null, // what the open window shows: { ctx, dish, key, spot }
};

const RATING_LABELS = { avg: "Ø", taste: "Taste", portion: "Portion size", value: "Value for money" };
const RATING_SHORT = { portion: "Portion", value: "Value" }; // below 360 px
const RATING_COUNT_FIELD = { taste: "nTaste", portion: "nPortion", value: "nValue" };

/** Ratings need the accounts database: none where sign-in is off (local, other previews). */
const ratingsShown = () => account.status !== "off";

/** The day before an ISO date. */
const dayBefore = (date) => addDaysTo(date, -1);

/** A place's ratings on a date, once per open menu panel (closing the panel forgets them). */
function loadRatings(place, date) {
  const k = `${place}|${date}`;
  if (!mealRatings.cache.has(k)) {
    // Signed in the answer is personal (your own values): past the browser's cache, which may hold a signed-out copy.
    const p = getJSON(`/api/meal-ratings?${new URLSearchParams({ place, date })}`, { fresh: signedIn() })
      .then((r) => r.dishes ?? {})
      .catch(() => null);
    mealRatings.cache.set(k, p);
  }
  return mealRatings.cache.get(k);
}

function clearMealRatings() {
  mealRatings.cache.clear();
}

/** The current theme's rating colours (style.css --rate-neg, --rate-zero, --rate-pos). */
function ratingStops() {
  const css = getComputedStyle(document.documentElement);
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const fallback = RATING_COLOURS[dark ? "dark" : "light"];
  const read = (name, f) => {
    const v = css.getPropertyValue(name).trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(v) ? v : f;
  };
  return { neg: read("--rate-neg", fallback.neg), zero: read("--rate-zero", fallback.zero), pos: read("--rate-pos", fallback.pos) };
}

/** Colours a figure by its value (and remembers it, so a change of theme can colour it again). */
function paintRating(node, v) {
  node.dataset.rating = String(v);
  node.style.color = ratingColour(v, ratingStops());
}

function repaintRatings() {
  const stops = ratingStops();
  document.querySelectorAll("[data-rating]").forEach((n) => {
    n.style.color = ratingColour(Number(n.dataset.rating), stops);
  });
}

const ratingsWord = (n) => `${n} ${n === 1 ? "rating" : "ratings"}`;

/**
 * The dish's corner: "Rate" (today's and yesterday's dishes) and the average in a big coloured figure, or a muted
 * "–" when nobody rated it. Nothing for dishes still to come, or where ratings aren't shown. Filled when the place's
 * ratings arrive; `big` is the lightbox's.
 */
function ratingSpot(ctx, dish, { big = false } = {}) {
  if (!ctx || !ratingsShown()) return null;
  const kind = ratingDay(ctx.date, ctx.today, dayBefore(ctx.today));
  if (kind === "future") return null;
  const key = dishKey(ctx.facility, ctx.date, ctx.meal, dish.line, dish.name);
  const spot = el("div", { class: `dish-rating${big ? " big" : ""}`, "data-dish": key });
  if (big) markTour(spot, "rating"); // the lightbox's, for the tutorial
  spot.ratingCtx = { ctx, dish, key, kind };
  loadRatings(ctx.place, ctx.date).then((dishes) => fillSpot(spot, dishes));
  return spot;
}

function fillSpot(spot, dishes) {
  const { ctx, dish, key, kind } = spot.ratingCtx;
  if (!dishes) return spot.replaceChildren();
  const s = dishes[key] ?? null;
  const rate = kind === "rate" ? el("button", { type: "button", class: "rate-btn", "aria-haspopup": "dialog", "aria-label": `Rate ${dish.name}` }, "Rate") : null;
  rate?.addEventListener("click", () => openRatingDialog({ mode: "rate", ctx, dish, key, spot }));
  let figure;
  if (s?.n) {
    figure = el("button", { type: "button", class: "rating-figure", "aria-haspopup": "dialog",
      "aria-label": `${ratingFigure(s.avg)} on average, ${ratingsWord(s.n)}: show the ratings`, title: ratingsWord(s.n) }, ratingFigure(s.avg));
    paintRating(figure, s.avg ?? 0);
    figure.addEventListener("click", () => openRatingDialog({ mode: "view", ctx, dish, key, spot }));
  } else {
    figure = el("span", { class: "rating-none", title: "No ratings yet", "aria-label": "No ratings yet" }, "–");
  }
  spot.replaceChildren(...[rate, figure].filter(Boolean));
}

/** Every corner of `key` on the page, drawn again from the cache (after a rating). */
async function refreshSpots(ctx, key) {
  const dishes = await loadRatings(ctx.place, ctx.date);
  document.querySelectorAll(".dish-rating").forEach((spot) => {
    if (spot.dataset.dish === key) fillSpot(spot, dishes);
  });
}

// --- the window ---

/** A column's label: the short words below 360 px for the two long ones (the CSS picks). */
function ratingLabel(cat) {
  const long = RATING_LABELS[cat];
  if (!RATING_SHORT[cat]) return el("span", { class: "rating-label" }, long);
  return el("span", { class: "rating-label" }, el("span", { class: "long" }, long), el("span", { class: "short", "aria-hidden": "true" }, RATING_SHORT[cat]));
}

/** Draws a bar in a track: up and green for positive, down and red for negative, 5 = the full half height. */
function setBar(track, v) {
  const bar = track.querySelector(".rating-bar");
  const set = typeof v === "number";
  track.classList.toggle("unset", !set);
  bar.classList.toggle("pos", set && v > 0);
  bar.classList.toggle("neg", set && v < 0);
  bar.style.setProperty("--h", set ? `${(Math.abs(v) / RATING_MAX) * 50}%` : "0%");
}

function ratingTrack(hint = null) {
  return el("div", { class: "rating-track" }, el("span", { class: "rating-zero", "aria-hidden": "true" }), el("span", { class: "rating-bar" }),
    hint ? el("span", { class: "rating-hint", "aria-hidden": "true" }, hint) : null);
}

/** The value above a bar: the figure in its colour, or "–". */
function showValue(node, v) {
  node.textContent = ratingFigure(v);
  if (typeof v === "number") paintRating(node, v);
  else {
    delete node.dataset.rating;
    node.style.color = "";
  }
}

/**
 * The window for a dish: `mode` "view" shows its ratings (and "Rate" when it takes them), "rate" lets you set yours
 * (preloaded when you rated it before). Signed out, "rate" says to sign in. Backdrop and Escape close it; the focus
 * goes back to the dish's corner.
 */
async function openRatingDialog({ mode, ctx, dish, key, spot }) {
  const dialog = $("#meal-rating");
  const dishes = (await loadRatings(ctx.place, ctx.date)) ?? {};
  const s = dishes[key] ?? null;
  mealRatings.dialog = { ctx, dish, key, spot };
  const when = ctx.date === ctx.today ? null : ctx.date === dayBefore(ctx.today) ? "Yesterday" : dayName(ctx.date);
  const head = el("div", { class: "rating-head" },
    el("h2", { id: "meal-rating-title" }, dish.name),
    el("p", { class: "muted small" }, [ctx.placeName, MEAL_NAMES[ctx.meal], when].filter(Boolean).join(" · ")));
  const close = (text = "Close", cls = "confirm-no") => {
    const b = el("button", { type: "button", class: cls }, text);
    b.addEventListener("click", () => dialog.close());
    return b;
  };
  let body;
  let first;
  if (mode === "rate" && !accountReady()) {
    const finish = signedIn() ? el("button", { type: "button", class: "confirm-yes" }, "Finish setting up") : null;
    finish?.addEventListener("click", () => {
      dialog.close();
      closeMenu();
      openAccountView("welcome");
    });
    body = [signedIn() ? el("p", {}, "Finish setting up your account first, then rate dishes.")
      : signInBlock("Sign in to rate dishes. Ratings need an account, so each person counts once."),
    el("div", { class: "confirm-buttons" }, close(), finish)];
    first = body[1].firstChild;
  } else if (mode === "rate") {
    ({ body, first } = rateBody(dialog, ctx, dish, key, s?.mine ?? null));
  } else {
    ({ body, first } = viewBody(dialog, ctx, dish, key, s, close));
  }
  dialog.replaceChildren(el("div", { class: `rating-box ${mode}` }, head, ...body));
  dialog.onclick = (e) => {
    if (e.target === dialog) dialog.close();
  };
  // One handler (the window may switch from showing to rating while open).
  dialog.onclose = () => {
    mealRatings.dialog = null;
    const back = spot?.isConnected ? spot.querySelector(mode === "rate" ? ".rate-btn" : ".rating-figure") ?? spot.querySelector("button") : null;
    back?.focus();
  };
  if (!dialog.open) dialog.showModal();
  first?.focus();
}

/** The read-only chart: Ø, a dashed line, then the three categories; "12 ratings" and Close (and Rate) below. */
function viewBody(dialog, ctx, dish, key, s, close) {
  const col = (cat, v, n = null) => {
    const value = el("span", { class: "rating-value" });
    showValue(value, v);
    const track = ratingTrack();
    setBar(track, v);
    const c = el("div", { class: `rating-col ${cat}` }, ratingLabel(cat), value, track);
    c.setAttribute("aria-label", `${RATING_LABELS[cat] === "Ø" ? "Average" : RATING_LABELS[cat]}: ${typeof v === "number" ? ratingFigure(v) : "not rated"}${n != null ? `, ${ratingsWord(n)}` : ""}`);
    c.setAttribute("role", "img");
    return c;
  };
  const chart = el("div", { class: "rating-chart" },
    col("avg", s?.avg ?? null),
    el("span", { class: "rating-sep", "aria-hidden": "true" }),
    ...RATING_CATEGORIES.map((c) => col(c, s?.[c] ?? null, s ? s[RATING_COUNT_FIELD[c]] : 0)));
  const rateable = ratingDay(ctx.date, ctx.today, dayBefore(ctx.today)) === "rate";
  const rate = rateable ? el("button", { type: "button", class: "confirm-no" }, s?.mine ? "Change your rating" : "Rate") : null;
  rate?.addEventListener("click", () => openRatingDialog({ mode: "rate", ctx, dish, key, spot: mealRatings.dialog?.spot }));
  // Your rating: the round red ✕ takes it back, with its street cred.
  const msg = el("p", { class: "form-error", role: "alert" });
  const remove = rateable && s?.mine && accountReady() ? removeButton("Remove my rating", async () => {
    remove.disabled = true;
    msg.textContent = "";
    try {
      const r = await accountFetch("DELETE", "/api/meal-ratings", { place: ctx.place, date: ctx.date, meal: ctx.meal, line: dish.line, name: dish.name });
      const k = `${ctx.place}|${ctx.date}`;
      const dishes = { ...((await mealRatings.cache.get(k)) ?? {}), [r.key ?? key]: r.dish };
      mealRatings.cache.set(k, Promise.resolve(dishes));
      await refreshSpots(ctx, r.key ?? key);
      forgetCred();
      openRatingDialog({ mode: "view", ctx, dish, key, spot: mealRatings.dialog?.spot });
    } catch (e) {
      remove.disabled = false;
      msg.textContent = errorText(e);
    }
  }) : null;
  const done = close("Close", "confirm-yes");
  return {
    body: [chart,
      el("p", { class: "rating-count muted" }, s?.n ? ratingsWord(s.n) : "No ratings yet"),
      msg,
      el("div", { class: "confirm-buttons" }, remove, rate, done)],
    first: done,
  };
}

/**
 * The editable chart: each category's bar is a slider (drag, or arrow keys ±0.5, Page Up/Down ±2, Home −5, End +5,
 * Delete to unset); a click on the value above it types it. Ø follows. "Rate" sends once a category is set.
 */
function rateBody(dialog, ctx, dish, key, mine) {
  const values = { taste: mine?.taste ?? null, portion: mine?.portion ?? null, value: mine?.value ?? null };
  const msg = el("p", { class: "form-error", role: "alert" });
  const avgValue = el("span", { class: "rating-value" });
  const avgTrack = ratingTrack();
  const send = el("button", { type: "button", class: "confirm-yes" }, "Rate");
  const sync = () => {
    const avg = ratingAverage(RATING_CATEGORIES.map((c) => values[c]));
    showValue(avgValue, avg);
    setBar(avgTrack, avg);
    send.disabled = RATING_CATEGORIES.every((c) => values[c] === null);
  };
  const cols = RATING_CATEGORIES.map((cat) => {
    const value = el("button", { type: "button", class: "rating-value edit", "aria-label": `${RATING_LABELS[cat]}: type a value` });
    const track = ratingTrack("Drag or type");
    track.tabIndex = 0;
    track.setAttribute("role", "slider");
    track.setAttribute("aria-label", RATING_LABELS[cat]);
    track.setAttribute("aria-valuemin", String(RATING_MIN));
    track.setAttribute("aria-valuemax", String(RATING_MAX));
    track.setAttribute("aria-orientation", "vertical");
    const set = (v) => {
      values[cat] = v;
      showValue(value, v);
      setBar(track, v);
      if (v === null) {
        track.removeAttribute("aria-valuenow");
        track.setAttribute("aria-valuetext", "Not rated");
      } else {
        track.setAttribute("aria-valuenow", String(v));
        track.setAttribute("aria-valuetext", ratingFigure(v));
      }
      msg.textContent = "";
      sync();
    };
    // Dragging: the value follows the finger, snapped to 0.5.
    const at = (e) => {
      const r = track.getBoundingClientRect();
      return ratingAtY(Math.min(r.height, Math.max(0, e.clientY - r.top)), r.height);
    };
    track.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        track.setPointerCapture(e.pointerId);
      } catch {} // a pointer that is already gone
      track.classList.add("dragging");
      track.focus();
      set(at(e));
    });
    track.addEventListener("pointermove", (e) => {
      if (track.hasPointerCapture(e.pointerId)) set(at(e));
    });
    const end = (e) => {
      if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
      track.classList.remove("dragging");
    };
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
    track.addEventListener("keydown", (e) => {
      const cur = values[cat];
      const step = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 2, PageDown: -2 }[e.key];
      let next;
      if (step !== undefined) next = snapRating((cur ?? 0) + (cur === null ? Math.sign(step) * 0.5 : step));
      else if (e.key === "Home") next = RATING_MIN;
      else if (e.key === "End") next = RATING_MAX;
      else if (e.key === "Delete" || e.key === "Backspace") next = null;
      else return;
      e.preventDefault();
      set(next);
    });
    // Typing: the value turns into a number field; Enter or leaving it keeps it (snapped), Escape doesn't.
    value.addEventListener("click", () => {
      const input = el("input", { type: "number", class: "rating-input", min: String(RATING_MIN), max: String(RATING_MAX), step: String(RATING_STEP),
        "aria-label": `${RATING_LABELS[cat]}, from −5 to 5` });
      if (values[cat] !== null) input.value = String(values[cat]);
      let done = false;
      const finish = (keep) => {
        if (done) return;
        done = true;
        if (keep && input.value.trim()) set(snapRating(input.value) ?? values[cat]);
        else if (keep) set(null);
        input.replaceWith(value);
        value.focus();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault(); // the window stays open
          e.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener("blur", () => finish(true));
      value.replaceWith(input);
      input.focus();
      input.select();
    });
    set(values[cat]);
    return el("div", { class: `rating-col ${cat}` }, ratingLabel(cat), value, track);
  });
  const chart = el("div", { class: "rating-chart edit" },
    el("div", { class: "rating-col avg", "aria-live": "polite" }, ratingLabel("avg"), avgValue, avgTrack),
    el("span", { class: "rating-sep", "aria-hidden": "true" }),
    ...cols);
  send.addEventListener("click", async () => {
    send.disabled = true;
    msg.textContent = "";
    try {
      const r = await accountFetch("PUT", "/api/meal-ratings", {
        place: ctx.place, date: ctx.date, meal: ctx.meal, line: dish.line, name: dish.name,
        taste: values.taste, portion: values.portion, value: values.value,
      });
      // The answer is the dish's new summary: into the cache, onto every corner that shows it.
      const k = `${ctx.place}|${ctx.date}`;
      const dishes = { ...((await mealRatings.cache.get(k)) ?? {}), [r.key ?? key]: r.dish };
      mealRatings.cache.set(k, Promise.resolve(dishes));
      await refreshSpots(ctx, r.key ?? key);
      dialog.close();
      credEarned(r.cred);
    } catch (e) {
      msg.textContent = errorText(e);
      sync();
    }
  });
  const cancel = el("button", { type: "button", class: "confirm-no" }, "Cancel");
  cancel.addEventListener("click", () => dialog.close());
  sync();
  return {
    body: [chart,
      el("p", { class: "rating-count muted small" }, "From −5 to 5. Each category is optional."),
      msg,
      el("div", { class: "confirm-buttons rate-buttons" }, cancel, send)],
    first: cols[0].querySelector(".rating-track"),
  };
}

function initRatings() {
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", repaintRatings);
}
