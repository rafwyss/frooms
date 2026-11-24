"use strict";

// Accounts on the page (plans/PLAN_ACCOUNTS.md, section 8): the account button at the right of the top bar and its
// menu, signing in with edu-ID, the first sign-in's profile step, Profile, Account (sign out, delete) and the stars kept
// with the account (7.4). Signing in is a plain link to /auth/login: a top-level navigation, no third-party script, so
// the CSP stays as it is. Colours are set through element.style, never inline in the markup.
//
// The views are detail views of kind "account" in the sheet (places.js): { kind: "account", id: "signin" | "welcome" |
// "profile" | "account" | … }, without an address of their own, so Back, the history and the sheet work as for "Near
// you". friends.js and checkin.js add their own views to `accountViews`. Loaded after places.js, before app.js.

const account = {
  status: "unknown", // "unknown" (not asked yet), "out", "in", "off" (no sign-in on this host) or "error"
  me: null, // GET /api/me's answer while signed in
  hash: null, // what the sign-in left in the address, read once: { welcome: true } or { error: code }
  loadedAt: 0,
  starsTimer: 0, // the next PUT /api/me/stars
  starsSentAt: 0,
  listeners: [], // called after every change of `status` or `me` (the You tab, the map, the check-in button)
};

/** The views in the sheet, by id ("friends:raffi" calls accountViews.friends with "raffi"). */
const accountViews = {};

const SIGNIN_ERRORS = {
  cancelled: "Sign-in was cancelled.",
  expired: "The sign-in took too long or was started in another tab. Please try again.",
  not_member: "frooms is for ETH and UZH members. Your edu-ID isn't linked to either.",
  failed: "Sign-in didn't work. Please try again.",
  unavailable: "edu-ID can't be reached right now. Please try again in a few minutes.",
};

/** The Worker's error codes ({ detail: code }) in words. */
const ACCOUNT_ERRORS = {
  offline: "You're offline.",
  network: "Couldn't reach frooms. Please try again.",
  signed_out: "You're signed out. Sign in again to go on.",
  profile_needed: "Finish setting up your account first.",
  username_taken: "That username is taken.",
  bad_username: "Usernames are 3 to 20 letters a–z, digits, “_” or “.”.",
  bad_colour: "Pick two colours.",
  low_contrast: "Those colours are too hard to read together.",
  locked: "That bubble style needs a higher Street cred level.",
  bad_style: "Pick either a metal or gradient colours.",
  too_many_requests: "Too many requests right now, try again in a minute.",
  too_many_friend_requests: "That's 30 friend requests today, the most for a day. Try again tomorrow.",
  too_many_friends: "That's 300 friends, the most an account can have.",
  no_such_person: "frooms doesn't know that person (any more).",
  no_such_request: "That request isn't there any more.",
  unknown_place: "frooms doesn't list that place (any more).",
  bad_until: "Pick an end time within the next 12 hours.",
  no_checkin: "You aren't checked in any more.",
  sign_in_off: "Sign-in works on frooms.ch only.",
  no_such_report: "That report is older than 4 hours now.",
  own_report: "That's your own report.",
  no_such_dish: "That dish isn't on the menu any more.",
  not_rateable: "Dishes can be rated on their day and the day after.",
  bad_rating: "Set at least one category, from −5 to 5.",
  tour: "In the tutorial nothing is sent.",
};

const errorText = (e) => ACCOUNT_ERRORS[e?.message] ?? (e?.status >= 500 ? "Something went wrong. Please try again." : e?.message || "Something went wrong.");

/** SWITCH's own sign-out (decision 14: signing out of frooms leaves the edu-ID session as it is). */
const EDUID_LOGOUT = "https://login.eduid.ch/idp/profile/Logout";

const PERSON_ICON = "M8 2.3a2.7 2.7 0 1 1 0 5.4 2.7 2.7 0 0 1 0-5.4zM2.6 14c.4-2.9 2.6-4.5 5.4-4.5s5 1.6 5.4 4.5";

const signedIn = () => account.status === "in" && !!account.me;
/** Signed in with the profile step done: everything else needs that. */
const accountReady = () => signedIn() && !account.me.profile_needed;

// --- requests ---

/**
 * A request to the account endpoints: the answer's JSON (null for 204), or an Error whose message is the Worker's
 * code (`detail`) and `status` the HTTP status. A 401 means the session ended: the page is signed out at once.
 */
async function accountFetch(method, url, body = undefined) {
  // While the tutorial runs only reading and your own stars go out (plans/PLAN_TUTORIAL.md, section 6): everything else
  // fails with "tour", which every caller shows as ACCOUNT_ERRORS.tour in place of its confirmation.
  if (typeof tourActive === "function" && tourActive() && method !== "GET" && !(method === "PUT" && url === "/api/me/stars")) {
    const e = new Error("tour");
    e.status = 0;
    throw e;
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const e = new Error(navigator.onLine === false ? "offline" : "network");
    e.status = 0;
    throw e;
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.detail || `HTTP ${res.status}`);
    e.status = res.status;
    if (res.status === 401 && account.status === "in") setSignedOut();
    throw e;
  }
  return data;
}

/** The person as /api/me says, or as signed out (401), or sign-in off on this host (404). Asked again at most once a minute. */
async function loadMe({ force = false } = {}) {
  if (!force && Date.now() - account.loadedAt < 60_000) return;
  if (navigator.onLine === false) return renderAccountButton();
  account.loadedAt = Date.now();
  let res;
  try {
    res = await fetch("/api/me");
  } catch {
    return renderAccountButton();
  }
  if (res.status === 401) {
    if (account.status !== "out") setSignedOut();
    else accountChanged();
    return;
  }
  if (res.status === 404) {
    account.status = "off";
    account.me = null;
  } else if (res.ok) {
    const me = await res.json().catch(() => null);
    if (!me) return;
    account.me = me;
    account.status = "in";
    syncAccountStars();
  } else {
    account.status = account.me ? account.status : "error";
  }
  accountChanged();
}

