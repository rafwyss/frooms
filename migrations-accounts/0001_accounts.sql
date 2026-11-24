-- Accounts (plans/PLAN_ACCOUNTS.md, section 6.1), in the D1 databases fruum-accounts (ACCOUNTS, frooms.ch) and
-- fruum-accounts-dev (ACCOUNTS_DEV, the fixed preview host). Applied by hand, never by CI (CLAUDE.md).

CREATE TABLE users (
  id TEXT PRIMARY KEY,            -- edu-ID's pairwise identifier (the ID token's `sub`)
  username TEXT UNIQUE,           -- lower case; NULL until the first sign-in's profile step is done
  first_name TEXT NOT NULL,       -- from edu-ID, refreshed at every sign-in
  last_name TEXT NOT NULL,
  name_key TEXT NOT NULL,         -- "raffaele wyss": lower case, accents folded, for search
  bg TEXT,                        -- bubble background, "#1f3a5f"; NULL until the profile step
  fg TEXT,                        -- bubble text
  email_hash TEXT,                -- SHA-256 of the lower-case address; NULL when none
  uni TEXT NOT NULL,              -- eth / uzh, from the affiliation
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL   -- last sign-in or session renewal (decision 15)
);
CREATE INDEX users_name ON users (name_key);
CREATE INDEX users_email ON users (email_hash);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,    -- SHA-256 of the cookie's token; the token itself is never stored
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL     -- renewed_at + 30 days (decision 16)
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE friend_requests (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX friend_requests_to ON friend_requests (to_id);

-- Two rows per friendship, so "my friends" is one lookup.
CREATE TABLE friends (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE blocks (
  user_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

-- One row per person: their stars as the page keeps them (lib.js `cleanStars`: at most 40, newest first).
CREATE TABLE stars (user_id TEXT PRIMARY KEY, list TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,                   -- NULL once the person is removed (section 7.3)
  kind TEXT NOT NULL,             -- room / space (decision 11: never a building alone)
  place TEXT NOT NULL,            -- "HG E 33.1" or "MMB79"
  area TEXT NOT NULL,
  building TEXT NOT NULL,
  name TEXT NOT NULL,             -- as shown when checking in
  started_at INTEGER NOT NULL,
  until INTEGER NOT NULL,         -- always set (decision 5)
  ended_at INTEGER,               -- set by check-out or by a new check-in
  source TEXT NOT NULL,           -- how it was started: nearby / search / place
  ended_by TEXT                   -- user / moved (a new check-in) / NULL: it ran out at `until`
);
CREATE UNIQUE INDEX checkins_open ON checkins (user_id) WHERE ended_at IS NULL;
CREATE INDEX checkins_user ON checkins (user_id, started_at);
