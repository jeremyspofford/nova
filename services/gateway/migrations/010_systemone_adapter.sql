-- The decision role (docs/plans/rebuild/decision-role/spec.md §1): a provider
-- can be a decision-model server — `systemone`, a base URL and an optional
-- key, no chat. A Kev box on the owner's network is one. The CHECK is 003's
-- inline column constraint (Postgres named it providers_adapter_check).
--
-- `local` already exists (005). It stops being derived from the adapter in
-- code (providers.validate_shape): the owner says whether a provider runs on
-- his own machine. Nothing here changes a stored value.
--
-- Idempotent (007's rule): DROP-then-ADD.
ALTER TABLE providers DROP CONSTRAINT IF EXISTS providers_adapter_check;
ALTER TABLE providers ADD CONSTRAINT providers_adapter_check
    CHECK (adapter IN ('ollama', 'openai-chat', 'anthropic-messages', 'systemone'));
