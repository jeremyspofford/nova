-- Everything a paired machine is allowed to be, as rows read live.
--
-- A device is not a user and not an agent: it is a key core has bound to a
-- name, plus the set of capabilities an operator has granted that name. The
-- LLM never talks to a device — it calls ordinary tools, those tools ride the
-- one authorizer (D-012), and only then does core sign an envelope. What this
-- schema is responsible for is the layer under all of that: which key, which
-- name, which grants, and whether the record is still live.
--
-- Four tables, one migration, because they are one fact: the trust root for
-- slice 5.

-- Core's own signing key. Every device pins this at pairing, so it is
-- generated ONCE per install and never rotated in place — a second row would
-- mean two answers to "which key is core's", and the CHECK makes that
-- unrepresentable rather than merely unwritten. The database is already the
-- trust root here (it holds password hashes and live sessions), so the key
-- lives beside them rather than inventing a second secret store.
CREATE TABLE core_signing_key (
    id              smallint PRIMARY KEY CHECK (id = 1),
    private_key_hex text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- A pairing code is the one moment an unauthenticated caller may write to this
-- database, so it is short-lived, single-use, and stored only as a hash — the
-- operator sees the code once, on the screen that minted it. used_at is burned
-- by the same one-statement idiom as consents.validate_and_use: the WHERE
-- clause is the whole check, so "expired" and "already used" are decided by
-- postgres, not by a branch that could be reordered.
CREATE TABLE pairing_codes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash  text NOT NULL UNIQUE,
    created_by uuid REFERENCES people (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
);

CREATE TABLE devices (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name         text NOT NULL,
    platform     text NOT NULL,
    hostname     text NOT NULL,
    -- The device's ed25519 public key: 32 raw bytes as lowercase hex. The
    -- CHECK is the last line, not the first — app/devices.py validates and
    -- lowercases before it ever gets here — but a key of the wrong shape can
    -- never reach a verification call and silently fail every command.
    pubkey       text NOT NULL CHECK (pubkey ~ '^[0-9a-f]{64}$'),
    -- Who authorised the pairing: the person whose pairing code was burned.
    -- The enrolling caller has no identity of its own, so this is the only
    -- authorisation in the arc.
    owner_person uuid REFERENCES people (id) ON DELETE SET NULL,
    -- The roadmap's default grant, expressed as a column default so a caller
    -- that forgets to pass capabilities cannot accidentally widen it. Read
    -- live on every command (T2) — never cached into a session.
    capabilities jsonb NOT NULL DEFAULT '["system.info"]',
    fs_roots     jsonb NOT NULL DEFAULT '[]',
    enrolled_at  timestamptz NOT NULL DEFAULT now(),
    -- NULL until the device's first heartbeat. Tile state is DERIVED from this
    -- (T4), never from a stored "online" flag that outlives the socket, and a
    -- device that has never been seen renders "never" rather than a green dot.
    last_seen    timestamptz,
    revoked_at   timestamptz
);

-- The name is how a person and the model address a machine ("read that file on
-- laptop"), so two live answers is an ambiguity no prose resolves. Partial on
-- revoked_at IS NULL: revoking frees the name, because reinstalling a laptop
-- should not force it to be called laptop-2 forever. The revoked row itself
-- stays — the audit trail must not vanish with the grant.
CREATE UNIQUE INDEX devices_live_name ON devices (name) WHERE revoked_at IS NULL;

-- The device's own hash-chained log, replayed upstream on connect (T2/T3).
-- prev_hash is NULL only for the first entry a device ever writes; a gap or a
-- mismatch is a loud device.audit_break governance event naming the seq, never
-- a silent reindex. UNIQUE(device_id, seq) makes a replayed batch idempotent:
-- re-sending entries core already has conflicts instead of duplicating them.
CREATE TABLE device_audit (
    device_id   uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    seq         bigint NOT NULL,
    prev_hash   text,
    hash        text NOT NULL,
    ts          timestamptz NOT NULL,
    -- Device-supplied and therefore text, not uuid: a refusal entry may carry
    -- a malformed or absent envelope_id, and the row that records "this
    -- machine refused something odd" must be storable, not rejected by a cast.
    envelope_id text,
    capability  text,
    summary     text,
    ok          boolean NOT NULL,
    exit_code   integer,
    PRIMARY KEY (device_id, seq)
);

CREATE INDEX device_audit_recent ON device_audit (device_id, ts DESC);
