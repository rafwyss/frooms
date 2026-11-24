-- Menus from ETH's gastronomy system (Cookpit), written only by the menu prefetch (worker/prefetch.ts, runMenuPrefetch).

-- One place (Cookpit facility) on one day: its opening hours, meal times and dishes (MenuDay in worker/menus.ts).
-- A row is only rewritten when its JSON changed. Rows older than MENU_HISTORY_DAYS are deleted once a day.
CREATE TABLE menu_days (
  facility INTEGER NOT NULL,
  date TEXT NOT NULL,      -- YYYY-MM-DD
  at INTEGER NOT NULL,     -- when this version was fetched (epoch ms)
  data TEXT NOT NULL,      -- JSON MenuDay
  PRIMARY KEY (facility, date)
) WITHOUT ROWID;

-- Per facility: the last fetch, whether it worked, and whether the place publishes menu lines at all (mensa or café).
CREATE TABLE menu_fetches (
  facility INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0
);
