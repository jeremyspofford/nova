-- T1-04: CREDENTIAL_MASTER_KEY auto-bootstrap.
--
-- The capability credential vault encrypts secrets with AES-256-GCM using a
-- master key read from settings.credential_master_key (CREDENTIAL_MASTER_KEY
-- env var). Day-1 users running `make up` without the install wizard arrive
-- with an empty value and a 500 on the first credential POST.
--
-- This migration seeds an empty platform_config row so the orchestrator's
-- startup hook (ensure_credential_master_key) can UPDATE it with a generated
-- value when no env var is set. Existing deployments that already have the
-- key live in CREDENTIAL_MASTER_KEY are unaffected — the startup hook treats
-- a non-empty settings.credential_master_key as authoritative and leaves the
-- platform_config row alone.

INSERT INTO platform_config (key, value, description, is_secret, updated_at) VALUES
  (
    'capability.credential_master_key',
    '""',
    'Auto-generated master key for capability credential vault (AES-256-GCM). 64-char hex. Mirrors CREDENTIAL_MASTER_KEY env var when set; otherwise generated and persisted here on first orchestrator startup.',
    TRUE,
    NOW()
  )
ON CONFLICT (key) DO NOTHING;
