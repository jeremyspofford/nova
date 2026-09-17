-- The append-only governance ledger: every authorization decision that is not
-- a plain auto-allow leaves a row here — a consent raised, decided or burned,
-- and every policy denial (promotions/demotions are T3). It is written IN THE
-- SAME TRANSACTION as the state mutation it records (consents.validate_and_use
-- writes consent.burned in the burn's own transaction; a failed event write
-- rolls the burn back), mirroring traces.close_turn's atomic close.
--
-- It is read by NO decision path — it is the audit, not an authority. There is
-- deliberately no foreign key from subject_ref to consents: the ledger must
-- outlive the row it describes, so a deleted consent never erases its history.

CREATE TABLE governance_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         text NOT NULL,
    action_class text,
    actor        text,
    subject_ref  uuid,
    meta         jsonb NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX governance_events_created_at ON governance_events (created_at DESC, id DESC);
CREATE INDEX governance_events_subject ON governance_events (subject_ref) WHERE subject_ref IS NOT NULL;
