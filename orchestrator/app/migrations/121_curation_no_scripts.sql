-- 121_curation_no_scripts.sql
-- Amendment to the curation contract (120): a capable model interpreted
-- "distill the journal" as "write curate_memory.py to automate it", invented
-- nonexistent APIs, and produced zero memory writes while self-reporting
-- success. Curation is tool calls in-session, never code.

UPDATE goals
SET description = regexp_replace(
        description,
        'Contract for every run:',
        'Do the work with the memory tools IN THIS SESSION — call remember() once per durable item. NEVER write scripts, code files, or workspace files to automate curation; there is no curation script, the remember tool IS the mechanism.

Contract for every run:'),
    updated_at = NOW()
WHERE title = 'Nightly memory curation'
  AND description NOT LIKE '%IN THIS SESSION%';
