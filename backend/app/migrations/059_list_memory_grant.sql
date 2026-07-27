-- list_memory: the catalogue tool, granted to whatever already reads memory.
--
-- Derived rather than enumerated. The rule is "an agent that can open a
-- document may see which documents exist", so the grant follows
-- read_memory_item instead of a list of agent names I would have to keep
-- correct — and an agent created after this migration inherits the pairing
-- from whoever writes its grants, not from a stale list here.
--
-- memory-curator is the case that shows why this was wrong before: its
-- entire job is curating memory, and it held delete_memory_item and
-- read_memory_item while having no way to enumerate what it was curating.
-- It could delete a document it could not list.
--
-- Deliberately NOT granted to the search-only agents (guardian,
-- agent-manager, tool-creator, model-manager, agent-creator): they reach
-- memory to answer a specific question, and a corpus listing is not part of
-- that job. Grant it to them the day one of them needs it.

UPDATE agents
   SET allowed_tools = array_append(allowed_tools, 'list_memory')
 WHERE allowed_tools IS NOT NULL
   AND 'read_memory_item' = ANY(allowed_tools)
   AND NOT ('list_memory' = ANY(allowed_tools));
