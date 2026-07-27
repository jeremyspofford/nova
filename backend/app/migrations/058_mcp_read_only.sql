-- An MCP server the operator declares READ-ONLY.
--
-- Under the containment invariant (phase 2) an MCP tool fails CLOSED — it is
-- treated as an ACTOR, because a server can implement literally anything and
-- the backend cannot tell `read_file` from `rm -rf` by its name. Correct, and
-- it makes phase 3 impossible as written: reading a file would be refused on
-- any turn holding a fetched transcript, which is most of them.
--
-- So the operator declares it at registration, and the backend enforces the
-- consequence. A declaration is not a guess: the person who chose to run
-- `@modelcontextprotocol/server-filesystem` with a `:ro` mount knows what it
-- can do, and the kernel is what actually holds the line — this flag only
-- decides whether its tools may run alongside untrusted text.
--
-- Default FALSE: an undeclared server stays an actor.
ALTER TABLE mcp_servers
    ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN mcp_servers.read_only IS
    'Operator declares this server cannot change anything. Its tools then '
    'classify as READERs and survive the untrusted-context fence.';
