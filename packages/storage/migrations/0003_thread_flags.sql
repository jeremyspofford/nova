-- M2 thread flags (FR-026, FR-032). A side chat is a child thread that reads its parent's
-- context and adds no turns to it; memory_opt_out keeps a chat out of memory extraction.
ALTER TABLE thread ADD COLUMN side INTEGER NOT NULL DEFAULT 0;
ALTER TABLE thread ADD COLUMN memory_opt_out INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_thread_parent ON thread (parent_thread_id);
