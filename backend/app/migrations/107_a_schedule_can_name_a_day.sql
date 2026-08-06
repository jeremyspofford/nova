-- Migration 107: a schedule can name a day, not just a number of minutes.
--
-- Jeremy, 2026-08-06:
--
--     "scheduling things shouldn't just be a number of minutes, we should be
--      able to set a date, or every monday, things like that, just like I
--      might on apple's reminders app, or google reminders or calendars."
--
-- He hit it the same evening. He asked Nova "can you remember to tell me
-- tomorrow to see what their current rate is?", and the only thing this table
-- could express was `interval_minutes` — so "tomorrow" became `next_run_at =
-- now + 1440 minutes`: a reminder that fires every day forever, at whatever
-- o'clock he happened to ask. Nova called it a "one-shot morning reminder" in
-- its own description and then told him it would fire at 5:24 PM, because
-- there was no field in which either sentence could be true.
--
-- NULLABLE, AND `interval_minutes` STAYS. Every existing row keeps behaving
-- exactly as it does today with no data migration and no backfill: a NULL
-- schedule means "use interval_minutes", which is what `app/schedules.py`
-- does. The old shape is also expressible in the new one
-- ({"every":"minutes","n":360}), so nothing is trapped in the old world
-- either.
--
-- WHY A COLUMN AND NOT A CRON STRING. Cron cannot say "once, on the 14th",
-- has no timezone, and is written by nobody who is not already a programmer —
-- and both of the writers here are meant to be a person clicking a UI and a
-- model filling in a tool argument. A small closed set of shapes can be
-- validated field by field and refused with a sentence that says what to
-- write instead; a cron expression can only be refused as a whole.
--
-- The scheduler is untouched: it reads `next_run_at <= now()` and always did.
-- Recurrence is a function that decides what to write there next.

ALTER TABLE automations
    ADD COLUMN IF NOT EXISTS schedule jsonb;

COMMENT ON COLUMN automations.schedule IS
    'Calendar recurrence: {"every":"week","on":["mon"],"at":"09:00"} and the '
    'other shapes in app/schedules.py. NULL means fall back to '
    'interval_minutes. Times are wall-clock in nova.timezone, so a job asked '
    'for 09:00 stays at 09:00 across a DST boundary.';
