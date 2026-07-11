-- Migration 122: remove platform_config rows that nothing reads
--
-- 2026-07-10 config audit: these keys were written by the Settings UI (or
-- seeded by earlier migrations) but no service ever consumed them — the UI
-- presented configuration that silently did nothing.
--
--   nova.default_model   superseded by llm.default_chat_model (demoted from
--                        DEFAULT_CHAT_MODEL, read by llm-gateway /v1/models/resolve)
--   context.*_pct        the per-slice context budget allocator was never
--                        implemented; the sliders were a placebo. The one
--                        real knob, context.compaction_threshold, stays and
--                        is now actually read by the pipeline executor.

DELETE FROM platform_config
WHERE key IN (
    'nova.default_model',
    'context.system_pct',
    'context.tools_pct',
    'context.memory_pct',
    'context.history_pct',
    'context.working_pct'
);
