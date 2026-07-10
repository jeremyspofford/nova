-- 120_curation_link_contract.sql
-- Tighten the Nightly memory curation goal (seeded in 090). Four fires on the
-- old prompt produced ~1 concept file and zero links: no provenance links, no
-- cross-links, vague steps. The Brain graph's edges come ONLY from markdown
-- links in file bodies, so a topic without links is an orphan and journals
-- stay an unconnected scatter.
-- (Numbering note: 105-119 are reserved by the autonomy-core branch.)

UPDATE goals
SET description = $curation$Distill the memory journal inbox into curated, LINKED topic files.

Contract for every run:
1. Call get_memory_stats() — if the active backend is not "okf", complete without writing anything.
2. Review journal files (journal/YYYY-MM-DD.md) from the last 7 days that are at least 1 day old, via search_memory / read_memory.
3. IGNORE repetitive machine noise (e.g. "Cortex cycle #N … no stale goals", heartbeats, identical status lines). Distill only durable facts, preferences, decisions, learnings, and project state.
4. For each durable item, call remember(title=…, type=…, description=…, text=…, tags=…). Requirements:
   - The title names the concept (e.g. "GPU inference setup") — never a date, never "journal".
   - description is one factual line for the index.
   - End text with a "## Sources" section containing a markdown link to EVERY journal file the item was distilled from, using bundle-root paths: [Journal 2026-07-09](/journal/2026-07-09.md).
   - Where the item relates to an existing concept, link it inline the same way: [Nova inference setup](/projects/nova-inference-setup.md). Use search_memory/read_memory to find exact ids. These body links are what connect the Brain graph.
   - Merge into an existing concept (target=…) instead of creating a near-duplicate.
   - Where an item changes how Nova should operate (identity, values, standing behavior), also link [Soul](/self/soul.md).
5. Report: journals reviewed, concepts written/updated, links added. If nothing durable was found, say so explicitly.$curation$,
    updated_at = NOW()
WHERE title = 'Nightly memory curation';
