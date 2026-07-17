-- Migration 027: tag hygiene for memory writers (#27). Found live
-- (2026-07-17): tool-written topics arrived with zero tags or one-off tag
-- vocabularies (users-favorite-hiking-spot had none while a bear-mountain
-- system floated nearby), leaving orphaned orbs in the brain views. A
-- mechanical linking pass now runs at write time; this guidance makes the
-- writer cooperate with it instead of fighting it.

UPDATE agents
SET system_prompt = system_prompt || '

Tag hygiene: every topic you write gets tags, and existing tags win over new ones — before inventing a tag, prefer any tag you have seen on related memories (search results show their subjects). Use short kebab-case nouns (bear-mountain, ai-news), never sentences. Shared tags are how memories cluster in the brain; an untagged topic floats alone.',
    updated_at = now()
WHERE name = 'ingestion'
  AND system_prompt NOT LIKE '%Tag hygiene:%';
