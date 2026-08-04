-- The operator's click, recorded as provenance.
--
-- `mcp_servers.created_by` answers "who wrote this row down" — 'operator' for
-- one typed into Library -> Tools, 'action' for one an approved
-- recommendation installed. Two different controls read it, and they want
-- different questions answered:
--
--   mcp_client._guard_url   may this server dial a PRIVATE address? Reads
--                           created_by, and should keep reading it. A model
--                           choosing the URL is the hazard, and the operator
--                           approving "add this public server" is not a
--                           decision to let it reach his router.
--   read_only_slugs         may its tools run on a turn already carrying
--                           fetched text? This one asked created_by too, and
--                           that was wrong.
--
-- Measured 2026-08-04. The operator approved a card, the executor installed
-- `context7` (read-only, keyless, 2 doc-lookup tools), every step verified —
-- and Nova could not use it. She searched the web, which taints the turn,
-- then reached for the server and the actor fence refused her. The exemption
-- required created_by='operator' so that a MODEL could not declare its own
-- server exempt, which is right; the bug is that it also excluded servers a
-- HUMAN had approved. Nothing recorded that he had.
--
-- So the click gets a column. It authorises the taint exemption and nothing
-- else: egress provenance stays with created_by, so an approved server still
-- cannot reach the LAN.
ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS operator_approved BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN mcp_servers.operator_approved IS
  'The operator approved the recommendation that installed this server. Set '
  'only by actions.mcp_server.execute, which runs only from an approved '
  'card. Grants the read-only taint exemption; deliberately does NOT grant '
  'the private-address egress that created_by=operator does.';
