"use strict";

// Street cred on the page (plans/PLAN_STREET_CRED.md, 11.1): the view "frooms Street cred" in the sheet (the account
// menu's item after Friends), its full log with the day filter, the leaderboards, the "+5 street cred" toast that every
// action earning points shows, and the invites' POST /api/cred/invite. Views of kind "account": "cred" and "cred:log".
// The rules (levels, points, caps, unlocks) are in lib.js, the same as the Worker's (worker/cred.ts). Loaded after
// friends.js.

const credView = {
  summary: null, // GET /api/cred
  loading: false,
  error: "",
  log: null, // the full list: { day, entries, more, days, loading, error }
  pickerOpen: false,
  // data: GET /api/cred/board by range, its pages joined; scroll: where each range's list was scrolled to (kept across redraws)
  board: { range: "recent", data: {}, loading: "", error: "", busy: false, scroll: {} },
  howOpen: false, // "How to earn" folded out (kept across redraws)
};

const credShown = (sub = null) => {
  const p = placesView.current;
  return p?.kind === "account" && (sub === null ? /^cred(:|$)/.test(p.id) : p.id === (sub ? `cred:${sub}` : "cred"));
};

/** Draw the view again, keeping the focus on the control that had it (they carry `data-focus`). */
function drawCredIfOpen() {
  if (!credShown()) return;
  const a = document.activeElement;
  const key = a?.closest?.("#detail") ? a.dataset.focus : null;
  renderPlaceView();
  if (key) document.querySelector(`#detail [data-focus="${key}"]`)?.focus({ preventScroll: true });
}

/** GET /api/cred, then draw the view again (if it's still open). */
async function loadCred() {
  credView.loading = true;
  try {
    credView.summary = await accountFetch("GET", "/api/cred");
    credView.error = "";
    noteCredLevel(credView.summary);
    noteTrusted(credView.summary.trusted);
  } catch (e) {
    credView.error = errorText(e);
  } finally {
    credView.loading = false;
  }
  drawCredIfOpen();
}

/** The account's level and total as the menu's badge shows them, from any answer that has them. */
function noteCredLevel(c) {
  if (!account.me || !c) return;
  const before = account.me.cred?.level;
  account.me.cred = { ...(account.me.cred ?? {}), total: c.total, level: c.level, ...(c.trusted === undefined ? {} : { trusted: c.trusted }) };
  if (before !== c.level) renderAccountMenu();
}

// --- the toast ---

const toastState = { timer: 0, node: null };
const TOAST_MS = 3000;

/**
 * A short line above the tabs for 3 s ("+5 street cred"). A manual popover, so it shows over an open dialog (the
 * feedback form stays open after sending) as well as over the page.
 */
function showToast(text) {
  let t = toastState.node;
  if (!t) {
    t = el("div", { id: "toast", class: "toast", role: "status", "aria-live": "polite", popover: "manual" });
    document.body.append(t);
    toastState.node = t;
  }
  clearTimeout(toastState.timer);
  t.textContent = "";
  try {
    if (t.matches(":popover-open")) t.hidePopover();
    t.showPopover();
  } catch {
    t.classList.add("shown"); // no popovers in this browser: a plain fixed box
  }
  // The text after it's shown, so screen readers announce the change.
  setTimeout(() => (t.textContent = text), 30);
  toastState.timer = setTimeout(() => {
    try {
      t.hidePopover();
    } catch {
      t.classList.remove("shown");
    }
  }, TOAST_MS);
}

/**
 * An answer's `cred` ({ points, total, level }): "+5 street cred" when it earned something (with the level-up and its
 * unlock), and the menu's badge follows. Every action that can earn calls this with its answer's `cred`.
 */
/** Street cred was taken back (a report or rating removed): the view reads its numbers again when it's shown. */
function forgetCred() {
  if (!accountReady()) return;
  credView.summary = null;
  credView.log = null;
  credView.board.data = {};
  if (credShown()) loadCred();
}

function credEarned(cred) {
  if (!cred || !accountReady()) return;
  const before = account.me.cred?.level ?? null;
  noteCredLevel(cred);
  const text = credToastText(cred, before);
  if (!text) return;
  // The view's numbers are old now: read again when it's shown.
  credView.summary = null;
  credView.log = null;
  credView.board.data = {};
  if (credShown()) loadCred();
  showToast(text);
}

