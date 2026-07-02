-- 090_seed_memory_curation_goal.sql
-- Nightly memory curation goal for the OKF markdown backend: distill journal
-- inbox entries into curated topic files. Fires via cortex's cron scheduler
-- (requires features.brain_enabled). A retention backstop in memory-service
-- archives journals >45 days old regardless, so nothing rots if the brain is
-- off — this goal is the quality layer on top.

INSERT INTO goals (title, description, status, priority, schedule_cron,
                   check_interval_seconds, created_by, created_via,
                   max_cost_usd, review_policy)
SELECT
    'Nightly memory curation',
    'Distill the memory journal inbox into curated topic files.

Steps:
1. Call get_memory_stats() — if the backend is not "okf", complete without doing anything.
2. Use search_memory / read_memory to review journal entries older than 3 days (journal/YYYY-MM-DD.md files).
3. For each durable fact, preference, decision, or learning found in those entries, call remember(title=..., type=..., description=..., text=...) to write or update a topic file. Merge related facts into one concept rather than creating near-duplicates; link related concepts with markdown links.
4. Skip transient content (small talk, one-off status updates, superseded states).
5. Report how many journal entries you reviewed and how many concepts you wrote.',
    'active',
    3,
    '0 3 * * *',
    86400,
    'system',
    'migration',
    1.00,
    'auto'
WHERE NOT EXISTS (
    SELECT 1 FROM goals WHERE title = 'Nightly memory curation'
);
