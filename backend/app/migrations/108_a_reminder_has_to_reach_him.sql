-- Migration 108: an automation whose job is to tell him something has to
-- actually tell him.
--
-- His ByteByteGo reminder, 2026-08-06. The instruction Nova wrote reads
-- "Remind Jeremy to check ByteByteGo's current pricing…" — and says nothing
-- about HOW. When it fires, the agent produces text, `record_run` files that
-- text as the run summary, and the summary goes to the journal. He never sees
-- it. The reminder he asked for would have reminded nobody.
--
-- It is the shape this repo keeps finding: the capability exists
-- (`notify_operator` is granted to main), the run is green, and the outcome
-- reaches nobody. Whether the push happens rests on the model choosing to make
-- one call — which is a prompt doing a control's job, and today of all days
-- there is a great deal of evidence about what that is worth.
--
-- SO THE BACKEND SENDS IT. `notify` on the row means "this run's output is for
-- the operator": the scheduler delivers the summary through the notify
-- registry after the run, whatever the agent did or did not call. A reminder
-- is then a reminder because of a column, not because of a sentence.
--
-- DEFAULT FALSE, so nothing that exists starts pushing. The digests and polls
-- already in this table are background work whose output belongs in memory;
-- turning them all into notifications would teach him to ignore the channel,
-- which is the failure mode that makes the next real alert invisible.

ALTER TABLE automations
    ADD COLUMN IF NOT EXISTS notify boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN automations.notify IS
    'The run summary is delivered to the operator through notify.send when '
    'this is true. For automations whose whole purpose is to tell him '
    'something — reminders, alerts — so delivery does not depend on the agent '
    'remembering to call notify_operator.';