function setSignedOut() {
  account.status = "out";
  account.me = null;
  clearTimeout(account.starsTimer);
  // The browser keeps its copy of the stars; the next sign-in merges them again (plan 7.4).
  saveAccountPrefs({});
  accountChanged();
}

/** After every change: the button, an open account view that shows the state, and the listeners. */
function accountChanged() {
  renderAccountButton();
  const p = placesView.current;
  if (p?.kind === "account") {
    const view = p.id.split(":")[0];
    if (view === "welcome" && accountReady()) placeBack();
    else if (["signin", "account"].includes(view)) renderPlaceView(); // the others draw themselves (forms keep their typing)
  }
  for (const fn of account.listeners) fn();
}

// --- the account button and its menu ---

/**
 * A person's bubble: their initials in their colours (others: { initials, bg, fg, bg2, fg2, metal }). Gradients and
 * metals (Street cred's unlocks, lib.js bubbleLook) go in as custom properties through the CSSOM (the CSP allows no
 * style attributes); gradient letters are an inner span clipped to its text.
 */
function bubble(p, cls = "") {
  const b = el("span", { class: `bubble ${cls}`.trim(), "aria-hidden": "true" }, el("span", { class: "bubble-letters" }, p?.initials || "?"));
  const look = bubbleLook(p);
  if (look) {
    b.classList.add("styled");
    b.style.setProperty("--bubble-bg", look.background);
    b.style.setProperty("--bubble-fg", look.color);
    if (look.text) {
      b.classList.add("grad-text");
      b.style.setProperty("--bubble-text", look.text);
    }
    if (look.metal) b.classList.add("metal", `metal-${look.metal}`);
  }
  return b;
}

function renderAccountButton() {
  const b = $("#account");
  if (!b) return;
  const me = signedIn() ? account.me : null;
  const offline = navigator.onLine === false;
  const waiting = (me?.requests ?? 0) > 0;
  const dot = !!me && (me.profile_needed || waiting);
  b.classList.toggle("offline", offline);
  b.classList.toggle("signed-in", !!me);
  fill(b, me ? bubble(me) : smallIcon(PERSON_ICON), dot ? el("span", { class: "account-dot" }) : null);
  const label = !me ? (offline ? "Menu (offline)" : "Menu and sign in")
    : me.profile_needed ? "Finish setting up your account"
    : `Your account, ${me.username}${waiting ? `: ${plural(me.requests, "friend request", "friend requests")}` : ""}`;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.setAttribute("aria-haspopup", "menu");
  renderAccountMenu();
}

/**
 * The menu below the account button, for everyone. Signed in: Friends (with the number of requests), frooms Street
 * cred (with the level), Profile, Account. Signed out: just "Sign in" (the sign-in view); signed in without the
 * profile step done: "Finish setting up" (the welcome view). Then a line, and About frooms., Tutorial, Send feedback,
 * Report a bug (+50), Contact, Privacy (the You tab's footer links, which stay there too, without Report a bug).
 */
function renderAccountMenu() {
  const menu = $("#account-menu");
  const me = accountReady() ? account.me : null;
  const action = (content, onClick, label = null) => {
    const b = el("button", { type: "button", role: "menuitem" }, ...content);
    if (label) b.setAttribute("aria-label", label);
    b.addEventListener("click", () => {
      closeAccountMenu();
      onClick();
    });
    return b;
  };
  // Back puts the focus on the account button again.
  const item = (text, id, extra = null) => action([el("span", {}, text), extra], () => openAccountView(id, $("#account")));
  const privacy = el("a", { href: "/privacy", role: "menuitem" }, "Privacy");
  const yours = me ? [
    el("div", { class: "account-who", "aria-hidden": "true" }, bubble(me), el("span", {}, el("strong", {}, me.username), el("span", { class: "muted" }, me.name))),
    accountViews.friends ? markTour(item("Friends", "friends", me.requests ? el("span", { class: "count-badge", "aria-label": plural(me.requests, "request", "requests") }, String(me.requests)) : null), "menu-friends") : null,
    accountViews.cred ? markTour(action([el("span", { class: "nowrap" }, "frooms Street cred"), el("span", { class: "level-badge", "aria-hidden": "true" }, `Lv ${me.cred?.level ?? 1}`)],
      () => openAccountView("cred", $("#account")), `frooms Street cred, level ${me.cred?.level ?? 1}`), "menu-cred") : null,
    item("Profile", "profile"),
    item("Account", "account"),
  ] : signedIn() ? [item("Finish setting up", "welcome")]
    : [markTour(action([el("span", {}, "Sign in")], () => openAccountView("signin", $("#account"))), "menu-signin")];
  fill(menu,
    ...yours,
    el("div", { class: "menu-sep", role: "separator" }),
    action([el("span", {}, "About ", wordmarkText())], () => openAccountView("about", $("#account")), "About frooms"),
    markTour(action([el("span", {}, "Tutorial")], () => tourLoad()), "menu-tutorial"),
    action([el("span", {}, "Send feedback")], () => openFeedback()),
    // A bug report earns 50 once an admin has checked it (bugs.js, worker/bugs.ts); signed out it says so in the form.
    action([el("span", {}, "Report a bug"), el("span", { class: "level-badge bug-badge", "aria-hidden": "true" }, `+${CRED_POINTS.bug}`)],
      () => startBugReport(), `Report a bug, ${CRED_POINTS.bug} street cred once we've checked it`),
    item("Contact", "contact"),
    privacy,
  );
}

/** "frooms." as the logo writes it (the wordmark's font, navy in light, white in dark, the red dot). */
const wordmarkText = () => el("span", { class: "wordmark" }, "frooms", el("span", { class: "dot" }));

