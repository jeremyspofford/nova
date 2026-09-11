-- Governance event ledger (docs/DECISIONS.md D-020, D-030; Slice 2).
--
-- DDL ONLY — deliberately no data rows. The no-backfill watermark is this
-- file's own applied_at in schema_migrations; completeness claims for the
-- onboarded event types (consent.decided, consent.burned, capability.changed)
-- begin there and nowhere earlier.
--
-- Classification: governance-internal, LOCAL-ONLY — rows from this table are
-- never cloud-eligible (D-013/D-014).
--
-- Append-only is an APPLICATION-LEVEL contract in this slice, pinned by
-- tests/test_governance_ledger.py (no UPDATE/DELETE against this table
-- anywhere in app/, only app/governance.py inserts). The database itself
-- does not yet prevent mutation; DB-level hardening is a later, separate
-- decision, not implied here.
--
-- The ledger is not an authorization authority: nothing at runtime reads it
-- to decide anything, and app/governance.py exposes no query API for
-- decision paths.

CREATE TABLE IF NOT EXISTS governance_events (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    event_type      text        NOT NULL,
    schema_version  smallint    NOT NULL DEFAULT 1,
    -- Attribution is recorded, never invented: NULL means unknown.
    actor_kind      text CHECK (actor_kind IN ('operator', 'agent', 'system')),
    actor_id        text,
    -- Always 'unknown' in this slice — no authoritative assurance source
    -- exists until the principal/credential model (D-010) lands.
    actor_assurance text,
    subject_kind    text        NOT NULL,
    subject_id      text        NOT NULL,
    trace_id        uuid,
    conversation_id uuid,
    run_id          text,
    -- Typed, allowlisted, identifier-only payloads (app/governance.py
    -- constructors). The cap is a backstop: an oversized payload REJECTS
    -- the write rather than storing a partial audit record.
    payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
    CHECK (octet_length(payload::text) <= 8192)
);

CREATE INDEX IF NOT EXISTS idx_governance_events_type_time
    ON governance_events (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_governance_events_subject
    ON governance_events (subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_governance_events_time
    ON governance_events (occurred_at);
