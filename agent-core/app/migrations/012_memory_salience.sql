-- Migration 012: continuity memory — kind + importance on memories.
-- kind: fact | preference | event | insight (no CHECK on purpose — unknown
-- kinds must degrade gracefully, never break ingestion).
-- importance: 0..1, weight in salience-ranked retrieval.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'fact';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS importance real NOT NULL DEFAULT 0.5;
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories (kind);