function closeAccountMenu() {
  const menu = $("#account-menu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $("#account").setAttribute("aria-expanded", "false");
}

function accountTapped(e) {
  e.stopPropagation();
  const menu = $("#account-menu");
  if (menu.hidden) openAccountMenu();
  else closeAccountMenu();
}

/** Open the menu (the account button, or the first-visit window's Skip pointing at its Tutorial). */
function openAccountMenu({ focus = true } = {}) {
  const menu = $("#account-menu");
  closeCampusMenu();
  renderAccountMenu();
  menu.hidden = false;
  $("#account").setAttribute("aria-expanded", "true");
  if (focus) menu.querySelector("[role=menuitem]")?.focus();
}

/**
 * Open an account view in the sheet. From another account view it replaces that one (Back goes where it came from),
 * from a place's view it stacks, from the list it's a new entry.
 */
function openAccountView(id, opener = null) {
  const cur = placesView.current;
  const from = cur?.kind === "account" ? "place" : cur ? "stack" : "list";
  return openPlace({ kind: "account", id }, { from, opener });
}

/** Draw an account view (places.js renderPlaceView). */
function renderAccountView(box, p) {
  const [view, ...rest] = p.id.split(":");
  box.dataset.key = `account|${p.id}`;
  const draw = accountViews[view] ?? accountViews.signin;
  draw(box, rest.join(":"));
}

// --- signing in ---

const loginUrl = () => `/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`;

/** "Sign in with edu-ID" with what it means, or why it can't be done here. `why` is a sentence above it. */
function signInBlock(why = null) {
  const parts = [];
  if (why) parts.push(el("p", { class: "signin-why" }, why));
  if (account.status === "off") {
    parts.push(el("p", { class: "message" }, "Sign-in works on frooms.ch only (and on frooms' accounts preview)."));
    return el("div", { class: "signin" }, ...parts);
  }
  if (navigator.onLine === false) {
    parts.push(el("p", { class: "message" }, "You're offline. Signing in needs a connection."));
    return el("div", { class: "signin" }, ...parts);
  }
  const link = el("a", { class: "signin-btn", href: loginUrl() }, el("span", { class: "eduid-mark", "aria-hidden": "true" }, "edu"), el("span", {}, "Sign in with edu-ID"));
  parts.push(link,
    el("p", { class: "muted signin-note" }, "Use the edu-ID you use for ETH or UZH. frooms only gets your name, university and email address."),
    el("p", { class: "signin-links" }, el("a", { href: "/privacy" }, "Privacy notice")));
  return el("div", { class: "signin" }, ...parts);
}

accountViews.signin = (box) => {
  $("#sheet-title").textContent = signedIn() ? "Account" : "Sign in";
  const error = account.hash?.error;
  const msg = error ? el("p", { class: "message warning", role: "alert" }, SIGNIN_ERRORS[error] ?? SIGNIN_ERRORS.failed) : null;
  if (accountReady()) {
    fill(box, el("p", {}, `You're signed in as ${account.me.username}.`), accountLink("Your account", "account"));
    return;
  }
  const tour = el("button", { type: "button", class: "sheet-link" }, "Take the tour");
  // The tour closes this view itself (tutorial.js: account views aren't brought back at its end).
  tour.addEventListener("click", () => tourLoad());
  fill(box, msg,
    el("p", { class: "signin-lead" }, "With an account your stars are kept on every device, and you can add friends and check in, so they see where you study."),
    signInBlock(),
    el("p", { class: "signin-tour" }, "New to frooms? ", tour));
};

/** A link-styled button to another account view. */
function accountLink(text, id) {
  const b = el("button", { type: "button", class: "sheet-link" }, `${text} →`);
  b.addEventListener("click", () => openAccountView(id));
  return b;
}

// --- the profile step and Profile ---

/** What the profile form holds while it's open (kept across redraws). */
const profileDraft = { username: "", bg: "", fg: "", bg2: null, fg2: null, metal: null, check: { name: "", text: "", ok: null }, seq: 0, timer: 0, error: "", saved: false, for: null };

function resetProfileDraft(welcome) {
  const me = account.me;
  const colours = me.bg && me.fg ? { bg: me.bg, fg: me.fg, bg2: me.bg2 ?? null, fg2: me.fg2 ?? null, metal: me.metal ?? null } : { ...randomBubble(), bg2: null, fg2: null, metal: null };
  Object.assign(profileDraft, { username: me.username ?? "", ...colours, check: { name: "", text: "", ok: null }, error: "", saved: false, board: false, for: welcome ? "welcome" : "profile" });
}

accountViews.welcome = (box) => {
  if (!signedIn()) return accountViews.signin(box);
  if (accountReady()) return accountViews.profile(box);
  $("#sheet-title").textContent = `Welcome, ${account.me.first_name}`;
  if (profileDraft.for !== "welcome") resetProfileDraft(true);
  fill(box, ...profileForm(true));
};

accountViews.profile = (box) => {
  if (!signedIn()) return accountViews.signin(box);
  if (!accountReady()) return accountViews.welcome(box);
  $("#sheet-title").textContent = "Profile";
  if (profileDraft.for !== "profile") resetProfileDraft(false);
  fill(box, ...profileForm(false));
};

const darkMode = () => matchMedia("(prefers-color-scheme: dark)").matches;

/** The open profile form's redraw, so its swatches follow a switch between light and dark mode. */
let redrawProfileColours = null;
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => redrawProfileColours?.());

/**
 * A colour wheel: hue around the circle (red to the right, as in most wheels), saturation from the white centre out,
 * and a slider under it for the brightness (white to black). `get()` is the colour to show ("#rrggbb"), `onChange`
 * gets each picked colour. Drag or tap the wheel; with the keyboard, the arrows turn the hue (left, right) and the
 * saturation (up, down). Returns { node, sync }; sync() follows a colour set from elsewhere (a swatch).
 */
