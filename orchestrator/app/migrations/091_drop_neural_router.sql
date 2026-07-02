-- 091_drop_neural_router.sql
-- The neural router (learned retrieval re-ranker) was removed with the move
-- to the OKF markdown memory backend: it never activated in practice (needed
-- 200+ labeled observations) and the engram backend is now frozen/legacy.
-- retrieval_log stays — mark-used feedback still records usage signals.

DROP TABLE IF EXISTS neural_router_models;
