// Bug reports that earn Street cred once an admin has checked them. "Report a bug" in the account menu (static/bugs.js)
// sends an ordinary feedback (category "broken", the clicked element in its context) with `bug: true`; signed in, the
// feedback's id is then linked to the account in the accounts database (migrations-accounts/0004_bug_reports.sql) as
// pending. On /admin an admin rewards it (+50, the cred action `bug`, once per report by the log's UNIQUE ref) or
// declines it with a short reason the sender sees on their Street cred page.

import { AuthError } from "./auth";
import { award, credState, earned } from "./cred";

/** At most this many of your reports wait for a decision at a time; the next one is sent once one is decided. */
export const BUG_PENDING_MAX = 3;
/** The start of the message kept for the sender's list. */
export const BUG_SUMMARY_MAX = 120;
/** A decline's reason, shown to the sender under the report (two lines on a phone). */
export const BUG_REASON_MAX = 120;
/** Decided reports on /admin: the last 30 days. */
const DECIDED_SHOWN_MS = 30 * 86_400_000;

/** The message's first characters, on one line, for the sender's list. */
export function bugSummary(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > BUG_SUMMARY_MAX ? `${line.slice(0, BUG_SUMMARY_MAX - 1)}…` : line;
}

/** How many of `userId`'s reports wait for a decision. */
export async function pendingBugs(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM bug_reports WHERE user_id = ? AND status = 'pending'").bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Links feedback `id` to its sender as pending. */
export async function linkBug(db: D1Database, id: number, userId: string, at: number, message: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO bug_reports (id, user_id, at, summary) VALUES (?, ?, ?, ?)")
    .bind(id, userId, at, bugSummary(message))
    .run();
}

export interface AdminBug {
  id: number;
  at: number;
  username: string | null;
  name: string | null;
  status: string;
  reason: string | null;
  decided_at: number | null;
}

/** For /admin: every pending report (oldest first) and those decided in the last 30 days (newest first). */
export async function adminBugs(db: D1Database, now: number): Promise<AdminBug[]> {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.at, u.username, u.first_name || ' ' || u.last_name AS name, b.status, b.reason, b.decided_at
       FROM bug_reports b LEFT JOIN users u ON u.id = b.user_id
       WHERE b.status = 'pending' OR b.decided_at >= ?
       ORDER BY b.status != 'pending', CASE WHEN b.status = 'pending' THEN b.at ELSE -b.decided_at END`,
    )
    .bind(now - DECIDED_SHOWN_MS)
    .all<AdminBug>();
  return results;
}

/**
 * Rewards (`reason` ignored) or declines (`reason` required, at most BUG_REASON_MAX characters) pending report `id`.
 * 404 when there is no such report, 409 when it is decided already. Answers the report's new state and, for a reward,
 * what the sender earned.
 */
export async function decideBug(db: D1Database, id: number, decision: unknown, reason: unknown, now: number) {
  if (!Number.isInteger(id) || id < 1) throw new AuthError(400, "bad_id");
  if (decision !== "reward" && decision !== "decline") throw new AuthError(400, "bad_decision");
  const why = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "";
  if (decision === "decline" && !why) throw new AuthError(400, "reason_needed");
  if (why.length > BUG_REASON_MAX) throw new AuthError(400, "reason_too_long");
  const row = await db.prepare("SELECT user_id, status FROM bug_reports WHERE id = ?").bind(id).first<{ user_id: string; status: string }>();
  if (!row) throw new AuthError(404, "no_such_bug");
  if (row.status !== "pending") throw new AuthError(409, "already_decided");
  const mark = db
    .prepare("UPDATE bug_reports SET status = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .bind(decision === "reward" ? "rewarded" : "declined", decision === "reward" ? null : why, now, id);
  if (decision === "decline") {
    await mark.run();
    return { id, status: "declined", reason: why };
  }
  const earn = await award(db, row.user_id, "bug", String(id), now);
  await db.batch([mark, ...earn]);
  return { id, status: "rewarded", cred: await credState(db, row.user_id, earned("bug", earn)) };
}