/** The invites' WhatsApp and Copy link (app.js inviteControl): 3 street cred, signed in. Never in the invite's way. */
function credInvite(kind) {
  if (!kind || !accountReady() || navigator.onLine === false) return;
  accountFetch("POST", "/api/cred/invite", { kind }).then((r) => credEarned(r?.cred), () => { /* the invite went out anyway */ });
}

// "You're a trusted reporter now": the 20th 👍 comes from someone else's vote, so the page notices it in /api/me or
// /api/cred and says so once per browser and account (decision 26).
const TRUSTED_KEY = "frooms-trusted";

function noteTrusted(trusted) {
  if (!accountReady() || trusted === undefined) return;
  const user = account.me.username;
  let seen = null;
  try {
    seen = localStorage.getItem(TRUSTED_KEY);
  } catch { /* storage unavailable: say nothing rather than say it every time */ return; }
  try {
    if (trusted && seen !== user) {
      localStorage.setItem(TRUSTED_KEY, user);
      showToast("You're a trusted reporter now");
    } else if (!trusted && seen === user) localStorage.removeItem(TRUSTED_KEY);
  } catch { /* as above */ }
}

// --- the view ---

/** One log line: what earned it, when, and "+5". */
function credEntry(e) {
  return el("li", { class: "cred-entry" },
    el("span", { class: "cred-what" }, el("span", { class: "cred-label" }, e.label), el("span", { class: "cred-when muted" }, credWhen(e.at))),
    el("span", { class: "cred-pts", "aria-label": `plus ${e.points} street cred` }, `+${e.points}`));
}

const HOW_TO_EARN = [
  ["friend", "Becoming friends with someone", "for both of you, taken back when the friendship ends"],
  ["checkin", "Checking in", "up to 4 a day, not again at the same place within 2 hours"],
  ["report", "Reporting how full a place is", "up to 10 a day"],
  ["report_liked", "A 👍 on a report you sent", "each, taken back when it turns 👎"],
  ["report_vote", "Rating someone's report 👍 or 👎", "once per report, up to 20 a day"],
  ["invite", "Inviting people (WhatsApp or Copy link)", "up to 5 a day"],
  ["problem", "Reporting a problem", "up to 3 a day"],
  ["feedback", "Sending an idea or other feedback", "1 a day"],
  ["meal_rating", "Rating a dish", "once per dish, up to 5 a day"],
  ["bug", "Reporting a bug (Report a bug, in the menu)", "once we've checked it"],
];

function howToEarn() {
  const rows = HOW_TO_EARN.map(([action, what, rule]) => el("li", { class: "cred-entry" },
    el("span", { class: "cred-what" }, el("span", { class: "cred-label" }, what), el("span", { class: "cred-when muted" }, rule)),
    el("span", { class: "cred-pts" }, `+${CRED_POINTS[action]}`)));
  const unlocks = Object.entries(CRED_UNLOCKS).map(([l, u]) => `level ${l} ${u.toLowerCase()}`).join(", ");
  const d = el("details", { class: "detail-part cred-how", "data-tour": "cred-how" }, el("summary", {}, el("h3", {}, "How to earn street cred")),
    el("ul", { class: "cred-list" }, ...rows),
    el("p", { class: "muted small" }, `Only signed in: what you do signed out earns nothing. Your level counts all your street cred: level 2 at 100, and each level after takes 50 more than the one before (250, 450, 700, 1000 …), up to level ${CRED_MAX_LEVEL}.`),
    el("p", { class: "muted small" }, `Your bubble gets new looks: ${unlocks}. More rewards later.`));
  d.open = credView.howOpen;
  d.addEventListener("toggle", () => (credView.howOpen = d.open));
  return d;
}

