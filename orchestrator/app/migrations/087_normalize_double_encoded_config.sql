-- 087_normalize_double_encoded_config.sql
--
-- One-time (idempotent) data fix for platform_config rows that were stored
-- DOUBLE JSON-encoded: a jsonb string whose text content is itself a
-- JSON-encoded scalar, e.g. value = '"\"local-only\""' instead of the correct
-- '"local-only"'. The extra layer came from earlier write paths that
-- json.dumps()'d an already-encoded value. It made the config API, audit
-- history, and the boot .env-reconcile all read values with stray quotes
-- (e.g. the WARN "effective value '"local-only"'").
--
-- This unwraps exactly ONE encoding layer, restoring single encoding.
--
-- Safety / scope:
--   * NON-secret rows only. Secret-flagged rows (auth.jwt_secret,
--     capability.credential_master_key) are excluded — their consuming code
--     owns the current encoding, and rewriting auth.jwt_secret would
--     invalidate every live JWT session.
--   * Only touches a jsonb string whose content starts and ends with '"' AND
--     satisfies the PG16 `IS JSON` predicate, so a legitimate bareword value
--     (e.g. nova.name = 'Nova', a URL, a multi-word persona) is never matched.
--   * `(content)::jsonb` cannot fail here because the `IS JSON` guard already
--     proved the content parses.
--   * Idempotent: after unwrapping, the content no longer begins with '"', so
--     a re-run selects nothing.

UPDATE platform_config
SET value = (value #>> '{}')::jsonb,
    updated_at = NOW()
WHERE is_secret = false
  AND jsonb_typeof(value) = 'string'
  AND left(value #>> '{}', 1) = '"'
  AND right(value #>> '{}', 1) = '"'
  AND (value #>> '{}') IS JSON;
