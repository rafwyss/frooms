// The admin page (/admin, plans/PLAN_ADMIN_STATS.md section 7.2): the numbers of GET /api/admin/stats as one card per
// group, each a table (metric | Total | 30 days | 7 days | Today) with a 30-day bar chart per row that has a series.
// A plain script on its own: nothing from app.js. The endpoint answers 404 to everyone but the admins; /api/me then
// tells signed out (401) from "not available".
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";
  const WEB_ANALYTICS = "https://dash.cloudflare.com/16809ae8e49ba07862a09c7258bde7b1/web-analytics";
  const numberFmt = new Intl.NumberFormat("en-GB");
  const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const shortDayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" });

  /** An element with attributes and children (strings become text, never HTML). */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }

  function svg(tag, attrs = {}, ...children) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    for (const c of children) node.append(c);
    return node;
  }

  const date = (iso) => new Date(`${iso}T00:00:00Z`);
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const fmt = (n) => (typeof n === "number" ? numberFmt.format(n) : "–");

  // --- States -----------------------------------------------------------------------------------------------------

  function showState(...children) {
    $("stats").hidden = true;
    const state = $("state");
    state.hidden = false;
    state.replaceChildren(...children);
  }

  const loading = () => showState(el("p", { text: "Loading…" }));

  const signedOut = () =>
    showState(
      el("h1", { text: "Sign in" }),
      el("p", { text: "This page is for frooms' admins. Sign in with your edu-ID to see it." }),
      el("a", { class: "button primary", href: "/auth/login?return=/admin", text: "Sign in" }),
    );

  const notAvailable = () => showState(el("h1", { text: "Not available." }), el("p", {}, el("a", { href: "/", text: "Back to frooms" })));

  function failed(message) {
    const retry = el("button", { type: "button", class: "button", text: "Try again" });
    retry.addEventListener("click", load);
    showState(el("h1", { text: "Couldn't load the numbers" }), el("p", { text: message }), retry);
  }

  // --- Loading ----------------------------------------------------------------------------------------------------

  async function detail(res) {
    try {
      return (await res.json()).detail || "";
    } catch {
      return "";
    }
  }

  async function load() {
    if ($("stats").hidden) loading();
    $("refresh").disabled = true;
    try {
      let res;
      try {
        res = await fetch("/api/admin/stats", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      } catch {
        return failed("frooms can't be reached. Check the connection.");
      }
      if (res.ok) return render(await res.json());
      if (res.status === 404 || res.status === 401) {
        // Not an admin, or not signed in: the account call says which.
        let me = null;
        try {
          me = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" });
        } catch {
          // offline: say "not available" rather than guess
        }
        return me && me.status === 401 ? signedOut() : notAvailable();
      }
      if (res.status === 429) return failed("Too many requests. Try again in a minute.");
      failed((await detail(res)) || `The server answered ${res.status}.`);
    } finally {
      $("refresh").disabled = false;
    }
  }

  // --- The chart --------------------------------------------------------------------------------------------------

  const W = 120;
  const H = 24;

  /** 30 bars, oldest first, today's marked; each bar's day and number on hover, all of them in the label. */
  function chart(series, lastDay) {
    const n = series.length;
    const pitch = W / n;
    const bar = Math.max(1, pitch - 1);
    const max = Math.max(...series, 0);
    const first = addDays(lastDay, -(n - 1));
    const label = `Last ${n} days, ${shortDayFmt.format(date(first))} to today: ${series.map(fmt).join(", ")}`;
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label, focusable: "false", preserveAspectRatio: "none" });
    series.forEach((v, i) => {
      const day = addDays(lastDay, i - (n - 1));
      const h = v > 0 && max > 0 ? Math.max(2, (v / max) * H) : 1;
      const x = i * pitch;
      const hit = svg("rect", { class: "hit", x, y: 0, width: pitch, height: H });
      hit.append(svg("title", {}, `${dayFmt.format(date(day))}: ${fmt(v)}`));
      const cls = `bar${i === n - 1 ? " today" : ""}${v > 0 ? "" : " zero"}`;
      root.append(hit, svg("rect", { class: cls, x: x + 0.5, y: H - h, width: bar, height: h, rx: Math.min(1, bar / 2) }));
    });
    return root;
  }

  // --- The tables -------------------------------------------------------------------------------------------------

  const period = (long, short) => [el("span", { class: "long", text: long }), el("span", { class: "short", text: short })];

  function numCell(value, sub) {
    return el("td", { class: "num" }, fmt(value), sub ? el("small", { text: sub }) : null);
  }

  /** The note under a metric's name: its note, else where it comes from. Both in the label's tooltip. */
  function metricCell(m, part) {
    const small = m.note || (part ? "" : m.source || "");
    return el("th", { scope: "row", class: "metric", title: [m.source, m.note].filter(Boolean).join(" · ") || null }, m.label, small ? el("small", { text: small }) : null);
  }

  function rows(m, lastDay, hasCharts) {
    const since = m.since ? `since ${shortDayFmt.format(date(m.since))}` : null;
    const tbody = el("tbody");
    const chartCell = (cls) => el("td", { class: `chart ${cls}` }, m.series ? chart(m.series, lastDay) : null);
    tbody.append(
      el(
        "tr",
        {},
        metricCell(m, false),
        numCell(m.total, since),
        numCell(m.d30),
        numCell(m.d7),
        numCell(m.today),
        hasCharts ? chartCell("beside") : null,
      ),
    );
    // On phones the chart has a row of its own under the numbers (CSS shows one or the other).
    if (m.series) tbody.append(el("tr", { class: "under", "aria-hidden": "true" }, el("td", { colspan: 5 }, chart(m.series, lastDay))));
    for (const p of m.parts || []) {
      tbody.append(el("tr", { class: "part" }, metricCell(p, true), numCell(p.total), numCell(p.d30), numCell(p.d7), numCell(p.today), hasCharts ? el("td", { class: "chart beside" }) : null));
    }
    return tbody;
  }

  function card(group, lastDay, opts = {}) {
    const metrics = group.key === "use" ? [...group.metrics].sort((a, b) => (b.d30 ?? -1) - (a.d30 ?? -1)) : group.metrics;
    const hasCharts = metrics.some((m) => m.series);
    const head = el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { scope: "col", class: "metric" }, el("span", { class: "visually-hidden", text: "Metric" })),
        el("th", { scope: "col", class: "num", text: "Total" }),
        el("th", { scope: "col", class: "num" }, period("30 days", "30 d")),
        el("th", { scope: "col", class: "num" }, period("7 days", "7 d")),
        el("th", { scope: "col", class: "num", text: "Today" }),
        hasCharts ? el("th", { scope: "col", class: "chart", text: "Last 30 days" }) : null,
      ),
    );
    const table = el("table", {}, el("caption", { class: "visually-hidden", text: group.label }), head, metrics.map((m) => rows(m, lastDay, hasCharts)));
    return el("section", { class: "card", "aria-label": group.label }, el("h2", { text: group.label }), opts.intro ? el("p", { class: "muted" }, opts.intro) : null, table);
  }

  const VISITS_WHY = {
    no_token: "",
    no_site: "The Web Analytics site isn't configured (CF_ACCOUNT_ID, CF_SITE_TAG).",
    timeout: "Cloudflare didn't answer in time.",
    error: "Cloudflare's answer couldn't be read.",
  };

  function visitsCard(a) {
    const link = () => el("a", { href: WEB_ANALYTICS, target: "_blank", rel: "noopener", text: "Cloudflare Web Analytics" });
    // Cloudflare's days are UTC days: the chart ends on the group's own day.
    if (a.visits) return card(a.visits, a.visits.day || a.day, { intro: ["From ", link(), ", by UTC day."] });
    const why = VISITS_WHY[a.visits_reason] || "";
    return el(
      "section",
      { class: "card", "aria-label": "Visits" },
      el("h2", { text: "Visits" }),
      why ? el("p", { class: "muted", text: why }) : null,
      el("p", {}, "Visits: see ", link(), "."),
    );
  }

  function render(a) {
    $("state").hidden = true;
    $("stats").hidden = false;
    $("today").textContent = `Today, ${dayFmt.format(date(a.day))}`;
    const where = a.host_db === "fruum-accounts" ? "" : ` · accounts from ${a.host_db}`;
    $("asof").textContent = `Data from ${timeFmt.format(new Date(a.generated_at))}${where}`;
    const banner = $("banner");
    banner.hidden = a.counters !== "missing";
    banner.textContent = a.counters === "missing"
      ? "The usage counters aren't set up on this database yet (migrations-accounts/0003_stats.sql), so the counted numbers show –."
      : "";
    const groups = a.groups.map((g) => card(g, a.day));
    // Visits after Accounts, so the two columns start with who comes and who signs up.
    groups.splice(1, 0, visitsCard(a));
    $("cards").replaceChildren(...groups);
    renderFeedback(a.feedback || []);
    renderBugs(a.bugs || []);
  }

  // --- Feedback -----------------------------------------------------------------------------------------------------

  const FEEDBACK_LABELS = {
    broken: "Something's broken",
    "wrong-info": "Wrong room info",
    idea: "Idea or improvement",
    person: "Report a person",
    other: "Other",
  };
  const FEEDBACK_FIRST = 20;
  const whenFmt = new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich",
  });
  let feedbackAll = false;

  /** What the sender had open, as "key: value" pairs (empty values left out), like the email's last lines. */
  function contextText(ctx) {
    if (!ctx) return "";
    return Object.entries(ctx)
      .filter(([, v]) => v !== "" && v !== null && v !== undefined && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" · ");
  }

  function feedbackEntry(f) {
    const context = contextText(f.context);
    return el(
      "li",
      { class: "fb" },
      el(
        "div",
        { class: "fb-head" },
        el("span", { class: `fb-cat cat-${f.category}`, text: FEEDBACK_LABELS[f.category] || f.category }),
        el("time", { datetime: new Date(f.at).toISOString(), text: whenFmt.format(new Date(f.at)) }),
        f.email ? el("a", { href: `mailto:${f.email}`, text: f.email }) : el("span", { class: "muted", text: "No email" }),
      ),
      el("p", { class: "fb-msg", text: f.message }),
      context ? el("p", { class: "fb-ctx muted", text: context }) : null,
    );
  }

  function renderFeedback(list) {
    const shown = feedbackAll ? list : list.slice(0, FEEDBACK_FIRST);
    $("feedback-intro").textContent = list.length
      ? `The newest ${list.length === 1 ? "message" : `${list.length} messages`}, newest first (at most 100). Each one is still emailed too.`
      : "No feedback yet.";
    $("feedback-list").replaceChildren(...shown.map(feedbackEntry));
    const more = $("feedback-more");
    more.hidden = shown.length >= list.length;
    more.textContent = `Show all ${list.length}`;
    more.onclick = () => {
      feedbackAll = true;
      renderFeedback(list);
    };
  }

  // --- Bug reports (worker/bugs.ts) ----------------------------------------------------------------------------------

  const BUG_POINTS = 50;
  const REASON_MAX = 120; // worker/bugs.ts BUG_REASON_MAX: two lines on the sender's phone
  const BUG_ERRORS = {
    reason_needed: "Write a reason first.",
    reason_too_long: `At most ${REASON_MAX} characters.`,
    already_decided: "Already decided. Refresh to see it.",
    no_such_bug: "That report is gone. Refresh.",
  };

  async function decide(id, decision, reason, msg, buttons) {
    buttons.forEach((b) => (b.disabled = true));
    msg.textContent = "Saving…";
    try {
      const res = await fetch("/api/admin/bug", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ id, decision, reason }),
      });
      if (res.ok) return load();
      const code = await detail(res);
      msg.textContent = BUG_ERRORS[code] || code || `The server answered ${res.status}.`;
    } catch {
      msg.textContent = "frooms can't be reached. Check the connection.";
    }
    buttons.forEach((b) => (b.disabled = false));
  }

  function bugEntry(b) {
    const who = b.username ? `@${b.username}${b.name ? ` (${b.name})` : ""}` : "A deleted account";
    const picked = b.context && b.context.picked;
    const rest = b.context ? { ...b.context } : null;
    if (rest) delete rest.picked;
    const status = b.status === "pending" ? "Pending" : b.status === "rewarded" ? `Rewarded +${BUG_POINTS}` : "Declined";
    const li = el(
      "li",
      { class: "fb" },
      el(
        "div",
        { class: "fb-head" },
        el("span", { class: `fb-cat bug-${b.status}`, text: status }),
        el("time", { datetime: new Date(b.at).toISOString(), text: whenFmt.format(new Date(b.at)) }),
        el("span", { text: who }),
        el("span", { class: "muted", text: `#${b.id}` }),
      ),
      el("p", { class: "fb-msg", text: b.message ?? "(The feedback row is gone.)" }),
      picked ? el("p", { class: "fb-ctx", text: `Picked: ${contextText(picked)}` }) : el("p", { class: "fb-ctx muted", text: "No element picked." }),
      rest ? el("p", { class: "fb-ctx muted", text: contextText(rest) }) : null,
      b.status === "declined" && b.reason ? el("p", { class: "fb-ctx", text: `Reason: ${b.reason}` }) : null,
    );
    if (b.status !== "pending") return li;
    const msg = el("p", { class: "fb-ctx bug-msg", role: "status" });
    const reward = el("button", { type: "button", class: "button primary", text: `Reward +${BUG_POINTS}` });
    const decline = el("button", { type: "button", class: "button", text: "Decline…" });
    const reason = el("input", { type: "text", class: "bug-reason", maxlength: REASON_MAX, placeholder: "Why not? The sender sees this.", "aria-label": "Reason" });
    const count = el("span", { class: "muted bug-count", text: `0/${REASON_MAX}` });
    const confirm = el("button", { type: "button", class: "button", text: "Decline" });
    const declineRow = el("div", { class: "bug-decline", hidden: true }, reason, count, confirm);
    const all = [reward, decline, confirm];
    reason.addEventListener("input", () => (count.textContent = `${reason.value.length}/${REASON_MAX}`));
    reward.addEventListener("click", () => decide(b.id, "reward", "", msg, all));
    decline.addEventListener("click", () => {
      declineRow.hidden = false;
      reason.focus();
    });
    confirm.addEventListener("click", () => decide(b.id, "decline", reason.value, msg, all));
    li.append(el("div", { class: "bug-actions" }, reward, decline), declineRow, msg);
    return li;
  }

  function renderBugs(list) {
    $("bugs").hidden = !list.length;
    const pending = list.filter((b) => b.status === "pending").length;
    $("bugs-intro").textContent = `${pending ? `${pending} waiting for you, oldest first.` : "Nothing waiting."} Decided in the last 30 days below. A decline's reason (at most ${REASON_MAX} characters) shows on the sender's Street cred page.`;
    $("bugs-list").replaceChildren(...list.map(bugEntry));
  }

  $("refresh").addEventListener("click", load);
  load();
})();
