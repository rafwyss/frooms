// Renders /api/experiment (see worker/experiment.ts) on experiment.html.
"use strict";

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : String(c ?? ""));
  return node;
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)} %` : "–");
const dayLabel = (iso) => new Date(`${iso}T12:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const time = (iso) => iso.slice(11, 16);
const when = (iso) => `${dayLabel(iso.slice(0, 10))} ${time(iso)}`;

function table(target, head, rows) {
  const t = $(target);
  t.replaceChildren(
    el("thead", {}, el("tr", {}, ...head.map(([label, cls]) => el("th", cls ? { class: cls } : {}, label)))),
    el("tbody", {}, ...rows.map((cells) => el("tr", {}, ...cells.map(([v, cls]) => el("td", cls ? { class: cls } : {}, v))))),
  );
}

function sum(rows, key) {
  return rows.reduce((s, r) => s + r[key], 0);
}

// Width set through the DOM: the CSP doesn't allow inline style attributes.
function bar(px) {
  const b = el("span", { class: "bar" });
  b.style.width = `${Math.round(px)}px`;
  return b;
}

function kpi(value, label, alert = false) {
  return el("div", { class: `kpi${alert ? " alert" : ""}` }, el("div", { class: "value" }, value), el("span", { class: "label muted" }, label));
}

function typeTable(target, rows) {
  const block = $(target).closest("section");
  block.hidden = !rows.length;
  const total = {
    type: "All",
    rooms: sum(rows, "rooms"),
    checks: sum(rows, "checks"),
    changed: sum(rows, "changed"),
    hours: sum(rows, "hours"),
    added_upcoming: sum(rows, "added_upcoming"),
    removed_upcoming: sum(rows, "removed_upcoming"),
    added: sum(rows, "added"),
    removed: sum(rows, "removed"),
    rooms_changed: sum(rows, "rooms_changed"),
  };
  const body = [...rows, ...(rows.length > 1 ? [total] : [])];
  table(
    target,
    [["Type"], ["Rooms", "num"], ["Re-fetches", "num"], ["With a change", "num"], ["New, upcoming", "num"], ["Dropped, upcoming", "num"], ["All changes", "num"], ["Rooms affected", "num"], ["Changes / 100 room-hours", "num"]],
    body.map((r) => [
      [r.type],
      [r.rooms, "num"],
      [r.checks, "num"],
      [pct(r.changed, r.checks), "num"],
      [r.added_upcoming, "num added"],
      [r.removed_upcoming, "num removed"],
      [r.added + r.removed, "num"],
      [r.rooms_changed, "num"],
      [r.hours ? ((100 * (r.added + r.removed)) / r.hours).toFixed(2) : "–", "num"],
    ]),
  );
}

function render(data) {
  const finished = !data.active;
  const range = data.first_day ? ` Data from ${dayLabel(data.first_day)} to ${dayLabel(data.last_day)}.` : " No data yet.";
  // `until` is exclusive: the last day with checks is the day before.
  const last = new Date(`${data.until}T12:00`);
  last.setDate(last.getDate() - 1);
  const end = dayLabel(last.toISOString().slice(0, 10));
  $("#state").textContent = finished ? `Finished: the last day was ${end}.${range}` : `Running through ${end}.${range}`;

  const check = data.types.filter((t) => t.source === "check");
  const refresh = data.types.filter((t) => t.source === "refresh");

  if (check.length) {
    const checks = sum(check, "checks");
    const upcoming = sum(check, "added_upcoming") + sum(check, "removed_upcoming");
    const baseChecks = sum(refresh, "checks");
    const baseUpcoming = sum(refresh, "added_upcoming") + sum(refresh, "removed_upcoming");
    $("#kpis").replaceChildren(
      kpi(checks.toLocaleString("en-GB"), "extra checks of rooms fetched once a night"),
      kpi(pct(sum(check, "changed"), checks), "of those checks found any change"),
      kpi(upcoming, "upcoming changes frooms would have missed", upcoming > 0),
      kpi(pct(upcoming, checks), `upcoming changes per check (seminar and meeting rooms: ${pct(baseUpcoming, baseChecks)})`),
    );
    $("#kpis").hidden = false;
  }

  typeTable("#check-table", check);
  typeTable("#refresh-table", refresh);

  const days = new Map();
  for (const d of data.days) {
    if (!days.has(d.day)) days.set(d.day, { check: { checks: 0, changed: 0 }, refresh: { checks: 0, changed: 0 } });
    days.get(d.day)[d.source] = d;
  }
  const maxChecks = Math.max(1, ...[...days.values()].map((d) => d.check.checks));
  $("#days-block").hidden = !days.size;
  table(
    "#days-table",
    [["Day"], ["Extra checks", "num"], ["With a change", "num"], [""], ["Refreshes", "num"], ["With a change", "num"]],
    [...days].map(([day, d]) => [
      [dayLabel(day)],
      [d.check.checks, "num"],
      [pct(d.check.changed, d.check.checks), "num"],
      [bar((60 * d.check.checks) / maxChecks)],
      [d.refresh.checks, "num"],
      [pct(d.refresh.changed, d.refresh.checks), "num"],
    ]),
  );

  $("#recent-block").hidden = !data.recent.length;
  table(
    "#recent-table",
    [["Noticed"], ["Room"], ["Type"], ["Change"], ["Booking"], ["Title"], ["Upcoming"]],
    data.recent.map((c) => [
      [when(c.detected_at)],
      [c.path],
      [c.type],
      [c.kind === "added" ? "new" : "dropped", c.kind],
      [`${dayLabel(c.day)} ${time(c.date_from)}–${time(c.date_to)}`],
      [c.title ?? "", "title"],
      [c.upcoming ? "yes" : "no"],
    ]),
  );
}

fetch("/api/experiment")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then(render)
  .catch((e) => {
    $("#state").textContent = `Could not load the results: ${e.message}`;
  });
