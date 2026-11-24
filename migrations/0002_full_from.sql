-- The first fetch of the day now covers a month, not a week.
ALTER TABLE fetches RENAME COLUMN week_from TO full_from;
