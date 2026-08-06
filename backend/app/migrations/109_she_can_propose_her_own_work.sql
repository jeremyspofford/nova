-- Migration 109: she can propose her own work.
--
-- ROADMAP #34, phase I1 (spec → docs/plans/ideation-goals.md).
--
-- The gap Jeremy has been circling since 2026-08-05: "She needs to be able to
-- go and do things on her own, figure it out, without me needing to do it for
-- her." Everything built since has made her more reliable at work he HANDS
-- her — she can write code, verify it in a sandbox, have it reviewed, land it
-- on a branch and put it into service. She still cannot START anything. Every
-- piece of work in this repository began with him asking.
--
-- This is the smallest honest version of "she starts things": once a week she
-- reads her own memory and puts one to three concrete proposals in front of
-- him. It proposes and stops. Nothing here acts.
--
-- READ-ONLY BY CONSTRUCTION, which is what makes a weekly unattended agent a
-- small decision. `ideator` holds four reading tools and `raise_recommendation`
-- — no write_memory, no delete, no web_search or fetch_url, no MCP, nothing
-- that deploys or schedules. It is migration 045's reasoning run in reverse:
-- that agent got a destructive grant and was therefore narrowed to one job;
-- this one has no destructive grant AND no untrusted input, so the surface is
-- zero in both directions.
--
-- ITS MODEL IS MAIN'S, read at apply time rather than pinned. Idea quality is
-- the entire point of the agent, and the eval pipeline is the standing way to
-- change that later — a hardcoded model here would be a second place that has
-- to be remembered.
--
-- THE SCHEDULE IS A REAL SCHEDULE (migration 107): Monday at 09:00 in his
-- timezone, not "every 10080 minutes from whenever this migration ran". A job
-- that says weekly and means "every seven days from a random Thursday
-- afternoon" is the defect that produced 107.
--
-- `next_run_at` is seeded a few minutes out so the FIRST run happens while
-- somebody is watching. The schedule governs every run after it.

INSERT INTO agents (name, description, system_prompt, model, allowed_tools,
                    routing_keywords, enabled, is_system)
VALUES (
    'ideator',
    'Mines memory for the operator''s interests, recurring friction and stale '
    'wishes, then proposes a few concrete buildable ideas as recommendation '
    'cards. Read-only: it never builds, fetches or writes — the operator decides.',
    E'You are the Ideator. Once a week you mine Nova''s memory — journals, '
    'topics, ingested sources — for the operator''s interests, recurring '
    'friction, and stale wishes, and you propose a small number of concrete, '
    'buildable ideas.\n\n'
    'For every idea you raise:\n'
    '- It must be motivated by SPECIFIC memory items. Name them: cite each '
    'supporting item''s title or id in the idea''s body.\n'
    '- Shape: a one-line pitch (the title), then a short body with "Why now" '
    '(the cited evidence) and "First step" (one plausible, concrete opening '
    'move someone could take this week).\n'
    '- Raise it with raise_recommendation: kind ''idea'', dedupe_key '
    '''idea:<kebab-slug-of-the-subject>'' — pick the slug from the subject '
    'itself so the same subject always yields the same slug.\n\n'
    'You only propose. You never build, schedule, fetch, or write memory.\n'
    'Never re-propose a subject that list_past_ideas already shows, even '
    'reworded, even if it is still undecided.\n'
    'A generic idea that could apply to anyone is a failure: if you cannot '
    'cite the memory items that motivated an idea, do not raise it.\n'
    'Proposing nothing is an acceptable outcome.',
    (SELECT model FROM agents WHERE name = 'main'),
    ARRAY['search_memory', 'read_memory_item', 'list_stale_topics',
          'list_past_ideas', 'raise_recommendation'],
    ARRAY['idea', 'ideate', 'propose', 'brainstorm'],
    true, true)
ON CONFLICT (name) DO UPDATE
    SET allowed_tools = EXCLUDED.allowed_tools,
        description   = EXCLUDED.description,
        system_prompt = EXCLUDED.system_prompt,
        updated_at    = now();

INSERT INTO automations (name, description, instruction, agent_name,
                         interval_minutes, schedule, timeout_seconds,
                         enabled, is_system, next_run_at)
VALUES (
    'weekly-ideation',
    'Reads memory once a week and proposes up to three grounded ideas.',
    E'Weekly ideation pass. Work in this order:\n'
    '1. Call list_past_ideas and note every subject already raised. None of '
    'them may be proposed again, in any wording, regardless of status.\n'
    '2. Mine memory for grounding: search_memory for the operator''s recent '
    'interests, recurring frustrations or friction, wishes and "someday" '
    'remarks, and abandoned threads; use read_memory_item to read the '
    'promising hits in full; optionally call list_stale_topics for neglected '
    'subjects worth reviving. Ignore journal entries that are automation run '
    'reports.\n'
    '3. Select at most 3 ideas (fewer is fine) that are concrete and buildable '
    'and grounded in what you read. For each, call raise_recommendation with '
    'kind ''idea'', title = the one-line pitch, body = markdown with "Why now" '
    'citing the specific memory items by title/id and "First step" with a '
    'plausible opening move, dedupe_key = ''idea:<kebab-slug-of-subject>''.\n'
    '4. Finish with a one-paragraph report listing the ideas you raised (or '
    '"no new ideas this week" if nothing was genuinely grounded — that is a '
    'valid result, not a failure).',
    'ideator',
    10080,
    '{"every": "week", "on": ["mon"], "at": "09:00"}'::jsonb,
    900,
    true, false,
    now() + interval '4 minutes')
ON CONFLICT (name) DO NOTHING;

COMMENT ON COLUMN recommendations.kind IS
    'mcp_server | model | action | note | idea. `idea` is the ideator''s, and '
    'list_past_ideas reads exactly that set as its dedupe ledger.';
