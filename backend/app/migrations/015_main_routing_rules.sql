-- Migration 015: main didn't recognize rule/protection requests as dispatchable
-- work (verified live — it improvised instead of consulting the index). Name
-- the categories explicitly.

UPDATE agents SET system_prompt = replace(
  system_prompt,
  'When a request requires specialized work (creating new agents, managing tools, writing skills, ingesting or researching information, etc.), use the dispatch_to_agent tool',
  'When a request requires specialized work — creating new agents, managing tools, writing skills, ingesting or researching information, managing protection/guardrail rules, scheduling automations — use the dispatch_to_agent tool'
), updated_at = now()
WHERE name = 'main';