/** Recent and All-time, the level with its bar and the next unlock, your bubble, the trusted reporter's progress. */
function credTotals(s) {
  const prog = levelProgress(s.total);
  const unlock = nextUnlockText(s.level);
  const bar = el("div", { class: "cred-bar", role: "progressbar", "aria-label": `Level ${s.level}`, "aria-valuemin": String(prog.from), "aria-valuemax": String(prog.to ?? prog.from), "aria-valuenow": String(s.total) },
    el("span", { class: "cred-bar-fill" }));
  bar.firstChild.style.width = `${Math.round(Math.min(1, Math.max(0, prog.fraction)) * 1000) / 10}%`;
  const trusted = s.trusted
    ? el("p", { class: "cred-trusted" }, el("img", { src: "/icons/trusted.svg", alt: "", width: "20", height: "20" }), el("span", {}, el("strong", {}, "Trusted reporter"),
      el("span", { class: "muted" }, ": your reports are marked in the Report log.")))
    : el("p", { class: "cred-trusted muted" }, `${s.likes ?? 0} of ${TRUSTED_LIKES} 👍 to become a trusted reporter`);
  return el("section", { class: "detail-part cred-totals", "data-tour": "cred-totals" },
    el("div", { class: "cred-top" },
      el("div", { class: "cred-figs" },
        el("div", { class: "cred-fig" }, el("span", { class: "cred-num" }, String(s.recent)), el("span", { class: "cred-fig-label" }, "Recent", el("span", { class: "muted" }, " · last 30 days"))),
        el("div", { class: "cred-fig" }, el("span", { class: "cred-num" }, String(s.total)), el("span", { class: "cred-fig-label" }, "All-time"))),
      el("div", { class: "cred-me" }, bubble(account.me, "big"), el("span", { class: "cred-level" }, `Level ${s.level}`))),
    el("div", { class: "cred-progress" },
      bar,
      el("p", { class: "cred-next" }, prog.top ? el("span", {}, `Top level: ${CRED_MAX_LEVEL}`) : el("span", {}, `${prog.toGo} to level ${s.level + 1}`),
        el("span", { class: "muted" }, unlock ?? "More rewards later"))),
    trusted);
}

/** The 5 latest entries and "Show more" (the full list in the same sheet; Back returns). */
function credLatest(s) {
  const more = el("button", { type: "button", class: "sheet-link" }, "Show more →");
  more.addEventListener("click", () => openPlace({ kind: "account", id: "cred:log" }, { from: "stack", opener: more }));
  return el("section", { class: "detail-part" },
    el("h3", {}, "Latest"),
    s.latest.length ? el("ul", { class: "cred-list" }, ...s.latest.map(credEntry))
      : el("p", { class: "muted" }, "Nothing yet. Check in, report how full a place is, rate a dish or add a friend to earn your first street cred."),
    s.latest.length ? more : null);
}

/** Your bug reports (worker/bugs.ts), when you sent any: waiting, rewarded, or not rewarded with the reason. */
function credBugs(s) {
  if (!s.bugs?.length) return null;
  const row = (b) => {
    const status = b.status === "rewarded" ? el("span", { class: "cred-pts" }, `+${CRED_POINTS.bug}`)
      : el("span", { class: `bug-status ${b.status}` }, b.status === "pending" ? "Reward pending" : "Not rewarded");
    return el("li", { class: "cred-entry" },
      el("span", { class: "cred-what" }, el("span", { class: "cred-label" }, b.summary), el("span", { class: "cred-when muted" }, credWhen(b.at)),
        b.status === "declined" && b.reason ? el("span", { class: "bug-reason" }, b.reason) : null),
      status);
  };
  return el("section", { class: "detail-part" }, el("h3", {}, "Your bug reports"), el("ul", { class: "cred-list" }, ...s.bugs.map(row)));
}

