-- Phase 4's finding: a workload that needs anything from the network cannot
-- function, and she had no way to ask. Default-deny was working exactly as
-- built; what was missing was the exception path.
--
-- Two verbs, not one, and the split is the control. The approval card is
-- composed from a goal's VERBS, so a single `allow_egress` would mean the
-- operator approving "fetch from pypi" was also approving "reach my router",
-- with nothing on the card to tell him. Separate verbs make the card state
-- which decision he is making.
UPDATE agents
   SET allowed_tools = (
         SELECT array_agg(DISTINCT t)
           FROM unnest(allowed_tools || ARRAY['allow_internet_egress',
                                              'allow_host_egress',
                                              'list_egress']) AS t),
       updated_at = now()
 WHERE name = 'deployer' AND allowed_tools IS NOT NULL;

-- and the read half to main, so "why can't it reach anything" is answerable
-- without a dispatch
UPDATE agents
   SET allowed_tools = (
         SELECT array_agg(DISTINCT t)
           FROM unnest(allowed_tools || ARRAY['list_egress']) AS t),
       updated_at = now()
 WHERE name = 'main' AND allowed_tools IS NOT NULL;

UPDATE agents
   SET system_prompt = system_prompt || E'\n\nEgress is denied by default in your namespace. If a workload cannot reach something, that is usually why — check list_egress before assuming the service is broken. allow_internet_egress opens the public internet; allow_host_egress opens one address on the operator''s own network and needs an IP or CIDR, never a hostname. Both are grants the operator approves once and only he can revoke, so ask for the narrower one.',
       updated_at = now()
 WHERE name = 'deployer'
   AND system_prompt NOT LIKE '%allow_internet_egress%';
