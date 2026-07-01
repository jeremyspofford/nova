-- 086: Minimal default tool surface for local models.
--
-- Supersedes migration 060's disabled_groups band-aid. Rather than hiding a few
-- groups, the default chat agent now sees only three primitives:
--   read_file, write_file, run_shell
-- Everything else (web search, git, hardware inspection, code search) is
-- reachable THROUGH run_shell (curl, git, nvidia-smi, rg, ls, ...). A tiny tool
-- surface is what actually lets small local models reliably emit tool calls,
-- and it slashes system-prompt size.
--
-- Other tools remain registered. Re-expose them by widening (or clearing)
-- default_allowed_tools from the dashboard (Settings -> tool permissions).
--
-- Idempotent + non-destructive: only seeds default_allowed_tools when absent,
-- so a user's dashboard edits are never trampled on restart.

-- Case 1: a tool_permissions row already exists (e.g. seeded by migration 060)
-- but has no allowlist yet — merge the key in, preserving disabled_groups.
UPDATE platform_config
SET value = value || '{"default_allowed_tools": ["read_file", "write_file", "run_shell"]}'::jsonb,
    updated_at = NOW()
WHERE key = 'tool_permissions'
  AND NOT (value ? 'default_allowed_tools');

-- Case 2: no tool_permissions row at all — create one.
INSERT INTO platform_config (key, value, description)
SELECT
  'tool_permissions',
  '{"disabled_groups": [], "default_allowed_tools": ["read_file", "write_file", "run_shell"]}'::jsonb,
  'Default agent tool surface. default_allowed_tools = global allowlist applied to agents that do not set their own.'
WHERE NOT EXISTS (SELECT 1 FROM platform_config WHERE key = 'tool_permissions');
