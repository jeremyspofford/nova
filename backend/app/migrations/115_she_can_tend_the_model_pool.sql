-- Migration 115: she can tend the model pool.
--
-- THE FAILURE (2026-08-07, live). Jeremy: "Can you get the latest DeepSeek
-- flash llm available". Thirty-one minutes of Nova describing UI steps —
-- including "Settings -> Models, toggle edit mode", an edit mode deleted
-- from the UI — because she was mechanically right: NO agent could write
-- curated_models, main could not even LIST the catalog without a dispatch,
-- and model-manager, having found a model, had no way to put a decision in
-- front of the operator. He hand-inserted the row at 18:36:36 with the
-- malformed slug 'openrouter:~deepseek/deepseek-v4-flash-latest' (the
-- openrouter.ai profile-URL shape, which the provider does not serve) and
-- repointed main at it 21 seconds later. The hand insert logged nothing.
--
-- What the code half of this lane built: manage_curated_models (every add
-- resolves the id against the LIVE provider catalog and refuses or
-- normalises the '~' form — the check that would have stopped that slug);
-- capability_events on every curated write; and the model.assign typed
-- recommendation action, so an assignment reaches the operator as a card
-- and his approval performs the same PATCH he did by hand
-- (agents/registry._SYSTEM_PROTECTED stays exactly as strict as it was).
--
-- THE GRANTS — the step missed FIVE times before (095, 096, 099, 104, 106):
-- a tool is not a capability until an agent holds it.
--
-- manage_curated_models -> model-manager: the steward of the model family.
-- Goal-scoped (scopes.GOAL_SCOPED_TOOLS) with 'list' exempt as a read.
UPDATE agents
SET allowed_tools = allowed_tools || ARRAY['manage_curated_models'],
    updated_at = now()
WHERE name = 'model-manager'
  AND allowed_tools IS NOT NULL
  AND NOT ('manage_curated_models' = ANY(allowed_tools));

-- raise_recommendation -> model-manager: after discovering a model she had
-- NO mechanical way to put the decision in front of the operator — the card
-- (and its model.assign plan) is that way.
UPDATE agents
SET allowed_tools = allowed_tools || ARRAY['raise_recommendation'],
    updated_at = now()
WHERE name = 'model-manager'
  AND allowed_tools IS NOT NULL
  AND NOT ('raise_recommendation' = ANY(allowed_tools));

-- list_models -> main: read-only and cheap. She held NONE of
-- list_models/recommend_models/pull_model, so "what models could I use"
-- required a dispatch, and dispatch answers are hearsay — she could not
-- even look at the catalog she was being asked about.
UPDATE agents
SET allowed_tools = allowed_tools || ARRAY['list_models'],
    updated_at = now()
WHERE name = 'main'
  AND allowed_tools IS NOT NULL
  AND NOT ('list_models' = ANY(allowed_tools));

-- The agent index is how main decides to dispatch (the migration-016
-- lesson): the description must advertise the new capability or "add this
-- model" never reaches the model-manager.
UPDATE agents
SET description = 'Manages Nova''s model inventory and fit: lists what''s available across providers, downloads new local models (Ollama), recommends which model each agent should use based on this machine''s hardware, curates the approved model pool (add/enable/disable curated models, verified against the live provider catalog), and raises model-assignment cards for the operator to approve. Dispatch "what models do we have", "get/download/pull a model", "add/approve this model", or "what model should I/my agents use" requests here.',
    routing_keywords = ARRAY['model','pull','download','inference','llm',
                             'ollama','recommend','hardware','curated',
                             'approve','deepseek','openrouter'],
    updated_at = now()
WHERE name = 'model-manager';

-- ...and the model-manager learns what the new verbs are for. Facts, not
-- controls: the catalog check and the operator gate hold whether or not
-- this text is read.
UPDATE agents
SET system_prompt = system_prompt || '

- manage_curated_models is the approved model pool. `add` verifies the id against the live provider catalog and REFUSES ids the provider does not serve — a ''~author/model'' slug from a website URL is normalised to the real API id or refused, so always report the id the RESULT names, never the one you sent. Adding approves a model for dropdowns/recommendations/standbys; it assigns nothing to any agent.
- To put an agent on a model, raise_recommendation with action {"type": "model.assign", "agent": "<name>", "model": "<provider:id>", "why": "..."}. You cannot change any agent''s model yourself — the operator''s approval of that card performs the change. Say the card was raised and stop; never claim the assignment happened.',
    updated_at = now()
WHERE name = 'model-manager'
  AND system_prompt NOT LIKE '%manage_curated_models%';
