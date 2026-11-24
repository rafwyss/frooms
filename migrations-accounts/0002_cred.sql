-- Street cred, report links and votes, meal ratings (plans/PLAN_STREET_CRED.md, section 6). Applied by hand, never by
-- CI (CLAUDE.md): to fruum-accounts-dev for the feature branches, to fruum-accounts only at the release.

-- The points log: one row per award. `ref` makes an award happen once (the friend's id, the check-in's id, the report's
-- id, "<report id>:<voter id>", the dish key, or "<day>:<n>" for invites and feedback). `detail` is the place's or
-- dish's name the log's label needs, kept here because report links go after 2 days while the log keeps 12 months.
CREATE TABLE cred (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,           -- friend / checkin / report / report_liked / report_vote / invite / problem / feedback / meal_rating
  points INTEGER NOT NULL,
  ref TEXT NOT NULL,
  detail TEXT,
  UNIQUE (user_id, action, ref)
);
CREATE INDEX cred_user ON cred (user_id, at);
CREATE INDEX cred_at ON cred (at);

ALTER TABLE users ADD COLUMN cred_total INTEGER NOT NULL DEFAULT 0;     -- all-time, kept when old log rows go
ALTER TABLE users ADD COLUMN cred_at INTEGER;                           -- when cred_total last grew (leaderboard ties)
ALTER TABLE users ADD COLUMN board INTEGER NOT NULL DEFAULT 0;          -- 1: on the leaderboards
ALTER TABLE users ADD COLUMN board_at INTEGER;                          -- when they joined them
ALTER TABLE users ADD COLUMN likes_received INTEGER NOT NULL DEFAULT 0; -- 👍 on their reports (trusted reporter at 20)
ALTER TABLE users ADD COLUMN bg2 TEXT;                                  -- second gradient colours (level 2 and 3)
ALTER TABLE users ADD COLUMN fg2 TEXT;
ALTER TABLE users ADD COLUMN metal TEXT;                                -- bronze / silver / gold (level 4 to 6) or NULL

-- Which account sent a report in `fruum` (fruum itself never gets a user id). Kept 2 days.
CREATE TABLE report_owners (
  report_id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX report_owners_user ON report_owners (user_id);

-- 👍 (up = 1) or 👎 (up = 0) on a report. Kept 2 days.
CREATE TABLE report_votes (
  report_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  up INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (report_id, user_id)
);
CREATE INDEX report_votes_user ON report_votes (user_id);

-- One person's rating of one day's dish (dish = facility|date|meal|line|name). Each category NULL or -5 to 5 in steps
-- of 0.5, at least one set. Kept 60 days, as long as the menus themselves.
CREATE TABLE meal_ratings (
  dish TEXT NOT NULL,
  date TEXT NOT NULL,
  place TEXT NOT NULL,
  user_id TEXT NOT NULL,
  taste REAL,
  portion REAL,
  value REAL,
  at INTEGER NOT NULL,
  PRIMARY KEY (dish, user_id)
);
CREATE INDEX meal_ratings_place ON meal_ratings (place, date);
CREATE INDEX meal_ratings_user ON meal_ratings (user_id);
