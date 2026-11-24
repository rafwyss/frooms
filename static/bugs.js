// "Report a bug" (the account menu, worker/bugs.ts): first "Tap what's broken", an overlay over the whole page that
// outlines the element under the pointer and takes the one tapped, then the feedback window in its bug mode (app.js
// openFeedback) with that element named. Signed in, the report earns 50 street cred once an admin has checked it.
// Only a description of the element is sent (its id or tutorial name, role and visible text), never a screenshot: the
// page can show friends' names and check-ins.
"use strict";

const BUG_TEXT_MAX = 80;

/** The element as the report names it: tag, id, tutorial name, label and the start of its text. */
function describeBugElement(node) {
  const clip = (text, n = BUG_TEXT_MAX) => {
    const t = String(text ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const tag = node.tagName.toLowerCase();
  const tour = node.closest("[data-tour]")?.getAttribute("data-tour") ?? "";
  // The nearest id upwards: where on the page it is when the element itself has none.
  const within = node.closest("[id]");
  const label = node.getAttribute("aria-label") || node.getAttribute("title") || node.getAttribute("alt") || "";
  const text = clip(node.innerText || node.textContent || "");
  const classes = clip([...node.classList].slice(0, 3).join("."), 60);
  const name = `${tag}${node.id ? `#${node.id}` : ""}${classes ? `.${classes}` : ""}`;
  return {
    element: name,
    ...(within && within !== node ? { within: `#${within.id}` } : {}),
    ...(tour ? { tour } : {}),
    ...(label ? { label: clip(label) } : {}),
    ...(text ? { text } : {}),
  };
}

/** One line for the form: "“Send feedback” (button)" or "button.sheet-star". */
function bugElementLine(d) {
  if (!d) return "No element picked";
  const what = d.label || d.text;
  return what ? `“${what}” (${d.element.split(/[#.]/)[0]})` : d.element;
}

let bugPick = null;

/** Starts "Report a bug": the picker, then the form. */
function startBugReport() {
  if (bugPick) return;
  const box = el("div", { class: "bug-pick-box", "aria-hidden": "true" });
  const skip = el("button", { type: "button", class: "bug-pick-btn" }, "Skip");
  const cancel = el("button", { type: "button", class: "bug-pick-btn" }, "Cancel");
  const bar = el("div", { class: "bug-pick-bar", role: "dialog", "aria-label": "Report a bug" },
    el("span", { class: "bug-pick-text" }, el("strong", {}, "Tap what's broken"), el("span", { class: "muted" }, "or skip if it's not one thing")),
    skip, cancel);
  const layer = el("div", { class: "bug-pick" }, box, bar);
  const under = (x, y) => document.elementsFromPoint(x, y).find((n) => !layer.contains(n) && n !== document.documentElement && n !== document.body) ?? null;
  const outline = (node) => {
    if (!node) return (box.hidden = true);
    const r = node.getBoundingClientRect();
    box.hidden = false;
    Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
  };
  const end = (picked) => {
    document.removeEventListener("keydown", onKey, true);
    layer.remove();
    bugPick = null;
    if (picked !== undefined) openFeedback("broken", null, { bug: picked });
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    end();
  };
  layer.addEventListener("pointermove", (e) => {
    if (bar.contains(e.target)) return;
    outline(under(e.clientX, e.clientY));
  });
  layer.addEventListener("click", (e) => {
    if (bar.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const node = under(e.clientX, e.clientY);
    if (!node) return;
    outline(node);
    end(describeBugElement(node));
  });
  skip.addEventListener("click", () => end(null));
  cancel.addEventListener("click", () => end());
  document.addEventListener("keydown", onKey, true);
  box.hidden = true;
  document.body.append(layer);
  bugPick = layer;
  skip.focus();
}
