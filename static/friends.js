"use strict";

// Friends (plans/PLAN_ACCOUNTS.md, section 8.5): the Friends view in the sheet with its search, incoming requests,
// your friends and sent requests, "More people" from /api/people, removing and blocking, and the add-a-friend link
// (frooms.ch/?add=<username>). People always arrive as { username, name: "Raffaele W.", initials, bg, fg }. Views of
// kind "account": "friends" and "add:<username>". Loaded after account.js.

const friendsView = {
  data: null, // GET /api/friends: { friends, incoming, outgoing }
  loading: false,
  error: "",
  query: "",
  people: null, // /api/people's answer for `peopleFor`
  peopleFor: "",
  peopleError: "",
  seq: 0,
  timer: 0,
  openMenu: null, // the username whose row shows its actions (Remove friend, Block, Report)
  busy: new Set(), // usernames with a request on its way
  status: new Map(), // username -> what an action on them just led to: "requested", "friends", "removed", "blocked"
  pendingAdd: addParam(location.search), // an add-a-friend link this page was opened with
};

/** One person: their bubble, the username and below it "Raffaele W.", then what can be done (`actions`). */
function personRow(p, actions = [], { sub = null, cls = "" } = {}) {
  return el("li", { class: `person ${cls}`.trim(), "data-user": p.username },
    bubble(p),
    el("span", { class: "person-text" }, el("span", { class: "person-user" }, p.username), el("span", { class: "person-name muted" }, sub ?? p.name)),
    actions.length ? el("span", { class: "person-actions" }, ...actions.filter(Boolean)) : null);
}

function smallButton(text, onClick, cls = "") {
  const b = el("button", { type: "button", class: `pill ${cls}`.trim() }, text);
  b.addEventListener("click", onClick);
  return b;
}

/** GET /api/friends, then draw the view again (if it's still open). */
async function loadFriends() {
  friendsView.loading = true;
  try {
    friendsView.data = await accountFetch("GET", "/api/friends");
    friendsView.error = "";
    // The account button's dot follows the requests.
    if (account.me && account.me.requests !== friendsView.data.incoming.length) {
      account.me.requests = friendsView.data.incoming.length;
      renderAccountButton();
    }
  } catch (e) {
    friendsView.error = errorText(e);
  } finally {
    friendsView.loading = false;
  }
  drawFriendsIfOpen();
  if (searchOpen()) renderSearch(); // the search's People
}

const friendsShown = () => placesView.current?.kind === "account" && /^(friends|add|person)(:|$)/.test(placesView.current.id);

function drawFriendsIfOpen() {
  if (friendsShown()) renderPlaceView();
}

/** Run a change about `username`, then reload the lists (and the account's request count). */
async function friendAction(username, run, after = null) {
  if (friendsView.busy.has(username)) return;
  friendsView.busy.add(username);
  drawFriendsIfOpen();
  try {
    const r = await run();
    credEarned(r?.cred); // making friends: 25 street cred, once per pair
    if (after) friendsView.status.set(username, typeof after === "function" ? after(r) : after);
    friendsView.error = "";
  } catch (e) {
    friendsView.error = errorText(e);
  } finally {
    friendsView.busy.delete(username);
  }
  friendsView.openMenu = null;
  await loadFriends();
  // People found in "More people" carry their state from the search: refresh it too.
  if (friendsView.peopleFor) searchPeople(friendsView.peopleFor, true);
}

const sendRequest = (u) => friendAction(u, () => accountFetch("POST", "/api/friends/requests", { user: u }), (r) => r?.status ?? "requested");
const acceptRequest = (u) => friendAction(u, () => accountFetch("POST", "/api/friends/requests/accept", { user: u }), "friends");
const dropRequest = (u) => friendAction(u, () => accountFetch("DELETE", `/api/friends/requests?user=${encodeURIComponent(u)}`), "none");

async function removeFriend(u) {
  const ok = await askConfirm({ title: `Remove ${u}?`, body: [`${u} isn't told. You stop seeing each other's check-ins, you both lose the 25 street cred your friendship gave, and either of you can send a new request later.`], yes: "Remove friend", danger: true });
  if (ok) friendAction(u, () => accountFetch("DELETE", `/api/friends?user=${encodeURIComponent(u)}`), "removed");
}

