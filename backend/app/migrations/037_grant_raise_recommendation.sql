-- Migration 037: re-grant raise_recommendation to main + ingestion.
--
-- Migration 032 (recommendation surface) intends to grant this tool to both
-- agents, and its committed grant clause is correct — but an earlier draft of
-- 032 ran and was marked applied on the dev DB before the grant was finalized,
-- so on that DB neither agent actually received it (verified 2026-07-21: main
-- and ingestion both lacked it, and the recommendation surface's RAISE half was
-- inert as a result). Because migrations are tracked by filename and never
-- re-run, editing 032 would fix nothing here; this fresh migration closes the
-- gap idempotently. On a clean clone where 032 already granted it, the
-- NOT (... = ANY(...)) guard makes this a no-op.
--
-- main (the front door) and ingestion (which learns from the web, incl. media
-- via ingest_media) are the two agents meant to surface actionable
-- recommendations. Only the operator DECIDES — the decide API is never granted.

UPDATE agents
   SET allowed_tools = array_append(allowed_tools, 'raise_recommendation'),
       updated_at = now()
 WHERE name IN ('main', 'ingestion')
   AND allowed_tools IS NOT NULL
   AND NOT ('raise_recommendation' = ANY(allowed_tools));
