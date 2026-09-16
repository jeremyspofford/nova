-- S25.1.3 — "he read it" is a timestamp, not a state.
--
-- `seen` as a STATE quietly meant a second thing: it is not in
-- DELIVERABLE_STATES, so marking a card seen dropped it out of the digest's
-- owed set — permanently, and while the urgent push path went on pushing the
-- same row, because that path reads different columns. One click, two
-- meanings, and the button said only one of them.
--
-- The application stopped writing the state in the same change as this
-- migration. That is not enough on its own: every row a live box has ALREADY
-- marked seen is sitting in a state the code no longer produces, and would
-- stay invisible to every future digest for as long as it exists. So the
-- rows are rewritten here, by the same evidence `notices._STATE_FROM_EVIDENCE`
-- uses to derive a state after an unmute:
--
--   delivered_at  -> 'delivered'  (a channel reported it landed)
--   failed_reason -> 'failed'     (a channel was tried and nobody was told)
--   otherwise     -> 'raised'     (nobody has told him yet — and now the
--                                  digest will, which is the whole point)
--
-- `seen_at` is untouched. It was always the read receipt, it stays the read
-- receipt, and the badge still counts from it.
UPDATE notices
SET state = CASE
        WHEN delivered_at IS NOT NULL THEN 'delivered'
        WHEN failed_reason IS NOT NULL THEN 'failed'
        ELSE 'raised'
    END
WHERE state = 'seen';

-- And then the line of code that refuses. Leaving 'seen' in the CHECK would
-- leave the schema permitting a state the application says does not exist —
-- a control you have to remember rather than one that holds.
ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_state_check;
ALTER TABLE notices
    ADD CONSTRAINT notices_state_check
    CHECK (state IN ('raised', 'delivered', 'failed', 'muted'));

-- The companion CHECK goes with it: it said a `seen` state must carry a
-- `seen_at`, and there is no `seen` state to carry one.
ALTER TABLE notices DROP CONSTRAINT IF EXISTS notices_seen_says_when;