function colourWheel(label, get, onChange) {
  const SIZE = 220; // CSS pixels; the canvas has the device's pixels
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const canvas = el("canvas", { class: "wheel-canvas", tabindex: "0", role: "application", "aria-label": `${label}: colour wheel. Arrows left and right change the hue, up and down the saturation.` });
  canvas.width = canvas.height = Math.round(SIZE * ratio);
  const slider = el("input", { type: "range", class: "wheel-bright", min: "0", max: "100", step: "1", "aria-label": `${label}: brightness` });
  const hexOut = el("span", { class: "wheel-hex muted", "aria-live": "polite" });
  let hsv = hexToHsv(get());
  let last = get(); // the colour last shown, so a re-sync to the same colour keeps a grey's hue
  let disc = null; // the wheel at full brightness, drawn once

  const drawDisc = () => {
    const n = canvas.width;
    const r = n / 2;
    const img = new ImageData(n, n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - r;
        const dy = r - (y + 0.5);
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const hex = hsvToHex(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360, Math.min(1, d / (r - 1)), 1);
        const i = (y * n + x) * 4;
        img.data[i] = parseInt(hex.slice(1, 3), 16);
        img.data[i + 1] = parseInt(hex.slice(3, 5), 16);
        img.data[i + 2] = parseInt(hex.slice(5, 7), 16);
        img.data[i + 3] = d > r - 1 ? Math.round(255 * (r - d)) : 255; // a soft edge
      }
    }
    disc = img;
  };

  const draw = () => {
    if (!disc) drawDisc();
    const ctx = canvas.getContext("2d");
    const n = canvas.width;
    const r = n / 2;
    ctx.putImageData(disc, 0, 0);
    // Brightness darkens the whole wheel, as in the system pickers.
    if (hsv.v < 1) {
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = `rgba(0, 0, 0, ${1 - hsv.v})`;
      ctx.fillRect(0, 0, n, n);
      ctx.globalCompositeOperation = "source-over";
    }
    // The crosshair: a ring and four ticks, dark on light colours and light on dark ones.
    const a = (hsv.h * Math.PI) / 180;
    const cx = r + Math.cos(a) * hsv.s * (r - 1);
    const cy = r - Math.sin(a) * hsv.s * (r - 1);
    const shown = hsvToHex(hsv.h, hsv.s, hsv.v);
    ctx.strokeStyle = colourContrast(shown, "#000000") >= colourContrast(shown, "#ffffff") ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5 * ratio;
    const ring = 7 * ratio;
    ctx.beginPath();
    ctx.arc(cx, cy, ring, 0, Math.PI * 2);
    for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(cx + ux * ring * 0.4, cy + uy * ring * 0.4);
      ctx.lineTo(cx + ux * ring * 1.7, cy + uy * ring * 1.7);
    }
    ctx.stroke();
    slider.value = String(Math.round((1 - hsv.v) * 100));
    slider.style.setProperty("--wheel-track", `linear-gradient(to right, ${hsvToHex(hsv.h, hsv.s, 1)}, #000000)`);
    hexOut.textContent = shown;
    canvas.setAttribute("aria-valuetext", shown);
  };

  const emit = () => {
    last = hsvToHex(hsv.h, hsv.s, hsv.v);
    draw();
    onChange(last);
  };

  const pick = (e) => {
    const box = canvas.getBoundingClientRect();
    const r = box.width / 2;
    const dx = e.clientX - box.left - r;
    const dy = r - (e.clientY - box.top);
    hsv = { ...hsv, h: ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360, s: Math.min(1, Math.hypot(dx, dy) / r) };
    // Picking a hue on a black wheel would show nothing: bring the brightness up.
    if (hsv.v < 0.05) hsv.v = 1;
    emit();
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pick(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (canvas.hasPointerCapture(e.pointerId)) pick(e);
  });
  canvas.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 15 : 3;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") hsv = { ...hsv, h: (hsv.h + (e.key === "ArrowLeft" ? step : -step) + 360) % 360 };
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") hsv = { ...hsv, s: Math.max(0, Math.min(1, hsv.s + ((e.key === "ArrowUp" ? 1 : -1) * step) / 100)) };
    else return;
    e.preventDefault();
    emit();
  });
  slider.addEventListener("input", () => {
    hsv = { ...hsv, v: 1 - Number(slider.value) / 100 };
    emit();
  });

  const sync = () => {
    const c = get();
    if (c === last) return;
    last = c;
    const next = hexToHsv(c);
    // A grey has no hue of its own: keep the one shown, so the brightness slider doesn't jump the hue to red.
    hsv = next.s === 0 ? { ...next, h: hsv.h } : next;
    if (!panel.hidden) draw();
  };
  const panel = el("div", { class: "wheel-panel" }, canvas, el("div", { class: "wheel-bright-row" }, slider, hexOut));
  panel.hidden = true;
  return {
    node: panel,
    sync,
    open(on) {
      panel.hidden = !on;
      if (on) draw();
    },
  };
}

/**
 * A row of swatches and a colour wheel for one of the bubble's colours. `swatches()` gives the swatches (the
 * backgrounds' first one follows light and dark mode). For the gradients' second colours, `opts.none` (the wheel's
 * colour while unset) adds a "None" button first (a flat bubble), and `opts.level` is the Street cred level that
 * unlocks the row: below it the row is greyed with "Level N" and only "None" works (to drop a style kept from before,
 * plan 11.2).
 */
