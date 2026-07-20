-- Migration 030: consent hardening (2026-07-20 review round) — guardian's
-- charter learns the third consent kind: pattern/target changes are gated
-- too, since a rewritten pattern that never matches is a deletion in
-- effect. Enforcement lives in the tool layer (builtin.py); this only
-- keeps the charter truthful.

UPDATE agents SET system_prompt = replace(
    system_prompt,
    'When a request names a specific rule and asks to weaken, disable, or delete it,',
    'When a request names a specific rule and asks to weaken, disable, delete, or modify it (pattern or targets included — a rewritten pattern is a deletion in disguise),')
 WHERE name = 'guardian' AND is_system
   AND system_prompt LIKE '%asks to weaken, disable, or delete it%';
