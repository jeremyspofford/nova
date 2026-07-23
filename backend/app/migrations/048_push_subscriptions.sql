-- Migration 048: Web Push — per-device subscriptions + the VAPID identity
-- (plan: web push provider; ntfy stays as the fully-local alternative)
--
-- Both tables live in the shared DB on purpose: subscriptions belong to the
-- Nova entity (any instance may push), and the VAPID keypair must be stable
-- across instances or subscriptions minted by one box would be undeliverable
-- from another.

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id            UUID PRIMARY KEY,
    endpoint      TEXT NOT NULL UNIQUE,   -- push-service capability URL
    p256dh        TEXT NOT NULL,          -- client public key (encryption)
    auth          TEXT NOT NULL,          -- client auth secret
    label         TEXT,                   -- device name (UA-derived)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ,
    failures      INT NOT NULL DEFAULT 0
);

-- Single-row keypair, generated lazily on first use. Deliberately NOT in the
-- settings store: that renders in the Settings UI and the private key must
-- never appear there.
CREATE TABLE IF NOT EXISTS push_vapid (
    id           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    public_key   TEXT NOT NULL,   -- uncompressed P-256 point, base64url (applicationServerKey)
    private_key  TEXT NOT NULL,   -- raw 32-byte scalar, base64url (pywebpush format)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
