-- Migration 020: two findings from the 2026-07-14 19:24 incident + operator
-- decisions.
--
-- (a) "Delete the weather skill" was fabricated ("✅ deleted", zero tool
-- calls, file untouched) — and even a perfect dispatch would have failed:
-- NO agent tool could delete anything. skill-manager gains
-- delete_memory_item (skills/ and topics/ only; journals are the audit
-- trail, identity is out of reach by path AND by rule).
--
-- (b) System agents are always active (operator decision): core
-- infrastructure has no off toggle — rules and tool grants are the
-- constraint mechanisms, enforced at the API layer.

UPDATE agents
SET allowed_tools = array_append(allowed_tools, 'delete_memory_item'),
    updated_at = now()
WHERE name = 'skill-manager'
  AND NOT ('delete_memory_item' = ANY(allowed_tools));

UPDATE agents
SET system_prompt = system_prompt || '

- delete_memory_item permanently removes a skill (or topic) by item id, e.g. skills/weather-clothing-advice.md. Look up the exact id first (search_memory), and report the tool''s returned status — never claim a deletion you did not perform.',
    updated_at = now()
WHERE name = 'skill-manager'
  AND system_prompt NOT LIKE '%delete_memory_item%';

-- defense in depth: the protect-soul rule also watches the new delete tool
-- (the tool itself already refuses non-skills/topics paths)
UPDATE rules
SET target_tools = array_append(target_tools, 'delete_memory_item'),
    updated_at = now()
WHERE name = 'protect-soul'
  AND NOT ('delete_memory_item' = ANY(target_tools));

-- system agents are always active
UPDATE agents SET enabled = true, updated_at = now()
WHERE is_system AND NOT enabled;
