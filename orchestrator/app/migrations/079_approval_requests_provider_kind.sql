-- T2-02: Add provider_kind to approval_requests so consent_rules can mirror it.
-- Closes G4 from docs/audits/2026-05-03-readiness-assessment.md.
--
-- Without this column, decide_approval() at consent.py:207 has nowhere to read
-- the provider from when it materialises a remembered consent rule, and falls
-- back to a hardcoded "github". When M12's second provider (Cloudflare) lands,
-- a remembered Cloudflare MUTATE would create a github-scoped rule and trigger
-- accidental auto-approvals on GitHub tools sharing the same tool_name.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. No CHECK constraint in v1 — provider
-- enum lives in the application layer until M12.

ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS provider_kind TEXT;

-- Backfill: every approval row created before this migration came from the
-- only provider wired up in v1 — github (open_fix_pr, comment_on_pr,
-- register_webhook, unregister_webhook). Without this update, _find_matching_rule
-- would miss against rules with provider_kind='github' for legacy rows whose
-- column is NULL.
UPDATE approval_requests
SET provider_kind = 'github'
WHERE provider_kind IS NULL
  AND tool_name IN (
    'open_fix_pr',
    'comment_on_pr',
    'register_webhook',
    'unregister_webhook'
  );
