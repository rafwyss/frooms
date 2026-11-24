"use strict";

// The tutorial (plans/PLAN_TUTORIAL.md): a fog over the real page with a hole (the spotlight) on the element a step
// explains, a card with the step's text, and a runner that goes through a journey's steps. Loaded only when the tour
// starts (app.js tourLoad: the account menu, the You tab's footer, the sign-in view, /?tutorial), into the page's
// global scope: every top-level name starts with `tour` (test/scripts.test.ts).
//
// The fog is one manual popover (#tour) in the top layer, above the sheet, the map and open <dialog>s; it's shown
// again whenever a dialog opens, so it stays on top. A modal dialog makes everything outside it inert, a popover shown
// above it too (checked in headless Chrome: the card's buttons couldn't be clicked), so while one is open #tour moves
// into it (tourHost): it stays in the top layer, above the dialog, and can be clicked. It never sends anything (app.js tourActive() guards the sending
// points), and on exit it puts the page back as it found it (tourSnapshot, tourRestore).
//
// Steps find their elements by name (`data-tour="<name>"`, set where the page draws them; tourFind). The shared
// chapters A to G (tourChapters) work with the places of the journey they run in (TOUR_CONTEXT); a chapter seen before
// is left out or offered for skipping (tourOffer). `?tutorial=chapter:D[:journey]` runs chapters on their own.
// The four journeys (tourJourney) are those chapters plus their own steps; the friends journey's account steps explain
// in a card without a hole while nobody is signed in, and come back after signing in (tourSignIn, tourResume).

/** Space around the spotlit element (px), and the hole's corner radius. */
const TOUR_PAD = 6;
const TOUR_RADIUS = 12;
/** The spotlight glides to a new target this long (jumps with reduced motion). */
const TOUR_GLIDE_MS = 250;
/** How long a step waits for its target (`ready`) before it shows its fallback or is skipped. */
const TOUR_READY_MS = 4000;
/** How long after a step shows its element is scrolled back into view when the view moves it out (still drawing). */
const TOUR_REVEAL_MS = 1500;
/** A "tap" step moves on this long after its element was clicked (and the next frame): the page reacts first. */
const TOUR_TAP_MS = 120;
/** After a flight to another campus, the ring comes back once the map has been still this long. */
const TOUR_STILL_MS = 300;
/** The card's gap to the hole and to the window's edges (px). */
const TOUR_GAP = 12;
const TOUR_REDUCED = matchMedia("(prefers-reduced-motion: reduce)");

/** The journeys' names: the progress line's and the welcome screen's. */
const TOUR_NAMES = { friends: "Friends", study: "Study", meet: "Meet", food: "Food", map: "Map", cred: "Street cred" };
const TOUR_TITLES = {
  friends: "Connect with my friends on campus",
  study: "Find places to study",
  meet: "Find a room to meet with my team",
  food: "Look through food options",
  map: "Navigate the campus",
  cred: "Earn street cred",
};
const TOUR_CLOSING = { friends: "That's it for friends.", study: "That's it for studying.", meet: "That's it for meeting.", food: "That's it for food.", map: "That's it for the map.", cred: "That's every way to earn street cred." };

/** The chapters' names, for the skip prompt ("You've seen Place details already."). */
const TOUR_CHAPTER_NAMES = { A: "Map and sheet", B: "Search", C: "Time and filters", D: "Place details", E: "Occupancy reports", F: "Stars and You", G: "Account" };

/**
 * What a journey's chapters work with: the tab, the kind of place D to F open (the list's first suitable row, a
 * `first-*` target the list marks while drawing it) and the example query B types.
 */
const TOUR_CONTEXT = {
  friends: { tab: "study", first: "first-space", kind: "space", query: "library" },
  study: { tab: "study", first: "first-space", kind: "space", query: "library" },
  meet: { tab: "rooms", first: "first-room", kind: "room", query: "seminar room" },
  food: { tab: "mensa", first: "first-mensa", kind: "mensa", query: "cheap vegan" },
  map: { tab: "study", first: "first-space", kind: "space", query: "library" },
  cred: { tab: "study", first: "first-space", kind: "space", query: "library" },
};

/** The first element named `name` (`data-tour`, set where the page draws it) that is shown, or null. */
const tourFind = (name) => [...document.querySelectorAll(`[data-tour="${name}"]`)].find((n) => n.getClientRects().length) ?? null;

// A step's target (the blue ring) and context (the part around it without fog) are an element, several elements (a
// row of buttons) or a box in window pixels ({ x, y, w, h }: the map's visible part).
const tourList = (t) => (t == null ? [] : Array.isArray(t) ? t : [t]);
const tourElements = (t) => tourList(t).filter((n) => n instanceof Element);
/** Still on the page (a box always is): else the step asks for its target again (the list was drawn again). */
const tourConnected = (t) => tourList(t).length > 0 && tourElements(t).every((n) => n.isConnected);
const tourHas = (t, node) => tourElements(t).some((n) => n.contains(node));

