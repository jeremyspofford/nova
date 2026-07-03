-- Engram backend removed: recommendation↔memory links now store backend-neutral
-- memory ids (OKF markdown paths are strings, not UUIDs).
CREATE TABLE IF NOT EXISTS intel_recommendation_memories (
    recommendation_id UUID NOT NULL REFERENCES intel_recommendations(id) ON DELETE CASCADE,
    memory_id         TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (recommendation_id, memory_id)
);

DROP TABLE IF EXISTS intel_recommendation_engrams;
