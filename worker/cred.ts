// Street cred (plans/PLAN_STREET_CRED.md, sections 5 and 6): points that signed-in people earn for what others can see
// or use, in the accounts database. The Worker awards them where the action happens (social.ts, index.ts); this module
// holds the rules, the caps, the levels and the read side (summary, log, leaderboards).
//
// A day is the Zurich calendar day. Every award is one row in `cred`, made once by UNIQUE (user_id, action, ref), and
// raises `users.cred_total` in the same batch. Old rows go after 12 months (except friends'); the total stays.

import { AuthError, sha256Hex } from "./auth";
import { batchWithBump, bumpFor } from "./stats";
import { zurichDate, zurichToUtc } from "./tz";

const DAY_MS = 86_400_000;
export const RECENT_MS = 30 * DAY_MS; // "Recent": a rolling 30 days
export const CRED_KEPT_MS = 365 * DAY_MS; // log rows older than this go (except `friend`)
export const LOG_PAGE = 50;
export const LATEST = 5;
export const BOARD_SIZE = 50;

export const ACTIONS = ["friend", "checkin", "report", "report_liked", "report_vote", "invite", "problem", "feedback", "meal_rating", "bug"] as const;
export type CredAction = (typeof ACTIONS)[number];

/** Points per action (section 5). */
export const POINTS: Record<CredAction, number> = {
  friend: 25,
  checkin: 5,
  report: 3,
  report_liked: 1,
  report_vote: 1,
  invite: 3,
  problem: 5,
  feedback: 10,
  meal_rating: 3,
  // A bug report an admin rewarded (worker/bugs.ts): no daily cap, since each one is checked by hand.
  bug: 50,
};

/** Awards per Zurich day; actions without an entry have no daily cap (friends: once per pair; likes: per 👍). */
export const CAPS: Partial<Record<CredAction, number>> = {
  checkin: 4,
  report: 10,
  report_vote: 20,
  invite: 5,
  problem: 3,
  feedback: 1,
  meal_rating: 5,
};

/** A check-in at the same place within this long of an earlier one earns nothing. */
export const CHECKIN_SAME_PLACE_MS = 2 * 3_600_000;

/** Actions whose `ref` is a counter of the day ("2026-11-18:2"): each earns per occurrence up to the cap. */
const COUNTED = new Set<CredAction>(["invite", "problem", "feedback"]);

/** The invite kinds POST /api/cred/invite takes. */
export const INVITE_KINDS = new Set(["checkin", "place", "meal", "friend-link"]);

// --- Levels (static/lib.js keeps the same rule; test/cred.test.ts compares them) --------------------------------------

/** The highest level: 20, at 10,450 points. */
export const MAX_LEVEL = 20;

/** Points where `level` starts: level 1 at 0, then each step 50 more than the one before (100, 250, 450, 700, 1000 …). */
export function levelStart(level: number): number {
  const n = Math.max(0, Math.floor(level) - 1);
  return 100 * n + 25 * n * (n - 1);
}

/** The level of an all-time total: 1 from 0, 2 from 100, 3 from 250 and so on up to MAX_LEVEL. */
export function levelOf(points: number): number {
  let level = 1;
  while (level < MAX_LEVEL && levelStart(level + 1) <= points) level++;
  return level;
}

/** What each level unlocks for the bubble; higher levels unlock nothing new yet. */
export const UNLOCKS: Record<number, { key: string; label: string }> = {
  2: { key: "gradient-bg", label: "Gradient background" },
  3: { key: "gradient-text", label: "Gradient text" },
  4: { key: "bronze", label: "Bronze bubble" },
  5: { key: "silver", label: "Silver bubble" },
  6: { key: "gold", label: "Gold bubble" },
};

/** The next unlock above `level`, or null when there is none ("More rewards later"). */
export function nextUnlock(level: number): { level: number; key: string; label: string } | null {
  const next = Object.keys(UNLOCKS).map(Number).sort((a, b) => a - b).find((l) => l > level);
  return next === undefined ? null : { level: next, ...UNLOCKS[next] };
}

// --- Awarding ---------------------------------------------------------------------------------------------------------

/** When the Zurich day of `now` began. */
export function dayStart(now: number): number {
  const [y, m, d] = zurichDate(now).split("-").map(Number);
  return zurichToUtc(y, m, d);
}

