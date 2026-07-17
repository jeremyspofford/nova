-- Migration 026: per-automation timeout override + append-only digest fix
-- (roadmap #26). tech-news-digest timed out twice at the global 300s budget
-- because its instruction demanded whole-document regeneration ("preserving
-- previous entries") — generation time grew with the digest until it outran
-- the budget. The instruction now uses write_memory's append mode (only the
-- delta is generated; earlier entries are preserved mechanically) and
-- month-capped digest topics. timeout_seconds stays available for jobs that
-- are legitimately long, NULL = the global automations.run_timeout_seconds.

ALTER TABLE automations ADD COLUMN IF NOT EXISTS timeout_seconds INTEGER
    CHECK (timeout_seconds IS NULL OR timeout_seconds >= 30);

-- No-op on installs without the chat-created automation. Failure streak
-- reset so the restructured job gets a fresh 5-strike allowance.
UPDATE automations
SET instruction = 'Search the web for the latest AI and tech news from the past 12 hours: major developments, breakthroughs, company announcements, and trending topics in artificial intelligence. Compile 5-10 key stories with source URLs. Store ONLY the new stories in this month''s digest topic (title: "AI News Digest — <Month> <Year>"): use search_memory to find it; if it exists, call write_memory with its item_id AND append=true, sending just today''s section starting with a "## <Month> <day>, <year>" heading — earlier entries are preserved automatically, so never re-send, rewrite, or summarize them. If no digest topic exists for the current month, create a new one (tags: ai-news, tech-news, digest). Finish with a one-line report of how many stories you added.',
    consecutive_failures = 0,
    updated_at = now()
WHERE name = 'tech-news-digest';
