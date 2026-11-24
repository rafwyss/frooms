-- Every occupancy reading from ETH's study-space feed, as fetched by the scheduled prefetch (worker/prefetch.ts).
-- Kept indefinitely: it's the history for our own "usually this full" estimates and for checking ETH's data quality.
-- A reading is stored on every fetch, even if ETH's timestamp hasn't moved (a frozen sensor).
CREATE TABLE occupancy (
  space TEXT NOT NULL,   -- ETH's roomGlobalIdentifier, e.g. 'HGH30.1'
  at INTEGER NOT NULL,   -- when frooms fetched it (epoch ms)
  measured_at INTEGER,   -- ETH's timestamp of the reading (epoch ms)
  people INTEGER,        -- ETH's head-count estimate
  capacity INTEGER,      -- maxPeople
  pct INTEGER,           -- occupancyPercentage as ETH sent it (20 % steps)
  status TEXT,           -- green / yellow / red / unknown
  trend TEXT,            -- steady / filling / emptying
  active INTEGER,        -- activeFlag (1/0)
  PRIMARY KEY (space, at)
) WITHOUT ROWID;
