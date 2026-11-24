-- Feedback sent from the form in the page's footer (POST /api/feedback, worker/feedback.ts). Read it with
-- npx wrangler d1 execute fruum --remote --command "SELECT * FROM feedback ORDER BY at DESC LIMIT 20"
-- No IP address or other identifier is stored; the email only when the sender gives one.
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,      -- when it arrived (epoch ms)
  category TEXT NOT NULL,   -- broken / wrong-info / idea / other
  message TEXT NOT NULL,
  email TEXT,               -- optional, for a reply
  context TEXT              -- JSON: the tab, area, buildings, time and screen size the sender had open
);
CREATE INDEX feedback_at ON feedback (at);
