"use strict";

// The date and time picker of the filters' Time field (app.js renderTimeField): a month calendar (datePicker) and a
// two-drum time wheel (timeWheel), each shown inline under the field's buttons. The pure parts, the month's grid and
// the wheel's physics, are in lib.js (calendarMonth, wheelIndex, wheelGlide, roundToStep) and tested there; this file
// renders them and handles the pointer, the keyboard and the animation. No inline styles: everything set here goes
// through the CSSOM (the CSP forbids style attributes).

const WEEKDAY_NAMES = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
// Values in a drum's window, and the nodes rendered for them (one spare above and one below, for the half-way states).
const WHEEL_VISIBLE = 5;
const DRUM_SLOTS = WHEEL_VISIBLE + 2;
// A click (no drag) and a snap move a drum this fast; a mouse notch and a key this fast.
const WHEEL_SNAP_MS = 160;
const WHEEL_NOTCH_MS = 120;

const pickerPad = (n) => String(n).padStart(2, "0");
const pickerToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pickerPad(d.getMonth() + 1)}-${pickerPad(d.getDate())}`;
};
/** "Friday 13 November 2026", for the days' labels. */
const pickerLongDate = (iso) => new Date(`${iso}T12:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const pickerAddDays = (iso, n) => {
  const d = new Date(`${iso}T12:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pickerPad(d.getMonth() + 1)}-${pickerPad(d.getDate())}`;
};

/**
 * A month calendar: the month's name with arrows to the previous and next month, a weekday row (Mo to Su) and the days
 * as buttons (role=grid). `value` is the selected ISO date, `min` and `max` the pickable range (days outside are
 * disabled), `allowed(date)` (optional) disables the days it says no to and the arrow keys skip them, `onPick(date)`
 * runs on a click or Enter, `onClose()` on Escape. Returns the element, with `update(value)` (show another day and
 * its month) and `focusDay()` (move the keyboard focus onto the focused day).
 */
function datePicker({ value, min = null, max = null, allowed = null, onPick, onClose }) {
  const box = el("div", { class: "cal" });
  let selected = value;
  let focused = value; // the day that holds the keyboard focus (roving tabindex)
  let shown = value.slice(0, 7); // the month on show
  const today = pickerToday();
  const inRange = (d) => (!min || d >= min) && (!max || d <= max) && (!allowed || allowed(d));
  const clamp = (d) => (min && d < min ? min : max && d > max ? max : d);

  function navButton(text, label, month, disabled) {
    const b = el("button", { type: "button", class: "cal-nav", "aria-label": label }, text);
    b.disabled = disabled;
    b.addEventListener("click", () => {
      shown = month;
      // Keep the focus inside the month on show: the same day of the month when it exists, else its last day.
      const dayNo = Math.min(Number(focused.slice(8)), calendarMonth(month).weeks.flat().filter(Boolean).length);
      focused = clamp(`${month}-${pickerPad(dayNo)}`);
      render();
    });
    return b;
  }

  function render() {
    const { title, weeks } = calendarMonth(shown);
    const prev = addMonthsTo(shown, -1);
    const next = addMonthsTo(shown, 1);
    const head = el("div", { class: "cal-head" },
      navButton("‹", "Previous month", prev, !!min && `${prev}-31` < min),
      el("span", { class: "cal-title", "aria-live": "polite" }, title),
      navButton("›", "Next month", next, !!max && `${next}-01` > max));
    const grid = el("div", { class: "cal-grid", role: "grid", "aria-label": "Day" },
      el("div", { class: "cal-row", role: "row" }, ...WEEKDAY_NAMES.map((w) => el("span", { class: "cal-wd", role: "columnheader" }, w))));
    // The day that takes the focus: the focused one, or (when that's disabled) the month's first that isn't.
    const days = weeks.flat().filter(Boolean);
    const rov = inRange(focused) || !days.some(inRange) ? focused : days.find(inRange);
    for (const week of weeks) {
      grid.append(el("div", { class: "cal-row", role: "row" }, ...week.map((d) => {
        if (!d) return el("span", { class: "cal-blank", role: "gridcell" });
        const cls = ["cal-day", d === selected ? "sel" : "", d === today ? "today" : ""].filter(Boolean).join(" ");
        const b = el("button", { type: "button", role: "gridcell", class: cls, "aria-label": pickerLongDate(d), "aria-selected": String(d === selected), tabindex: d === rov ? "0" : "-1" }, String(Number(d.slice(8))));
        if (!inRange(d)) b.disabled = true;
        else b.addEventListener("click", () => {
          selected = d;
          focused = d;
          onPick(d);
        });
        return b;
      })));
    }
    box.replaceChildren(head, grid);
  }

  // Arrows move the focus by a day or a week (into the next month when needed), Escape closes; Enter and Space are
  // the button's own click.
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose?.();
      return;
    }
    const by = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (by === undefined || !e.target.classList.contains("cal-day")) return;
    e.preventDefault();
    // With `allowed`, on to the next day it allows in that direction (at most a year on), else stay.
    let next = clamp(pickerAddDays(focused, by));
    for (let i = 0; allowed && !inRange(next) && i < 400 && next !== clamp(pickerAddDays(next, by)); i++) next = clamp(pickerAddDays(next, by));
    if (inRange(next)) focused = next;
    shown = focused.slice(0, 7);
    render();
    box.focusDay();
  });

  box.update = (date) => {
    selected = date;
    focused = date;
    shown = date.slice(0, 7);
    render();
  };
  box.focusDay = () => box.querySelector('.cal-day[tabindex="0"]')?.focus({ preventScroll: true });
  render();
  return box;
}

