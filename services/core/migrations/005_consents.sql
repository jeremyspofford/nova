-- A consent is a single-use, args-bound, requestor-bound permission the
-- operator grants for ONE gated action. It is raised only by the funnel
-- (services/core/app/policy.py via consents.raise_consent), decided only by an
-- authenticated operator (consents.decide, wired to an API in T2), and burned
-- at most once by the funnel (consents.validate_and_use). No LLM ever judges
-- it — the burn is one SQL UPDATE whose WHERE clause is the whole check.
--
-- args_hash binds the consent to the EXACT arguments approved (ruling S3-R3):
-- v3's D-029 id-only / agent-optional fallbacks are NOT carried, so an
-- approval for one URL can never be spent on another.
--
-- expires_at is the TTL, written at creation and checked in the burn's WHERE
-- clause. conversation_id is kept so the card can be rendered inline where it
-- was raised (a NULL conversation_id hides a pending card — a known S2 defect).

CREATE TABLE consents (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    action_class     text NOT NULL,
    args_hash        text NOT NULL,
    requestor_person uuid NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    requestor_agent  text NOT NULL,
    conversation_id  uuid REFERENCES conversations (id) ON DELETE SET NULL,
    -- The exact arguments approved, kept alongside their hash so the card is
    -- reconstructable from the row (the Approvals page re-queries) and the
    -- binding is auditable. args_hash is what the burn matches on; args is what
    -- the operator sees.
    args             jsonb NOT NULL DEFAULT '{}',
    summary          text NOT NULL,
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'denied')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    expires_at       timestamptz NOT NULL,
    decided_at       timestamptz,
    decided_by       uuid REFERENCES people (id) ON DELETE SET NULL,
    used_at          timestamptz
);

-- The burn's WHERE clause filters on (status, used_at, expires_at, args_hash,
-- requestor); this index serves that lookup and the Approvals page's
-- "pending in this conversation" query.
CREATE INDEX consents_lookup
    ON consents (action_class, args_hash, requestor_person, requestor_agent, status);
CREATE INDEX consents_pending
    ON consents (conversation_id, created_at DESC) WHERE status = 'pending';