/** The leaderboards: the opt-in, or Recent / All-time with your row, and leaving. */
function credBoards(s) {
  const b = credView.board;
  const part = el("section", { class: "detail-part cred-boards" }, el("h3", {}, "Leaderboards"));
  const msg = el("p", { class: "form-error", role: "alert" }, b.error);
  if (!s.board) {
    const join = el("button", { type: "button", class: "done-btn primary-action", "data-focus": "join" }, "Join the leaderboards");
    join.disabled = b.busy;
    join.addEventListener("click", () => setBoard(true));
    part.append(
      el("p", {}, `Show your username and name (${account.me.name}) with your street cred to other frooms users who also take part. Only they can see the leaderboards.`),
      el("p", {}, join), msg);
    return part;
  }
  const range = b.range;
  const sw = switcher(["recent", "all"], { recent: "Recent", all: "All-time" }, range, (r) => {
    b.range = r;
    drawCredIfOpen();
  }, "Leaderboard");
  sw.querySelectorAll(".chip").forEach((c, i) => (c.dataset.focus = `range-${i}`));
  part.append(sw);
  const data = b.data[range];
  if (!data) {
    if (b.loading !== range) loadBoard(range);
    part.append(el("p", { class: "muted" }, b.error ? "" : "Loading…"), msg);
  } else {
    const row = (r) => el("li", { class: `cred-row${r.me ? " me" : ""}` },
      el("span", { class: "cred-rank" }, String(r.rank)),
      bubble(r.bubble, "small"),
      el("span", { class: "person-text" }, el("span", { class: "person-user" }, r.username), el("span", { class: "person-name muted" }, r.name)),
      el("span", { class: "cred-row-pts" }, String(r.points)));
    // Everyone who joined, in a box that shows 10 and scrolls; the next 50 load as the end comes into view. Your own
    // row stays below the box until its page has loaded.
    const rows = data.rows.map(row);
    if (data.more || b.loading === range) rows.push(el("li", { class: "cred-gap muted" }, "Loading…"));
    const listed = data.rows.some((r) => r.me);
    const list = el("ol", { class: "cred-board", "aria-label": range === "recent" ? "Recent leaderboard" : "All-time leaderboard" }, ...rows);
    const box = el("div", { class: "cred-board-box" }, list);
    box.addEventListener("scroll", () => {
      b.scroll[range] = box.scrollTop;
      if (data.more && b.loading !== range && box.scrollTop + box.clientHeight >= box.scrollHeight - 120) loadBoard(range, true);
    }, { passive: true });
    // Sized once it's on the page: the 11th row's top, so exactly 10 show.
    requestAnimationFrame(() => {
      if (list.children.length > 10) box.style.maxHeight = `${list.children[10].offsetTop}px`;
      box.scrollTop = b.scroll[range] ?? 0;
    });
    const mine = !listed && data.you.rank
      ? el("ol", { class: "cred-board cred-board-me", start: String(data.you.rank), "aria-label": "Your place" },
        row({ rank: data.you.rank, bubble: account.me, username: account.me.username, name: account.me.name, points: data.you.points, me: true }))
      : null;
    part.append(rows.length ? box : el("p", { class: "muted" }, "Nobody here yet."), mine);
    if (!data.you.rank) part.append(el("p", { class: "muted small" }, range === "recent" ? "You're listed once you earn street cred in the last 30 days." : "You're listed once you earn street cred."));
    part.append(el("p", { class: "muted small" }, range === "recent" ? "Street cred of the last 30 days. Equal scores: whoever got there first." : "All street cred. Equal scores: whoever got there first."));
    part.append(msg);
  }
  const leave = el("button", { type: "button", class: "sheet-link cred-leave", "data-focus": "leave" }, "Leave the leaderboards");
  leave.disabled = b.busy;
  leave.addEventListener("click", async () => {
    const ok = await askConfirm({ title: "Leave the leaderboards?", body: ["Others no longer see you there, and you no longer see the leaderboards. You can join again any time."], yes: "Leave" });
    if (ok) setBoard(false);
    else leave.focus();
  });
  part.append(el("p", {}, leave));
  return part;
}

/** The leaderboard of `range`; `next`: its next 50 after those loaded, added to them. */
async function loadBoard(range, next = false) {
  const b = credView.board;
  const had = next ? b.data[range] : null;
  b.loading = range;
  try {
    const after = had?.rows.at(-1)?.rank ?? 0;
    const page = await accountFetch("GET", `/api/cred/board?range=${range}${after ? `&after=${after}` : ""}`);
    b.data[range] = had ? { ...page, rows: [...had.rows, ...page.rows] } : page;
    if (!had) b.scroll[range] = 0;
    b.error = "";
  } catch (e) {
    b.error = errorText(e);
    if (e.message === "not_on_board" && credView.summary) credView.summary.board = false;
  } finally {
    b.loading = "";
  }
  drawCredIfOpen();
}

async function setBoard(on) {
  const b = credView.board;
  b.busy = true;
  b.error = "";
  drawCredIfOpen();
  try {
    await accountFetch("PUT", "/api/cred/board", { on });
    if (credView.summary) credView.summary.board = on;
    b.data = {};
  } catch (e) {
    b.error = errorText(e);
  } finally {
    b.busy = false;
  }
  drawCredIfOpen();
  // The focus where the change happened: the switch after joining, the join button after leaving.
  setTimeout(() => document.querySelector(on ? ".cred-boards .switch .chip.on" : ".cred-boards .primary-action")?.focus({ preventScroll: true }), 0);
}

accountViews.cred = (box, sub) => {
  if (!accountReady()) return signedIn() ? accountViews.welcome(box) : accountViews.signin(box);
  if (sub === "log") return drawCredLog(box);
  $("#sheet-title").textContent = "frooms Street cred";
  const s = credView.summary;
  if (!s) {
    if (!credView.loading) loadCred();
    return fill(box, credView.error ? el("p", { class: "message warning", role: "alert" }, credView.error) : el("p", { class: "muted" }, "Loading…"));
  }
  fill(box, el("div", { class: "cred-view" }, credLatest(s), credTotals(s), credBugs(s), howToEarn(), credBoards(s)));
};