async function blockPerson(u) {
  const ok = await askConfirm({
    title: `Block ${u}?`,
    body: [`This ends your friendship and any requests between you, and you won't find each other in search any more. ${u} isn't told.`,
      "To report someone, use Report: it goes to frooms with what you write."],
    yes: "Block",
    danger: true,
  });
  if (ok) friendAction(u, () => accountFetch("POST", "/api/blocks", { user: u }), "blocked");
}

/** A friend's row: their bubble and names, and "⋯" for Remove friend, Block and Report. */
function friendRow(p) {
  const open = friendsView.openMenu === p.username;
  const more = el("button", { type: "button", class: "pill more-pill", "aria-expanded": String(open), "aria-label": `More for ${p.username}` }, "⋯");
  more.addEventListener("click", () => {
    friendsView.openMenu = open ? null : p.username;
    drawFriendsIfOpen();
  });
  const row = personRow(p, [friendsView.busy.has(p.username) ? el("span", { class: "muted small" }, "…") : more]);
  if (open) {
    row.append(el("div", { class: "person-menu" },
      smallButton("Remove friend", () => removeFriend(p.username)),
      smallButton("Block", () => blockPerson(p.username), "danger"),
      smallButton("Report", () => openFeedback("person", p.username))));
  }
  return row;
}

/** What can be done about someone found by search ({ friend, request: "sent" | "received" | null }). */
function personActions(p) {
  const u = p.username;
  if (friendsView.busy.has(u)) return [el("span", { class: "muted small" }, "…")];
  const st = friendsView.status.get(u);
  const isFriend = friendsView.data?.friends.some((f) => f.username === u) ?? p.friend;
  if (isFriend || st === "friends") return [el("span", { class: "pill done" }, "Friends ✓")];
  if (st === "blocked") return [el("span", { class: "muted small" }, "Blocked")];
  const sent = friendsView.data?.outgoing.some((f) => f.username === u) ?? p.request === "sent";
  const received = friendsView.data?.incoming.some((f) => f.username === u) ?? p.request === "received";
  if (received) return [smallButton("Accept", () => acceptRequest(u), "primary")];
  if (sent || st === "requested") return [el("span", { class: "pill done" }, "Requested")];
  return [smallButton("Add friend", () => sendRequest(u), "primary")];
}

/** /api/people for "More people" (from 3 letters, or a whole email address), 400 ms after the last key. */
function searchPeople(query, now = false) {
  clearTimeout(friendsView.timer);
  const q = query.trim();
  const email = q.includes("@") && !q.startsWith("@");
  const needed = email ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q) : foldText(q.replace(/^@/, "")).length >= 3;
  if (!needed) {
    friendsView.people = null;
    friendsView.peopleFor = "";
    friendsView.peopleError = "";
    return;
  }
  const seq = ++friendsView.seq;
  friendsView.timer = setTimeout(async () => {
    countUse("people_search");
    try {
      const r = await accountFetch("GET", `/api/people?q=${encodeURIComponent(q.replace(/^@/, ""))}`);
      if (seq !== friendsView.seq) return;
      friendsView.people = r.people;
      friendsView.peopleFor = q;
      friendsView.peopleError = "";
    } catch (e) {
      if (seq !== friendsView.seq) return;
      friendsView.peopleError = errorText(e);
    }
    drawFriendsResults();
    if (searchOpen()) renderSearch(); // the search's People
  }, now ? 0 : 400);
}

/** The add-a-friend link to share: frooms.ch/?add=<username>. */
const addLink = () => `${location.origin}/?add=${encodeURIComponent(account.me.username)}`;

