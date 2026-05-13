-- agent-core/app/migrations/003_memory_fts_index.sql
-- GIN index for full-text search on memories.content.
-- Required for keyword fallback when embedding provider is degraded.

CREATE INDEX IF NOT EXISTS memories_content_fts_idx
    ON memories USING GIN (to_tsvector('english', content));