// --- the full log ---

/** The first page (a day's or all), or the next one after the last entry shown (`more`). */
async function loadCredLog(more = false) {
  const log = credView.log;
  log.loading = true;
  log.error = "";
  const q = new URLSearchParams();
  if (log.day) q.set("day", log.day);
  if (more && log.entries.length) q.set("before", String(log.entries[log.entries.length - 1].id));
  const day = log.day;
  try {
    const r = await accountFetch("GET", `/api/cred/log${q.size ? `?${q}` : ""}`);
    if (credView.log !== log || log.day !== day) return; // the filter changed meanwhile
    log.entries = more ? [...log.entries, ...r.entries] : r.entries;
    log.more = r.more;
    if (r.days) log.days = r.days; // every first page lists all the days with entries, a day's too
  } catch (e) {
    log.error = errorText(e);
  } finally {
    log.loading = false;
  }
  drawCredIfOpen();
}

function pickLogDay(day) {
  const log = credView.log;
  log.day = day;
  log.entries = [];
  log.more = false;
  credView.pickerOpen = false;
  loadCredLog();
  drawCredIfOpen();
  setTimeout(() => document.querySelector(".cred-filter .time-btn")?.focus({ preventScroll: true }), 0);
}

function drawCredLog(box) {
  $("#sheet-title").textContent = "Your street cred";
  if (!credView.log) {
    credView.log = { day: null, entries: [], more: false, days: null, loading: false, error: "" };
    credView.pickerOpen = false;
    loadCredLog();
  }
  const log = credView.log;
  const days = log.days ?? [];
  const dayBtn = el("button", { type: "button", class: "time-btn", "data-focus": "day", "aria-expanded": String(credView.pickerOpen), "aria-label": `Day: ${log.day ? pickerLongDate(log.day) : "all days"}` },
    log.day ? pickerLongDate(log.day) : "All days");
  dayBtn.disabled = !days.length;
  dayBtn.addEventListener("click", () => {
    credView.pickerOpen = !credView.pickerOpen;
    drawCredIfOpen();
    if (credView.pickerOpen) setTimeout(() => document.querySelector(".cred-filter .cal")?.focusDay(), 0);
  });
  const all = log.day ? chip("All days", false, () => pickLogDay(null)) : null;
  const filter = el("div", { class: "cred-filter" }, el("span", { class: "cred-filter-label muted" }, "Day"), el("div", { class: "row" }, dayBtn, all));
  if (credView.pickerOpen && days.length) {
    const set = new Set(days);
    const cal = datePicker({
      value: log.day ?? days[0], min: days[days.length - 1], max: days[0], allowed: (d) => set.has(d),
      onPick: (d) => pickLogDay(d),
      onClose: () => {
        credView.pickerOpen = false;
        renderPlaceView();
        setTimeout(() => document.querySelector(".cred-filter .time-btn")?.focus({ preventScroll: true }), 0);
      },
    });
    filter.append(el("div", { class: "picker" }, cal));
  }
  const more = el("button", { type: "button", class: "detail-action", "data-focus": "more" }, log.loading && log.entries.length ? "Loading…" : "Show more");
  more.disabled = log.loading;
  more.addEventListener("click", () => loadCredLog(true));
  const list = log.entries.length ? el("ul", { class: "cred-list" }, ...log.entries.map(credEntry))
    : el("p", { class: "muted" }, log.loading ? "Loading…" : log.error ? "" : log.day ? "Nothing on that day." : "Nothing yet.");
  fill(box, el("div", { class: "cred-view" },
    el("section", { class: "detail-part" }, filter),
    el("section", { class: "detail-part", "aria-live": "polite" }, list,
      log.error ? el("p", { class: "message warning", role: "alert" }, log.error) : null,
      log.more ? el("p", {}, more) : null)));
}

function initCred() {
  account.listeners.push(() => {
    if (!accountReady()) {
      credView.summary = null;
      credView.log = null;
      credView.board = { range: "recent", data: {}, loading: "", error: "", busy: false, scroll: {} };
      return;
    }
    noteTrusted(account.me.cred?.trusted);
    if (credShown() && !credView.summary && !credView.loading) renderPlaceView();
  });
}