function shareLinkBox() {
  const [button, menu] = inviteControl(() => `Add me as a friend on frooms: I'm ${account.me.username}.`, addLink, { labels: "Share your link", kind: "friend-link" });
  return el("section", { class: "detail-part share-link", "data-tour": "friend-link" },
    el("h3", {}, "Your add-a-friend link"),
    el("p", { class: "muted small" }, "Friends who open it see you with “Add friend” (after signing in)."),
    el("p", { class: "link-text" }, addLink().replace(/^https?:\/\//, "")),
    inviteBox([button, menu]));
}

accountViews.friends = (box) => {
  if (!accountReady()) return signedIn() ? accountViews.welcome(box) : accountViews.signin(box);
  $("#sheet-title").textContent = "Friends";
  // The search field stays while the lists below it are drawn again, so typing isn't interrupted.
  if (!box.querySelector("#friends-search")) {
    const input = el("input", { id: "friends-search", type: "search", placeholder: "Username, name or email", "aria-label": "Search friends and people", autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "search" });
    input.value = friendsView.query;
    input.addEventListener("input", () => {
      friendsView.query = input.value;
      searchPeople(input.value);
      drawFriendsResults();
    });
    fill(box, el("div", { class: "friends-search", "data-tour": "friends-search" }, input), el("div", { id: "friends-results", class: "friends-results", "aria-live": "polite" }));
    if (!friendsView.loading) loadFriends(); // every opening: requests may have come in
  }
  drawFriendsResults();
};

function drawFriendsResults() {
  const out = document.getElementById("friends-results");
  if (!out || !friendsShown()) return;
  const d = friendsView.data;
  const q = friendsView.query.trim();
  const parts = [];
  if (friendsView.error) parts.push(el("p", { class: "message warning", role: "alert" }, friendsView.error));
  if (!d) {
    parts.push(el("p", { class: "muted" }, friendsView.loading ? "Loading…" : ""));
    return fill(out, ...parts);
  }
  const group = (title, rows, empty = null, cls = "") => (rows.length || empty
    ? el("section", { class: `detail-part friends-group ${cls}`.trim() }, el("h3", {}, title, rows.length ? el("span", { class: "count" }, ` ${rows.length}`) : null),
      rows.length ? el("ul", { class: "people-list" }, ...rows) : el("p", { class: "muted" }, empty))
    : null);
  if (!q) {
    parts.push(group("Friend requests", d.incoming.map((p) => personRow(p, friendsView.busy.has(p.username) ? [el("span", { class: "muted small" }, "…")]
      : [smallButton("Accept", () => acceptRequest(p.username), "primary"), smallButton("Decline", () => dropRequest(p.username))], { cls: "incoming" }))));
    parts.push(group("Your friends", sortFriends(d.friends).map(friendRow), "No friends yet. Search for people above, or share your link."));
    parts.push(group("Sent requests", d.outgoing.map((p) => personRow(p, friendsView.busy.has(p.username) ? [el("span", { class: "muted small" }, "…")]
      : [smallButton("Withdraw", () => dropRequest(p.username))]))));
    parts.push(shareLinkBox());
    return fill(out, ...parts);
  }
  const mine = sortFriends(d.friends).filter((p) => friendMatches(p, q));
  parts.push(group("Your friends", mine.map(friendRow), "None of your friends matches."));
  const email = q.includes("@") && !q.startsWith("@");
  if (!friendsView.peopleFor || foldText(friendsView.peopleFor) !== foldText(q)) {
    const short = !email && foldText(q.replace(/^@/, "")).length < 3;
    parts.push(el("section", { class: "detail-part" }, el("h3", {}, "More people"),
      el("p", { class: "muted" }, friendsView.peopleError || (short ? "Type 3 letters or more to find people by username or name, or a whole email address." : email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q) ? "Type the whole email address." : "Searching…"))));
  } else {
    const friendNames = new Set(d.friends.map((f) => f.username));
    const others = (friendsView.people ?? []).filter((p) => !friendNames.has(p.username));
    parts.push(group("More people", others.map((p) => personRow(p, personActions(p))),
      email ? "Nobody on frooms uses that email address (or they blocked you)." : "Nobody else on frooms matches."));
    if (!email) parts.push(el("p", { class: "muted small" }, "Search finds people by username, name, or a whole email address, which is never shown."));
  }
  fill(out, ...parts);
}

// --- the add-a-friend link: /?add=<username> ---

accountViews.add = (box, username) => {
  $("#sheet-title").textContent = "Add a friend";
  if (!signedIn()) return fill(box, signInBlock(`Sign in to add ${username} as a friend.`));
  if (!accountReady()) return accountViews.welcome(box);
  if (username === account.me.username) {
    return fill(box, el("p", {}, "That's your own add-a-friend link: send it to your friends."), accountLink("Friends", "friends"));
  }
  const key = `add|${username}`;
  if (friendsView.addFor !== key) {
    friendsView.addFor = key;
    friendsView.addPerson = undefined;
    fill(box, el("p", { class: "muted" }, "Loading…"));
    accountFetch("GET", `/api/people?q=${encodeURIComponent(username)}`).then((r) => {
      friendsView.addPerson = r.people.find((p) => p.username === username) ?? null;
    }, (e) => {
      friendsView.addPerson = null;
      friendsView.error = errorText(e);
    }).finally(drawFriendsIfOpen);
    if (!friendsView.data) loadFriends();
    return;
  }
  const p = friendsView.addPerson;
  if (p === undefined) return fill(box, el("p", { class: "muted" }, "Loading…"));
  if (!p) return fill(box, el("p", {}, `frooms doesn't know ${username} (any more).`), friendsView.error ? el("p", { class: "muted" }, friendsView.error) : null, accountLink("Friends", "friends"));
  fill(box,
    el("ul", { class: "people-list add-person" }, personRow(p, personActions(p))),
    el("p", { class: "muted small" }, "Friends see where each other check in. Nobody sees a check-in before accepting."),
    friendsView.error ? el("p", { class: "message warning", role: "alert" }, friendsView.error) : null,
    accountLink("All your friends", "friends"));
};

/** The address without ?add= (once the link has been dealt with). */
function dropAddParam() {
  const q = new URLSearchParams(location.search);
  if (!q.has("add")) return;
  q.delete("add");
  const search = q.toString();
  history.replaceState(history.state, "", location.pathname + (search ? `?${search}` : ""));
}

/** After the first /api/me (account.js startAccount): an add-a-friend link opens its view. */
function friendsStart() {
  const u = friendsView.pendingAdd;
  if (!u) return;
  if (accountReady()) {
    friendsView.pendingAdd = null;
    openAccountView(`add:${u}`);
    dropAddParam();
  } else if (!signedIn()) {
    // Signed out: the sign-in comes back to this address, ?add= included.
    openAccountView(`add:${u}`);
    if (account.status === "off") dropAddParam();
  } // profile_needed: the welcome view first (friendsAfterWelcome)
}

/** The profile step is done: an add-a-friend link waiting for it opens now. Returns whether it did. */
function friendsAfterWelcome() {
  const u = friendsView.pendingAdd;
  if (!u) return false;
  friendsView.pendingAdd = null;
  setTimeout(() => {
    openAccountView(`add:${u}`);
    dropAddParam();
  }, 0);
  return true;
}

function initFriends() {
  account.listeners.push(() => {
    syncSearchPlaceholder();
    if (!accountReady()) {
      friendsView.data = null;
      friendsView.people = null;
      friendsView.peopleFor = "";
      friendsView.status.clear();
      friendsView.addFor = null;
    }
    if (friendsShown()) renderPlaceView();
  });
}

// --- friends' check-ins: the You tab, the map and the campus buttons (plan 8.7, 8.8) ---

const friendsMap = {
  list: [], // GET /api/friends/checkins: { person, kind, place, area, building, name, since, until }, latest first
  loadedAt: 0,
  timer: 0,
  layer: true, // the map's Friends layer (its own button; on by default)
  nodes: new Map(), // cluster key -> its bubble on the map
};
const FRIENDS_REFRESH_MS = 2 * 60 * 1000; // only while the page is visible and signed in (plan 5.5)
const FRIENDS_LAYER_KEY = "frooms-friends-layer";
const FRIENDS_ICON = "M5.8 7.2a2.3 2.3 0 1 1 0-4.6 2.3 2.3 0 0 1 0 4.6zM1.5 13.5c.3-2.5 2-3.9 4.3-3.9s4 1.4 4.3 3.9M10.6 7a2 2 0 1 0 0-4M12 9.7c1.5.4 2.4 1.6 2.6 3.4";

/** Friends whose check-in is still running. */
const friendCheckinsNow = () => (accountReady() ? friendsMap.list.filter((c) => c.until > Date.now()) : []);

/** How many friends are checked in on a campus (the campus buttons and the campus menu). */
const friendsOnCampus = (area) => friendCheckinsNow().filter((c) => c.area === area).length;

/** A small count of friends for a campus button or menu entry ("2" with a bubble), or null. */
function friendsBadge(area) {
  const n = friendsOnCampus(area);
  if (!n) return null;
  return el("span", { class: "friends-count", title: plural(n, "friend checked in", "friends checked in") }, smallIcon(FRIENDS_ICON), String(n));
}

async function loadFriendCheckins() {
  if (!accountReady() || navigator.onLine === false || document.visibilityState !== "visible") return;
  friendsMap.loadedAt = Date.now();
  try {
    const r = await accountFetch("GET", "/api/friends/checkins");
    friendsMap.list = r.checkins ?? [];
  } catch {
    return; // the last answer stays until the next try
  }
  friendCheckinsChanged();
}

/** Every 2 minutes while visible and signed in; at once when the page comes back after that long. */
function pollFriendCheckins() {
  clearInterval(friendsMap.timer);
  friendsMap.timer = 0;
  if (!accountReady()) {
    if (friendsMap.list.length) {
      friendsMap.list = [];
      friendCheckinsChanged();
    }
    return;
  }
  if (Date.now() - friendsMap.loadedAt > FRIENDS_REFRESH_MS - 10_000) loadFriendCheckins();
  friendsMap.timer = setInterval(loadFriendCheckins, FRIENDS_REFRESH_MS);
}

function friendCheckinsChanged() {
  if (state.mode === "you") renderYouAccount();
  if (mapView.doc) {
    renderLinks();
    scheduleDraw();
  }
  if (state.areas) renderAreas();
  syncFriendsButton();
  const p = placesView.current;
  if (p?.kind === "account" && p.id.startsWith("friendsat:")) renderPlaceView();
  if (p?.kind === "building") renderPlaceView();
}

/** Metres from you to a friend's building, when your position and their building are known. */
function friendDistance(c) {
  const here = meOn(mapView.doc);
  if (!here) return null;
  const at = c.area === mapView.area ? anchorOf(c.building) : anchorIn(c.area, c.building);
  return at ? Math.hypot(at[0] - here[0], at[1] - here[1]) : null;
}

const areaNameOf = (area) => state.areas?.areas.find((a) => a.area === area)?.name ?? area;

/** A friend's check-in as a row: bubble, username, "Raffaele W.", the place and its times; it opens the place. */
function friendCheckinRow(c, from = "list") {
  const other = c.area !== state.area ? areaNameOf(c.area) : null;
  const open = el("button", { type: "button", class: "row-open friend-open" },
    bubble(c.person),
    el("span", { class: "person-text" },
      el("span", { class: "person-user" }, c.person.username, el("span", { class: "muted person-short" }, ` · ${c.person.name}`)),
      el("span", { class: "friend-place" }, [c.name, other].filter(Boolean).join(" · ")),
      el("span", { class: "person-name muted" }, checkinWhen(c, Date.now()))));
  open.addEventListener("click", () => openPlace({ kind: c.kind, id: c.place, area: c.area }, { from, opener: open }));
  return el("li", { class: "room friend-checkin", "data-building": c.building }, open);
}

/** The You tab's "Friends here now" (signed out: one line about signing in). */
function friendsHereSection() {
  if (!accountReady()) return account.status === "out" ? youSignInLine() : null;
  const list = sortFriendCheckins(friendCheckinsNow(), { distance: friendDistance, area: state.area });
  const parts = [el("h2", {}, "Friends here now", list.length ? el("span", { class: "count" }, ` ${list.length}`) : null)];
  if (list.length) parts.push(el("ul", {}, ...list.map((c) => friendCheckinRow(c))));
  else {
    parts.push(el("p", { class: "muted" }, "None of your friends is checked in."));
    if (!friendsView.data && !friendsView.loading) loadFriends().then(() => state.mode === "you" && renderYouAccount());
    if (friendsView.data && !friendsView.data.friends.length) {
      const b = el("button", { type: "button", class: "chip" }, "Find friends");
      b.addEventListener("click", () => openAccountView("friends"));
      parts.push(el("div", { class: "chips" }, b));
    }
  }
  return el("div", { class: "group friends-here", "data-tour": "friends-here" }, ...parts);
}

// The map's layer button.

function loadFriendsLayer() {
  try {
    friendsMap.layer = localStorage.getItem(FRIENDS_LAYER_KEY) !== "off";
  } catch { /* on */ }
}

function syncFriendsButton() {
  const box = $(".map-friends-box");
  const b = $("#map-friends-btn");
  box.hidden = !accountReady() || !!mapView.floor;
  const n = friendCheckinsNow().length;
  b.setAttribute("aria-pressed", String(friendsMap.layer));
  const label = `${friendsMap.layer ? "Hide" : "Show"} friends on the map${n ? ` (${plural(n, "friend", "friends")} checked in)` : ""}`;
  b.setAttribute("aria-label", label);
  b.title = label;
}

// The bubbles: one per building, above its label; overlapping ones merge (lib.js stackBubbles).

/**
 * How far above the building's anchor a bubble sits (px): above its label. Zoomed out the labels are small and the
 * bubbles too (26 px), zoomed in (cards) 32 px; bubbles closer than their size plus 4 px merge.
 */
const bubbleCards = () => $("#map-view").classList.contains("cards");
const bubbleLift = () => (bubbleCards() ? 40 : 21);
const bubbleGap = () => (bubbleCards() ? 36 : 30);

/** Who is checked in where on the map shown: [{ key: "Z|HG", area, code, people: [{ c, me }] }], you first. */
function checkinsByBuilding() {
  const out = new Map();
  const add = (c, me) => {
    const key = `${c.area}|${c.building}`;
    if (!out.has(key)) out.set(key, { key, area: c.area, code: c.building, people: [] });
    out.get(key).people.push({ c, me });
  };
  const mine = myCheckin();
  if (mine) add({ ...mine, person: account.me }, true);
  for (const c of friendCheckinsNow()) add(c, false);
  return [...out.values()];
}

/** Where a building's bubble goes on the map (metres in the shown campus's frame), or null when it isn't on it. */
function bubbleAnchor(area, code) {
  if (area === mapView.area) return pinFor("buildings", code) ?? anchorOf(code);
  if (ZENTRUM_PARTNER[mapView.area] === area) return anchorIn(area, code);
  return null;
}

function placeFriendBubbles() {
  const box = $("#map-friends");
  const show = accountReady() && friendsMap.layer && !!mapView.doc && !mapView.floor && !PIN_MODE; // zoomed out too: they merge
  const groups = show ? checkinsByBuilding() : [];
  const { cx, cy, scale, width, height } = mapView;
  const lift = bubbleLift();
  const items = [];
  const byKey = new Map();
  for (const g of groups) {
    const at = bubbleAnchor(g.area, g.code);
    if (!at) continue;
    items.push({ key: g.key, x: (at[0] - cx) * scale + width / 2, y: (at[1] - cy) * scale + height / 2 - lift, n: g.people.length });
    byKey.set(g.key, g);
  }
  const clusters = stackBubbles(items, bubbleGap());
  box.classList.toggle("small", !bubbleCards());
  const seen = new Set();
  for (const cl of clusters) {
    const id = cl.keys.join(",");
    seen.add(id);
    const people = cl.keys.flatMap((k) => byKey.get(k).people);
    const me = people.find((p) => p.me);
    const friends = people.filter((p) => !p.me);
    const face = friends[0] ?? me;
    const codes = cl.keys.map((k) => buildingLabel(byKey.get(k).code));
    const label = `${friends.length ? `${plural(friends.length, "friend", "friends")}${me ? " and you" : ""}` : "You"} in ${codes.join(", ")}: ${people.map((p) => (p.me ? "you" : p.c.person.username)).join(", ")}`;
    let node = friendsMap.nodes.get(id);
    const sig = people.map(({ c: { person: q } }) => [q.username, q.bg, q.fg, q.bg2, q.fg2, q.metal].join(",")).join("|");
    if (!node || node.dataset.sig !== sig) {
      node?.remove();
      node = el("button", { type: "button", class: `friend-bubble${me ? " me" : ""}`, "data-keys": id, "data-sig": sig },
        bubble(face.c.person), people.length > 1 ? el("span", { class: "fb-count" }, String(people.length)) : null);
      friendsMap.nodes.set(id, node);
      box.append(node);
    }
    node.setAttribute("aria-label", label);
    node.title = label;
    node.style.transform = `translate(${Math.round(cl.x)}px, ${Math.round(cl.y)}px) translate(-50%, -50%)`;
  }
  // The tutorial's "friend-bubbles": the first bubble with a friend in it, else the first.
  const first = clusters.find((cl) => cl.keys.some((k) => byKey.get(k).people.some((p) => !p.me))) ?? clusters[0];
  for (const [id, node] of friendsMap.nodes) {
    if (first && id === first.keys.join(",")) node.dataset.tour = "friend-bubbles";
    else delete node.dataset.tour;
    if (seen.has(id)) continue;
    node.remove();
    friendsMap.nodes.delete(id);
  }
}

/** A bubble was picked: "Friends in HG" (several buildings when merged). */
function openFriendsAt(keys) {
  openAccountView(`friendsat:${keys}`);
}

accountViews.friendsat = (box, arg) => {
  const keys = arg.split(",").filter(Boolean);
  const groups = new Map(checkinsByBuilding().map((g) => [g.key, g]));
  const codes = keys.map((k) => buildingLabel(k.split("|")[1]));
  $("#sheet-title").textContent = codes.length <= 2 ? `Friends in ${codes.join(" and ")}` : "Friends nearby";
  if (!accountReady()) return accountViews.signin(box);
  const parts = [];
  for (const key of keys) {
    const g = groups.get(key);
    if (!g) continue;
    const [area, code] = key.split("|");
    parts.push(el("section", { class: "detail-part" },
      el("h3", {}, buildingLabel(code), area !== state.area ? el("span", { class: "muted" }, ` · ${areaNameOf(area)}`) : null),
      el("ul", { class: "rows" }, ...g.people.map(({ c, me }) => (me ? myCheckinRow(c) : friendCheckinRow(c, "stack"))))));
  }
  if (!parts.length) parts.push(el("p", { class: "muted" }, "Nobody is checked in there any more."));
  const all = el("button", { type: "button", class: "sheet-link" }, "All checked-in friends →");
  all.addEventListener("click", () => {
    history.replaceState(null, "", "/");
    closePlace();
    selectMode("you");
  });
  fill(box, ...parts, el("div", { class: "detail-links" }, all));
};

/** Your own check-in among friends' (a merged bubble's view). */
function myCheckinRow(c) {
  const open = el("button", { type: "button", class: "row-open friend-open" },
    bubble(account.me, "me"),
    el("span", { class: "person-text" }, el("span", { class: "person-user" }, "You"), el("span", { class: "friend-place" }, c.name), el("span", { class: "person-name muted" }, checkinWhen(c, Date.now()))));
  open.addEventListener("click", () => openPlace({ kind: c.kind, id: c.place, area: c.area }, { from: "stack", opener: open }));
  return el("li", { class: "room friend-checkin mine" }, open);
}

/** A building's view: "Friends here: anna_k, zoe.m" when any friend is checked in there (and you, if you are). */
function friendsInBuilding(code) {
  const g = checkinsByBuilding().find((x) => x.code === code && (x.area === state.area || ZENTRUM_PARTNER[state.area] === x.area));
  if (!g) return null;
  const names = g.people.map((p) => (p.me ? "you" : p.c.person.username));
  const b = el("button", { type: "button", class: "sheet-link friends-here-link" }, smallIcon(FRIENDS_ICON), ` ${g.people.some((p) => !p.me) ? "Friends here" : "Checked in here"}: ${names.join(", ")} →`);
  b.addEventListener("click", () => openFriendsAt(g.key));
  return b;
}

function initFriendsMap() {
  loadFriendsLayer();
  $("#map-friends-btn").replaceChildren(smallIcon(FRIENDS_ICON));
  $("#map-friends-btn").addEventListener("click", () => {
    friendsMap.layer = !friendsMap.layer;
    try {
      localStorage.setItem(FRIENDS_LAYER_KEY, friendsMap.layer ? "on" : "off");
    } catch { /* for this visit */ }
    syncFriendsButton();
    scheduleDraw();
  });
  account.listeners.push(() => {
    if (accountReady() && !friendsMap.timer) pollFriendCheckins();
    else if (!accountReady()) pollFriendCheckins();
    syncFriendsButton();
    scheduleDraw();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && accountReady() && Date.now() - friendsMap.loadedAt > FRIENDS_REFRESH_MS - 10_000) loadFriendCheckins();
  });
  syncFriendsButton();
}

