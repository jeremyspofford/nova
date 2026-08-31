-- web_search joins the action-class table, seeded disposition = 'auto'.
--
-- web_search (app/tools/web_search.py) GETs the bundled, loopback-only SearXNG
-- and returns the top results as text. It is a read: contained (it reaches only
-- the in-network metasearch service, which itself only reads the public web),
-- reversible (it writes nothing), and visible (the call shows in Activity).
-- The owner does not want to approve web reads — migration 008 made exactly
-- that call for fetch_url ("if I ask it about data it should get by searching
-- the internet, I don't want to need to approve that") — and a SEARCH is the
-- other half of that same intent. So it is seeded 'auto', not 'consent'.
--
-- This is REQUIRED, not optional: the kernel (app/policy.py) DENIES a tool with
-- no row here (fail-closed), and the "every registered tool has a row" tripwire
-- (tests/test_action_classes.py) reddens the day a registered tool lands without
-- one — so a new tool is never auto by accident. This is the deliberate row for
-- web_search's arrival.
--
-- risk_tier is descriptive only (audit/UI); 'outward' matches fetch_url's family
-- — it reaches the internet, if only through the search service. earned stays at
-- its default false: this is an owner-directed seeded-auto, NOT a graduated one,
-- so it must never demote itself on a single failure (policy only tracks earned
-- autos). It is fully revocable from Settings -> Autonomy later.
--
-- Idempotent: ON CONFLICT DO NOTHING seeds the row only when it is absent, so a
-- re-application is a no-op and — the reason it is DO NOTHING rather than DO
-- UPDATE — an operator who later revokes web_search to 'consent' in Settings ->
-- Autonomy is never quietly overwritten back to 'auto'.
INSERT INTO action_classes (action_class, risk_tier, disposition) VALUES
    ('web_search', 'outward', 'auto')
ON CONFLICT (action_class) DO NOTHING;
