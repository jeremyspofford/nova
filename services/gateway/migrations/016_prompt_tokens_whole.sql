-- One meaning for prompt_tokens (S38c T7): the WHOLE input, with the cache
-- reads and writes as parts of it — what every OpenAI-shaped provider
-- already states. Until T7 the anthropic-messages adapter stated Anthropic's
-- `input_tokens`, the UNCACHED remainder, as prompt_tokens, so the rows it
-- wrote are in the old frame and a Spend sum would add an old remainder to
-- a new whole. This moves them into the new frame, losslessly: the cache
-- columns and the billed cost stay exactly as stored, and re-pricing a
-- moved row with T7's formula gives the dollars it was billed. A NULL cache
-- count is no part (adds 0); a row with no prompt count stays unmetered.
-- Rows are told apart by their provider row's adapter; a row whose provider
-- row is gone cannot be, and is left as stored (none from Anthropic on
-- 2026-10-14). Core's past llm_call spans keep the frame they were traced in.
UPDATE usage_events u
   SET prompt_tokens = u.prompt_tokens
                       + COALESCE(u.cache_read_tokens, 0)
                       + COALESCE(u.cache_write_tokens, 0)
  FROM providers p
 WHERE p.name = u.provider
   AND p.adapter = 'anthropic-messages'
   AND u.prompt_tokens IS NOT NULL;