// --- people in the page's search (signed in): your friends at once, other people from /api/people ---

/** The search field changed: look for people too (from 3 letters, or a whole email address). */
function searchPeopleToo(query) {
  if (!accountReady()) return;
  if (!friendsView.data && !friendsView.loading) loadFriends();
  searchPeople(query);
}

const SEARCH_FRIENDS_SHOWN = 8;

/** The search's "People" group: matching friends first (with where they're checked in), then other people; or null. */
function peopleSearchGroup(query) {
  if (!accountReady()) return null;
  const q = query.trim();
  const mine = friendsView.data?.friends ?? [];
  const friendNames = new Set(mine.map((f) => f.username));
  const friends = sortFriends(mine).filter((p) => friendMatches(p, q)).slice(0, SEARCH_FRIENDS_SHOWN);
  const fetched = friendsView.peopleFor && foldText(friendsView.peopleFor) === foldText(q) ? friendsView.people ?? [] : [];
  const others = fetched.filter((p) => !friendNames.has(p.username) && p.username !== account.me.username);
  if (!friends.length && !others.length) return null;
  const checkedIn = new Map(friendCheckinsNow().map((c) => [c.person.username, c]));
  const row = (p, friend) => {
    const c = friend ? checkedIn.get(p.username) : null;
    const state = friend ? (c ? `at ${c.name}` : "Friend")
      : p.request === "sent" || friendsView.status.get(p.username) === "requested" ? "Requested"
      : p.request === "received" ? "Wants to be your friend" : null;
    const b = el("button", { type: "button", class: "search-hit person-hit" },
      bubble(p),
      el("span", { class: "person-text" }, el("span", { class: "hit-name" }, p.username), el("span", { class: "hit-sub muted" }, [p.name, state].filter(Boolean).join(" · "))));
    b.addEventListener("click", () => openFromSearch({ kind: "account", id: `person:${p.username}` }));
    return el("li", {}, b);
  };
  return el("section", { class: "search-group people-group" }, el("h2", {}, "People"),
    el("ul", {}, ...friends.map((p) => row(p, true)), ...others.map((p) => row(p, false))));
}

