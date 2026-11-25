-- Fewer D1 rows read (the Free plan allows 5M a day; in November 2026 frooms used about 4.6M).

-- The cards' opening hours (worker/store.ts readMenuTimes) ask for a week of every facility's menus by date alone,
-- which the primary key (facility, date) can't narrow: without this index every request read the whole table.
CREATE INDEX menu_days_date ON menu_days (date);

-- The prefetch's state of every room as one JSON value per source ('eth', 'uzh'), so each prefetch run reads two rows
-- instead of the whole `fetches` table (worker/store.ts readFetches). The old table is read only while a source has no
-- row here yet (the first run after this release); it can be dropped in a later migration.
CREATE TABLE fetch_state (
  source TEXT PRIMARY KEY,  -- 'eth' or 'uzh'
  value TEXT NOT NULL       -- JSON { path: [full_from, at] }
) WITHOUT ROWID;
