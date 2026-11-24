// Screenshots of the local page (npm run dev) in headless Chrome, for looking at a change without a browser extension.
// Drives Chrome over the DevTools protocol with Node's built-in WebSocket (Node 22 or later), no dependency.
//
//   node scripts/page_check.mjs [options] [url or path …]     (default: /)
//
// Each URL is shot at 390 × 844 (a phone, touch emulated) and 1440 × 900, in light and dark, into build/shots/
// as <name>-<phone|wide>-<light|dark>.png. A path ("/", "/?mode=mensa") is taken on http://127.0.0.1:8787.
// Options:
//   --tab study|rooms|mensa|you   click that tab after loading (rooms is Meet, mensa is Eat)
//   --eval "<js>"                 run this in the page after loading (and after --tab), before the shot
//   --wait <ms>                   wait this long after loading and after each step (default 2500)
//   --only phone|wide             one size only
//   --theme light|dark            one theme only
//   --name <name>                 file name prefix (default: from the URL and the tab)
//   --size <W>x<H>                one more size instead of the two: that many CSS px at scale 2, not touch (1440 × 900 at
//                                 200 % zoom is --size 720x450), shot as <name>-<W>x<H>-<theme>.png
//   --keys "Escape,Tab,…"         after --eval and --drag, press these keys (real key events, 300 ms apart): Escape,
//                                 Tab, Shift+Tab, Enter or a single character; then --after
//   --reduce-motion               prefers-reduced-motion: reduce
//   --chrome <path>               the Chrome binary (default: $CHROME, or Google Chrome's usual place on macOS)
//   --account <fixture>           signed in without a sign-in (plans/PLAN_STREET_CRED.md, section 4): see below
//   --drag "x1,y1,x2,y2"          after --eval, drag from one point to the other (CSS px): a finger on the phone, the
//                                 mouse on wide screens, in 10 steps; then --after "<js>" runs and its result is printed
// Errors and exceptions the page logs are printed, and what --eval returns (unless undefined).
//
// --account <fixture>: there is no local sign-in, so the account's calls are answered from scripts/fixtures/<fixture>/
// through the DevTools protocol's Fetch domain, and everything else goes through to the local Worker. A call's file
// is its path without /api/, "/" as "_" (GET /api/me: me.json, GET /api/friends/checkins: friends_checkins.json);
// another method puts it first (DELETE /api/me: DELETE.me.json). A call without a file goes through to the Worker
// (which answers the account's calls with 404 sign_in_off, as on a host without sign-in). The check-in is kept in a
// copy of me.json, so POST, PATCH and DELETE /api/checkin work without a file (they answer as the Worker does). In the
// files, a string "@now", "@now+90m" or "@now-2h" becomes that time in ms ("@today", "@day-17": a Zurich date). Each call answered that isn't a GET is
// printed with its body. The fixture "signed-out" (or none) intercepts nothing. The Report log (reports.json, the same
// for every place) is kept too, so POST /api/reports/vote answers as the Worker does and the log redraws. A file with
// "__status" is answered with that status (anon/me.json: 401, signed out as on frooms.ch).
// Meal ratings (meal-ratings.json): GET /api/meal-ratings reads the place's menu of that day from the local Worker and
// gives each dish the ratings the file names for it (`dishes`, by dish name in lower case), or made-up ones (a third of
// the dishes none) when `made_up` is true; PUT /api/meal-ratings changes them as the Worker would, for the run.
// Street cred (cred.json): kept for the run; check-ins, votes and invites (POST /api/cred/invite) add to it and answer
// `cred` as the Worker does; PUT /api/cred/board joins or leaves, GET /api/cred/board?range= answers cred_board.json's
// `recent` or `all` (403 unless joined); GET /api/cred/log filters cred_log.json by `day` (Zurich) and `before`, and
// lists the days from its entries when the file's `days` is empty.
// Profile (POST /api/me/profile): changes the copy of me.json for the run, with the Worker's rules for bubble styles.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://127.0.0.1:8787";