/** A person from search: a friend with where they're checked in, anyone else with Add friend. */
accountViews.person = (box, username) => {
  if (!accountReady() || !friendsView.data) {
    if (accountReady() && !friendsView.loading) loadFriends();
    if (accountReady()) return fill(box, el("p", { class: "muted" }, "Loading…"));
    return accountViews.add(box, username);
  }
  const friend = friendsView.data.friends.find((f) => f.username === username);
  if (!friend) return accountViews.add(box, username);
  $("#sheet-title").textContent = friend.username;
  const c = friendCheckinsNow().find((x) => x.person.username === username);
  fill(box,
    el("ul", { class: "people-list add-person" }, friendRow(friend)),
    el("section", { class: "detail-part" }, el("h3", {}, "Checked in"),
      c ? el("ul", { class: "rows" }, friendCheckinRow(c, "stack")) : el("p", { class: "muted" }, `${friend.username} isn't checked in right now.`)),
    friendsView.error ? el("p", { class: "message warning", role: "alert" }, friendsView.error) : null,
    accountLink("All your friends", "friends"));
};

/** Signed in, the search field says it finds friends too. */
function syncSearchPlaceholder() {
  const input = $("#search-input");
  const ready = accountReady();
  input.placeholder = ready ? "Room, study space, mensa, building or friend" : "Room, study space, mensa or building";
  input.setAttribute("aria-label", ready ? "Search rooms, study spaces, mensas, buildings and people" : "Search rooms, study spaces, mensas and buildings");
  $("#search-open span").textContent = ready ? "Search places and friends" : "Search rooms and places";
}