function colourRow(label, key, swatches, onChange, opts = {}) {
  const value = () => profileDraft[key];
  const shown = () => value() ?? (opts.none ? opts.none() : "#000000");
  const locked = (opts.level ?? 1) > myLevel();
  const buttons = swatches().map(() => {
    const b = el("button", { type: "button", class: "swatch" });
    b.disabled = locked;
    b.addEventListener("click", () => onChange(b.title));
    return b;
  });
  const none = opts.none ? el("button", { type: "button", class: "swatch-none", "aria-pressed": String(value() == null) }, "None") : null;
  none?.addEventListener("click", () => onChange(null));
  const wheel = colourWheel(label, shown, onChange);
  const wheelBtn = el("button", { type: "button", class: "swatch swatch-wheel", "aria-label": `${label}: colour wheel`, "aria-expanded": "false", title: "Colour wheel" });
  wheelBtn.disabled = locked;
  wheelBtn.addEventListener("click", () => {
    const open = wheelBtn.getAttribute("aria-expanded") !== "true";
    wheelBtn.setAttribute("aria-expanded", String(open));
    wheel.open(open);
  });
  const sync = () => {
    const list = swatches();
    buttons.forEach((b, i) => {
      b.title = list[i];
      b.style.background = list[i];
      b.setAttribute("aria-label", `${label} ${list[i]}`);
      b.setAttribute("aria-pressed", String(list[i] === value()));
    });
    if (none) {
      none.setAttribute("aria-pressed", String(value() == null));
      none.disabled = locked && value() == null;
    }
    // The wheel's button is marked when the colour is none of the swatches (one picked on the wheel).
    wheelBtn.setAttribute("aria-pressed", String(value() != null && !list.includes(value())));
    wheel.sync();
  };
  sync();
  const lock = locked ? el("span", { class: "lock-note" }, `Level ${opts.level}`) : null;
  return {
    node: el("div", { class: `field colour-field${locked ? " locked" : ""}` }, el("span", { class: "label" }, label, lock),
      el("div", { class: "swatches", role: "group", "aria-label": locked ? `${label}, unlocked at level ${opts.level}` : label }, none, ...buttons, wheelBtn),
      wheel.node),
    sync,
  };
}

/** Your Street cred level (from /api/me), 1 before any. */
const myLevel = () => account.me?.cred?.level ?? 1;

/**
 * The metals (levels 4 to 6, lib.js BUBBLE_METALS): a button each with your bubble in it. Locked ones are greyed with
 * "Level N"; the one you have stays clickable to drop it. Clicking the chosen one again goes back to your colours.
 */
function metalRow(onChange) {
  const me = account.me;
  const buttons = Object.entries(BUBBLE_METALS).map(([key, m]) => {
    const level = BUBBLE_STYLE_LEVELS[key];
    const locked = level > myLevel();
    const b = el("button", { type: "button", class: `metal-choice${locked ? " locked" : ""}`, "data-metal": key, "aria-pressed": String(profileDraft.metal === key),
      "aria-label": locked ? `${m.label}, unlocked at level ${level}` : m.label },
    bubble({ initials: me.initials, metal: key }, "small"), el("span", {}, m.label), locked ? el("span", { class: "lock-note" }, `Level ${level}`) : null);
    b.addEventListener("click", () => onChange(profileDraft.metal === key ? null : key));
    return b;
  });
  const sync = () => {
    for (const b of buttons) {
      const on = profileDraft.metal === b.dataset.metal;
      b.setAttribute("aria-pressed", String(on));
      b.disabled = b.classList.contains("locked") && !on;
    }
  };
  return { node: el("div", { class: "field colour-field" }, el("span", { class: "label" }, "Metal"), el("div", { class: "metal-choices", role: "group", "aria-label": "Metal" }, ...buttons)), sync };
}