/**
 * One drum of the time wheel: `count` values (0 to count - 1) shown as `text(i)`, circular, in a window of five with
 * the middle one large. It follows the finger 1:1 (one value per WHEEL_STEP_PX), glides on after a flick (wheelGlide)
 * and snaps to the nearest value; a click on a value above or below moves there; the mouse wheel moves one value per
 * notch; as a spinbutton, the arrows step by one, Page Up and Down by six, Home and End to the ends. Each settled
 * change calls `onSettle()`. Returns { el, value(), jumpTo(i), finish() } (finish: a glide lands on its target now).
 */
function drum({ count, label, index, text, onSettle }) {
  const STEP = WHEEL_STEP_PX;
  const height = WHEEL_VISIBLE * STEP;
  const centre = height / 2 - STEP / 2; // the middle slot's top
  const root = el("div", { class: "drum", role: "spinbutton", tabindex: "0", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": String(count - 1) });
  const band = el("div", { class: "drum-band", "aria-hidden": "true" });
  const list = el("div", { class: "drum-list", "aria-hidden": "true" });
  const slots = Array.from({ length: DRUM_SLOTS }, () => el("span", { class: "drum-v" }));
  list.append(...slots);
  root.append(band, list);
  root.style.height = `${height}px`;
  list.style.height = `${height}px`;
  band.style.top = `${centre}px`;
  band.style.height = `${STEP}px`;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let pos = index * STEP; // the list's offset: pos / STEP is the value in the middle (unbounded; wheelIndex wraps it)
  let settled = index;
  let anim = null; // the running glide: { from, to, start, duration, raf }
  let drag = null; // the finger: { id, y0, pos0, samples, moved }
  const mod = (k) => ((k % count) + count) % count;

  function paint() {
    const mid = Math.round(pos / STEP);
    for (let j = 0; j < DRUM_SLOTS; j++) {
      const k = mid + j - (DRUM_SLOTS - 1) / 2;
      const away = Math.min(Math.abs(k * STEP - pos) / STEP, 3); // distance from the centre, in values
      const s = slots[j];
      s.textContent = text(mod(k));
      s.style.transform = `translateY(${k * STEP - pos + centre}px) scale(${(1 - 0.08 * away).toFixed(3)})`;
      s.classList.toggle("mid", k === mid);
    }
  }

  function settle() {
    const v = wheelIndex(pos, STEP, count);
    root.setAttribute("aria-valuenow", String(v));
    root.setAttribute("aria-valuetext", text(v));
    if (v === settled) return;
    settled = v;
    onSettle?.();
  }

  function stop() {
    if (anim) cancelAnimationFrame(anim.raf);
    anim = null;
  }

  /** Glide to `target` (px) in `duration` ms, slowing down evenly (the finger's velocity carries on), then settle. */
  function animateTo(target, duration) {
    stop();
    if (reducedMotion || duration <= 0 || Math.abs(target - pos) < 0.5) {
      pos = target;
      paint();
      settle();
      return;
    }
    anim = { from: pos, to: target, start: performance.now(), duration, raf: 0 };
    const frame = (now) => {
      const t = Math.min(1, (now - anim.start) / anim.duration);
      const eased = 1 - (1 - t) * (1 - t); // constant deceleration
      pos = anim.from + (anim.to - anim.from) * eased;
      paint();
      if (t < 1) anim.raf = requestAnimationFrame(frame);
      else {
        anim = null;
        settle();
      }
    };
    anim.raf = requestAnimationFrame(frame);
  }

  const snapped = (p) => Math.round(p / STEP) * STEP;

  /** The finger let go at `velocity` px/ms: glide on and snap. */
  function release(velocity) {
    const { distance, duration } = wheelGlide(velocity);
    animateTo(snapped(pos + distance), Math.max(duration, WHEEL_SNAP_MS));
  }

  /** Move by `n` values from where the drum is heading. */
  function step(n, duration = WHEEL_NOTCH_MS) {
    animateTo(snapped(anim ? anim.to : pos) + n * STEP, duration);
  }

  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection or scrolling; the focus is set by hand
    root.focus({ preventScroll: true });
    try {
      root.setPointerCapture(e.pointerId);
    } catch { /* a pointer that's gone already: the drag still works while it stays over the drum */ }
    stop();
    drag = { id: e.pointerId, y0: e.clientY, pos0: pos, samples: [{ t: e.timeStamp, y: e.clientY }], moved: false };
  });
  root.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (Math.abs(dy) > 3) drag.moved = true;
    pos = drag.pos0 - dy; // the finger pulls the list down: earlier values come into view
    drag.samples.push({ t: e.timeStamp, y: e.clientY });
    while (drag.samples.length > 2 && e.timeStamp - drag.samples[0].t > 100) drag.samples.shift();
    paint();
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      // A click: on the value above or below the middle (or the middle itself), move there.
      const rect = root.getBoundingClientRect();
      step(Math.round((e.clientY - rect.top - rect.height / 2) / STEP), WHEEL_SNAP_MS);
      return;
    }
    // The release velocity from the last 100 ms of the drag; a finger that stopped before lifting has none.
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const dt = last.t - first.t;
    const stale = e.timeStamp - last.t > 100;
    release(stale || dt <= 0 ? 0 : -(last.y - first.y) / dt);
  };
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    release(0);
  });

  // The mouse wheel: one value per notch (a trackpad's small deltas add up to one).
  let notch = 0;
  root.addEventListener("wheel", (e) => {
    e.preventDefault();
    notch += e.deltaY;
    if (Math.abs(notch) < 20) return;
    const dir = notch > 0 ? 1 : -1;
    notch = 0;
    step(dir);
  }, { passive: false });

  root.addEventListener("keydown", (e) => {
    const by = { ArrowUp: 1, ArrowDown: -1, PageUp: 6, PageDown: -6 }[e.key];
    if (by !== undefined) {
      e.preventDefault();
      step(by);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const want = e.key === "Home" ? 0 : count - 1;
      const base = snapped(anim ? anim.to : pos);
      step(mod(want - wheelIndex(base, STEP, count))); // forwards to the wanted value
    }
  });

  function jumpTo(i) {
    if (drag) return; // never under the finger
    stop();
    pos = i * STEP;
    settled = i;
    paint();
    settle();
  }

  /** Land a running glide on its target at once (and settle), so what it was heading for is what's chosen. */
  function finish() {
    if (!anim) return;
    const target = anim.to;
    stop();
    pos = target;
    paint();
    settle();
  }

  paint();
  settle();
  return { el: root, value: () => settled, jumpTo, finish };
}

