-- 098_drop_legacy_memory_tables.sql
-- Drop the nine orphan tables left behind by the removed pre-OKF memory
-- system (SQLAlchemy schema.sql, engram era). No migration created them on
-- fresh installs, no code reads them (audited 2026-07-05, architecture/05
-- §D2) — they exist only on long-lived hosts. IF EXISTS keeps this a no-op
-- on fresh databases. neural_router_models was dropped by 091 but observed
-- live again (old image or backup restore) — dropped here once more.

DROP TABLE IF EXISTS
    engram_edges,
    engram_archive,
    engrams,
    working_memory_slots,
    embedding_cache,
    consolidation_log,
    retrieval_log,
    sources,
    neural_router_models
    CASCADE;