/** The profile step ("Welcome, Raffaele") and Profile: names from edu-ID, username, the bubble's colours. */
function profileForm(welcome) {
  const me = account.me;
  const d = profileDraft;
  const preview = el("div", { class: "person-row preview", "aria-hidden": "true" });
  const contrastLine = el("p", { class: "contrast-note", role: "status" });
  const drawPreview = () => {
    const u = d.username.trim().toLowerCase() || "username";
    preview.replaceChildren(bubble({ initials: me.initials, bg: d.bg, fg: d.fg, bg2: d.bg2, fg2: d.fg2, metal: d.metal }, "big"),
      el("span", { class: "person-text" }, el("span", { class: "person-user" }, u), el("span", { class: "person-name muted" }, me.name)));
    // A metal paints its own (tested) colours; the gradients are checked stop against stop.
    const [bg2, fg2] = d.metal ? [null, null] : [d.bg2, d.fg2];
    const ok = readableBubble(d.bg, d.fg, bg2, fg2);
    const low = () => bubbleContrast([d.bg, bg2].filter(Boolean), [d.fg, fg2].filter(Boolean)).toFixed(1);
    contrastLine.textContent = ok ? "" : `Too hard to read (contrast ${low()}, needs ${MIN_BUBBLE_CONTRAST}): pick a darker background or a lighter text, or the other way round.`;
    save.disabled = !ok;
    // Under a metal your two colours aren't seen (they stay for pages without metals): dimmed, a click drops the metal.
    for (const r of [bgRow, fgRow]) r.node.classList.toggle("under-metal", !!d.metal);
  };
  const rows = [];
  // Every change redraws all rows: a metal clears the gradients, a colour the metal (plan 11.2).
  const changed = () => {
    for (const r of rows) r.sync();
    drawPreview();
  };
  redrawProfileColours = changed;
  const bgRow = colourRow("Background", "bg", () => bubbleBackgrounds(darkMode()), (c) => {
    Object.assign(d, { bg: c, metal: null });
    changed();
  });
  const fgRow = colourRow("Text", "fg", () => BUBBLE_TEXTS, (c) => {
    Object.assign(d, { fg: c, metal: null });
    changed();
  });
  rows.push(bgRow, fgRow);
  // Street cred's unlocks, in level order (Profile only: the profile step is everyone's first, at level 1).
  const unlocks = [];
  if (!welcome) {
    const bg2Row = colourRow("Gradient background", "bg2", () => bubbleBackgrounds(darkMode()), (c) => {
      Object.assign(d, { bg2: c }, c ? { metal: null } : {});
      changed();
    }, { none: () => d.bg, level: BUBBLE_STYLE_LEVELS.bg2 });
    const fg2Row = colourRow("Gradient text", "fg2", () => BUBBLE_TEXTS, (c) => {
      Object.assign(d, { fg2: c }, c ? { metal: null } : {});
      changed();
    }, { none: () => d.fg, level: BUBBLE_STYLE_LEVELS.fg2 });
    const metals = metalRow((m) => {
      Object.assign(d, { metal: m }, m ? { bg2: null, fg2: null } : {});
      changed();
    });
    rows.push(bg2Row, fg2Row, metals);
    unlocks.push(el("h4", { class: "unlock-head" }, "Street cred unlocks"),
      bg2Row.node, fg2Row.node, metals.node);
  }

  const input = el("input", { id: "username-input", type: "text", value: d.username, autocomplete: "off", autocapitalize: "off", spellcheck: "false", maxlength: "20", inputmode: "text", "aria-describedby": "username-check" });
  const check = el("p", { id: "username-check", class: "username-check", role: "status" }, d.check.text);
  const showCheck = () => {
    check.textContent = d.check.text;
    check.classList.toggle("ok", d.check.ok === true);
    check.classList.toggle("bad", d.check.ok === false);
  };
  showCheck();
  input.addEventListener("input", () => {
    d.username = input.value;
    d.error = "";
    error.textContent = "";
    drawPreview();
    checkUsername(showCheck);
  });

  const save = el("button", { type: "submit", class: "done-btn" }, welcome ? "Done" : "Save");
  const error = el("p", { class: "form-error", role: "alert" }, d.error);
  const savedNote = el("p", { class: "muted", role: "status" }, d.saved ? "Saved." : "");
  const form = el("form", { class: "account-form", novalidate: "" },
    el("section", { class: "detail-part" },
      el("h3", {}, "From your edu-ID"),
      el("p", { class: "edu-name" }, `${me.first_name} ${me.last_name}`),
      el("p", { class: "muted" }, `${uniName(me.uni)} · ${welcome ? "frooms shows you as" : "Shown as"} “${me.name}”.`)),
    el("section", { class: "detail-part" },
      el("label", { class: "field", for: "username-input" }, el("span", { class: "label" }, "Username")),
      el("div", { class: "username-box" }, el("span", { class: "at", "aria-hidden": "true" }, "@"), input),
      check,
      el("p", { class: "muted small" }, "3 to 20 letters a–z, digits, “_” or “.”.")),
    el("section", { class: "detail-part" },
      el("h3", {}, "Your bubble"),
      preview, bgRow.node, fgRow.node, ...unlocks, contrastLine),
    welcome ? boardChoice(d) : null,
    welcome ? el("p", { class: "privacy-line" }, "Friends you accept can see where you check in. Anyone signed in can find you by name, username or email. ", el("a", { href: "/privacy" }, "Privacy notice")) : null,
    error, savedNote, save);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const problem = usernameProblem(d.username);
    if (problem) {
      d.check = { name: d.username, text: problem, ok: false };
      showCheck();
      return input.focus();
    }
    if (save.disabled) return; // unreadable (drawPreview)
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      const style = welcome ? { ...(d.board ? { board: true } : {}) } : { bg2: d.bg2, fg2: d.fg2, metal: d.metal };
      const r = await accountFetch("POST", "/api/me/profile", { username: d.username.trim().toLowerCase(), bg: d.bg, fg: d.fg, ...style });
      if (r.board && typeof credView === "object" && credView.summary) credView.summary.board = true;
      delete r.board;
      Object.assign(account.me, r, { profile_needed: false });
      d.saved = !welcome;
      d.error = "";
      profileDraft.for = null; // the next opening starts from the saved profile
      syncAccountStars();
      accountChanged(); // the welcome view closes itself
      if (welcome) afterWelcome();
      else {
        savedNote.textContent = "Saved.";
        save.textContent = "Save";
        save.disabled = false;
      }
    } catch (err) {
      d.error = errorText(err);
      error.textContent = d.error;
      if (err.message === "username_taken") {
        d.check = { name: d.username, text: "That username is taken.", ok: false };
        showCheck();
      }
      save.textContent = welcome ? "Done" : "Save";
      save.disabled = false;
    }
  });
  for (const r of rows) r.sync();
  drawPreview();
  return [form];
}

/**
 * The profile step's one question about the leaderboards, left unticked: ticked, Done joins them (POST /api/me/profile
 * `board`). Leaving or joining later is on the Street cred page.
 */
function boardChoice(d) {
  const box = el("input", { type: "checkbox", id: "board-choice" });
  box.checked = d.board;
  box.addEventListener("change", () => (d.board = box.checked));
  return el("section", { class: "detail-part board-choice" },
    el("label", { class: "check-line", for: "board-choice" }, box, el("span", {}, el("strong", {}, "Show me on the leaderboards"),
      el("span", { class: "muted small" }, "Your username, name and street cred, seen only by others who take part. You can change this any time under Street cred."))));
}

/** After the profile step: what was waiting for it (an add-a-friend link), else back where the page was. */
function afterWelcome() {
  if (typeof friendsAfterWelcome === "function" && friendsAfterWelcome()) return;
}

const uniName = (uni) => (uni === "uzh" ? "University of Zurich" : "ETH Zurich");

/** Free or taken, while typing (500 ms after the last key; the Worker counts it against the search limit). */
function checkUsername(show) {
  const d = profileDraft;
  clearTimeout(d.timer);
  const typed = d.username.trim().toLowerCase();
  const problem = usernameProblem(typed);
  if (problem) {
    d.check = { name: typed, text: typed.length < 3 && !/[^a-z0-9_.]/.test(typed) ? "" : problem, ok: typed.length < 3 ? null : false };
    return show();
  }
  if (typed === account.me?.username) {
    d.check = { name: typed, text: "That's your username.", ok: true };
    return show();
  }
  d.check = { name: typed, text: "Checking…", ok: null };
  show();
  const seq = ++d.seq;
  d.timer = setTimeout(async () => {
    try {
      const r = await accountFetch("GET", `/api/username?u=${encodeURIComponent(typed)}`);
      if (seq !== d.seq) return;
      d.check = r.available ? { name: typed, text: `${typed} is free.`, ok: true } : { name: typed, text: r.valid ? "That username is taken." : usernameProblem(typed) ?? "Not a username.", ok: false };
    } catch (e) {
      if (seq !== d.seq) return;
      d.check = { name: typed, text: e.message === "too_many_requests" ? "Can't check right now; Done will tell." : "", ok: null };
    }
    show();
  }, 500);
}

