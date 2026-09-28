-- The Jev Router switch (docs/plans/rebuild/decision-role/spec.md §4): an edit
-- to a role's chain, which stays the one source of truth. Whether the switch
-- is ON is never stored. It is read off the role's EFFECTIVE chain — the chat
-- model core passes for it (link 1 of the turns that send chat.model), then
-- its stored chain — as whether the cloud slot, the first link that is Jev
-- Router or on a cloud provider, holds a `typesafe/jev-router` link. What is
-- stored is the one thing the chain cannot say after the edit: the cloud link
-- the router replaced, so switching off puts it back, and where it was.
--
--   router_kept        NULL  nothing kept
--                      ''    on, and it replaced nothing (added after the local links)
--                      text  the link it replaced, as provider:model
--   router_kept_slot   'chain'       the router sits in the stored chain
--                      'chat_model'  the router is the chat model (core writes that)
--
-- The two are set and cleared together. Idempotent (007's rule): DROP-then-ADD.
ALTER TABLE routes ADD COLUMN IF NOT EXISTS router_kept text;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS router_kept_slot text;
ALTER TABLE routes DROP CONSTRAINT IF EXISTS routes_router_kept_slot_check;
ALTER TABLE routes ADD CONSTRAINT routes_router_kept_slot_check
    CHECK (router_kept_slot IN ('chain', 'chat_model'));
ALTER TABLE routes DROP CONSTRAINT IF EXISTS routes_router_kept_pair_check;
ALTER TABLE routes ADD CONSTRAINT routes_router_kept_pair_check
    CHECK ((router_kept IS NULL) = (router_kept_slot IS NULL));