/**
 * The time wheel: an hours drum (00 to 23) and a minutes drum (00, 05, … 55, or every `step` minutes) with a colon
 * between them. `value` is "HH:MM" (rounded down to the step), `onChange("HH:MM")` runs after every settled change,
 * `onClose()` on Escape. `allowed(hhmm)`, when given, returns the time to use instead of a settled one (the drums then
 * move there): a meal invite keeps to the meal's quarter hours.
 * Minutes passing 60 don't carry into the hours (the drums are independent, like a kitchen timer's). Returns the
 * element, with `setValue(hhmm)` (show another time, unless a finger is on a drum), `focusDrum()` (the keyboard focus
 * onto the hours) and `finish()` (gliding drums land on their targets now).
 */
function timeWheel({ value, onChange, onClose, step = TIME_STEP_MIN, allowed = null }) {
  const box = el("div", { class: "wheel", role: "group", "aria-label": "Time" });
  const parts = (hhmm) => {
    const r = roundToStep(hhmm, step);
    return [Number(r.slice(0, 2)), Number(r.slice(3, 5)) / step];
  };
  const [h, m] = parts(value);
  const emit = () => {
    const t = `${pickerPad(hours.value())}:${pickerPad(minutes.value() * step)}`;
    const ok = allowed ? allowed(t) : t;
    if (ok !== t) box.setValue(ok);
    onChange(ok);
  };
  const hours = drum({ count: 24, label: "Hours", index: h, text: (i) => pickerPad(i), onSettle: emit });
  const minutes = drum({ count: 60 / step, label: "Minutes", index: m, text: (i) => pickerPad(i * step), onSettle: emit });
  box.append(hours.el, el("span", { class: "wheel-colon", "aria-hidden": "true" }, ":"), minutes.el);
  box.setValue = (hhmm) => {
    const [hh, mm] = parts(hhmm);
    if (hh !== hours.value()) hours.jumpTo(hh);
    if (mm !== minutes.value()) minutes.jumpTo(mm);
  };
  box.focusDrum = () => hours.el.focus({ preventScroll: true });
  box.finish = () => {
    hours.finish();
    minutes.finish();
  };
  box.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    onClose?.();
  });
  return box;
}
