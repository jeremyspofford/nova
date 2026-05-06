-- SEC-006a: platform-level encrypted secrets store.
--
-- Holds long-lived credentials needed by long-running services (LLM provider
-- API keys, chat-bridge tokens, OAuth secrets, GitHub PAT for self-mod) so
-- they no longer have to live plaintext in `.env`. Ciphertext is AES-256-GCM
-- envelope-encrypted under HKDF subkey derived from settings.credential_master_key
-- (the same master key migration 077 already bootstraps for capability creds).
--
-- Tenant id for HKDF is the literal string "platform" — these are instance-level
-- secrets, not per-tenant. Per-tenant secrets continue to live in
-- capability_credentials (a separate domain).
--
-- Storage shape: one row per secret. Key is dot-namespaced, e.g.
-- "llm.anthropic_api_key", "bridge.telegram_bot_token". Ciphertext bytes are
-- the concatenated envelope layout from BuiltinCredentialProvider.encrypt.

CREATE TABLE IF NOT EXISTS platform_secrets (
    key         TEXT PRIMARY KEY,
    ciphertext  BYTEA NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS platform_secrets_updated_at_idx ON platform_secrets(updated_at);
