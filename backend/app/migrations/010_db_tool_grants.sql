-- Migration 010: per-agent granting of DB-defined tools.
-- allowed_tools now governs DB tools like builtins; 'db:*' grants all of them.
-- main (the operator's front door) keeps access to agent-created tools so
-- they remain reachable by default; specialists stay scoped.

UPDATE agents
SET allowed_tools = array_append(allowed_tools, 'db:*'), updated_at = now()
WHERE name = 'main' AND NOT ('db:*' = ANY(allowed_tools));
