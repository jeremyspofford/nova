-- Owner ruling D5 (2026-11-10): a failed task, a scheduled one included, is amber "Needs you". Tasks
-- are not a downed system; red is only for Nova itself stopped, and a dead component under a task
-- raises its own red problem. src/core/ledger.ts no longer raises "A task failed" as stopping; the
-- ones raised before this (an old failed "Backup now" kept the status mark red) are amber from here.
UPDATE problem SET stops = 0 WHERE source = 'ledger' AND message LIKE 'A task failed:%' AND stops = 1;
