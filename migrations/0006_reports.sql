-- Occupancy reports from the page (POST /api/report, worker/reports.ts). Kept indefinitely as usage data.
-- No IP address: `reporter` is the SHA-256 of a random id the browser keeps in localStorage.
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,          -- epoch ms
  kind TEXT NOT NULL,           -- 'level' (free/crowded/full), 'pct' (0..100), 'rating' (-5..5, of frooms' estimate)
  place_kind TEXT NOT NULL,     -- 'room' or 'space'
  place TEXT NOT NULL,          -- room path ('HG E 33.1') or space id ('HGH30.1')
  area TEXT NOT NULL,
  value INTEGER NOT NULL,       -- level: 0 free, 1 crowded, 2 full; pct: 0..100; rating: -5..5
  reporter TEXT NOT NULL,       -- SHA-256 hex of the client id
  estimate INTEGER              -- frooms' own estimate (pct) at the time, if it had one (for 'pct' and 'rating')
);
CREATE INDEX reports_place_at ON reports (place_kind, place, at);
CREATE INDEX reports_at ON reports (at);

-- "Usually this full": per sensor space and weekday, from the occupancy history. Rewritten once a day by the prefetch
-- (worker/usual.ts), in one SQL statement. One row per space and weekday (not per quarter hour), so the daily rewrite
-- costs about 1,400 row writes instead of 130,000 (D1 Free allows 100,000 a day).
-- `slots`: JSON object by quarter hour of the day ("0".."95", only those with readings), each
-- [pct_2m, n_2m, pct_7d, n_7d]: the average over the past 2 months (61 days) and over the past 7 days, and how many
-- readings each has.
CREATE TABLE usual (
  space TEXT NOT NULL,
  weekday INTEGER NOT NULL,     -- 0 Monday .. 6 Sunday
  slots TEXT NOT NULL,
  PRIMARY KEY (space, weekday)
) WITHOUT ROWID;
