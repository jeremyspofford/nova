-- S40 (the hub lane): the bundled engine is named `hub`.
--
-- Gateway migration 009 renames the builtin provider row `ollama` -> `hub`
-- (owner decision 1, 2026-09-18: every model id names the machine that runs
-- it, and `ollama:` named no machine). A setting holding the old id would
-- then ask the gateway for a provider that no longer exists, so the two
-- settings that hold a model id follow the rename here. The literal `hub` is
-- that rename's mirror: two databases, and no SQL here can ask the other.
--
-- Only a value that NAMED the old provider moves. A bare id (`qwen3.8:27b`)
-- already means "the default provider" and stays as the owner wrote it; a
-- cloud id (`openrouter:…`) names a provider this knows nothing about.
-- Nothing else in core stores a model id as configuration: an agent's chain
-- lives in the gateway's routes (009 rewrites them), and eval_runs /
-- turn_spans keep `ollama:` because that is what served then — a measurement
-- row never changes meaning.
--
-- Idempotent: a second run finds no value starting `ollama:`.
UPDATE settings
   SET value = to_jsonb('hub:' || substr(value #>> '{}', length('ollama:') + 1)),
       updated_at = now()
 WHERE key IN ('chat.model', 'chat.vision_model')
   AND jsonb_typeof(value) = 'string'
   AND (value #>> '{}') LIKE 'ollama:%';
