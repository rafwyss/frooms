-- Usage counts per Zurich day (plans/PLAN_ADMIN_STATS.md). No identifiers: the day, and per metric a number.
-- One row per day, so each beacon or counted action costs one row write. Kept indefinitely (about 365 rows a year).
-- Applied by hand, never by CI (CLAUDE.md): to fruum-accounts-dev for the feature branches, to fruum-accounts only at
-- the release.
CREATE TABLE stats_days (
  day TEXT PRIMARY KEY,          -- "2026-11-18", Zurich time
  counts TEXT NOT NULL           -- JSON object {"search": 12, "tab_eat": 4, ...}
) WITHOUT ROWID;