const args = process.argv.slice(2);
const opts = { wait: 2500, urls: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--tab") opts.tab = args[++i];
  else if (a === "--eval") opts.eval = args[++i];
  else if (a === "--wait") opts.wait = Number(args[++i]);
  else if (a === "--only") opts.only = args[++i];
  else if (a === "--theme") opts.theme = args[++i];
  else if (a === "--name") opts.name = args[++i];
  else if (a === "--chrome") opts.chrome = args[++i];
  else if (a === "--size") opts.size = args[++i].split("x").map(Number);
  else if (a === "--reduce-motion") opts.reduceMotion = true;
  else if (a === "--keys") opts.keys = args[++i].split(",");
  else if (a === "--account") opts.account = args[++i];
  else if (a === "--drag") opts.drag = args[++i].split(",").map(Number);
  else if (a === "--after") opts.after = args[++i];
  else opts.urls.push(a);
}
if (!opts.urls.length) opts.urls.push("/");

const chrome = opts.chrome ?? process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SIZES = (opts.size ? [{ name: opts.size.join("x"), width: opts.size[0], height: opts.size[1], mobile: false, scale: 2 }] : [
  { name: "phone", width: 390, height: 844, mobile: true, scale: 2 },
  { name: "wide", width: 1440, height: 900, mobile: false, scale: 1 },
]).filter((s) => opts.size || !opts.only || s.name === opts.only);
const THEMES = ["light", "dark"].filter((t) => !opts.theme || t === opts.theme);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Chrome and the protocol ---

const profile = mkdtempSync(join(tmpdir(), "frooms-chrome-"));
const proc = spawn(chrome, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const wsUrl = await new Promise((resolve, reject) => {
  let err = "";
  const timer = setTimeout(() => reject(new Error(`Chrome didn't start:\n${err}`)), 15000);
  proc.stderr.on("data", (d) => {
    err += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  proc.on("error", reject);
});

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`)) : resolve(msg.result);
  } else if (msg.method) {
    for (const l of listeners) l(msg);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const page = (method, params) => send(method, params, sessionId);
await page("Page.enable");
await page("Runtime.enable");
listeners.push((msg) => {
  if (msg.sessionId !== sessionId) return;
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    console.log(`  page exception: ${d.exception?.description ?? d.text}`);
  } else if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
    console.log(`  console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
  }
});

