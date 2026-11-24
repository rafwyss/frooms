-- Bug reports that earn Street cred once an admin has checked them (worker/bugs.ts). The report itself is a row of
-- fruum's `feedback` (category "broken", the clicked element in its context), which names no one; this table links it to
-- the account that sent it, until the reward is decided and a while after, so the sender can see the outcome.
-- Applied by hand, never by CI (CLAUDE.md): to fruum-accounts-dev for the feature branches, to fruum-accounts only at
-- the release.
CREATE TABLE bug_reports (
  id INTEGER PRIMARY KEY,        -- fruum's feedback.id
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,           -- when it was sent (epoch ms)
  summary TEXT NOT NULL,         -- the start of the message, for the sender's list (at most 120 characters)
  status TEXT NOT NULL DEFAULT 'pending', -- pending / rewarded / declined
  reason TEXT,                   -- why it was declined, shown to the sender (at most 120 characters)
  decided_at INTEGER             -- when it was rewarded or declined (epoch ms)
);
CREATE INDEX bug_reports_user ON bug_reports (user_id, at);
CREATE INDEX bug_reports_status ON bug_reports (status, at);
