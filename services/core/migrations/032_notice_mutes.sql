-- S25.1: a mute belongs to the CONDITION, not to one reading of it.
--
-- The mute used to be the notice row itself: "a muted row still occupies its
-- fingerprint, which IS the mute". The fingerprint is sha256 over
-- {key, facts}, so any check whose facts carry a moving number defeats it —
-- mute `work_failing_timers` at two consecutive failures and the third
-- failure has different facts, a different fingerprint, and arrives as a
-- fresh UNMUTED card. The condition never changed; the count did. Worse, the
-- muted row is never cleared or pruned, so it holds a fingerprint that will
-- never recur for as long as the table lives.
--
-- `finding_key` is the half that says WHICH condition (`timer:<id>`);
-- `facts` are what it currently reads. Silence keys on the first.
CREATE TABLE notice_mutes (
    check_name  text NOT NULL,
    finding_key text NOT NULL,
    muted_at    timestamptz NOT NULL DEFAULT now(),
    -- WHO asked for the silence. Null is Nova's own (S25 Q2: she can mute).
    -- "Nova muted this" and "you muted this" are different facts, and a
    -- silence he did not ask for must not be indistinguishable from one he
    -- did.
    muted_by    uuid REFERENCES people (id) ON DELETE SET NULL,
    PRIMARY KEY (check_name, finding_key)
);

-- Every raise asks "is this condition silenced?", so the lookup is the
-- primary key and needs nothing further.