async function evaluate(expression) {
  const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.log(`  eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result?.value;
}

async function load(url) {
  if (fixtureDir) {
    fixtureMe = readFixture("me") ?? null;
    fixtureReports = readFixture("reports") ?? null;
    fixtureMeals = readFixture("meal-ratings") ?? null;
    fixtureCred = readFixture("cred") ?? null;
    mealSummaries.clear();
  }
  const loaded = new Promise((resolve) => {
    const l = (msg) => {
      if (msg.sessionId === sessionId && msg.method === "Page.loadEventFired") {
        listeners.splice(listeners.indexOf(l), 1);
        resolve();
      }
    };
    listeners.push(l);
  });
  await page("Page.navigate", { url });
  await Promise.race([loaded, sleep(15000)]);
  await sleep(opts.wait);
}

/** A key pressed through the protocol's input events ("Escape", "Tab", "Shift+Tab", "Enter", "a"): its default action happens. */
const KEYS = { Escape: [27, "Escape"], Tab: [9, "Tab"], Enter: [13, "Enter", "\r"] };
async function press(spec) {
  const shift = spec.startsWith("Shift+");
  const key = shift ? spec.slice(6) : spec;
  const [code, name, text] = KEYS[key] ?? [key.toUpperCase().charCodeAt(0), key, key];
  const base = { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 };
  await page("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
  await page("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** A drag through the protocol's input events: real pointer events, as a finger or the mouse makes them. */
async function drag([x1, y1, x2, y2], touch) {
  const steps = 10;
  const at = (i) => ({ x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps });
  if (touch) {
    await page("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at(0)] });
    for (let i = 1; i <= steps; i++) {
      await page("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at(i)] });
      await sleep(16);
    }
    await page("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(0) });
    await page("Input.dispatchMouseEvent", { type: "mousePressed", ...at(0), button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      await page("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(i), button: "left", buttons: 1 });
      await sleep(16);
    }
    await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...at(steps), button: "left", buttons: 0, clickCount: 1 });
  }
}

// --- the account fixtures (--account) ---

const fixtureDir = opts.account && opts.account !== "signed-out" ? join(ROOT, "scripts", "fixtures", opts.account) : null;
if (fixtureDir && !existsSync(fixtureDir)) throw new Error(`No fixture ${opts.account} in scripts/fixtures/`);

/** "@now", "@now+90m", "@now-2h", "@now+30s" in a fixture: that time in ms, worked out when the file is read. */
function withTimes(v, now) {
  if (typeof v === "string") {
    // "@today", "@day-17": a Zurich calendar day ("2026-11-18"), for the admin page's answers.
    const d = /^@(?:today|day([+-]\d+))$/.exec(v);
    if (d) return zurichDay(now + Number(d[1] ?? 0) * 86_400_000);
    const m = /^@now(?:([+-]\d+)([smh]))?$/.exec(v);
    return m ? now + (m[1] ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]] : 0) : v;
  }
  if (Array.isArray(v)) return v.map((x) => withTimes(x, now));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withTimes(x, now)]));
  return v;
}

function readFixture(name) {
  const file = join(fixtureDir, `${name}.json`);
  return existsSync(file) ? withTimes(JSON.parse(readFileSync(file, "utf8")), Date.now()) : undefined;
}

/** The fixture's state while a run lasts (the check-in changes); read again at each page load. */
let fixtureMe = null;
let fixtureReports = null;
let fixtureMeals = null;
let fixtureCred = null; // GET /api/cred, kept for the run (joining the leaderboards, invites change it)

const zurichDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(new Date(ms));

/** Street cred for an action in the run: `points` more, as the Worker's `cred` answer. */
function fixtureEarn(points) {
  if (!fixtureCred) return undefined;
  fixtureCred.total += points;
  let level = 1;
  const start = (l) => 100 * (l - 1) + 25 * (l - 1) * (l - 2);
  while (start(level + 1) <= fixtureCred.total) level++;
  fixtureCred.level = level;
  return { points, total: fixtureCred.total, level };
}

/** GET /api/cred/log from cred_log.json: a Zurich day (`day`), the page after `before`, and the days (from the entries when the file has none). */
function credLogAnswer(url) {
  const file = readFixture("cred_log");
  if (!file) return null;
  const day = url.searchParams.get("day");
  const before = Number(url.searchParams.get("before")) || Infinity;
  const all = file.entries.filter((e) => (!day || zurichDay(e.at) === day) && e.id < before);
  const page = all.slice(0, 50);
  const out = { entries: page, more: all.length > 50 || (!day && before === Infinity && file.more) };
  if (before === Infinity) out.days = file.days?.length ? file.days : [...new Set(file.entries.map((e) => zurichDay(e.at)))];
  return { status: 200, body: out };
}
const mealSummaries = new Map(); // dish key -> summary, for the run

const dishKeyOf = (facility, date, meal, line, name) => [String(facility), date, meal, line, String(name).trim().toLowerCase()].join("|");
const round1 = (x) => Math.round(x * 10) / 10 + 0;
const avgOf = (s) => {
  const set = [s.taste, s.portion, s.value].filter((v) => typeof v === "number");
  return set.length ? round1(set.reduce((a, b) => a + b, 0) / set.length) : null;
};

/** Made-up ratings for a dish, the same for the same name: a third of the dishes have none. */
function madeUp(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0;
  if (h % 3 === 0) return null;
  const v = (k) => ((h >>> k) % 21) / 2 - 5; // -5 to 5 in steps of 0.5
  const s = { taste: v(2), portion: h % 5 === 0 ? null : v(7), value: v(12), n: 1 + (h % 17) };
  return { ...s, nTaste: s.n, nPortion: s.portion === null ? 0 : Math.max(1, s.n - 2), nValue: Math.max(1, s.n - 1) };
}

/** GET /api/meal-ratings from the place's menu of that day (the local Worker's) and the fixture. */
async function mealRatingsAnswer(url) {
  const place = url.searchParams.get("place");
  const date = url.searchParams.get("date");
  const res = await fetch(`${BASE}/api/menu?${new URLSearchParams({ place, from: date, days: "1" })}`);
  if (!res.ok) return { status: 200, body: { place, date, dishes: {} } };
  const menu = await res.json();
  const dishes = {};
  for (const m of menu.days.find((d) => d.date === date)?.meals ?? []) {
    for (const d of m.dishes) {
      const key = dishKeyOf(menu.place.facility, date, m.meal, d.line, d.name);
      if (!mealSummaries.has(key)) {
        const s = fixtureMeals.dishes?.[d.name.trim().toLowerCase()] ?? (fixtureMeals.made_up ? madeUp(d.name) : null);
        mealSummaries.set(key, s ? { ...s, mine: s.mine ?? null } : null);
      }
      const s = mealSummaries.get(key);
      if (s) dishes[key] = { ...s, avg: avgOf(s), ...(fixtureMe && !fixtureMe.__status ? {} : { mine: undefined }) };
    }
  }
  return { status: 200, body: { place, date, dishes } };
}

/** PUT /api/meal-ratings: your rating replaces your earlier one; the averages move as the Worker's would. */
async function mealRateAnswer(body) {
  const res = await fetch(`${BASE}/api/menu?${new URLSearchParams({ place: body.place, from: body.date, days: "1" })}`);
  const menu = res.ok ? await res.json() : null;
  if (!menu) return { status: 404, body: { detail: "no_such_dish" } };
  const key = dishKeyOf(menu.place.facility, body.date, body.meal, body.line, body.name);
  const s = mealSummaries.get(key) ?? { taste: null, portion: null, value: null, n: 0, nTaste: 0, nPortion: 0, nValue: 0, mine: null };
  const next = { ...s };
  const counts = { taste: "nTaste", portion: "nPortion", value: "nValue" };
  for (const c of ["taste", "portion", "value"]) {
    const n = s[counts[c]];
    const old = s.mine?.[c] ?? null;
    let sum = (s[c] ?? 0) * n - (old ?? 0);
    let k = n - (old === null ? 0 : 1);
    if (typeof body[c] === "number") {
      sum += body[c];
      k += 1;
    }
    next[c] = k ? round1(sum / k) : null;
    next[counts[c]] = k;
  }
  if (!s.mine) next.n = s.n + 1;
  next.mine = { taste: body.taste ?? null, portion: body.portion ?? null, value: body.value ?? null };
  mealSummaries.set(key, next);
  return { status: 200, body: { key, dish: { ...next, avg: avgOf(next) }, cred: { points: s.mine ? 0 : 3, total: 523, level: 4 } } };
}

/**
 * POST /api/me/profile as the Worker answers it (worker/social.ts chooseStyle, without the contrast check): left-out
 * styles kept, a metal clears the gradients and a gradient the metal, a new style above your level is 403 `locked`.
 */
function profileAnswer(body) {
  const levels = { bg2: 2, fg2: 3, bronze: 4, silver: 5, gold: 6 };
  const level = fixtureMe.cred?.level ?? 1;
  const pick = (k) => (body[k] === undefined ? fixtureMe[k] ?? null : body[k] || null);
  let [bg2, fg2, metal] = [pick("bg2"), pick("fg2"), pick("metal")];
  const gradient = (body.bg2 !== undefined && bg2) || (body.fg2 !== undefined && fg2);
  if (body.metal !== undefined && metal) {
    if (gradient) return { status: 400, body: { detail: "bad_style" } };
    bg2 = fg2 = null;
  } else if (gradient) metal = null;
  for (const [k, v] of [["bg2", bg2], ["fg2", fg2], [metal, metal]]) {
    if (v && v !== (fixtureMe[k === metal ? "metal" : k] ?? null) && levels[k] > level) return { status: 403, body: { detail: "locked" } };
  }
  Object.assign(fixtureMe, { username: body.username, bg: body.bg, fg: body.fg, bg2, fg2, metal });
  return { status: 200, body: { username: body.username, bg: body.bg, fg: body.fg, bg2, fg2, metal } };
}

/** The answer to an account call: { status, body } or null (through to the Worker). */
async function fixtureAnswer(method, url, postData) {
  const path = url.pathname.replace(/^\/api\//, "").replace(/\//g, "_");
  const body = postData ? (() => { try { return JSON.parse(postData); } catch { return {}; } })() : {};
  if (path === "me" && method === "GET" && fixtureMe?.__status) return { status: fixtureMe.__status, body: { detail: fixtureMe.detail ?? "" } };
  if (path === "me" && method === "GET" && fixtureMe) return { status: 200, body: fixtureMe };
  if (path === "meal-ratings" && fixtureMeals) {
    if (method === "GET") return mealRatingsAnswer(url);
    if (fixtureMe?.__status || !fixtureMe) return { status: 401, body: { detail: "signed_out" } };
    return mealRateAnswer(body);
  }
  if (path === "cred" && method === "GET" && fixtureCred) return { status: 200, body: fixtureCred };
  if (path === "cred_log" && method === "GET") return credLogAnswer(url);
  if (path === "cred_board" && fixtureCred) {
    if (method === "PUT") {
      fixtureCred.board = !!body.on;
      return { status: 200, body: { board: fixtureCred.board } };
    }
    if (!fixtureCred.board) return { status: 403, body: { detail: "not_on_board" } };
    const board = readFixture("cred_board");
    const range = url.searchParams.get("range");
    return board?.[range] ? { status: 200, body: board[range] } : null;
  }
  if (path === "cred_invite" && method === "POST" && fixtureCred) return { status: 200, body: { cred: fixtureEarn(3) } };
  if (path === "me_profile" && method === "POST" && fixtureMe && !fixtureMe.__status) return profileAnswer(body);
  if (path === "checkin" && fixtureMe) {
    const now = Date.now();
    if (method === "POST") {
      fixtureMe.checkin = { kind: body.kind, place: body.place, area: body.area, building: String(body.place).split(" ")[0], name: body.place, since: now, until: body.until ?? now + 3 * 3_600_000 };
      return { status: 201, body: { checkin: fixtureMe.checkin, cred: fixtureEarn(5) } };
    }
    if (method === "PATCH") {
      if (!fixtureMe.checkin) return { status: 404, body: { detail: "no_checkin" } };
      if (!(body.until > now && body.until - now <= 12 * 3_600_000)) return { status: 400, body: { detail: "bad_until" } };
      fixtureMe.checkin = { ...fixtureMe.checkin, until: body.until };
      return { status: 200, body: { checkin: fixtureMe.checkin } };
    }
    if (method === "DELETE") {
      fixtureMe.checkin = null;
      return { status: 204, body: null };
    }
  }
  if (path === "reports" && method === "GET" && fixtureReports) return { status: 200, body: { ...fixtureReports, at: new Date().toISOString().slice(0, 16) } };
  if (path === "reports_vote" && method === "POST" && fixtureReports) {
    const r = fixtureReports.reports.find((x) => x.id === body.id);
    if (!r) return { status: 404, body: { detail: "no_such_report" } };
    if (r.mine) return { status: 403, body: { detail: "own_report" } };
    if (r.vote === 1) r.up--;
    if (r.vote === -1) r.down--;
    r.vote = body.up === null ? 0 : body.up ? 1 : -1;
    if (r.vote === 1) r.up++;
    if (r.vote === -1) r.down++;
    return { status: 200, body: { report: r, cred: fixtureEarn(1) ?? { points: 1, total: 521, level: 4 } } };
  }
  const data = readFixture(method === "GET" ? path : `${method}.${path}`);
  return data === undefined ? null : { status: data === null ? 204 : 200, body: data };
}

async function startFixtures() {
  if (!fixtureDir) return;
  await page("Network.enable");
  await page("Network.setBypassServiceWorker", { bypass: true }); // the account's calls never go through it anyway
  await page("Fetch.enable", { patterns: [{ urlPattern: `${BASE}/api/*`, requestStage: "Request" }, { urlPattern: `${BASE}/auth/*`, requestStage: "Request" }] });
  listeners.push(async (msg) => {
    if (msg.sessionId !== sessionId || msg.method !== "Fetch.requestPaused") return;
    const { requestId, request } = msg.params;
    const url = new URL(request.url);
    let a = null;
    try {
      a = await fixtureAnswer(request.method, url, request.postData);
    } catch (e) {
      console.log(`  fixture failed: ${request.method} ${url.pathname}: ${e.message}`);
    }
    if (!a) return page("Fetch.continueRequest", { requestId }).catch(() => {});
    if (request.method !== "GET") console.log(`  fixture: ${request.method} ${url.pathname}${url.search} ${request.postData ?? ""} -> ${a.status}`);
    const text = a.body === null ? "" : JSON.stringify(a.body);
    await page("Fetch.fulfillRequest", {
      requestId,
      responseCode: a.status,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Cache-Control", value: "no-store" }],
      body: Buffer.from(text).toString("base64"),
    }).catch(() => {});
  });
}

await startFixtures();

// --- the shots ---

const outDir = join(ROOT, "build", "shots");
mkdirSync(outDir, { recursive: true });
const slug = (url) => url.replace(/^https?:\/\/[^/]+/, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "home";

try {
  for (const u of opts.urls) {
    const url = /^https?:/.test(u) ? u : BASE + (u.startsWith("/") ? u : `/${u}`);
    const name = opts.name ?? [slug(url), opts.tab].filter(Boolean).join("-");
    for (const size of SIZES) {
      for (const theme of THEMES) {
        await page("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: size.scale, mobile: size.mobile });
        await page("Emulation.setTouchEmulationEnabled", size.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await page("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme },
          ...(opts.reduceMotion ? [{ name: "prefers-reduced-motion", value: "reduce" }] : [])] });
        console.log(`${name} ${size.name} ${theme}: ${url}`);
        await load(url);
        if (opts.tab) {
          await evaluate(`document.querySelector('#tabs button[data-mode="${opts.tab}"]')?.click()`);
          await sleep(opts.wait);
        }
        if (opts.eval) {
          const out = await evaluate(opts.eval);
          if (out !== undefined) console.log(`  eval: ${typeof out === "string" ? out : JSON.stringify(out)}`);
          await sleep(opts.wait);
        }
        if (opts.drag) {
          await drag(opts.drag, size.mobile);
          await sleep(400);
        }
        for (const k of opts.keys ?? []) {
          await press(k.trim());
          await sleep(300);
        }
        if (opts.after) {
          const out = await evaluate(opts.after);
          if (out !== undefined) console.log(`  after: ${typeof out === "string" ? out : JSON.stringify(out)}`);
        }
        const { data } = await page("Page.captureScreenshot", { format: "png" });
        const file = join(outDir, `${name}-${size.name}-${theme}.png`);
        writeFileSync(file, Buffer.from(data, "base64"));
        console.log(`  -> ${file.replace(ROOT + "/", "")}`);
      }
    }
  }
} finally {
  ws.close();
  proc.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