// --- Account: university, sign out, privacy, delete ---

accountViews.account = (box) => {
  if (!signedIn()) return accountViews.signin(box);
  if (!accountReady()) return accountViews.welcome(box);
  const me = account.me;
  $("#sheet-title").textContent = "Account";
  const out = el("button", { type: "button", class: "detail-action" }, "Sign out");
  const outMsg = el("p", { class: "form-error", role: "alert" });
  out.addEventListener("click", async () => {
    out.disabled = true;
    try {
      await accountFetch("POST", "/auth/logout");
    } catch (e) {
      if (e.status !== 401) {
        out.disabled = false;
        outMsg.textContent = errorText(e);
        return;
      }
    }
    setSignedOut();
    if (placesView.current?.kind === "account") placeBack();
    flashAccountNote("Signed out of frooms.");
  });
  const del = el("button", { type: "button", class: "detail-action danger" }, "Delete account…");
  del.addEventListener("click", () => deleteAccount(del));
  fill(box,
    el("div", { class: "person-row" }, bubble(me, "big"), el("span", { class: "person-text" }, el("span", { class: "person-user" }, me.username), el("span", { class: "person-name muted" }, `${me.first_name} ${me.last_name}`))),
    el("section", { class: "detail-part" }, el("h3", {}, "University"), el("p", {}, `${uniName(me.uni)} (from your edu-ID)`)),
    el("section", { class: "detail-part" },
      el("h3", {}, "Sign out"),
      el("p", {}, out),
      el("p", { class: "muted small" }, "This signs you out of frooms in this browser. You're still signed in to edu-ID in this browser: ",
        el("a", { href: EDUID_LOGOUT, target: "_blank", rel: "noopener" }, "sign out of edu-ID"), "."),
      outMsg),
    el("section", { class: "detail-part" },
      el("h3", {}, "Your data"),
      el("p", {}, el("a", { href: "/privacy" }, "Privacy notice"), el("span", { class: "muted" }, ": what frooms keeps and for how long.")),
      el("p", {}, del)));
};

// --- About frooms. and Contact (the account menu and the You tab's footer; signed in or not) ---

/** The About text: one copy, in index.html's <template id="about-text">. */
accountViews.about = (box) => {
  fill($("#sheet-title"), "About ", wordmarkText());
  const text = document.getElementById("about-text");
  fill(box, el("div", { class: "about-text" }, ...(text ? [text.content.cloneNode(true)] : [])));
  // Its line about the tutorial starts it on this page (the link's /?tutorial would load the page again).
  box.querySelector(".about-tour a")?.addEventListener("click", (e) => {
    e.preventDefault();
    tourLoad();
  });
  // "feedback" in Who we are opens the feedback form (app.js openFeedback).
  box.querySelector(".about-feedback")?.addEventListener("click", (e) => {
    e.preventDefault();
    openFeedback();
  });
};

const CONTACT_EMAIL = "info@frooms.ch";
const COPY_ICON = "M9 4.5h8.5a1.5 1.5 0 0 1 1.5 1.5v11M6.5 8h8a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 5 18.5v-9A1.5 1.5 0 0 1 6.5 8z";

accountViews.contact = (box) => {
  $("#sheet-title").textContent = "Contact";
  const note = el("span", { class: "copy-note", role: "status" });
  const copy = el("button", { type: "button", class: "copy-btn", "aria-label": "Copy email address", title: "Copy email address" }, icon(COPY_ICON));
  let timer = 0;
  copy.addEventListener("click", async () => {
    clearTimeout(timer);
    let ok = true;
    try {
      await navigator.clipboard.writeText(CONTACT_EMAIL);
    } catch {
      ok = false;
    }
    copy.replaceChildren(icon(ok ? TICK_ICON : COPY_ICON));
    copy.classList.toggle("done", ok);
    note.textContent = ok ? "Copied" : "Couldn't copy";
    timer = setTimeout(() => {
      copy.replaceChildren(icon(COPY_ICON));
      copy.classList.remove("done");
      note.textContent = "";
    }, 2000);
  });
  fill(box,
    el("div", { class: "contact-row" }, el("a", { class: "contact-mail", href: `mailto:${CONTACT_EMAIL}` }, CONTACT_EMAIL), copy, note));
};

/**
 * A window in the middle of the screen asking to confirm. `confirmWord` (optional): what has to be typed first.
 * Resolves true (confirmed) or false.
 */
function askConfirm({ title, body = [], yes = "Yes", no = "Cancel", danger = false, confirmWord = null, inputLabel = null }) {
  const dialog = $("#confirm");
  return new Promise((resolve) => {
    const yesBtn = el("button", { type: "submit", class: `confirm-yes${danger ? " danger" : ""}` }, yes);
    const noBtn = el("button", { type: "button", class: "confirm-no" }, no);
    const input = confirmWord ? el("input", { type: "text", id: "confirm-input", autocomplete: "off", autocapitalize: "off", spellcheck: "false" }) : null;
    const form = el("form", { method: "dialog", class: "confirm-form" },
      el("h2", { id: "confirm-title" }, title),
      ...body.map((b) => (typeof b === "string" ? el("p", {}, b) : b)),
      input ? el("label", { class: "field", for: "confirm-input" }, el("span", {}, inputLabel ?? `Type ${confirmWord} to confirm`)) : null, input,
      el("div", { class: "confirm-buttons" }, noBtn, yesBtn));
    if (input) {
      yesBtn.disabled = true;
      input.addEventListener("input", () => (yesBtn.disabled = input.value.trim().toLowerCase() !== confirmWord.toLowerCase()));
    }
    let answer = false;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (yesBtn.disabled) return;
      answer = true;
      dialog.close();
    });
    noBtn.addEventListener("click", () => dialog.close());
    dialog.onclick = (e) => {
      if (e.target === dialog) dialog.close();
    };
    dialog.addEventListener("close", () => resolve(answer), { once: true });
    dialog.replaceChildren(form);
    dialog.showModal();
    (input ?? noBtn).focus();
  });
}

