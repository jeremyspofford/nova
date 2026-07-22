-- Migration 035: correct the tag-hygiene guidance (follows #27 / migration
-- 027; the block's tail was later rewritten by #28's about:user work, so this
-- targets the sentence up to "never sentences." and leaves the about:user
-- guidance after it intact). The original told writers "existing tags win over
-- new ones — prefer any tag you have seen on related memories," which actively
-- encouraged the over-linking bug found 2026-07-21: coincidental generic words
-- (zoo, media/transcript, new-york) and a homonym (giants) got adopted and
-- bridged wholly unrelated notes (a Bear Mountain hiking attraction to the "Me
-- at the zoo" YouTube video; the NY Giants to the Voyager probe). Generic tags
-- no longer bridge anything in code (memory._GENERIC_TAGS); this makes the
-- writer reach for SPECIFIC subject tags instead of reusing whatever word it
-- saw. The write_memory tool's `tags` field carries the same guidance, so
-- every writer gets it; this keeps the ingestion agent's framing aligned.
--
-- regexp_replace (not literal REPLACE) so the match doesn't hinge on the exact
-- em-dash byte in the stored prompt; [^\n]* spans the one-line sentence.

UPDATE agents
SET system_prompt = regexp_replace(
    system_prompt,
    'Tag hygiene:[^\n]*never sentences\.',
    'Tag hygiene: tag every topic by its SPECIFIC SUBJECT (bear-mountain, gas-giants, model-context-protocol) — specific subject tags are what cluster memories in the brain. Reuse an existing tag only when it names the SAME subject; never tag by generic category/format/kind (video, transcript, news, zoo, tools) or broad geography (new-york, usa) — those are search labels only and never link, so a note tagged only that way floats alone. Disambiguate words that have other meanings (gas-giants, not giants). Short kebab-case nouns, never sentences.'),
    updated_at = now()
WHERE system_prompt ~ 'Tag hygiene:[^\n]*never sentences\.';
