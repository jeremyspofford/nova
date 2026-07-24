-- Migration 049: household user profiles + voiceprints
-- (docs/plans/speaker-id.md)
--
-- Who Nova can recognize by voice. Voiceprints are biometric-adjacent:
-- local-only, deleted with the profile, and enrollment audio is embedded
-- and DISCARDED — no clips are stored. The hard rule: recognition is
-- personalization, never authentication — with this table empty, behavior
-- is exactly the single-operator behavior of before.

CREATE TABLE IF NOT EXISTS user_profiles (
    id             UUID PRIMARY KEY,
    name           TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'guest'
                   CHECK (role IN ('operator', 'kid', 'guest')),
    persona_notes  TEXT,            -- feeds the runner's who-you're-speaking-with block
    voiceprint     JSONB,           -- mean embedding vector; NULL until enrolled
    enrolled_clips INT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
