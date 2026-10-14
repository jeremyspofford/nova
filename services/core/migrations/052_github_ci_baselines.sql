-- fix/ci-event-gaps T1: the first poll of a newly listed repo only records a
-- baseline. A run that went red before the owner listed the repo is not news
-- (event turn 314390b4, run 38448065811 filed on a first poll), so the
-- github_ci poller (app/events_ci.py) files nothing the first time it reads a
-- repo; it inserts this row instead, and afterwards only a run completed after
-- `baselined_at` can file.
--
-- A table, not memory, so a restart never baselines again (and never files a
-- pre-listing run on its "first" poll); not a jsonb list on event_senders,
-- which is a list someone maintains; not a row in `events`: a baseline is not
-- an event. Two first polls at once: ON CONFLICT DO NOTHING on the key means
-- exactly one records it.
--
-- Number: main ends at 051_events.
--
-- Re-runnable: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS github_ci_baselines (
    repo         text PRIMARY KEY,
    baselined_at timestamptz NOT NULL DEFAULT now()
);
