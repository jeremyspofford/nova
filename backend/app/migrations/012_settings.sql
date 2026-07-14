-- Migration 012: runtime settings — the UI-configured source of truth.
-- Env vars are demoted to infra bootstrap + secrets only.

CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