/**
 * The statements that award `action` to `userId` (add them to the caller's batch), or none when nothing is earned: the
 * same `ref` was awarded before, or the day's cap is reached. For invites and feedback, `ref` is left out and becomes
 * the day plus a counter. `detail` is the place's or dish's name for the log's label.
 */
export async function award(
  db: D1Database,
  userId: string,
  action: CredAction,
  ref: string | null,
  now: number,
  detail: string | null = null,
): Promise<D1PreparedStatement[]> {
  const cap = CAPS[action];
  // A friendship with someone who deleted their account is kept under formerFriendRef; edu-ID gives them the same id
  // when they come back, so befriending them again must not pay a second time.
  const former = action === "friend" && ref ? await formerFriendRef(ref) : (ref ?? "");
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM cred WHERE user_id = ?1 AND action = ?2 AND at >= ?3) AS today,
              (SELECT COUNT(*) FROM cred WHERE user_id = ?1 AND action = ?2 AND ref IN (?4, ?5)) AS had`,
    )
    .bind(userId, action, dayStart(now), ref ?? "", former)
    .first<{ today: number; had: number }>();
  const today = row?.today ?? 0;
  if (cap !== undefined && today >= cap) return [];
  if (COUNTED.has(action)) ref = `${zurichDate(now)}:${today + 1}`;
  else if (!ref || row?.had) return [];
  const points = POINTS[action];
  return [
    db
      .prepare("INSERT OR IGNORE INTO cred (user_id, at, action, points, ref, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(userId, now, action, points, ref, detail),
    // changes(): the insert just before, so a row that was already there (a race) adds nothing.
    db.prepare("UPDATE users SET cred_total = cred_total + ?1, cred_at = ?2 WHERE id = ?3 AND changes() > 0").bind(points, now, userId),
  ];
}

/** The statements that take an award back (a 👍 turned 👎 or removed, a friend removed), or none when there is nothing to take. */
export async function takeBack(db: D1Database, userId: string, action: CredAction, ref: string): Promise<D1PreparedStatement[]> {
  const row = await db.prepare("SELECT points FROM cred WHERE user_id = ? AND action = ? AND ref = ?").bind(userId, action, ref).first<{ points: number }>();
  if (!row) return [];
  return [
    db.prepare("DELETE FROM cred WHERE user_id = ? AND action = ? AND ref = ?").bind(userId, action, ref),
    db.prepare("UPDATE users SET cred_total = MAX(0, cred_total - ?1) WHERE id = ?2 AND changes() > 0").bind(row.points, userId),
  ];
}

/** What an answer that awards carries, so the page can show "+5 street cred": what this action earned, the new total. */
export async function credState(db: D1Database, userId: string, points: number) {
  const total = (await db.prepare("SELECT cred_total AS t FROM users WHERE id = ?").bind(userId).first<{ t: number }>())?.t ?? 0;
  return { points, total, level: levelOf(total) };
}

/** Points earned by statements from award() (0 when it gave none). */
export const earned = (action: CredAction, statements: D1PreparedStatement[]) => (statements.length ? POINTS[action] : 0);

// --- Reading ----------------------------------------------------------------------------------------------------------

/** The log line of an entry, built when read (never stored). `friend` is the other person's username, if they still exist. */
export function logLabel(action: string, detail: string | null, friend: string | null = null): string {
  switch (action) {
    case "friend":
      return friend ? `Friends with @${friend}` : "Friends with a former user";
    case "checkin":
      return detail ? `Checked in at ${detail}` : "Checked in";
    case "report":
      return detail ? `Reported occupancy at ${detail}` : "Reported occupancy";
    case "report_liked":
      return detail ? `Your report at ${detail} got a 👍` : "Your report got a 👍";
    case "report_vote":
      return "Rated a report";
    case "invite":
      return "Invited friends";
    case "problem":
      return "Reported a problem";
    case "feedback":
      return "Sent feedback";
    case "meal_rating":
      return detail ? `Rated ${detail}` : "Rated a dish";
    case "bug":
      return "Bug report rewarded";
  }
  return "Street cred";
}

interface LogRow {
  id: number;
  at: number;
  action: string;
  points: number;
  detail: string | null;
  friend: string | null;
}

const LOG_COLS = `c.id, c.at, c.action, c.points, c.detail,
  CASE WHEN c.action = 'friend' THEN (SELECT username FROM users WHERE id = c.ref) END AS friend`;

const entry = (r: LogRow) => ({ id: r.id, at: r.at, action: r.action, points: r.points, label: logLabel(r.action, r.detail, r.friend) });

/** GET /api/cred: totals, level, the next unlock, the opt-in and the 5 latest entries. */
export async function credSummary(db: D1Database, userId: string, now: number) {
  const [user, recent, latest, bugs] = await Promise.all([
    db.prepare("SELECT cred_total, board, likes_received FROM users WHERE id = ?").bind(userId).first<{ cred_total: number; board: number; likes_received: number }>(),
    db.prepare("SELECT COALESCE(SUM(points), 0) AS n FROM cred WHERE user_id = ? AND at > ?").bind(userId, now - RECENT_MS).first<{ n: number }>(),
    db.prepare(`SELECT ${LOG_COLS} FROM cred c WHERE c.user_id = ? ORDER BY c.id DESC LIMIT ?`).bind(userId, LATEST).all<LogRow>(),
    db
      .prepare("SELECT id, at, summary, status, reason FROM bug_reports WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?")
      .bind(userId, LATEST)
      .all<{ id: number; at: number; summary: string; status: string; reason: string | null }>(),
  ]);
  const total = user?.cred_total ?? 0;
  const level = levelOf(total);
  return {
    total,
    recent: recent?.n ?? 0,
    level,
    levelStart: levelStart(level),
    // null at the top level: there is no next one.
    nextLevelAt: level < MAX_LEVEL ? levelStart(level + 1) : null,
    nextUnlock: nextUnlock(level),
    board: !!user?.board,
    // Trusted reporter (section 9): 👍 received on your reports so far, and whether that's 20 or more.
    likes: user?.likes_received ?? 0,
    trusted: (user?.likes_received ?? 0) >= TRUSTED_LIKES,
    latest: latest.results.map(entry),
    // Your bug reports (worker/bugs.ts), newest first: pending, rewarded, or declined with the reason.
    bugs: bugs.results,
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/cred/log: 50 entries a page, newest first, older than `before` (an entry id) when given, of one Zurich day
 * when `day` is given. The first page (no `before`) also lists the days that have entries, newest first.
 */
export async function credLog(db: D1Database, userId: string, opts: { day?: string | null; before?: string | null }) {
  const where = ["c.user_id = ?"];
  const binds: (string | number)[] = [userId];
  if (opts.day) {
    if (!DAY_RE.test(opts.day) || Number.isNaN(Date.parse(`${opts.day}T00:00:00Z`))) throw new AuthError(400, "bad_day");
    const [y, m, d] = opts.day.split("-").map(Number);
    const from = zurichToUtc(y, m, d);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    where.push("c.at >= ?", "c.at < ?");
    binds.push(from, zurichToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()));
  }
  if (opts.before) {
    const before = Number(opts.before);
    if (!Number.isInteger(before) || before < 1) throw new AuthError(400, "bad_before");
    where.push("c.id < ?");
    binds.push(before);
  }
  const rows = (await db
    .prepare(`SELECT ${LOG_COLS} FROM cred c WHERE ${where.join(" AND ")} ORDER BY c.id DESC LIMIT ?`)
    .bind(...binds, LOG_PAGE + 1)
    .all<LogRow>()).results;
  const out: { entries: ReturnType<typeof entry>[]; more: boolean; days?: string[] } = {
    entries: rows.slice(0, LOG_PAGE).map(entry),
    more: rows.length > LOG_PAGE,
  };
  if (!opts.before) {
    const ats = (await db.prepare("SELECT at FROM cred WHERE user_id = ? ORDER BY at DESC").bind(userId).all<{ at: number }>()).results;
    out.days = [...new Set(ats.map((r) => zurichDate(r.at)))];
  }
  return out;
}

/** PUT /api/cred/board: on or off the leaderboards. */
export async function setBoard(db: D1Database, userId: string, on: boolean, now: number) {
  await db.prepare("UPDATE users SET board = ?, board_at = ? WHERE id = ?").bind(on ? 1 : 0, on ? now : null, userId).run();
  return { board: on };
}

interface BoardRow {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  bg: string | null;
  fg: string | null;
  bg2: string | null;
  fg2: string | null;
  metal: string | null;
  points: number;
  rank: number;
}

/**
 * GET /api/cred/board?range=recent|all[&after=<rank>]: everyone who opted in (403 unless you did), 50 a page from rank
 * `after` + 1 (`more` when there are further pages), ties going to whoever got there first, and your own rank. People
 * without points in the range aren't listed (`you.rank` is then null). `person` turns a user row into how the page
 * shows people (social.ts).
 */
export async function leaderboard<P>(
  db: D1Database,
  userId: string,
  range: string | null,
  now: number,
  person: (u: BoardRow) => P,
  afterParam: string | null = null,
) {
  if (range !== "recent" && range !== "all") throw new AuthError(400, "bad_range");
  const after = afterParam === null ? 0 : Number(afterParam);
  if (!Number.isInteger(after) || after < 0) throw new AuthError(400, "bad_after");
  const me = await db.prepare("SELECT board FROM users WHERE id = ?").bind(userId).first<{ board: number }>();
  if (!me?.board) throw new AuthError(403, "not_on_board");
  // One query: the scores of the opted-in, ranked by points, then by who reached them first, then by when they joined.
  const scores =
    range === "recent"
      ? `SELECT c.user_id AS id, SUM(c.points) AS points, MAX(c.at) AS last FROM cred c JOIN users u ON u.id = c.user_id
         WHERE u.board = 1 AND c.at > ?2 GROUP BY c.user_id HAVING SUM(c.points) > 0`
      : `SELECT id, cred_total AS points, COALESCE(cred_at, 0) AS last FROM users WHERE board = 1 AND cred_total > 0`;
  const rows = (await db
    .prepare(
      `WITH s AS (${scores}),
            r AS (SELECT s.id, s.points, ROW_NUMBER() OVER (ORDER BY s.points DESC, s.last, u.board_at, s.id) AS rank
                  FROM s JOIN users u ON u.id = s.id)
       SELECT u.id, u.username, u.first_name, u.last_name, u.bg, u.fg, u.bg2, u.fg2, u.metal, r.points, r.rank
       FROM r JOIN users u ON u.id = r.id WHERE (r.rank > ?4 AND r.rank <= ?4 + ?3 + 1) OR r.id = ?1 ORDER BY r.rank`,
    )
    .bind(userId, now - RECENT_MS, BOARD_SIZE, after)
    .all<BoardRow>()).results;
  const mine = rows.find((r) => r.id === userId);
  const page = rows.filter((r) => r.rank > after && r.rank <= after + BOARD_SIZE);
  return {
    range,
    rows: page.map((r) => ({ rank: r.rank, ...person(r), points: r.points, me: r.id === userId })),
    // The row one past the page came along only to tell whether there's another page.
    more: rows.some((r) => r.rank === after + BOARD_SIZE + 1),
    you: { rank: mine?.rank ?? null, points: mine?.points ?? 0 },
  };
}

// --- Report votes (plan section 9) ------------------------------------------------------------------------------------

/** 👍 received on your reports from this many on: a trusted reporter. */
export const TRUSTED_LIKES = 20;

/** What the Report log adds to an entry: counts and the trusted mark for everyone, `mine` and `vote` signed in. */
export interface ReportMarks {
  up: number;
  down: number;
  trusted: boolean;
  mine?: boolean;
  vote?: 1 | -1 | 0;
}

/**
 * The votes and trusted marks of reports `ids` (one query, the ids as one JSON parameter), by id. With `me`, also
 * whether each is yours and how you voted. Never who sent or voted: nothing tells two reports of one person apart.
 */
export async function reportMarks(db: D1Database, ids: number[], me: string | null): Promise<Map<number, ReportMarks>> {
  const out = new Map<number, ReportMarks>();
  if (!ids.length) return out;
  const { results } = await db
    .prepare(
      `WITH ids(id) AS (SELECT value FROM json_each(?1))
       SELECT ids.id AS id,
         (SELECT COUNT(*) FROM report_votes v WHERE v.report_id = ids.id AND v.up = 1) AS up,
         (SELECT COUNT(*) FROM report_votes v WHERE v.report_id = ids.id AND v.up = 0) AS down,
         (SELECT u.likes_received >= ?3 FROM report_owners o JOIN users u ON u.id = o.user_id WHERE o.report_id = ids.id) AS trusted,
         (SELECT o.user_id = ?2 FROM report_owners o WHERE o.report_id = ids.id) AS mine,
         (SELECT v.up FROM report_votes v WHERE v.report_id = ids.id AND v.user_id = ?2) AS vote
       FROM ids`,
    )
    .bind(JSON.stringify(ids), me ?? "", TRUSTED_LIKES)
    .all<{ id: number; up: number; down: number; trusted: number | null; mine: number | null; vote: number | null }>();
  for (const r of results) {
    const marks: ReportMarks = { up: r.up, down: r.down, trusted: !!r.trusted };
    if (me) {
      marks.mine = !!r.mine;
      marks.vote = r.vote === null ? 0 : r.vote ? 1 : -1;
    }
    out.set(Number(r.id), marks);
  }
  return out;
}

/** A report as the vote needs it, from `fruum` (index.ts): when it was sent and the place's name for the log. */
export interface VotedReport {
  at: number;
  name: string;
}

/**
 * POST /api/reports/vote: 👍 (`up` true), 👎 (false) or no vote (null) on report `id`, which `report` describes (null:
 * no such report in the log). 404 when it's older than the 4-hour log, 403 on your own. The voter earns `report_vote`
 * on their first vote on it; the owner (if they sent it signed in) gains or loses `report_liked` and a 👍 in
 * `likes_received` as the vote turns to or from 👍. Answers the report's new marks and the voter's `cred`.
 */
export async function castVote(db: D1Database, me: string, id: number, up: boolean | null, report: VotedReport | null, logMs: number, now: number) {
  if (!report || report.at <= now - logMs) throw new AuthError(404, "no_such_report");
  const [owner, prev] = await Promise.all([
    db.prepare("SELECT user_id FROM report_owners WHERE report_id = ?").bind(id).first<{ user_id: string }>(),
    db.prepare("SELECT up FROM report_votes WHERE report_id = ? AND user_id = ?").bind(id, me).first<{ up: number }>(),
  ]);
  if (owner?.user_id === me) throw new AuthError(403, "own_report");
  const statements: D1PreparedStatement[] = [
    up === null
      ? db.prepare("DELETE FROM report_votes WHERE report_id = ? AND user_id = ?").bind(id, me)
      : db
          .prepare("INSERT INTO report_votes (report_id, user_id, up, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (report_id, user_id) DO UPDATE SET up = ?3, at = ?4")
          .bind(id, me, up ? 1 : 0, now),
  ];
  const earn = up === null ? [] : await award(db, me, "report_vote", String(id), now);
  statements.push(...earn);
  const wasUp = prev?.up === 1;
  if (owner && wasUp !== (up === true)) {
    const ref = `${id}:${me}`;
    // likes_received moves with the owner's cred_total update just before it (changes()), so it follows report_liked.
    if (up === true) {
      const give = await award(db, owner.user_id, "report_liked", ref, now, report.name);
      if (give.length) statements.push(...give, db.prepare("UPDATE users SET likes_received = likes_received + 1 WHERE id = ? AND changes() > 0").bind(owner.user_id));
    } else {
      const take = await takeBack(db, owner.user_id, "report_liked", ref);
      if (take.length) statements.push(...take, db.prepare("UPDATE users SET likes_received = MAX(0, likes_received - 1) WHERE id = ? AND changes() > 0").bind(owner.user_id));
    }
  }
  // Usage counters (stats.ts): a new vote only; changing or removing one isn't counted.
  await batchWithBump(db, statements, bumpFor(db, now, { report_vote: !prev && up !== null ? 1 : 0 }));
  const marks = (await reportMarks(db, [id], me)).get(id)!;
  return { report: { id, ...marks }, cred: await credState(db, me, earned("report_vote", earn)) };
}

/**
 * A report removed by its sender (DELETE /api/report): its link to the account and its votes go, and the account it
 * was sent from loses what it earned through it, the +3 and every 👍's +1 (likes_received follows). Voters keep their
 * +1 for voting. Nothing when it was sent signed out.
 */
export async function removedReportStatements(db: D1Database, id: number): Promise<D1PreparedStatement[]> {
  const owner = await db.prepare("SELECT user_id FROM report_owners WHERE report_id = ?").bind(id).first<{ user_id: string }>();
  const out = [
    db.prepare("DELETE FROM report_owners WHERE report_id = ?").bind(id),
    db.prepare("DELETE FROM report_votes WHERE report_id = ?").bind(id),
  ];
  if (!owner) return out;
  const likes = await db
    .prepare("SELECT ref FROM cred WHERE user_id = ? AND action = 'report_liked' AND ref LIKE ?")
    .bind(owner.user_id, `${id}:%`)
    .all<{ ref: string }>();
  for (const { ref } of likes.results) {
    const take = await takeBack(db, owner.user_id, "report_liked", ref);
    if (take.length) out.push(...take, db.prepare("UPDATE users SET likes_received = MAX(0, likes_received - 1) WHERE id = ? AND changes() > 0").bind(owner.user_id));
  }
  out.push(...(await takeBack(db, owner.user_id, "report", String(id))));
  return out;
}

// --- Account deletion and the daily clean-up --------------------------------------------------------------------------

/**
 * The account's Street cred rows (DELETE /api/me): its log, report links, votes and meal ratings. Others keep the
 * points they earned through it, but their rows no longer name it: a friend's `ref` (the id) becomes
 * formerFriendRef(id), and a 👍's "<report id>:<voter id>" becomes "former:<row id>" (the log then says "a former user").
 */
export const deleteCredStatements = async (db: D1Database, id: string): Promise<D1PreparedStatement[]> => [
  db.prepare("UPDATE cred SET ref = ? WHERE action = 'friend' AND ref = ?").bind(await formerFriendRef(id), id),
  db.prepare("UPDATE cred SET ref = 'former:' || id WHERE action = 'report_liked' AND substr(ref, instr(ref, ':') + 1) = ?").bind(id),
  db.prepare("DELETE FROM cred WHERE user_id = ?").bind(id),
  db.prepare("DELETE FROM report_owners WHERE user_id = ?").bind(id),
  db.prepare("DELETE FROM report_votes WHERE user_id = ?").bind(id),
  db.prepare("DELETE FROM meal_ratings WHERE user_id = ?").bind(id),
  db.prepare("DELETE FROM bug_reports WHERE user_id = ?").bind(id),
];

/**
 * A deleted friend's `ref`: a hash of their id, which names no one (no user row has it) but lets award() see that the
 * pair was already paid for when the same person signs up again.
 */
export const formerFriendRef = async (id: string) => `former:${await sha256Hex(`friend:${id}`)}`;

export const REPORT_LINK_KEPT_MS = 2 * DAY_MS;
export const MEAL_RATING_KEPT_DAYS = 60; // as long as the menus (config.ts MENU_HISTORY_DAYS)
/** A decided bug report stays in the sender's list this long; one never decided goes with the log's 12 months. */
export const BUG_DECIDED_KEPT_MS = 90 * DAY_MS;

/**
 * The daily clean-up's part (social.ts cleanAccounts): old log rows except friends', report links and votes, ratings,
 * and bug reports 90 days after they were decided.
 */
export function cleanCredStatements(db: D1Database, now: number): D1PreparedStatement[] {
  const oldest = zurichDate(now - MEAL_RATING_KEPT_DAYS * DAY_MS);
  return [
    db.prepare("DELETE FROM cred WHERE at < ? AND action != 'friend'").bind(now - CRED_KEPT_MS),
    db.prepare("DELETE FROM report_owners WHERE at < ?").bind(now - REPORT_LINK_KEPT_MS),
    db.prepare("DELETE FROM report_votes WHERE at < ?").bind(now - REPORT_LINK_KEPT_MS),
    db.prepare("DELETE FROM meal_ratings WHERE date < ?").bind(oldest),
    db.prepare("DELETE FROM bug_reports WHERE (status != 'pending' AND decided_at < ?1) OR at < ?2").bind(now - BUG_DECIDED_KEPT_MS, now - CRED_KEPT_MS),
  ];
}
