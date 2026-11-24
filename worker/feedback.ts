// The feedback form in the page's footer: validates a submission, stores it in D1 (migrations/0004_feedback.sql) and
// builds the notification email that index.ts sends for it.

import { toZurichIso } from "./tz";

export const FEEDBACK_CATEGORIES = ["broken", "wrong-info", "idea", "person", "other"] as const;
export const MAX_MESSAGE = 4000;
const MAX_EMAIL = 200;
const MAX_CONTEXT = 2000; // bytes of JSON
/** Overall cap, so a flood from many addresses can't fill the database. */
export const MAX_FEEDBACK_PER_DAY = 200;

export const FEEDBACK_FROM = { email: "feedback@notify.frooms.ch", name: "frooms feedback" };
const LABELS: Record<string, string> = {
  broken: "Something's broken",
  "wrong-info": "Wrong room info",
  idea: "Idea or improvement",
  person: "Report a person",
  other: "Other",
};

export interface Feedback {
  /** fruum's feedback.id (0 in tests that build one by hand). */
  id: number;
  at: number;
  category: string;
  message: string;
  email: string | null;
  context: Record<string, unknown> | null;
}

export class FeedbackError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Stores one submission and returns it, or throws a FeedbackError saying what's wrong with it. Honeypot hits are
 * dropped silently (null), so bots see the same answer as people.
 */
export async function saveFeedback(db: D1Database, body: unknown, now = Date.now()): Promise<Feedback | null> {
  if (!body || typeof body !== "object") throw new FeedbackError(400, "Expected a JSON object");
  const b = body as Record<string, unknown>;
  // A field people never see; bots fill in every field they find.
  if (typeof b.website === "string" && b.website !== "") return null;

  if (!FEEDBACK_CATEGORIES.includes(b.category as never)) throw new FeedbackError(400, "Pick a category");
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!message) throw new FeedbackError(400, "Please describe your feedback");
  if (message.length > MAX_MESSAGE) throw new FeedbackError(400, `Please keep it under ${MAX_MESSAGE} characters`);

  const email = typeof b.email === "string" ? b.email.trim() : "";
  if (email && (email.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new FeedbackError(400, "That email address doesn't look right");
  }
  let context: string | null = null;
  if (b.context && typeof b.context === "object") {
    context = JSON.stringify(b.context);
    if (context.length > MAX_CONTEXT) context = null;
  }

  const recent = await db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE at > ?").bind(now - 86_400_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_FEEDBACK_PER_DAY) {
    throw new FeedbackError(503, "Lots of feedback today already. Please try again tomorrow or write to info@frooms.ch");
  }
  const res = await db
    .prepare("INSERT INTO feedback (at, category, message, email, context) VALUES (?, ?, ?, ?, ?)")
    .bind(now, b.category as string, message, email || null, context)
    .run();
  return { id: Number(res.meta?.last_row_id ?? 0), at: now, category: b.category as string, message, email: email || null, context: context ? JSON.parse(context) : null };
}

/**
 * The notification for one submission: the whole feedback, with Reply-To set to the sender when they gave an email.
 * `bugFrom` (a bug report sent signed in, worker/bugs.ts): the sender's username, and the subject says a reward waits.
 */
export function feedbackEmail(f: Feedback, to: string, bugFrom: string | null = null): EmailMessageBuilder {
  const label = bugFrom ? `Bug report (reward pending) from @${bugFrom}` : (LABELS[f.category] ?? f.category);
  const firstLine = f.message.split(/\s*\n/)[0].replace(/\s+/g, " ");
  const teaser = firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
  const when = toZurichIso(f.at).slice(0, 16).replace("T", " ");
  const context = Object.entries(f.context ?? {})
    .filter(([, v]) => v !== "" && v !== null && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `  ${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  const text = [
    `Category: ${label}`,
    `From: ${f.email ? `${f.email} (reply to this email to answer)` : "not given"}`,
    ...(bugFrom ? [`Reward or decline it on https://frooms.ch/admin (report #${f.id})`] : []),
    `Sent: ${when} (Zurich time)`,
    "",
    f.message,
    "",
    "---",
    context.length ? `What they had open:\n${context.join("\n")}` : "No page context.",
  ].join("\n");
  return {
    from: FEEDBACK_FROM,
    to,
    subject: `[frooms] ${label}: ${teaser}`,
    text,
    ...(f.email ? { replyTo: f.email } : {}),
  };
}