/** The map's visible part in window pixels: between the top bar and the sheet on phones, all of it on wide windows. */
function tourMapBox() {
  const v = document.getElementById("map-view").getBoundingClientRect();
  if (!v.width || !v.height) return null;
  const b = visibleBox();
  return { x: v.left + b.x0, y: v.top + b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
}

/** The building label nearest the middle of the map's visible part (not a mensa's or a microwave's), or null. */
function tourMapLabel() {
  const box = tourMapBox();
  if (!box) return null;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let best = null;
  let bestD = Infinity;
  for (const n of document.querySelectorAll("#map-labels .map-label[data-code]")) {
    if (n.dataset.place !== undefined || n.dataset.microwave !== undefined || n.classList.contains("dim")) continue;
    const r = n.getBoundingClientRect();
    if (!r.width || r.left < box.x + 8 || r.right > box.x + box.w - 8 || r.top < box.y + 40 || r.bottom > box.y + box.h - 8) continue;
    const d = (r.left + r.width / 2 - cx) ** 2 + (r.top + r.height / 2 - cy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/**
 * An example friend's bubble over a building near the middle of the map, for the friends steps when no real bubble
 * shows (nobody signed in, or no friend checked in). Drawn by the tour only: nothing is stored or sent, and it can't
 * be clicked. Placed every frame (tourTick), removed with the step.
 */
function tourDemoBubble() {
  if (tourState.demo?.isConnected) return tourState.demo;
  const node = el("div", { class: "friend-bubble tour-demo", "aria-hidden": "true" }, bubble({ initials: "AB", bg: "#ffd166", fg: "#010057" }));
  document.getElementById("map-friends").append(node);
  tourState.demo = node;
  tourState.demoCode = null;
  tourPlaceDemo();
  return node;
}

function tourPlaceDemo() {
  const node = tourState.demo;
  if (!node?.isConnected) return;
  let label = tourState.demoCode ? document.querySelector(`#map-labels .map-label[data-code="${CSS.escape(tourState.demoCode)}"]:not([data-place]):not([data-microwave])`) : null;
  if (!label?.getClientRects().length) {
    label = tourMapLabel();
    tourState.demoCode = label?.dataset.code ?? null;
  }
  // Hidden like real bubbles: with the friends button off (signed in), and while the map flies to another campus.
  node.hidden = !label || (accountReady() && !friendsMap.layer) || tourMapFlying();
  if (node.hidden) return;
  const v = document.getElementById("map-view").getBoundingClientRect();
  const r = label.getBoundingClientRect();
  node.style.setProperty("transform", `translate(${Math.round(r.left + r.width / 2 - v.left)}px, ${Math.round(r.top - v.top - 4)}px) translate(-50%, -100%)`);
}

/** The map flies to another campus (map.js adds "flying" for the flight). */
const tourMapFlying = () => document.getElementById("map-view").classList.contains("flying");

function tourDropDemo() {
  tourState.demo?.remove();
  tourState.demo = null;
  tourState.demoCode = null;
}

/**
 * A real bubble with a friend in it (friends.js marks the first such one, else your own: that one doesn't count), or
 * null; tourBubble: else the example (tourDemoBubble).
 */
function tourFriendBubble() {
  const n = tourFind("friend-bubbles");
  return n && !n.getAttribute("aria-label")?.startsWith("You in") ? n : null;
}
const tourBubble = () => tourFriendBubble() ?? tourDemoBubble();

/** Row `n` (1 to 3) of the detail view's actions (places.js actionGrid's data-row), or null when it has none. */
function tourActionRow(n) {
  const grid = tourFind("place-actions");
  const cells = grid ? [...grid.querySelectorAll(`.action-cell[data-row="${n}"]`)].filter((c) => c.getClientRects().length) : [];
  return cells.length ? cells : null;
}
const tourPhone = () => layout() === "full";
/** A step's title or body: a string, or a function giving one when the step shows. */
const tourText = (v) => (typeof v === "function" ? v() : v);

/** Wait (every frame) until `ok()` is true, at most `ms`. */
function tourUntil(ok, ms = 1500) {
  const until = performance.now() + ms;
  return new Promise((resolve) => {
    const check = () => {
      let done = false;
      try {
        done = !!ok();
      } catch { /* not yet */ }
      if (done || performance.now() > until) return resolve(done);
      requestAnimationFrame(check);
    };
    check();
  });
}

/** The next frame: after the click that set off a step has gone through (the account menu closes on any click). */
const tourFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

/**
 * Back to a list: the dish's window, the menu panel, the search, a detail view, the pickers and the filters closed
 * (and the check-in view's query the tour typed taken out); then the tab `tab`, if given.
 */
async function tourToList(tab = null) {
  const photo = document.getElementById("photo-box");
  if (photo.open) photo.close();
  if (menuPanel().open) {
    closeMenu();
    await tourUntil(() => !menuPanel().open);
  }
  if (tourState.checkinTyped) {
    tourState.checkinTyped = false;
    checkinView.query = "";
  }
  if (searchOpen()) {
    closeSearch();
    await tourUntil(() => !searchOpen());
  }
  if (placesView.current) {
    tourLeaveView();
    await tourUntil(() => !placesView.current);
  }
  openPicker(null);
  closeFilters();
  if (tab && state.mode !== tab) selectMode(tab);
}

/** The tab `tab`'s list is drawn (its answer is in), so a missing `first-*` means there's no suitable row. */
function tourListed(tab) {
  if (state.mode !== tab) return false;
  if (tab === "rooms") return !!mapView.data?.rooms && !document.getElementById("results").hidden;
  return state.spaces?.area === state.area;
}

/** The phone's sheet at `pos` (peek, half, full); nothing on wide windows. */
function tourSheet(pos) {
  if (tourPhone() && sheet.current() !== pos) sheet.snap(pos);
}

/**
 * A room's or space's view open for chapters D to F: the one open, else the tab's first suitable row (its
 * `first-*`), else the list's first row of a room or space, as if clicked.
 */
async function tourEnsurePlace(ctx) {
  const p = placesView.current;
  if (p && (p.kind === "room" || p.kind === "space")) return;
  await tourToList(ctx.tab);
  const anyRow = () => [...document.querySelectorAll("#results li[data-room] .row-open, #space-results li[data-space] .row-open")].find((n) => n.getClientRects().length);
  await tourUntil(() => tourFind(ctx.first) || anyRow(), TOUR_READY_MS);
  const row = tourFind(ctx.first) ?? anyRow();
  if (!row) return;
  tourState.target = null; // this click isn't a "tap" on the step shown before
  row.click();
  await tourUntil(() => tourFind("place-status"), TOUR_READY_MS);
}

/** Type `text` into the search field, a letter at a time (at once with reduced motion), as the page sees typing. */
async function tourType(text) {
  const input = document.getElementById("search-input");
  const steps = TOUR_REDUCED.matches ? [text] : [...text].map((_, i) => text.slice(0, i + 1));
  for (const value of steps) {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (steps.length > 1) await new Promise((r) => setTimeout(r, 45));
  }
}

/** "2026-11-20": tomorrow, or the last day the pickers offer when that's earlier. */
function tourTomorrow() {
  const d = addDaysTo(isoDate(new Date()), 1);
  return state.dates?.max && d > state.dates.max ? state.dates.max : d;
}

/** The starred row in the You tab of the place F1 starred (the li's data-room or data-space, as the list draws it). */
function tourStarredRow() {
  const s = tourState.starred;
  if (!s) return null;
  const li = document.querySelector(`#you-places li[data-${s.kind === "room" ? "room" : "space"}="${CSS.escape(s.id)}"]`);
  return li?.getClientRects().length ? li : null;
}

/**
 * The shared chapters' steps by id (section 9), for `journey`'s places (TOUR_CONTEXT). A journey always gets the
 * same steps, so a step's index (the address's `step`) means the same each time; steps that don't apply at the
 * moment (`only`) are passed over when they come.
 */
function tourChapters(journey) {
  const ctx = TOUR_CONTEXT[journey] ?? TOUR_CONTEXT.study;
  const room = ctx.kind === "room";
  const placeBefore = () => tourEnsurePlace(ctx);
  const PLACE_WORD = { room: "room", space: "place", mensa: "mensa" };
  const PLACES_WORD = { room: "rooms", space: "places", mensa: "mensas" };
  const OPEN_BODY = {
    space: "Click a study space to see everything about it.",
    room: "Click a room to see its day and its bookings.",
    mensa: "Click a mensa for its meal times, menus and more.",
  };
  return {
    A: [
      {
        id: "a-frooms",
        title: "This is frooms.",
        body: () => (tourPhone() ? "The map shows the campus, the sheet below lists what's free and open." : "The map shows the campus, the list on the left what's free and open."),
        target: () => tourFind(tourPhone() ? "sheet-handle" : "sheet"),
        advance: "next",
        before: async () => {
          await tourToList();
          tourSheet("half");
        },
      },
      {
        id: "a-sheet",
        title: "Pull the sheet",
        body: "Drag it up for the list, down for the map.",
        target: () => tourFind("sheet-handle"),
        advance: "next",
        only: tourPhone,
      },
      { id: "a-tabs", title: "Four tabs", body: "Study, Meet, Eat and You. Each answers one question.", target: () => tourFind("tabs"), advance: "next" },
      { id: "a-campus", title: "Your campus", body: "Switch between ETH's and UZH's campuses here.", target: () => tourFind("campus"), advance: "next" },
    ],
    B: [
      {
        id: "b-search",
        title: "Search anything",
        body: "Room codes like HG E 33, names, or things like library or cheap vegan.",
        target: () => tourFind("search"),
        advance: "tap",
        before: async () => {
          if (searchOpen()) {
            closeSearch();
            await tourUntil(() => !searchOpen());
          }
        },
      },
      {
        id: "b-try",
        title: "Try it",
        body: "Places come first. Go to results open the right tab with its filters.",
        target: () => tourFind("search-view"),
        advance: "next",
        before: async () => {
          if (!searchOpen()) openSearch();
          await tourType(ctx.query);
        },
        ready: () => searchIndex || searchLoad.failed,
      },
      {
        id: "b-close",
        title: "Back to the list",
        body: "Back closes the search.",
        target: () => tourFind("search-back"),
        advance: "tap",
        before: () => {
          if (!searchOpen()) openSearch();
        },
      },
    ],
    C: [
      {
        id: "c-time",
        title: "Now, or later",
        body: "frooms shows what's free now. Pick a date and time to plan ahead.",
        target: () => tourFind("time"),
        advance: "tap",
        before: async () => {
          await tourToList(ctx.tab);
          openFilters();
        },
      },
      // Meet only: the tour picks tomorrow at 14:00, as the calendar and the wheel would.
      ...(room ? [{
        id: "c-later",
        title: "Tomorrow at 14:00",
        body: "The list now shows rooms free tomorrow at 14:00.",
        target: () => tourFind("first-room"),
        advance: "next",
        before: () => {
          openPicker(null);
          pickDate(tourTomorrow());
          pickTime("14:00");
          closeFilters();
        },
        ready: () => document.querySelector("#g-long .title")?.textContent.includes("at 14:00"),
        fallback: { title: "Tomorrow at 14:00", body: "No room is free for that long then. Another time or fewer filters find more." },
      }] : []),
      {
        id: "c-buildings",
        title: "Buildings",
        body: "Pick one or more buildings, or star the ones you use.",
        target: () => tourFind("buildings"),
        advance: "next",
        before: () => {
          openPicker(null);
          if (document.getElementById("sheet-filters").hidden) openFilters();
        },
      },
    ],
    D: [
      {
        id: "d-open",
        title: "Open a place",
        body: OPEN_BODY[ctx.kind],
        target: () => tourFind(ctx.first),
        advance: "tap",
        before: async () => {
          await tourToList(ctx.tab);
          tourSheet("half");
        },
        ready: () => tourFind(ctx.first) || tourListed(ctx.tab),
        fallback: ctx.kind === "mensa"
          ? { title: "Open a mensa", body: () => `Mensas are closed ${state.now ? "now" : "then"}. A click on a card still opens its times and menus.` }
          : { title: "Open a place", body: () => `${room ? "No room is free for long enough" : "Nothing is open"} ${state.now ? "now" : "then"}. A click on any row opens its details.` },
      },
      { id: "d-glance", title: "At a glance", body: "Whether it's free or open, and until when.", target: () => tourFind("place-status"), advance: "next", before: placeBefore, ready: () => tourFind("place-status") },
      ...(room ? [{
        id: "d-day",
        title: "The day",
        body: "Green is free, red booked, grey closed. The navy line is your chosen time.",
        target: () => tourFind("schedule-bar"),
        advance: "next",
        before: placeBefore,
      }] : []),
      // What you can do: the buttons row by row (Raffaele's wording), the whole grid without fog around the row.
      {
        id: "d-actions",
        title: "Get there",
        body: `Find the ${PLACE_WORD[ctx.kind]}.`,
        target: () => tourActionRow(1),
        context: () => tourFind("place-actions"),
        advance: "next",
        before: placeBefore,
        only: () => !!tourActionRow(1),
      },
      {
        id: "d-help",
        title: "Help us out",
        body: `Help us out! Report how full ${PLACES_WORD[ctx.kind]} are and report problems to us.`,
        target: () => tourActionRow(2),
        context: () => tourFind("place-actions"),
        advance: "next",
        before: placeBefore,
        only: () => !!tourActionRow(2),
      },
      {
        id: "d-share",
        title: "Friends and favourites",
        body: `Check in and show your friends where you are, send it to them directly and star your favourite ${PLACES_WORD[ctx.kind]}.`,
        target: () => tourActionRow(3),
        context: () => tourFind("place-actions"),
        advance: "next",
        before: placeBefore,
        only: () => !!tourActionRow(3),
      },
    ],
    E: [
      { id: "e-reports", title: "How full is it?", body: "The figures show what people reported in the past 2 hours.", target: () => tourFind("report-log"), advance: "next", before: placeBefore },
      // Spaces with a sensor: their usual day.
      ...(room ? [] : [{
        id: "e-usual",
        title: "Usually this full",
        body: "The day's usual curve helps you pick a time.",
        target: () => tourFind("usual"),
        advance: "next",
        before: placeBefore,
        only: () => !!tourFind("usual"),
      }]),
      {
        id: "e-report",
        title: "Report it",
        body: "When you're there, tell others how full it is.",
        target: () => tourFind("report"),
        context: () => tourFind("place-actions"),
        advance: "tap",
        before: async () => {
          await placeBefore();
          // Closed again, so the click opens it (a report of yours in the past 2 hours keeps it open).
          if (placesView.reportPanel === "report" && tourFind("report")) {
            placesView.reportPanel = null;
            await renderPlaceView({ reuse: true });
          }
        },
        fallback: { title: "Report it", body: "While a place is open, Report occupancy here tells others how full it is right now." },
      },
      {
        id: "e-choices",
        title: "Free, crowded or full",
        body: () => (tourFind("report-choices")?.querySelector("input[type=range]")
          ? "Slide to how full it is, then Send. In the tutorial nothing is sent."
          : "One click sends it, counted for 2 hours. In the tutorial nothing is sent."),
        target: () => tourFind("report-choices"),
        advance: "next",
        ready: () => tourFind("report-choices") || !tourFind("report"),
        only: () => !!tourFind("report-choices"),
      },
    ],
    F: [
      {
        id: "f-star",
        title: "Star it",
        body: "Starred places come first everywhere. Click the star again to remove it.",
        target: () => tourFind("star"),
        advance: "tap",
        before: async () => {
          await placeBefore();
          const p = placesView.current;
          tourState.starred = p && (p.kind === "room" || p.kind === "space") ? { kind: p.kind, id: p.id } : null;
        },
      },
      { id: "f-you", title: "You", body: "Click You for your starred places.", target: () => tourFind("tab-you"), advance: "tap" },
      {
        id: "f-row",
        title: "Your places",
        body: "Your starred places, with their status now.",
        target: tourStarredRow,
        advance: "next",
        before: async () => {
          if (placesView.current) await tourToList();
          if (state.mode !== "you") selectMode("you");
          tourSheet("half");
        },
        ready: tourStarredRow,
        fallback: { title: "Your places", body: "Starred places show here, with their status now." },
      },
    ],
    G: [
      {
        id: "g-account",
        title: "Optional account",
        body: "Sign in with your ETH or UZH edu-ID for friends, check-ins and Street cred. Everything else works without.",
        target: () => tourFind("account"),
        advance: "next",
        before: () => tourToList(),
        // Signed out (where sign-in works): Sign in with edu-ID, or go on without (plan 4.6).
        actions: (i) => (accountReady() || account.status !== "out" ? null : [
          ["Continue without", () => {
            tourState.signedOut = true;
            tourDone(i);
          }],
          ["Sign in with edu-ID", () => tourSignIn(i + 1), true],
        ]),
      },
    ],
  };
}

/**
 * Sign in from the tour: the address says where to go on (`/?tutorial=<journey>&step=<next>`, read back by
 * app.js tourFromUrl after the round trip), then SWITCH edu-ID's page (account.js loginUrl keeps the query).
 */
function tourSignIn(next) {
  const q = tourState.chapters ? `tutorial=chapter:${tourState.chapters.join(",")}:${tourState.journey}` : `tutorial=${tourState.journey}&step=${next}`;
  history.replaceState(history.state, "", `/?${q}`);
  location.href = loginUrl();
}

// --- the journeys' own steps (section 9) ---

/** The account menu open, as its button would open it (signed in with a profile only). */
async function tourAccountMenu() {
  await tourToList();
  await tourFrame();
  if (!accountReady()) return;
  closeCampusMenu();
  renderAccountMenu();
  document.getElementById("account-menu").hidden = false;
  document.getElementById("account").setAttribute("aria-expanded", "true");
}

/** The Friends view open (from the list, as the menu's Friends opens it). */
async function tourFriendsView() {
  if (friendsShown() && placesView.current.id === "friends") return;
  await tourToList();
  openAccountView("friends", document.getElementById("account"));
  await tourUntil(() => tourFind("friends-search"), TOUR_READY_MS);
}

/**
 * The Check in view open with a place to pick: the places around you, or, without a position (nothing to list), the
 * journey's example query typed into its search (taken out again by tourToList).
 */
async function tourCheckinView(query) {
  if (!checkinShown()) {
    await tourToList();
    openAccountView("checkin");
  }
  await tourUntil(() => tourFind("checkin-place") || document.querySelector("#checkin-places .near-privacy"), TOUR_READY_MS);
  if (tourFind("checkin-place")) return;
  const input = document.getElementById("checkin-search");
  if (!input) return;
  tourState.checkinTyped = true;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The Street cred view open (as the account menu's frooms Street cred opens it), with "How to earn" folded out if `how`. */
async function tourCredView(how = false) {
  if (!credShown("")) {
    await tourToList();
    openAccountView("cred", document.getElementById("account"));
  }
  await tourUntil(() => tourFind("cred-totals"), TOUR_READY_MS);
  const d = tourFind("cred-how");
  if (how && d && !d.open) d.open = true;
}

/** The menu panel open at Compare menus (or Find your meal, `view` "search"), as the Eat tab's buttons open it. */
async function tourMenuPanel(view = "compare") {
  const panel = menuPanel();
  if (panel.open && menuView.view === view) return;
  await tourToList("mensa");
  tourState.target = null; // not a "tap" on the step shown before
  if (view === "search") openMenu(null, document.getElementById("meal-search-btn"), null, { view: "search" });
  else openMenu(null, document.getElementById("compare-btn"));
}

/** A dish's window open over the comparison: the first dish's, as if clicked. */
async function tourDishBox() {
  const box = document.getElementById("photo-box");
  if (box.open) return;
  await tourMenuPanel();
  await tourUntil(() => tourFind("dish"), TOUR_READY_MS);
  const dish = tourFind("dish");
  if (!dish) return;
  tourState.target = null;
  dish.click();
}

/** The map's filter `key` off, so the step's click turns it on (the tour puts the filter back at the end). */
function tourLayerOff(key) {
  if (state.mapLayer !== key) return;
  state.mapLayer = null;
  renderMapLayers();
  fillLabels();
  scheduleDraw();
}

/**
 * Each journey's chapter ids and own steps, in order (section 9; lib.js tourPlan lays them out). A step is
 * { id, title, body, target, context, advance, doneWhen, demo, before, ready, fallback, only, actions, keepMenus, signedIn, explain } (plan 4.4):
 * `advance` may be a function (Check in is a "next" step while you're checked in); `signedIn` steps show `explain` as
 * a card without a hole while nobody is signed in (or are passed without one); `keepMenus` keeps an invite menu open
 * (the runner closes them before every other step).
 */
function tourJourney(journey) {
  const ctx = TOUR_CONTEXT[journey];
  if (!ctx) return null;
  const placeBefore = () => tourEnsurePlace(ctx);
  const toTab = (tab = null) => async () => {
    await tourToList(tab);
    tourSheet("half");
  };
  const toMap = async () => {
    await tourToList();
    tourSheet("peek");
  };
  if (journey === "friends") {
    return ["A", "G",
      {
        id: "fr-menu",
        signedIn: true,
        title: "Your friends",
        body: "Friends lives in this menu. Click it.",
        target: () => tourFind("menu-friends"),
        context: () => document.getElementById("account-menu"),
        advance: "tap",
        before: tourAccountMenu,
        ready: () => tourFind("menu-friends"),
        explain: { title: "Your friends", body: "Signed in, the account menu at the top has Friends: your requests, your friends and people to add." },
      },
      {
        id: "fr-find",
        signedIn: true,
        title: "Find people",
        body: "Search by name, username or email.",
        target: () => tourFind("friends-search"),
        advance: "next",
        before: tourFriendsView,
        ready: () => tourFind("friends-search"),
        explain: { title: "Find people", body: "Friends finds people by name, username or a whole email address." },
      },
      {
        id: "fr-link",
        signedIn: true,
        title: "Your link",
        body: "Share your add-a-friend link. Anyone who opens it can add you.",
        target: () => tourFind("friend-link"),
        advance: "next",
        before: tourFriendsView,
        ready: () => tourFind("friend-link") || friendsView.error,
        explain: { title: "Your link", body: "Every account has an add-a-friend link to share. Anyone who opens it can add you." },
      },
      {
        id: "fr-checkin",
        signedIn: true,
        title: "Check in",
        body: () => (myCheckin() ? "You're checked in. This button checks you out again." : "Let friends know where you are. Click it."),
        target: () => tourFind("checkin-button"),
        advance: () => (myCheckin() ? "next" : "tap"),
        before: toTab(),
        explain: { title: "Check in", body: "Signed in, the round button checks you in where you are, so friends can join you." },
      },
      {
        id: "fr-place",
        signedIn: true,
        title: "Pick a place",
        body: "Click a place to check in. In the tutorial, this doesn't send anything.",
        target: () => tourFind("checkin-place"),
        advance: "next",
        before: () => tourCheckinView(ctx.query),
        ready: () => tourFind("checkin-place"),
        explain: { title: "Pick a place", body: "The places around you come first, or search for one. Friends see the place, never your position." },
      },
      {
        id: "fr-layer",
        signedIn: true,
        title: "Friends on the map",
        body: "Bubbles show where your friends are checked in. This button shows or hides them.",
        target: () => tourFind("layer-friends"),
        context: tourMapBox,
        advance: "next",
        demo: true,
        before: async () => {
          await toMap();
          if (!tourFriendBubble()) tourDemoBubble();
        },
        explain: { title: "Friends on the map", body: "Signed in, bubbles on the map show where your friends are checked in." },
      },
      {
        // Signed out too: an example bubble shows what friends look like on the map (tourDemoBubble).
        id: "fr-bubbles",
        title: "Your friends' bubbles",
        body: () => (tourFriendBubble() ? "A click on one shows who's there and since when."
          : accountReady() ? "Like this one: an example, as nobody is checked in now. A click on a real one shows who's there."
            : "Signed in, your friends show like this one, an example. A click on a real one shows who's there."),
        target: tourBubble,
        context: tourMapBox,
        advance: "next",
        demo: true,
        before: toMap,
        ready: () => tourFriendBubble() || tourMapLabel(),
        fallback: { title: "Your friends' bubbles", body: "Bubbles above the buildings show where your friends are checked in." },
      },
      {
        id: "fr-here",
        signedIn: true,
        title: "Friends here now",
        body: "In You: who is checked in where, the nearest first.",
        target: () => tourFind("friends-here"),
        advance: "next",
        before: async () => {
          await tourToList("you");
          tourSheet("half");
        },
        ready: () => tourFind("friends-here"),
        explain: { title: "Friends here now", body: "Signed in, the You tab lists the friends checked in right now, the nearest first." },
      },
      {
        id: "fr-invite",
        title: "Invite",
        body: "Send a place and time to friends on WhatsApp or as a link.",
        target: () => tourFind("invite"),
        context: () => tourFind("place-actions"),
        advance: "next",
        before: placeBefore,
        fallback: { title: "Invite", body: "While a place is open, Invite sends it and a time to friends on WhatsApp or as a link." },
      },
      {
        id: "fr-cred",
        signedIn: true,
        title: "Street cred",
        body: "Checking in, reporting and adding friends earn points and unlock bubble styles.",
        target: () => tourFind("menu-cred"),
        context: () => document.getElementById("account-menu"),
        advance: "next",
        before: tourAccountMenu,
        ready: () => tourFind("menu-cred"),
        explain: { title: "Street cred", body: "Signed in, checking in, reporting and adding friends earn points and unlock bubble styles." },
      },
    ];
  }
  if (journey === "cred") {
    // Every action that earns street cred (worker/cred.ts POINTS and CAPS), where it happens on the page.
    return ["G",
      {
        id: "cr-menu",
        signedIn: true,
        title: "Street cred",
        body: "Points for what helps others on frooms. Click it.",
        target: () => tourFind("menu-cred"),
        context: () => document.getElementById("account-menu"),
        advance: "tap",
        before: tourAccountMenu,
        ready: () => tourFind("menu-cred"),
        explain: { title: "Street cred", body: "Signed in, you earn points for what helps others. The account menu shows your level." },
      },
      {
        id: "cr-level",
        signedIn: true,
        title: "Your level",
        body: "Your points of the last 30 days and of all time. Each level unlocks a new look for your bubble.",
        target: () => tourFind("cred-totals"),
        advance: "next",
        before: () => tourCredView(),
        ready: () => tourFind("cred-totals"),
        explain: { title: "Levels", body: "Level 2 comes at 100 points. Each level unlocks a new look for your bubble: gradients, then bronze, silver and gold." },
      },
      {
        id: "cr-friend",
        signedIn: true,
        title: "Add friends: +25",
        body: "Becoming friends gives you both 25. Removing a friend takes it back from both of you.",
        target: () => tourFind("friends-search"),
        advance: "next",
        before: tourFriendsView,
        ready: () => tourFind("friends-search"),
        explain: { title: "Add friends: +25", body: "Becoming friends gives you both 25. Removing a friend takes it back from both of you." },
      },
      {
        id: "cr-checkin",
        signedIn: true,
        title: "Check in: +5",
        body: "Up to 4 a day. Checking in at the same place again within 2 hours earns nothing.",
        target: () => tourFind("checkin-button"),
        advance: "next",
        before: toTab(),
        explain: { title: "Check in: +5", body: "Each check-in earns 5, up to 4 a day; the same place again within 2 hours earns nothing." },
      },
      {
        id: "cr-report",
        title: "Report how full: +3",
        body: "Tell others how full a place is, up to 10 times a day. In the tutorial nothing is sent.",
        target: () => tourFind("report"),
        context: () => tourFind("place-actions"),
        advance: "next",
        before: placeBefore,
        fallback: { title: "Report how full: +3", body: "While a place is open, Report occupancy earns 3, up to 10 times a day." },
      },
      {
        id: "cr-votes",
        title: "Rate reports: +1",
        body: "In the Report log, 👍 or 👎 someone's report: +1 each, up to 20 a day. Every 👍 your own reports get is +1 too.",
        target: () => tourFind("report-log"),
        advance: "next",
        before: placeBefore,
        fallback: { title: "Rate reports: +1", body: "A place's Report log lets you rate others' reports (+1 each, up to 20 a day); each 👍 on yours is +1." },
      },
      {
        id: "cr-invite",
        title: "Invite: +3",
        body: "Send a place on WhatsApp or as a link, up to 5 times a day.",
        target: () => tourFind("invite"),
        context: () => tourFind("place-actions"),
        advance: "next",
        before: placeBefore,
        fallback: { title: "Invite: +3", body: "While a place is open, Invite earns 3 each time, up to 5 a day." },
      },
      {
        id: "cr-problem",
        title: "Report a problem: +5",
        body: "Wrong opening hours, a broken room, missing data: up to 3 a day.",
        target: () => tourFind("problem"),
        context: () => tourFind("place-actions"),
        advance: "next",
        before: placeBefore,
        fallback: { title: "Report a problem: +5", body: "Report a problem on any place earns 5, up to 3 a day." },
      },
      {
        id: "cr-meal",
        title: "Rate a dish: +3",
        body: "Rate taste, portion and value of a dish, up to 5 a day.",
        target: () => tourFind("rating"),
        advance: "next",
        before: tourDishBox,
        ready: () => tourFind("rating") || !ratingsShown() || !document.getElementById("photo-box").open,
        fallback: { title: "Rate a dish: +3", body: "Click a dish in the menus to rate it: 3 each, up to 5 a day." },
      },
      {
        id: "cr-feedback",
        title: "Send feedback: +10",
        body: "An idea or anything else for frooms, once a day.",
        target: () => tourFind("feedback"),
        advance: "next",
        before: async () => {
          await tourToList("you");
          tourSheet("full");
          await tourFrame();
          tourFind("feedback")?.scrollIntoView({ block: "center" });
        },
        fallback: { title: "Send feedback: +10", body: "Send feedback, at the end of the You tab, earns 10 once a day." },
      },
      {
        id: "cr-how",
        signedIn: true,
        title: "All of it in one place",
        body: "Every way to earn, with its daily limit. Only what you do signed in counts.",
        target: () => tourFind("cred-how"),
        advance: "next",
        before: () => tourCredView(true),
        ready: () => tourFind("cred-how"),
        explain: { title: "All of it in one place", body: "Signed in, frooms Street cred in the account menu lists every way to earn and its daily limit." },
      },
    ];
  }
  if (journey === "study") {
    return ["A",
      { id: "st-tab", title: "Study", body: "Libraries and study spaces, open now. Click Study.", target: () => tourFind("tab-study"), advance: "tap", before: toTab() },
      {
        id: "st-layer",
        title: "On the map",
        body: "Click to show each building's open study spaces.",
        target: () => tourFind("layer-study"),
        context: tourMapBox,
        advance: "tap",
        before: async () => {
          await toMap();
          tourLayerOff("study");
        },
      },
      {
        id: "st-near",
        title: "Near you",
        body: "Shows the nearest buildings with free spaces. Your position stays on your device.",
        target: () => tourFind("locate"),
        context: tourMapBox,
        advance: "next",
        before: toMap,
      },
      {
        id: "st-full",
        title: "How full",
        body: "The bar is the sensor, the figures are people's reports.",
        target: () => tourFind("first-space"),
        advance: "next",
        before: toTab("study"),
        ready: () => tourFind("first-space") || tourListed("study"),
        fallback: { title: "How full", body: () => `Nothing is open ${state.now ? "now" : "then"}. Open spaces show a bar from the sensor and figures from people's reports.` },
      },
      "D", "E",
      {
        id: "st-rooms",
        title: "Rooms to study in",
        body: "Computer rooms, seminar rooms and lecture halls free for an hour or more.",
        target: () => tourFind("first-study-room"),
        advance: "next",
        before: toTab("study"),
        ready: () => tourFind("first-study-room") || (tourListed("study") && studyRoomsNow() !== undefined),
        fallback: { title: "Rooms to study in", body: "Below the study spaces, Study lists rooms free for an hour or more. None is free that long right now." },
      },
      "B", "F"];
  }
  if (journey === "meet") {
    return ["A",
      { id: "me-tab", title: "Meet", body: "Seminar rooms and lecture halls free for as long as you need. Click Meet.", target: () => tourFind("tab-meet"), advance: "tap", before: toTab() },
      "C",
      {
        id: "me-filters",
        title: "Room types and equipment",
        body: "Add meeting rooms, or only rooms with a screen or projector.",
        target: () => tourFind("more-filters"),
        context: () => document.getElementById("sheet-filters"),
        advance: "next",
        before: async () => {
          await tourToList("rooms");
          openFilters();
          document.getElementById("filters").open = true;
        },
      },
      {
        id: "me-day",
        title: "The day at a glance",
        body: "Each row's bar is the room's day: green free, red booked.",
        target: () => tourFind("first-room")?.querySelector(".sched") ?? null,
        advance: "next",
        before: async () => {
          document.getElementById("filters").open = false;
          await toTab("rooms")();
        },
        ready: () => tourFind("first-room") || tourListed("rooms"),
        fallback: { title: "The day at a glance", body: "No room is free for long enough then. Each row's bar shows the room's day: green free, red booked." },
      },
      "D", "E",
      {
        id: "me-invite",
        title: "Invite your team",
        body: "Sends the room and the time you picked. Click it.",
        target: () => tourFind("invite"),
        context: () => tourFind("place-actions"),
        advance: "tap",
        before: placeBefore,
        fallback: { title: "Invite your team", body: "While a room is free, Invite sends it and the time you picked." },
      },
      {
        id: "me-send",
        title: "WhatsApp or a link",
        body: "Pick how to send it. In the tutorial nothing is sent.",
        target: () => tourFind("invite-menu"),
        advance: "next",
        keepMenus: true,
        before: async () => {
          await placeBefore();
          const button = tourFind("invite")?.querySelector("button.invite");
          if (button && !tourFind("invite-menu")) {
            tourState.target = null;
            button.click();
          }
        },
        only: () => !!tourFind("invite"),
      },
      "B", "F"];
  }
  if (journey === "food") {
    return ["A",
      { id: "fo-tab", title: "Eat", body: "Mensas and cafeterias, nearest first. Click Eat.", target: () => tourFind("tab-eat"), advance: "tap", before: toTab() },
      {
        id: "fo-card",
        title: "A mensa card",
        body: "When it serves, its flagship dish and the price for you.",
        target: () => tourFind("first-mensa"),
        advance: "next",
        before: toTab("mensa"),
        ready: () => tourFind("first-mensa") || tourListed("mensa"),
        fallback: { title: "A mensa card", body: () => `Mensas are closed ${state.now ? "now" : "then"}. During lunch a card says Lunch until 13:30, with its dish and price.` },
      },
      "D",
      {
        id: "fo-compare",
        title: "Compare menus",
        body: "Mensas side by side, for lunch or dinner. Click it.",
        target: () => tourFind("compare"),
        advance: "tap",
        before: toTab("mensa"),
        ready: () => tourFind("compare") || tourListed("mensa"),
        fallback: { title: "Compare menus", body: "Once the mensas publish their menus, Compare menus shows them side by side." },
      },
      {
        id: "fo-dish",
        title: "Pick a dish",
        body: "Click a dish for its photo and more.",
        target: () => tourFind("dish"),
        advance: "tap",
        before: () => tourMenuPanel(),
        ready: () => tourFind("dish"),
      },
      {
        id: "fo-box",
        title: "A dish",
        body: "Photo, values per 100 g, allergens, and at UZH its climate impact.",
        target: () => (document.getElementById("photo-box").open ? tourFind("dish-box") : null),
        advance: "next",
        before: tourDishBox,
        ready: () => document.getElementById("photo-box").open,
      },
      {
        id: "fo-rating",
        title: "Ratings",
        body: "Signed-in people rate taste, portion and value. The figure is the average.",
        target: () => tourFind("rating"),
        advance: "next",
        before: tourDishBox,
        ready: () => tourFind("rating") || !ratingsShown() || !document.getElementById("photo-box").open,
        only: () => !!tourFind("rating"),
      },
      {
        id: "fo-search",
        title: "Find your meal",
        body: "Every dish on campus, sorted your way. Click it.",
        target: () => tourFind("meal-search"),
        advance: "tap",
        before: toTab("mensa"),
        ready: () => tourFind("meal-search") || tourListed("mensa"),
      },
      {
        id: "fo-presets",
        title: "Presets",
        body: "Sort by price, protein or climate. Star a preset to see Your meal on every card.",
        target: () => tourFind("meal-presets"),
        advance: "next",
        before: () => tourMenuPanel("search"),
        ready: () => tourFind("meal-presets"),
      },
      {
        id: "fo-micro",
        title: "Microwaves",
        body: "Brought your own? The nearest microwaves.",
        target: () => tourFind("microwaves"),
        advance: "next",
        before: toTab("mensa"),
        ready: () => tourFind("microwaves") || tourListed("mensa"),
        only: () => !!tourFind("microwaves"),
      },
      "B", "F"];
  }
  if (journey === "map") {
    // Navigate the campus (added after the plan's four): the map without fog all along, the ring on what to use.
    const onMap = async () => {
      await toMap();
      await tourUntil(() => mapView.doc, TOUR_READY_MS);
    };
    return ["A",
      {
        id: "mp-pan",
        title: "Move around",
        body: () => (matchMedia("(pointer: coarse)").matches ? "Drag the map to move it, pinch to zoom." : "Drag the map to move it, scroll or pinch to zoom."),
        target: tourMapBox,
        advance: "next",
        before: onMap,
      },
      {
        id: "mp-zoom",
        title: "Zoom",
        body: "Or zoom with these buttons.",
        target: () => {
          const zoom = [document.getElementById("map-zoom-in"), document.getElementById("map-zoom-out")];
          return zoom.every((b) => b?.getClientRects().length) ? zoom : null;
        },
        context: tourMapBox,
        advance: "next",
        before: onMap,
      },
      {
        id: "mp-building",
        title: "Pick a building",
        body: () => (tourPhone() ? "Click a building to see what's free in it." : "Click a building to list only what's in it."),
        target: tourMapLabel,
        context: tourMapBox,
        advance: "tap",
        // The map takes the pointer on a press (map.js setPointerCapture), so the click names the map, not the label:
        // the step goes on once a building is picked, however.
        doneWhen: () => {
          // Wide windows filter the tab's list (Meet: state.buildings; Study, Eat: state.spaceBuildings), phones open a view.
          const picked = () => [state.buildings, state.spaceBuildings.study, state.spaceBuildings.mensa].map((b) => [...b].join(",")).join("|");
          const was = picked();
          const view = placesView.current;
          return () => picked() !== was || (placesView.current !== view && !!placesView.current && placesView.current.kind !== "account");
        },
        before: onMap,
        ready: tourMapLabel,
        fallback: { title: "Pick a building", body: "A click on a building's name shows what's free in it." },
      },
      {
        id: "mp-picked",
        title: "Its rooms and spaces",
        body: () => (tourPhone() ? "The sheet shows the building: its rooms, study spaces and mensas." : "The list shows only that building now. Click beside the buildings on the map to show all."),
        target: () => tourFind(tourPhone() ? "sheet-handle" : "sheet"),
        advance: "next",
        before: () => tourSheet("half"),
      },
      {
        id: "mp-fit",
        title: "The whole campus",
        body: "This button brings the whole campus back into view. Click it.",
        target: () => tourFind("map-fit"),
        context: tourMapBox,
        advance: "tap",
        before: async () => {
          await tourToList();
          await onMap();
          // Zoomed in first, so the button has something to do.
          if (mapView.scale < campusScale() * 2.2) {
            mapView.scale = clampScale(campusScale() * 2.6);
            clampCentre();
            scheduleDraw();
          }
        },
      },
      {
        id: "mp-campus",
        title: "Other campuses",
        body: "These buttons fly to the nearby campuses. The campus button at the top reaches all of them.",
        target: () => [...document.querySelectorAll("#map-links .map-link:not([hidden])")].filter((n) => n.getClientRects().length).slice(0, 2),
        context: tourMapBox,
        advance: "next",
        before: async () => {
          await onMap();
          // Zoomed in, the buttons hide (map.js placeLinks): the whole campus first, as the step before would.
          const links = () => [...document.querySelectorAll("#map-links .map-link:not([hidden])")].some((n) => n.getClientRects().length);
          if (!links()) {
            fitCampus();
            scheduleDraw();
            await tourUntil(links, 1500);
          }
        },
        only: () => [...document.querySelectorAll("#map-links .map-link:not([hidden])")].some((n) => n.getClientRects().length),
      },
      {
        id: "mp-layers",
        title: "What the map shows",
        body: "Study spaces, free rooms, mensas or cafeterias, one at a time. Click one to try.",
        target: () => document.getElementById("map-layers"),
        context: tourMapBox,
        advance: "tap",
        before: onMap,
      },
      {
        id: "mp-fold",
        title: "Fold the filters",
        body: () => (state.mapLayersOpen ? "This handle folds the filters to their icons, for more map. Click it." : "This handle opens the filters with their names again. Click it."),
        target: () => tourFind("map-layers-toggle"),
        context: tourMapBox,
        advance: "tap",
        // Dragged sideways instead of clicked: no click, but the filters fold or open all the same.
        doneWhen: () => {
          const was = state.mapLayersOpen;
          return () => state.mapLayersOpen !== was;
        },
        before: onMap,
      },
      {
        id: "mp-friends",
        title: "Friends on the map",
        body: () => (tourFriendBubble() ? "Bubbles show where your friends are checked in. A click shows who's there."
          : accountReady() ? "Your friends' bubbles show where they're checked in, like this example."
            : "Signed in, bubbles like this example show where your friends are checked in."),
        target: tourBubble,
        context: tourMapBox,
        advance: "next",
        demo: true,
        before: onMap,
        ready: () => tourFriendBubble() || tourMapLabel(),
        fallback: { title: "Friends on the map", body: "Signed in, bubbles above the buildings show where your friends are checked in." },
      },
      {
        id: "mp-friends-button",
        signedIn: true,
        title: "Show or hide friends",
        body: "This button shows or hides your friends' bubbles. Try it.",
        target: () => tourFind("layer-friends"),
        context: tourMapBox,
        advance: "next",
        demo: true,
        before: async () => {
          await onMap();
          if (!tourFriendBubble()) tourDemoBubble(); // hidden with the button off, like real ones
        },
      }];
  }
  return null;
}

/** The closing card's tip for the journeys that don't need an account: the friends journey is next. */
const TOUR_TIPS = {
  study: "Check in so friends can join you.",
  meet: "Signed in, you can check in and see where your friends are.",
  food: "Signed in, you can rate dishes and see where your friends eat.",
  map: "Check in so friends see you on the map.",
};

const tourState = {
  node: null, // #tour
  fog: null, // the fog's path: its hole is the step's context and target together
  catcher: null, // a clear path over everything but the target: clicks reach the target only
  ring: null, // the blue ring around the target
  blur: null, // the blur under the fog, clipped to the same shape
  context: null, // the step's context(): what shows without fog around the target (the menu, the map), or null
  demo: null, // the example friend's bubble on the map (tourDemoBubble), and the building it sits on
  demoCode: null,
  stillSince: null, // when the map stopped flying (tourTick: the ring waits for it)
  mapStep: false, // the step shown is about the map: the page itself doesn't pinch-zoom then (tourNoPageZoom)
  card: null,
  welcome: null,
  live: null, // the progress, for screen readers
  view: null, // "welcome", "step", "closing" or "ask" (Escape: exit?)
  snapshot: null,
  journey: null,
  chapters: null, // a run of chapters on their own (?tutorial=chapter:D), else null
  plan: [],
  index: 0,
  choices: {}, // the skip prompt's answers: a seen chapter's first index in the plan -> "skip" or "show"
  starred: null, // { kind, id } of the place F1 asked to star, for the You tab's row
  signedOut: false, // "Continue without" (G): the rest of the journey explains instead of showing
  advance: null, // the step shown: "tap" or "next" (a step's `advance` may be a function)
  redo: null, // draws the card shown before Escape again (the sign-in error's)
  paused: false, // waiting, without the fog, for the welcome view after signing in (tourResume)
  checkinTyped: false, // the tour typed into the Check in view's search (tourCheckinView); tourToList takes it out
  token: 0, // the step being shown; an older step's waiting stops when it changes
  target: null,
  find: null, // the step's target(): asked again while the element it gave is gone (the list drawn again)
  reveal: null, // { until, last }: the step's element is kept in view until then (tourReveal)
  shown: null, // as drawn: { hole, ring } (boxes { x, y, w, h } or null), or null
  glide: null, // { from, at }: the hole gliding from `from` since `at`
  frame: 0,
  size: "",
  cardKey: "",
  abort: null, // removes the listeners on exit
  observer: null,
  opener: null, // what had the focus when the tour started; it gets it back at the end (tourFocusBack)
  hosts: [], // the open modal dialogs, the last opened last: #tour lives in the last one (tourHost)
  progress: null, // cleanTour's shape, kept in memory when storage fails
};

// --- progress (localStorage frooms.tour, lib.js cleanTour) ---

function tourRead() {
  try {
    tourState.progress = cleanTour(JSON.parse(localStorage.getItem(TOUR_STORE) ?? "null"));
  } catch {
    tourState.progress = cleanTour(tourState.progress);
  }
  return tourState.progress;
}

function tourWrite(progress) {
  tourState.progress = cleanTour(progress);
  try {
    localStorage.setItem(TOUR_STORE, JSON.stringify(tourState.progress));
  } catch { /* kept in memory for this visit */ }
}

// --- start, exit and putting the page back ---

/** Start the tour: the welcome screen, or `journey` (at `step`). Called by app.js tourLoad once this file is loaded. */
function tourStart({ journey = null, step = null, chapters = null } = {}) {
  // `step` is the way back from signing in (tourSignIn): the same journey goes on, not counted again (tourResume).
  const go = () => (chapters ? tourBegin(journey, 0, chapters) : journey && step != null ? tourResume(journey, step)
    : journey ? tourBegin(journey) : tourWelcome());
  if (tourRunning || tourState.paused) return tourState.paused ? undefined : go();
  tourRunning = true;
  if (!(journey && step != null)) countUse(tourStatKey("open"));
  closeAccountMenu();
  closeCampusMenu();
  closeInviteMenus();
  // An account view (the sign-in view's "Take the tour") isn't brought back at the end: the tour starts over the list.
  // Back from signing in, the welcome view or the sign-in's error may be open already: tourResume deals with them.
  if (placesView.current?.kind === "account" && !(journey && step != null)) tourLeaveView();
  tourState.snapshot = tourSnapshot();
  tourState.opener = document.activeElement !== document.body ? document.activeElement : null;
  tourRead();
  tourBuild();
  tourShow();
  tourState.frame = requestAnimationFrame(tourTick);
  go();
}

/** What the tour may change and puts back (plan section 3): the tab, location, time, filters, map filter, open place and sheet. */
function tourSnapshot() {
  const p = placesView.current;
  return {
    mode: state.mode,
    area: state.area,
    now: state.now,
    date: state.date,
    time: state.time,
    buildings: [...state.buildings],
    spaceBuildings: { study: [...state.spaceBuildings.study], mensa: [...state.spaceBuildings.mensa] },
    types: state.types ? [...state.types] : null,
    equip: state.equip,
    duration: state.duration,
    minSeats: state.minSeats,
    kinds: [...state.kinds],
    mapLayer: state.mapLayer,
    layersOpen: state.mapLayersOpen,
    friendsLayer: friendsMap.layer,
    // Where the map looks (the campus journey moves and zooms it) and the building picked on it.
    map: { area: mapView.area, cx: mapView.cx, cy: mapView.cy, scale: mapView.scale, selected: mapView.selected ?? null },
    place: p && p.kind !== "account" ? { ...p } : null,
    sheet: sheet.current(),
    filters: !document.getElementById("sheet-filters").hidden,
    dialogs: [...document.querySelectorAll("dialog[open]")],
  };
}

/** Leave the open detail view for the list (all its history entries, as placeToList, account views included). */
function tourLeaveView() {
  if (!placesView.current) return;
  const depth = isPlaceEntry(history.state) ? placesView.depth : 0;
  if (depth > 0) {
    placesView.toList = true; // the popstate closes the view
    history.go(-depth);
  } else {
    history.replaceState(null, "", "/");
    closePlace();
  }
}

/** Put the page back as the snapshot has it. Stars made by the person's own click stay (they're not in it). */
async function tourRestore(s) {
  // The menu panel through its history entry (Back), the other windows the tour opened at once.
  if (menuPanel().open && !s.dialogs.includes(menuPanel())) {
    document.getElementById("photo-box").close();
    closeMenu();
    await tourUntil(() => !menuPanel().open);
  }
  if (tourState.checkinTyped) {
    tourState.checkinTyped = false;
    checkinView.query = "";
  }
  for (const d of document.querySelectorAll("dialog[open]")) if (!s.dialogs.includes(d)) d.close();
  closeInviteMenus();
  closeAccountMenu();
  closeCampusMenu();
  if (searchOpen()) closeSearch();
  if (!samePlace(placesView.current, s.place)) {
    if (s.place) await openPlace(s.place, { from: placesView.current ? "place" : "list" });
    else tourLeaveView();
  }
  if (s.area !== state.area) await selectArea(s.area);
  if (s.mode !== state.mode) selectMode(s.mode); // first: it carries the buildings between the tabs
  state.buildings = new Set(s.buildings);
  state.spaceBuildings = { study: new Set(s.spaceBuildings.study), mensa: new Set(s.spaceBuildings.mensa) };
  state.types = s.types ? new Set(s.types) : null;
  state.equip = s.equip;
  state.duration = s.duration;
  state.minSeats = s.minSeats;
  document.getElementById("min-seats").value = s.minSeats;
  state.kinds = new Set(s.kinds);
  if (s.mapLayer !== state.mapLayer) {
    state.mapLayer = s.mapLayer;
    renderMapLayers();
    fillLabels();
    scheduleDraw();
  }
  if (s.layersOpen !== state.mapLayersOpen) setLayersOpen(s.layersOpen);
  if (s.friendsLayer !== friendsMap.layer) {
    friendsMap.layer = s.friendsLayer;
    try {
      localStorage.setItem(FRIENDS_LAYER_KEY, s.friendsLayer ? "on" : "off");
    } catch { /* for this visit */ }
    syncFriendsButton();
    scheduleDraw();
  }
  // The map's view, when it's still the same campus (after flying back it shows the whole campus anyway).
  if (s.map && mapView.area === s.map.area && !mapView.floor) {
    if (!s.map.selected && mapView.selected) closeSheet();
    Object.assign(mapView, { cx: s.map.cx, cy: s.map.cy, scale: s.map.scale });
    clampCentre();
    scheduleDraw();
  }
  if (s.now) setNow(true, false);
  else {
    state.date = s.date;
    state.time = s.time;
    setNow(false, false);
  }
  savePrefs();
  renderModes();
  if (state.mode === "rooms") renderBuildings(state.roomBuildingList);
  else if (state.mode !== "you" && state.spaces?.area === state.area) renderSpaces();
  if (s.filters) openFilters();
  else closeFilters();
  refresh();
  sheet.snap(s.sheet);
}

/** Exit (the link, Escape twice, Done, Not now): the fog goes, the page goes back as it was. */
async function tourExit() {
  if (!tourRunning) return;
  tourState.token++;
  cancelAnimationFrame(tourState.frame);
  tourState.abort?.abort();
  tourState.observer?.disconnect();
  try {
    tourState.node.hidePopover();
  } catch { /* not shown */ }
  tourState.node.remove();
  tourState.node = null;
  tourState.target = null;
  tourState.context = null;
  tourState.find = null;
  tourState.shown = null;
  tourDropDemo();
  tourRunning = false;
  const s = tourState.snapshot;
  tourState.snapshot = null;
  if (s) await tourRestore(s);
  tourFocusBack();
}

/**
 * The focus back where the tour was started from: the button that started it, else (an account menu's "Tutorial",
 * gone with the menu; the first-visit window) the account button or the tab shown.
 */
function tourFocusBack() {
  const o = tourState.opener;
  tourState.opener = null;
  if (document.activeElement && document.activeElement !== document.body && !document.getElementById("tour")?.contains(document.activeElement)) return;
  const shown = (n) => n?.isConnected && n.getClientRects().length && !n.closest("[hidden], [inert]");
  const to = shown(o) ? o : o?.closest("#account-menu") ? document.getElementById("account") : document.querySelector("#tabs [aria-selected=true]");
  to?.focus({ preventScroll: true });
}

// --- the fog, the hole and the card ---

function tourBuild() {
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("class", "tour-fog");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svgNs, "path");
  path.setAttribute("fill-rule", "evenodd");
  path.setAttribute("class", "tour-shade");
  const ring = document.createElementNS(svgNs, "rect");
  ring.setAttribute("class", "tour-ring");
  ring.setAttribute("display", "none");
  const catcher = document.createElementNS(svgNs, "path");
  catcher.setAttribute("fill-rule", "evenodd");
  catcher.setAttribute("class", "tour-catch");
  svg.append(path, ring, catcher);
  tourState.fog = path;
  tourState.ring = ring;
  tourState.catcher = catcher;
  tourState.blur = el("div", { class: "tour-blur", "aria-hidden": "true" });
  tourState.card = el("div", { class: "tour-card", role: "dialog", "aria-modal": "false", "aria-labelledby": "tour-title", "aria-describedby": "tour-body", tabindex: "-1", hidden: "" });
  tourState.welcome = el("div", { class: "tour-welcome", role: "dialog", "aria-labelledby": "tour-welcome-title", "aria-describedby": "tour-question", tabindex: "-1", hidden: "" });
  tourState.live = el("p", { class: "visually-hidden", "aria-live": "polite" });
  tourState.node = el("div", { id: "tour", class: "tour", popover: "manual" }, tourState.blur, svg, tourState.card, tourState.welcome, tourState.live);
  document.body.append(tourState.node);
  // A click beside the target does nothing (the page under it waits), also in the context without fog; the ring's
  // inside lets clicks through to the real element.
  catcher.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    tourState.card.classList.remove("nudge");
    void tourState.card.offsetWidth;
    if (!tourState.card.hidden) tourState.card.classList.add("nudge");
  });
  const abort = new AbortController();
  tourState.abort = abort;
  document.addEventListener("keydown", tourKey, { capture: true, signal: abort.signal });
  document.addEventListener("click", tourTapped, { capture: true, signal: abort.signal });
  // On a map step a pinch with a finger on the card or the fog zoomed the page instead of the map (phones).
  document.addEventListener("touchmove", tourNoPageZoom, { capture: true, passive: false, signal: abort.signal });
  for (const type of ["gesturestart", "gesturechange"]) document.addEventListener(type, tourNoPageZoom, { capture: true, passive: false, signal: abort.signal }); // Safari
  // A dialog opened or closed (by a step, or a click through the hole): the fog goes into the top one, on top again.
  tourState.hosts = [...document.querySelectorAll("dialog[open]")].filter((d) => d.matches(":modal"));
  tourState.observer = new MutationObserver((list) => {
    let changed = false;
    for (const m of list) {
      const d = m.target;
      if (!(d instanceof HTMLDialogElement)) continue;
      changed = true;
      tourState.hosts = tourState.hosts.filter((x) => x !== d && x.open);
      if (d.open && d.matches(":modal")) tourState.hosts.push(d);
    }
    if (changed) tourShow();
  });
  tourState.observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
}

/**
 * Show the fog in the top layer, above everything open now (shown again after a dialog opens or closes): inside the
 * top modal dialog while one is open (outside it, it would be inert), else in the body.
 */
function tourShow() {
  const node = tourState.node;
  if (!node || tourState.paused) return;
  const host = tourState.hosts.filter((d) => d.open).at(-1) ?? document.body;
  const focused = node.contains(document.activeElement) ? document.activeElement : null;
  try {
    if (node.matches(":popover-open")) node.hidePopover();
    if (node.parentNode !== host) host.append(node);
    node.showPopover();
    focused?.focus({ preventScroll: true });
  } catch {
    node.classList.add("shown"); // no popovers in this browser: a plain fixed layer
  }
  tourState.size = ""; // redraw
}

/** "M…" for the window with the hole `r` ({ x, y, w, h }, or null for none) cut out (fill-rule evenodd). */
function tourPath(r) {
  const W = innerWidth;
  const H = innerHeight;
  let d = `M0 0H${W}V${H}H0Z`;
  if (!r) return d;
  const k = Math.min(TOUR_RADIUS, r.w / 2, r.h / 2);
  const n = (v) => Math.round(v * 10) / 10;
  d += `M${n(r.x + k)} ${n(r.y)}H${n(r.x + r.w - k)}A${k} ${k} 0 0 1 ${n(r.x + r.w)} ${n(r.y + k)}V${n(r.y + r.h - k)}` +
    `A${k} ${k} 0 0 1 ${n(r.x + r.w - k)} ${n(r.y + r.h)}H${n(r.x + k)}A${k} ${k} 0 0 1 ${n(r.x)} ${n(r.y + r.h - k)}` +
    `V${n(r.y + k)}A${k} ${k} 0 0 1 ${n(r.x + k)} ${n(r.y)}Z`;
  return d;
}

/**
 * The box around a target or context (an element, several, or a box; tourList): their boxes together plus `pad`,
 * inside the window. Null when none is on screen.
 */
function tourHoleOf(target, pad = TOUR_PAD) {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const n of tourList(target)) {
    let box;
    if (n instanceof Element) {
      if (!n.isConnected) continue;
      const c = n.getBoundingClientRect();
      if (!c.width && !c.height) continue;
      box = { l: c.left - pad, t: c.top - pad, r: c.right + pad, b: c.bottom + pad };
    } else if (n && typeof n.x === "number") box = { l: n.x, t: n.y, r: n.x + n.w, b: n.y + n.h };
    else continue;
    l = Math.min(l, box.l);
    t = Math.min(t, box.t);
    r = Math.max(r, box.r);
    b = Math.max(b, box.b);
  }
  if (l === Infinity) return null;
  const x = Math.max(0, l);
  const y = Math.max(0, t);
  const w = Math.min(innerWidth, r) - x;
  const h = Math.min(innerHeight, b) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** Two boxes together (either may be null). */
function tourUnion(a, b) {
  if (!a || !b) return a ?? b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** From box `a` to box `b` at `e` (0 to 1); `b` when there's nothing to glide from. */
const tourLerp = (a, b, e) => (a && b ? { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, w: a.w + (b.w - a.w) * e, h: a.h + (b.h - a.h) * e } : b);

/**
 * Every frame while the tour runs: the hole follows its target (a dragged sheet, a scrolled list, a resize), gliding
 * to a new one over TOUR_GLIDE_MS. Only redrawn when something moved.
 */
function tourTick(now) {
  tourState.frame = requestAnimationFrame(tourTick);
  // The list or view was drawn again (a refresh, a redraw after a report): the step's element is a new one.
  if (tourState.view === "step" && tourState.find && !tourConnected(tourState.target)) {
    try {
      tourState.target = tourState.find() ?? tourState.target;
    } catch { /* keeps the old one */ }
  }
  // A new step's element is scrolled into view; a view still being drawn may push it out again for a moment.
  const rv = tourState.reveal;
  if (rv && tourState.view === "step") {
    if (now > rv.until) tourState.reveal = null;
    else if (now - rv.last > 350) {
      rv.last = now;
      tourReveal(tourState.target);
    }
  }
  tourPlaceDemo();
  // The ring on the target; the hole without fog is the ring and the step's context (the menu, the map) together.
  const on = tourState.view === "step" || tourState.view === "ask";
  // While the map flies to another campus the ring goes, and comes back once the map has been still a moment.
  if (tourMapFlying()) tourState.stillSince = null;
  else tourState.stillSince ??= now;
  const still = tourState.stillSince != null && now - tourState.stillSince > TOUR_STILL_MS;
  const ringLive = on ? tourHoleOf(tourState.target) : null;
  let ctx = null;
  if (on && ringLive && tourState.context) {
    try {
      ctx = tourHoleOf(tourState.context(), TOUR_PAD + 2);
    } catch { /* none */ }
  }
  const live = ringLive ? { hole: tourUnion(ringLive, ctx), ring: ringLive } : null;
  let r = live;
  const g = tourState.glide;
  if (g && live && g.from && !TOUR_REDUCED.matches) {
    const t = Math.min(1, (now - g.at) / TOUR_GLIDE_MS);
    const e = 1 - (1 - t) ** 3;
    r = { hole: tourLerp(g.from.hole, live.hole, e), ring: tourLerp(g.from.ring, live.ring, e) };
    if (t >= 1) tourState.glide = null;
  } else tourState.glide = null;
  const f = (b) => (b ? [b.x, b.y, b.w, b.h].map((v) => v.toFixed(1)).join(",") : "-");
  const key = `${innerWidth}x${innerHeight}|${f(r?.hole)}|${f(r?.ring)}|${tourState.view}|${still}`;
  if (key === tourState.size) return;
  tourState.size = key;
  tourState.shown = r;
  const d = tourPath(r?.hole ?? null);
  tourState.fog.setAttribute("d", d);
  tourState.blur.style.setProperty("clip-path", `path(evenodd, "${d}")`);
  tourState.catcher.setAttribute("d", tourPath(r?.ring ?? null));
  const ring = tourState.ring;
  if (r?.ring && still) {
    const q = r.ring;
    ring.setAttribute("display", "inline");
    for (const [k, v] of [["x", q.x], ["y", q.y], ["width", q.w], ["height", q.h], ["rx", Math.min(TOUR_RADIUS, q.w / 2, q.h / 2)]]) ring.setAttribute(k, String(Math.round(v * 10) / 10));
  } else ring.setAttribute("display", "none");
  tourPlaceCard(r);
}

/**
 * The card beside the hole, never over it: below when there's room, else above (wide windows). On phones it's at the
 * bottom above the tabs when the hole is in the upper half, else at the top. Without a hole: in the middle.
 */
function tourPlaceCard(shown) {
  const card = tourState.card;
  if (card.hidden) return;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  // Beside the whole part without fog when it can be; else (the map, a tall menu) at least beside the ring.
  let at = tourCardSpot(shown?.hole ?? null, cw, ch);
  const ring = shown?.ring;
  const over = (p, b) => b && p.left < b.x + b.w && p.left + cw > b.x && p.top < b.y + b.h && p.top + ch > b.y;
  if (ring && shown.hole !== ring && over(at, shown.hole)) at = tourCardSpot(ring, cw, ch);
  card.style.setProperty("left", `${Math.round(at.left)}px`);
  card.style.setProperty("top", `${Math.round(at.top)}px`);
}

/** Where the card goes for the box `r` (null: the middle), as tourPlaceCard says. */
function tourCardSpot(r, cw, ch) {
  const W = innerWidth;
  const H = innerHeight;
  let left = (W - cw) / 2;
  let top = (H - ch) / 2;
  if (r) {
    const phone = layout() === "full";
    const tabs = document.getElementById("tabs").getBoundingClientRect();
    const bottomEdge = phone && tabs.top > H / 2 ? tabs.top : H;
    const below = r.y + r.h + TOUR_GAP;
    const above = r.y - TOUR_GAP - ch;
    const fitsBelow = below + ch <= bottomEdge - TOUR_GAP;
    const fitsAbove = above >= TOUR_GAP;
    if (phone) {
      const upper = r.y + r.h / 2 < H / 2;
      const atBottom = bottomEdge - TOUR_GAP - ch;
      // At the bottom (above the tabs) when the hole is in the upper half, else at the top; the other one when the
      // first would cover the hole; when both would (a short window, 200 % zoom), the one covering less of it.
      const covers = (t) => Math.max(0, Math.min(t + ch, r.y + r.h) - Math.max(t, r.y));
      const [first, second] = upper ? [atBottom, TOUR_GAP] : [TOUR_GAP, atBottom];
      top = !covers(first) || covers(first) <= covers(second) ? first : second;
    } else {
      top = fitsBelow || !fitsAbove ? (fitsBelow ? below : Math.max(TOUR_GAP, H - TOUR_GAP - ch)) : above;
      left = r.x + r.w / 2 - cw / 2;
      // Neither below nor above: beside it, on the side with more room.
      if (!fitsBelow && !fitsAbove) {
        const right = r.x + r.w + TOUR_GAP;
        left = W - right >= r.x ? right : r.x - TOUR_GAP - cw;
        top = Math.min(Math.max(TOUR_GAP, r.y), H - TOUR_GAP - ch);
      }
    }
  }
  left = Math.min(Math.max(TOUR_GAP, left), W - TOUR_GAP - cw);
  top = Math.min(Math.max(TOUR_GAP, top), H - TOUR_GAP - ch);
  return { left, top };
}

/**
 * Point the ring at `target` (null: none), gliding from where it is; `context()` gives what shows without fog around
 * it (tourTick). Without a target the example bubble goes too.
 */
function tourAim(target, context = null) {
  tourState.glide = { from: tourState.shown, at: performance.now() };
  tourState.target = target;
  tourState.context = target ? context : null;
  // A map step (the map is the target or what's around it): a pinch is meant for the map, not the page.
  tourState.mapStep = !!target && context === tourMapBox; // "Move around", whose target is the map, sets it in tourGo
  tourState.node?.classList.toggle("map-step", tourState.mapStep);
  if (!target) tourDropDemo();
  tourState.size = "";
}

// --- the welcome screen ---

function tourWelcome() {
  tourState.token++;
  tourState.view = "welcome";
  tourState.journey = null;
  tourState.chapters = null;
  tourState.find = null;
  tourAim(null);
  tourState.node.classList.add("strong");
  tourState.card.hidden = true;
  const done = tourRead().done.journeys;
  const buttons = TOUR_JOURNEY_IDS.map((j) => {
    const finished = done.includes(j);
    const b = el("button", { type: "button", class: "tour-journey" }, el("span", {}, TOUR_TITLES[j]),
      finished ? el("span", { class: "tour-tick" }, el("span", { "aria-hidden": "true" }, "✓"), el("span", { class: "visually-hidden" }, "(done)")) : null);
    b.addEventListener("click", () => tourBegin(j));
    return b;
  });
  const later = el("button", { type: "button", class: "tour-later" }, "Not now");
  later.addEventListener("click", tourExit);
  fill(tourState.welcome,
    el("h2", { id: "tour-welcome-title", class: "tour-welcome-title" }, "Welcome to ", wordmarkText()),
    el("p", { id: "tour-question", class: "tour-question" }, "What are you looking for?"),
    el("div", { class: "tour-journeys", role: "group", "aria-label": "Journeys" }, ...buttons),
    later);
  tourState.welcome.hidden = false;
  tourState.live.textContent = "Tutorial. What are you looking for?";
  buttons[0].focus({ preventScroll: true });
}

// --- the runner ---

/**
 * Start a journey (counted), at step `at` of its plan (lib.js tourPlan). With `chapters` (the debug address
 * `?tutorial=chapter:B,D`) those chapters run on their own with `journey`'s places, not counted: one chapter always
 * shows, several skip the seen ones as a journey would (A left out, the others offered).
 */
function tourBegin(journey, at = 0, chapters = null, { count = true, signedOut = false } = {}) {
  const parts = chapters ?? tourJourney(journey);
  if (!parts) return tourWelcome();
  if (!chapters && count) countUse(tourStatKey("start", journey));
  tourState.journey = journey;
  tourState.chapters = chapters;
  tourState.choices = {};
  tourState.starred = null;
  tourState.signedOut = signedOut;
  const done = chapters?.length === 1 ? [] : tourRead().done.chapters;
  tourState.plan = tourPlan(parts, tourChapters(journey), done);
  tourState.node.classList.remove("strong");
  tourState.welcome.hidden = true;
  tourGo(Math.min(Math.max(0, at), tourState.plan.length), 1);
}

/**
 * Back from signing in (plan 4.6): the page asks who is signed in right after the tour starts (app.js startAccount),
 * then the journey goes on at `at`, not counted again. A new account first gets the welcome view (its username and
 * bubble): the fog goes away and nothing is guarded until it's saved, then the tour comes back. A failed sign-in
 * (#signin-error=…) shows its usual text, and the rest of the journey explains instead of showing.
 */
async function tourResume(journey, at) {
  const token = ++tourState.token;
  tourState.view = "wait";
  tourState.journey = journey;
  tourState.chapters = null;
  tourAim(null);
  tourState.card.hidden = true;
  tourState.welcome.hidden = true;
  await tourUntil(() => account.status !== "unknown", 10000);
  if (token !== tourState.token || !tourRunning) return;
  const error = account.hash?.error;
  if (error) {
    // startAccount opened the sign-in view with the same text; the tour goes on over the list.
    if (placesView.current?.kind === "account") tourLeaveView();
    const show = () => {
      tourState.view = "error";
      tourState.redo = show; // Escape, then Keep going
      tourCard({
        progress: TOUR_NAMES[journey],
        title: "No sign-in this time",
        body: `${SIGNIN_ERRORS[error] ?? SIGNIN_ERRORS.failed} The tour goes on without an account.`,
        buttons: [["Continue", () => tourBegin(journey, at, null, { count: false, signedOut: true }), true]],
        focusPrimary: true,
      });
    };
    return show();
  }
  if (signedIn() && account.me.profile_needed) {
    // app.js startAccount opens the welcome view; when the tour started late and closed it, it opens again.
    const welcomeOpen = () => placesView.current?.kind === "account" && placesView.current.id === "welcome";
    if (!(await tourUntil(welcomeOpen, 1500))) openAccountView("welcome");
    await tourPause(() => accountReady());
    if (token !== tourState.token) return;
    // Saved: the welcome view closes through the history (its popstate comes later); the steps start after it.
    await tourUntil(() => !welcomeOpen(), 2000);
  }
  tourBegin(journey, at, null, { count: false });
}

/**
 * Take the fog away (and stop guarding: the welcome view saves the profile) until `ok()` is true after an account
 * change, then bring it back.
 */
function tourPause(ok) {
  tourState.paused = true;
  tourRunning = false;
  try {
    tourState.node.hidePopover();
  } catch { /* not shown */ }
  tourState.node.classList.remove("shown");
  return new Promise((resolve) => {
    const check = () => {
      if (!ok()) return;
      account.listeners.splice(account.listeners.indexOf(check), 1);
      tourState.paused = false;
      tourRunning = true;
      tourShow();
      resolve();
    };
    account.listeners.push(check);
  });
}

/** The run of a seen chapter that the person chose to skip, around step `i` (lib.js tourChapterSpan), or null. */
function tourSkippedSpan(i) {
  const span = tourState.plan[i]?.skip === "offer" ? tourChapterSpan(tourState.plan, i) : null;
  return span && tourState.choices[span[0]] === "skip" ? span : null;
}

/** The steps that show: without the chapters left out ("auto") or skipped. For the progress line. */
const tourShownSteps = () => tourState.plan.filter((s, i) => s.skip !== "auto" && !tourSkippedSpan(i));

/** The journey's name for the progress line: "Food", or "Chapter D" for a chapter run on its own. */
const tourRunName = () => (tourState.chapters ? `Chapter${tourState.chapters.length > 1 ? "s" : ""} ${tourState.chapters.join(", ")}`
  : TOUR_NAMES[tourState.journey] ?? "Tutorial");

/** Wait until `ready()` is true (checked every frame), at most TOUR_READY_MS; false when the step changed meanwhile. */
function tourWait(ready, token) {
  const until = performance.now() + TOUR_READY_MS;
  return new Promise((resolve) => {
    const check = () => {
      if (token !== tourState.token) return resolve(false);
      let ok = false;
      try {
        ok = !!ready();
      } catch { /* not yet */ }
      if (ok || performance.now() > until) return resolve(true);
      requestAnimationFrame(check);
    };
    check();
  });
}

/** Show step `i` of the plan, going on in direction `dir` (1 or -1) past the ones left out or without a target. */
async function tourGo(i, dir = 1) {
  const plan = tourState.plan;
  // Past the chapters left out ("auto") and those skipped; the skip prompt at the start of a seen chapter ("offer").
  for (;;) {
    while (i >= 0 && i < plan.length && plan[i].skip === "auto") i += dir;
    if (i < 0) return tourGo(0, 1);
    if (i >= plan.length) return tourFinish();
    const skipped = tourSkippedSpan(i);
    if (skipped) {
      i = dir > 0 ? skipped[1] : skipped[0] - 1;
      continue;
    }
    const span = plan[i].skip === "offer" ? tourChapterSpan(plan, i) : null;
    if (span && dir > 0 && i === span[0] && !tourState.choices[span[0]]) return tourOffer(span);
    break;
  }
  const token = ++tourState.token;
  tourState.index = i;
  tourState.view = "step";
  const { step } = plan[i];
  if (!step.demo) tourDropDemo(); // the example bubble stays only on the steps that show it
  tourState.advance = null; // a second click on the last step's element doesn't skip this one while it sets up
  if (!step.keepMenus) closeInviteMenus();
  // Nobody signed in: a step that needs an account explains in a card without a hole, or is passed (plan 4.6).
  if (step.signedIn && !accountReady()) {
    if (!step.explain) {
      if (dir > 0) tourPassed(i);
      return tourGo(i + dir, dir);
    }
    tourShow();
    tourAim(null);
    tourState.find = null;
    tourState.advance = "next";
    return tourCard({
      progress: tourProgressText(i),
      title: tourText(step.explain.title),
      body: tourText(step.explain.body),
      back: tourShownSteps().indexOf(plan[i]) > 0 ? () => tourGo(i - 1, -1) : null,
      next: () => tourDone(i),
    });
  }
  if (step.before) {
    try {
      await step.before();
    } catch (e) {
      console.warn(`Tutorial: step ${step.id} couldn't set the page up`, e);
    }
  }
  if (token !== tourState.token) return;
  if (step.ready) await tourWait(step.ready, token);
  if (token !== tourState.token) return;
  // A step that doesn't apply now (a phone's sheet on a wide window, a space without a sensor) is passed quietly.
  let applies = true;
  try {
    applies = !step.only || !!step.only();
  } catch { applies = false; }
  const target = applies && step.target ? step.target() : null;
  if (!applies || (step.target && !target && !step.fallback)) {
    if (applies) console.warn(`Tutorial: no target for step ${step.id}, skipped`);
    if (dir > 0) tourPassed(i);
    return tourGo(i + dir, dir);
  }
  tourShow(); // above a dialog the step opened
  tourAim(target, step.context ?? null);
  if (step.target === tourMapBox) {
    tourState.mapStep = true;
    tourState.node.classList.add("map-step");
  }
  // Into view now, and again in the next moments if the view is still being drawn (tourTick).
  tourReveal(target);
  tourState.reveal = { until: performance.now() + TOUR_REVEAL_MS, last: performance.now() };
  tourState.find = target ? step.target : null;
  const text = target || !step.fallback ? step : step.fallback;
  const tap = (typeof step.advance === "function" ? step.advance() : step.advance) === "tap" && !!target;
  tourState.advance = tap ? "tap" : "next";
  const actions = step.actions?.(i) ?? null;
  tourCard({
    progress: tourProgressText(i),
    title: tourText(text.title),
    body: tourText(text.body),
    back: tourShownSteps().indexOf(plan[i]) > 0 ? () => tourGo(i - 1, -1) : null,
    next: tap ? null : () => tourDone(i),
    hint: tap ? "Click it" : null,
    buttons: actions,
    focusPrimary: !!actions,
  });
  // A "tap" step whose click the page takes elsewhere (the map) says when it's done instead (`doneWhen` gives the
  // check, made when the step shows).
  if (tap && step.doneWhen) {
    const done = step.doneWhen();
    tourUntil(() => token !== tourState.token || done(), 30 * 60 * 1000).then(() => {
      if (token === tourState.token && tourState.view === "step") tourDone(i);
    });
  }
}

/**
 * Scroll the step's element into its list (the sheet, the search, a window) when it's outside the part that shows:
 * to the middle, gliding unless motion is reduced. The hole follows (tourTick).
 */
function tourReveal(targets) {
  const els = tourElements(targets).filter((n) => n.isConnected);
  if (!els.length) return;
  const target = els[0];
  let box = target.parentElement;
  while (box && box !== document.body) {
    const s = getComputedStyle(box);
    if (/(auto|scroll)/.test(s.overflowY) && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (!box || box === document.body) return;
  const rects = els.map((n) => n.getBoundingClientRect());
  const t = { top: Math.min(...rects.map((x) => x.top)), bottom: Math.max(...rects.map((x) => x.bottom)) };
  t.height = t.bottom - t.top;
  const b = box.getBoundingClientRect();
  // A detail view's actions stick to the sheet's bottom: what's under them doesn't show.
  const bar = box.querySelector(".detail-actions");
  const bottom = bar && !bar.contains(target) && !target.contains(bar) && getComputedStyle(bar).position === "sticky"
    ? Math.min(b.bottom, bar.getBoundingClientRect().top) : b.bottom;
  if (t.top >= b.top && t.bottom <= bottom) return;
  const room = bottom - b.top;
  const want = t.height > room ? box.scrollTop + t.top - b.top : box.scrollTop + t.top - b.top - (room - t.height) / 2;
  box.scrollTo({ top: Math.max(0, want), behavior: TOUR_REDUCED.matches ? "auto" : "smooth" });
}

/** "Food · 3 of 9". */
function tourProgressText(i) {
  const shown = tourShownSteps();
  return `${tourRunName()} · ${shown.indexOf(tourState.plan[i]) + 1} of ${shown.length}`;
}

/** Step `i` is behind: its chapter is marked done when it was the chapter's last step. */
function tourPassed(i) {
  const plan = tourState.plan;
  const chapter = plan[i]?.chapter;
  const span = tourChapterSpan(plan, i);
  if (chapter && span && i === span[1] - 1) tourWrite(tourMarkDone(tourRead(), { chapter }));
}

/** Step `i` done (Next, or its target clicked): on to the next one. */
function tourDone(i) {
  tourPassed(i);
  tourGo(i + 1, 1);
}

/**
 * The skip prompt (plan 4.5) at the start of a chapter seen before: "You've seen Place details already." with Skip
 * (the focus) and Show again. `span` is the chapter's run in the plan, [start, end).
 */
function tourOffer([start, end]) {
  tourState.token++;
  tourState.index = start;
  tourState.view = "offer";
  tourState.find = null;
  tourAim(null);
  const choose = (choice) => {
    tourState.choices[start] = choice;
    tourGo(choice === "skip" ? end : start, 1);
  };
  tourCard({
    progress: tourProgressText(start),
    title: `You've seen ${TOUR_CHAPTER_NAMES[tourState.plan[start].chapter]} already.`,
    body: "Skip it, or show it again.",
    back: tourShownSteps().indexOf(tourState.plan[start]) > 0 ? () => tourGo(start - 1, -1) : null,
    buttons: [["Show again", () => choose("show")], ["Skip", () => choose("skip"), true]],
    focusPrimary: true,
  });
}

/**
 * While a map step shows: no pinch-zoom of the page (two fingers moving, or Safari's gesture events). The map's own
 * pinch works on (its pointer events, map.js); one finger still drags the map or scrolls. Other steps zoom as usual.
 */
function tourNoPageZoom(e) {
  if (!tourState.mapStep || tourState.paused) return;
  if (e.type === "touchmove" && e.touches.length < 2) return;
  if (e.cancelable) e.preventDefault();
}

/** A "tap" step's target was clicked: the page reacts first (its own click handler), then the next step. */
function tourTapped(e) {
  if (tourState.view !== "step") return;
  if (tourState.advance !== "tap" || !tourHas(tourState.target, e.target)) return;
  const i = tourState.index;
  const token = tourState.token;
  // A moment for what the click sets off through the history (Back closing the search, a view opening), whose
  // popstate comes later and moves the focus, then the next frame.
  setTimeout(() => requestAnimationFrame(() => {
    if (token === tourState.token) tourDone(i);
  }), TOUR_TAP_MS);
}

/**
 * The journey's end: marked done, counted, and the closing card (`again`: the card once more, after Escape). Study,
 * Meet and Food end with a tip and "Show me" (the friends journey, unless it's done); the friends journey, signed out
 * where sign-in works, with "Sign in with edu-ID", which comes back to its first step after G.
 */
function tourFinish(again = false) {
  const j = tourState.journey;
  const chapters = tourState.chapters;
  tourState.token++;
  tourState.view = "closing";
  tourState.find = null;
  // A chapter run on its own (debug) isn't a journey: nothing marked or counted beyond its chapters.
  if (!chapters && !again) {
    tourWrite(tourMarkDone(tourRead(), { journey: j }));
    countUse(tourStatKey("done", j));
  }
  tourAim(null);
  // The page as it was, then `then` (the welcome screen with ✓ on this journey, or the next journey).
  const restart = (then) => async () => {
    const s = tourState.snapshot;
    if (s) await tourRestore(s);
    tourState.snapshot = tourSnapshot();
    then();
  };
  const tip = !chapters ? TOUR_TIPS[j] : null;
  const showMe = tip && !tourRead().done.journeys.includes("friends");
  const signIn = !chapters && j === "friends" && !accountReady() && account.status === "out" && navigator.onLine !== false;
  const afterG = tourState.plan.findIndex((p, i) => p.chapter === "G" && tourState.plan[i + 1]?.chapter !== "G") + 1;
  tourCard({
    progress: tourRunName(),
    title: chapters ? `That's it for ${chapters.length > 1 ? "these chapters" : "this chapter"}.` : TOUR_CLOSING[j] ?? "That's it.",
    body: tip ?? (signIn ? "Sign in to try it with your own friends." : "Pick another journey, or go on with frooms."),
    buttons: [
      ["Back to the start", restart(tourWelcome)],
      showMe ? ["Show me", restart(() => tourBegin("friends"))] : null,
      signIn && afterG > 0 ? ["Sign in with edu-ID", () => tourSignIn(afterG)] : null,
      ["Done", tourExit, true],
    ].filter(Boolean),
    exit: false,
  });
}

/**
 * Draw the card: `progress`, `title`, `body`, and either Back · Next (`back`, `next`; `hint` instead of Next on a
 * "tap" step) or its own `buttons` ([text, onClick, primary]), then "Exit tutorial" unless `exit` is false. The focus
 * moves to it and the progress is announced.
 */
function tourCard({ progress, title, body, back = null, next = null, hint = null, buttons = null, exit = true, focusPrimary = false }) {
  const card = tourState.card;
  const button = (text, onClick, primary = false) => {
    const b = el("button", { type: "button", class: primary ? "tour-primary" : "tour-secondary" }, text);
    b.addEventListener("click", onClick);
    return b;
  };
  const row = [back ? button("Back", back) : null, ...(buttons
    ? buttons.map(([text, onClick, primary]) => button(text, onClick, primary))
    : [next ? button("Next", next, true) : hint ? el("span", { class: "tour-hint" }, hint, el("span", { class: "visually-hidden" }, ". Tab moves to it.")) : null])];
  let exitLink = null;
  if (exit) {
    exitLink = el("button", { type: "button", class: "tour-exit" }, "Exit tutorial");
    exitLink.addEventListener("click", tourExit);
  }
  fill(card,
    el("p", { class: "tour-progress" }, progress),
    el("h2", { id: "tour-title", class: "tour-title" }, title),
    body ? el("p", { id: "tour-body", class: "tour-body" }, body) : null,
    el("div", { class: "tour-buttons" }, ...row.filter(Boolean)),
    exitLink);
  card.hidden = false;
  tourState.welcome.hidden = true;
  tourState.size = ""; // placed again on the next frame, with its new height
  tourPlaceCard(tourState.shown);
  // The card's title and body are read when it takes the focus (aria-labelledby, aria-describedby); this says where.
  tourState.live.textContent = progress;
  // The skip prompt and a step's own choices start on their main button (Skip, Sign in); the rest on the card.
  ((focusPrimary && card.querySelector(".tour-primary")) || card).focus({ preventScroll: true });
}

// --- the keyboard: Escape asks once, Tab stays between the card and the spotlit element ---

/** Escape: "Exit the tutorial?" with Exit and Keep going; a second Escape exits. */
function tourAskExit() {
  if (tourState.view === "ask") return tourExit();
  if (tourState.view === "welcome") return tourExit();
  if (tourState.view === "wait") return; // a moment, until the page knows who is signed in
  const back = tourState.view;
  const i = tourState.index;
  const target = tourState.target;
  tourState.view = "ask";
  tourState.token++;
  tourCard({
    progress: tourState.journey ? tourRunName() : "Tutorial",
    title: "Exit the tutorial?",
    body: "The page goes back to how it was.",
    buttons: [["Keep going", () => (back === "closing" ? tourFinish(true) : back === "error" ? tourState.redo?.() : tourGo(i, 1))], ["Exit", tourExit, true]],
    exit: false,
  });
  tourState.target = target; // the hole stays where it was while asking
}

const TOUR_FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

function tourKey(e) {
  if (tourState.paused) return; // the welcome view is the page's own until it's saved
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    tourAskExit();
    return;
  }
  if (e.key !== "Tab") return;
  const box = tourState.view === "welcome" ? tourState.welcome : tourState.card;
  const inBox = [...box.querySelectorAll(TOUR_FOCUSABLE)];
  const t = tourState.view === "step" ? tourState.target : null;
  const inTarget = tourElements(t).flatMap((n) => (n.matches(TOUR_FOCUSABLE) ? [n] : [...n.querySelectorAll(TOUR_FOCUSABLE)]));
  const order = [...inBox, ...inTarget].filter((x) => x.getClientRects().length);
  if (!order.length) return;
  e.preventDefault();
  const at = order.indexOf(document.activeElement);
  const to = at < 0 ? (e.shiftKey ? order.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + order.length) % order.length;
  order[to].focus({ preventScroll: true });
}
