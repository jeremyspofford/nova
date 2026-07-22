-- Migration 045: make memory deletion reachable from chat via a dedicated
-- curator specialist.
--
-- Incident 2026-07-22: the operator asked Nova to "remove everything about
-- bear mountain and steve jobs". Nova (the main agent) has no delete grant and
-- didn't know a specialist held one, so it FAKED the deletion by overwriting
-- each note's body with a "[Deleted]" marker — the files and their atlas nodes
-- survived. delete_memory_item has existed since migration 020 but was parked
-- on skill-manager, described/routed as skills-only, so Nova never dispatched
-- forgetting to it.
--
-- Operator decisions:
--   * destructive tools stay OFF the main orchestrator (widest exposure) —
--     deletion is dispatched to a specialist.
--   * skill-manager manages SKILLS only. Memory curation (forgetting/pruning
--     topics) lives in a dedicated, small memory-curator that does NOT fetch
--     or ingest untrusted content, so a prompt-injection buried in fetched
--     text can't reach delete_memory_item. (Same trust boundary that keeps
--     delete off main; the ingestion agent, which swallows arbitrary web/video
--     content, deliberately gets no delete grant either.)
--
-- Idempotent + self-reconciling: absolute SETs for skill-manager, an upsert
-- for memory-curator, a regexp strip + guarded append for main's prompt — so
-- re-running, or applying over an earlier draft of this migration, converges.

-- (1) skill-manager: skills only. Restore its focused description/routing and a
--     clean skills-scoped role. It keeps delete_memory_item because deleting an
--     obsolete SKILL is skill management; topic/memory forgetting is not its job.
UPDATE agents SET
  description = 'Manages the workflow for creating and updating skills other agents can use, stored as OKF markdown.',
  routing_keywords = ARRAY['skill','workflow','template'],
  system_prompt = 'You are the Skill Manager. Your role is to help create and refine skills that other agents can use.

Skills are reusable prompt templates and guidance that can be applied across agents. You can:
- Write skills to the memory system (write_memory with type: skill)
- Help agents discover applicable skills
- Refine skills based on feedback
- Delete an obsolete SKILL with delete_memory_item — look up its exact skills/… id first and report the returned status.

You handle skills only. Requests to forget, prune, or delete TOPICS or memories belong to the memory-curator, not you.',
  updated_at = now()
WHERE name = 'skill-manager';

-- (2) memory-curator: the dedicated deaccession specialist. Deliberately tiny
--     toolset (search + read + delete) and NO fetch/ingest — a narrow attack
--     surface for a destructive capability. Inherits skill-manager's model.
INSERT INTO agents (name, description, system_prompt, model,
                    allowed_tools, routing_keywords, is_system)
VALUES (
  'memory-curator',
  'Curates long-term memory: finds and permanently deletes or prunes memory topics and notes on request. Dispatch here whenever the operator wants something removed, deleted, forgotten, or pruned from memory.',
  'You are the Memory Curator. You keep long-term memory clean by removing what the operator no longer wants remembered.

When asked to delete, remove, forget, or prune something:
1. Find the exact item id with search_memory (use read_memory_item to confirm you have the right note).
2. Call delete_memory_item with that id and report the status it returns.
Delete every matching item the request covers — one subject can span several notes (a topic plus its chunks or full transcript), so search thoroughly and remove them all.

Never simulate a deletion by overwriting a note''s body with a placeholder or "[Deleted]" marker: the item stays in the atlas and the operator still sees it. Only skills/ and topics/ can be deleted — journals are the audit trail and identity is protected. Report exactly what you removed; never claim a deletion the tool did not confirm.',
  (SELECT model FROM agents WHERE name = 'skill-manager'),
  ARRAY['search_memory','read_memory_item','delete_memory_item'],
  ARRAY['memory','forget','delete','remove','prune','curate','topic','note'],
  true)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  system_prompt = EXCLUDED.system_prompt,
  allowed_tools = EXCLUDED.allowed_tools,
  routing_keywords = EXCLUDED.routing_keywords,
  is_system = EXCLUDED.is_system,
  updated_at = now();

-- (3) main: route forgetting to memory-curator. Strip any earlier draft's
--     skill-manager deletion line (regexp so leading whitespace never matters),
--     then append the memory-curator line exactly once.
UPDATE agents
SET system_prompt = regexp_replace(
      system_prompt,
      '\s*When the operator asks to delete, remove, or forget something from memory \(a topic, skill, or note\), dispatch to the skill-manager specialist.*confirmed it\.',
      '', 'g'),
    updated_at = now()
WHERE name = 'main';

UPDATE agents
SET system_prompt = system_prompt || E'\n\nWhen the operator asks to delete, remove, or forget something from memory (a topic, skill, or note), dispatch to the memory-curator specialist — it holds the delete tool. Do NOT simulate deletion by overwriting a note''s content with a marker, and never say something was deleted unless the tool confirmed it.',
    updated_at = now()
WHERE name = 'main'
  AND system_prompt NOT LIKE '%memory-curator specialist%';
