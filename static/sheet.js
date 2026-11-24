"use strict";

// The results sheet on phones: it lies over the map's lower part and has three positions, peek (only its head),
// half (half the frame between the top bar and the tabs) and full (up to just below the top bar). Dragging its head
// follows the finger and snaps to the nearest position on release (a quick flick goes on in its direction); a click
// on the grabber cycles half -> full -> half. It knows nothing about rooms. On wide windows it does nothing and
// reports "full".
//
// After every change it sets --sheet-top (px from the top of the window) and --top-px (the top bar's bottom) on the
// root, and calls the onChange listeners, so the map knows which part of it is visible.

const sheet = (() => {
  const PEEK_PX = 64;
  const FULL_GAP_PX = 8;
  const WIDE_QUERY = matchMedia("(min-width: 1000px)");
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");
  const listeners = [];
  let current = "half";
  let y = 0; // the sheet's offset below its full position (px)
  let frame = { top: 0, bottom: 0 }; // the top bar's bottom and the tabs' top (px)
  let el = null;

  const wide = () => WIDE_QUERY.matches;

  /** The offset (px below the full position) of each position, for the current frame. */
  function offsets() {
    const height = frame.bottom - frame.top - FULL_GAP_PX;
    return {
      full: 0,
      half: Math.max(0, Math.round((frame.bottom - frame.top) / 2 - FULL_GAP_PX)),
      peek: Math.max(0, height - PEEK_PX),
    };
  }

  function measure() {
    const top = document.getElementById("topbar").getBoundingClientRect().bottom;
    const bottom = document.getElementById("tabs").getBoundingClientRect().top;
    frame = { top, bottom };
    if (wide()) {
      el.style.top = "";
      el.style.height = "";
      return;
    }
    el.style.top = `${top + FULL_GAP_PX}px`;
    fit();
  }

  /**
   * The sheet's height: down to the tabs at its position, so the list scrolls to its end and the detail view's
   * actions stay in sight. While it moves it's as tall as at full height, so no gap opens above the tabs.
   */
  function fit(moving = false) {
    if (wide()) {
      el.style.height = "";
      return;
    }
    const full = frame.bottom - frame.top - FULL_GAP_PX;
    el.style.height = `${Math.round(moving ? full : full - y)}px`;
  }

  /** Move the sheet to offset `to` (px), with or without the snapping animation. */
  let settle = 0;
  function place(to, animate) {
    y = to;
    const anim = animate && !REDUCED.matches;
    el.classList.toggle("snapping", anim);
    el.style.transform = wide() ? "" : `translateY(${Math.round(y)}px)`;
    clearTimeout(settle);
    if (anim) {
      fit(true);
      settle = setTimeout(() => fit(), 320); // after the transition (transitionend isn't always sent)
    } else if (!drag) fit();
  }

  /** The sheet's top edge (px from the top of the window). */
  const top = () => (wide() ? frame.top : frame.top + FULL_GAP_PX + y);

  function changed() {
    const root = document.documentElement.style;
    root.setProperty("--sheet-top", `${Math.round(top())}px`);
    root.setProperty("--top-px", `${Math.round(frame.top)}px`);
    document.body.dataset.sheet = wide() ? "wide" : current;
    const grab = document.getElementById("sheet-grab");
    grab.setAttribute("aria-expanded", String(current === "full"));
    grab.setAttribute("aria-label", current === "full" ? "Show more of the map (arrow keys: list size)" : "Show more of the list (arrow keys: list size)");
    for (const fn of listeners) fn(current, top());
  }

  function snap(name, animate = true) {
    if (wide()) {
      current = "full";
      place(0, false);
      return changed();
    }
    current = name;
    place(offsets()[name], animate);
    changed();
  }

  /** The nearest position to the current offset, nudged by the release speed (px/ms, positive downwards). */
  function nearest(speed) {
    const o = offsets();
    const target = y + speed * 180; // where a flick would carry it
    return Object.entries(o).sort((a, b) => Math.abs(a[1] - target) - Math.abs(b[1] - target))[0][0];
  }

  let drag = null; // { id, startY, startOffset, last: [t, y][], moved }

  function setupDrag() {
    const head = document.getElementById("sheet-head");
    head.addEventListener("pointerdown", (e) => {
      if (wide() || e.button > 0) return;
      drag = { id: e.pointerId, startY: e.clientY, startOffset: y, last: [[e.timeStamp, e.clientY]], moved: false };
    });
    // Moves and the release are followed on the window: the finger soon leaves the head. No pointer capture before
    // it moves, so a plain click still reaches the head's buttons.
    window.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.abs(dy) < 6) return;
      if (!drag.moved) fit(true);
      drag.moved = true;
      const o = offsets();
      place(Math.min(o.peek, Math.max(0, drag.startOffset + dy)), false);
      drag.last.push([e.timeStamp, e.clientY]);
      if (drag.last.length > 5) drag.last.shift();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag;
      drag = null;
      if (!d.moved) return; // a click: the grabber's own handler
      const [t0, y0] = d.last[0];
      const speed = e.timeStamp > t0 ? (e.clientY - y0) / (e.timeStamp - t0) : 0;
      snap(nearest(speed));
      // A drag that started on a button must not also click it.
      const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 50);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);

    // At full height, scrolled to the top: pulling the list down brings the sheet to half (one gesture closes it).
    // Not from the time wheel's drums (picker.js), which are dragged up and down themselves.
    const body = document.getElementById("sheet-body");
    let pull = null;
    body.addEventListener("touchstart", (e) => {
      const onDrum = !!e.target.closest?.(".drum");
      pull = !wide() && !onDrum && current === "full" && body.scrollTop <= 0 ? e.touches[0].clientY : null;
    }, { passive: true });
    body.addEventListener("touchend", (e) => {
      if (pull !== null && body.scrollTop <= 0 && e.changedTouches[0].clientY - pull > 60) snap("half");
      pull = null;
    }, { passive: true });
  }

  function init() {
    el = document.getElementById("sheet");
    measure();
    snap("half", false);
    setupDrag();
    const grab = document.getElementById("sheet-grab");
    grab.addEventListener("click", () => snap(current === "half" ? "full" : "half"));
    // Every position without dragging: the arrow keys move it up and down (peek, half, full).
    grab.addEventListener("keydown", (e) => {
      const order = ["peek", "half", "full"];
      const i = order.indexOf(current);
      if (e.key === "ArrowUp" && i < 2) snap(order[i + 1]);
      else if (e.key === "ArrowDown" && i > 0) snap(order[i - 1]);
      else return;
      e.preventDefault();
    });
    el.addEventListener("transitionend", () => el.classList.remove("snapping"));
    const relayout = () => {
      measure();
      snap(current, false);
    };
    window.addEventListener("resize", relayout);
    WIDE_QUERY.addEventListener("change", () => {
      measure();
      snap("half", false);
    });
    new ResizeObserver(relayout).observe(document.getElementById("topbar"));
  }

  return {
    init,
    snap: (name, animate) => snap(name, animate),
    current: () => (wide() ? "full" : current),
    /** The sheet's top edge (px from the top of the window). */
    top,
    /** The top bar's bottom edge (px). */
    frameTop: () => frame.top,
    /** Where the map's visible part ends: the sheet's top, or its half position while it's at full height. */
    mapBottom: () => (wide() ? Infinity : frame.top + FULL_GAP_PX + (current === "full" ? offsets().half : y)),
    onChange: (fn) => listeners.push(fn),
  };
})();
