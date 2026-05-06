-- Feature flags v1: code-registered, override-only storage.

CREATE TABLE IF NOT EXISTS feature_flags (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    set_by TEXT NOT NULL,
    set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT
);

CREATE TABLE IF NOT EXISTS feature_flag_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('set', 'reset')),
    old_value JSONB,
    new_value JSONB,
    actor TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_audit_key_time
    ON feature_flag_audit (key, occurred_at DESC);
