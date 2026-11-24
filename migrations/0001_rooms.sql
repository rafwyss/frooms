-- Prefetched room data, written only by the scheduled prefetch (worker/prefetch.ts); requests only read.

-- Allocations of one room on one day: the bookings that start on `day` (Zurich time).
-- A row with an empty array means the room was fetched and has no bookings that day.
CREATE TABLE allocations (
  path TEXT NOT NULL,   -- room path, e.g. 'ML E 12'
  day TEXT NOT NULL,    -- YYYY-MM-DD
  at INTEGER NOT NULL,  -- when it was fetched from ETH (epoch ms)
  raw TEXT NOT NULL,    -- JSON array of PackedAllocation (worker/store.ts)
  PRIMARY KEY (path, day)
) WITHOUT ROWID;

-- One row per prefetched room: the first day of its last week fetch and when it was last fetched at all.
CREATE TABLE fetches (
  path TEXT PRIMARY KEY,
  week_from TEXT NOT NULL,
  at INTEGER NOT NULL
) WITHOUT ROWID;

-- Prefetch state: 'updated', 'backoff_until' (epoch ms) and 'minmax' (JSON).
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Experiment (worker/experiment.ts): how often bookings change during the day.
-- Re-fetches per day, room type and source ('check': rooms not otherwise refreshed; 'refresh': the regular refresh).
CREATE TABLE exp_checks (
  day TEXT NOT NULL,
  typecode TEXT NOT NULL,
  source TEXT NOT NULL,
  checks INTEGER NOT NULL,
  changed INTEGER NOT NULL,  -- checks that found at least one change
  hours REAL NOT NULL,       -- summed time since each room's previous fetch
  PRIMARY KEY (day, typecode, source)
) WITHOUT ROWID;

-- Each booking that appeared ('added': the room became busy) or disappeared ('removed': it became free).
CREATE TABLE exp_changes (
  id INTEGER PRIMARY KEY,
  detected_at INTEGER NOT NULL,
  prev_at INTEGER NOT NULL,  -- when the data it differs from was fetched
  path TEXT NOT NULL,
  typecode TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  title TEXT,
  upcoming INTEGER NOT NULL  -- 1 if the booking hadn't ended yet when the change was detected
);