async function deleteAccount(button) {
  const me = account.me;
  const ok = await askConfirm({
    title: "Delete your account?",
    body: [
      "This deletes your profile and username, your friends and friend requests, and the stars kept with your account, and ends your check-in. You can't undo it.",
      "Your past check-ins stay as usage data without your name: only the place and the times. Your stars stay in this browser.",
    ],
    yes: "Delete account",
    danger: true,
    confirmWord: me.username,
    inputLabel: `Type your username, ${me.username}, to confirm`,
  });
  if (!ok) return;
  button.disabled = true;
  try {
    await accountFetch("DELETE", "/api/me");
  } catch (e) {
    button.disabled = false;
    if (e.status !== 401) return flashAccountNote(errorText(e));
  }
  setSignedOut();
  if (placesView.current?.kind === "account") placeBack();
  flashAccountNote("Your account is deleted.");
}

/** A short line above the list, for what happened in an account view that closed (signed out, deleted). */
function flashAccountNote(text) {
  setTimeout(() => showNotice(text), 50);
}

// --- stars with the account (plan 7.4) ---

/** Per browser: whether its stars are linked to the signed-in account, and whether it has changes not sent yet. */
const ACCOUNT_KEY = "frooms-account";

function accountPrefs() {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveAccountPrefs(p) {
  try {
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(p));
  } catch { /* storage unavailable: the next load merges again, which loses nothing */ }
}

/**
 * The account's stars are the ones that count. The first load after a sign-in in this browser merges the browser's in
 * (mergeStars); changes this browser couldn't send yet (offline) win; otherwise the account's list replaces the
 * browser's. When the result differs from the account's, one PUT.
 */
function syncAccountStars() {
  const me = account.me;
  if (!accountReady()) return;
  const prefs = accountPrefs();
  const list = prefs.linked && prefs.dirty ? cleanStars(state.stars) : prefs.linked ? cleanStars(me.stars) : mergeStars(me.stars, state.stars);
  saveAccountPrefs({ linked: true, dirty: !sameStars(list, me.stars) });
  if (!sameStars(list, state.stars)) {
    state.stars = list;
    savePrefs();
    starsChanged();
  }
  if (!sameStars(list, me.stars)) scheduleStarsPush(0);
}

/** A star changed in this browser (app.js setStar): send the whole list, at most once every 2 s, the last list wins. */
function accountStarsChanged() {
  if (!accountReady()) return;
  saveAccountPrefs({ linked: true, dirty: true });
  scheduleStarsPush();
}

function scheduleStarsPush(delay = null) {
  clearTimeout(account.starsTimer);
  account.starsTimer = setTimeout(pushStars, delay ?? Math.max(0, account.starsSentAt + 2000 - Date.now()));
}

async function pushStars() {
  if (!accountReady() || navigator.onLine === false) return; // sent when the page is online again
  account.starsSentAt = Date.now();
  const sent = cleanStars(state.stars);
  try {
    const r = await accountFetch("PUT", "/api/me/stars", { stars: sent });
    if (account.me) account.me.stars = r.stars;
    if (sameStars(sent, state.stars)) saveAccountPrefs({ linked: true, dirty: false });
    else scheduleStarsPush();
  } catch { /* still marked as changed: sent again when online, or at the next load */ }
}

// --- set-up ---

/** What the sign-in put in the address (#welcome, #signin-error=…; the preview adds &claims= or &detail=, ignored). */
function readAccountHash() {
  const h = location.hash.slice(1);
  if (!h) return null;
  const q = new URLSearchParams(h);
  const out = q.has("welcome") ? { welcome: true } : q.get("signin-error") ? { error: q.get("signin-error") } : null;
  if (out) history.replaceState(history.state, "", location.pathname + location.search);
  return out;
}

function initAccount() {
  account.hash = readAccountHash();
  $("#account").addEventListener("click", accountTapped);
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.(".account-box")) closeAccountMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#account-menu").hidden) {
      e.preventDefault();
      closeAccountMenu();
      $("#account").focus();
    }
  });
  // The menu's items: Up and Down move between them (wrapping, over the line), Home and End to the ends.
  $("#account-menu").addEventListener("keydown", (e) => {
    const items = [...e.currentTarget.querySelectorAll("[role=menuitem]")];
    const i = items.indexOf(document.activeElement);
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
    if (to === undefined || !items.length) return;
    e.preventDefault();
    items[(to + items.length) % items.length].focus();
  });
  window.addEventListener("online", () => {
    renderAccountButton();
    loadMe({ force: account.status !== "in" });
    if (accountPrefs().dirty) scheduleStarsPush(0);
  });
  window.addEventListener("offline", renderAccountButton);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && account.status !== "off") loadMe();
  });
  renderAccountButton();
}

/** Once the first list is on screen: ask who is signed in, then show what the sign-in came back with. */
async function startAccount() {
  await loadMe({ force: true });
  if (signedIn()) countUse("load_signed_in");
  const hash = account.hash;
  if (hash?.error) return openAccountView("signin");
  if (signedIn() && account.me.profile_needed) return openAccountView("welcome");
  if (typeof friendsStart === "function") friendsStart();
}
