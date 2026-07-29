-- Narrow the maintainer's source access from a wildcard to named readers.
--
-- `mcp:nova-src:*` resolved to all FOURTEEN tools the reference filesystem
-- server implements, four of which write: create_directory, edit_file,
-- move_file, write_file. They would every one of them fail — the repo is
-- mounted `:ro` and the kernel refuses — but offering them is wrong twice
-- over. It spends context on definitions of things that cannot work, and it
-- invites the model to attempt an edit and then describe having made one,
-- which is precisely the narration failure this codebase keeps building
-- detectors for. A capability that always fails is worse than an absent one:
-- absent is legible.
--
-- Also worth recording, because it is a genuine sharp edge in the fence
-- rather than a fact about this agent: `read_only` on an MCP server is an
-- OPERATOR DECLARATION, and it makes every tool on that server classify as a
-- READER under the phase-2 untrusted-context check. nova-src is declared
-- read-only and genuinely is — the mount, not the declaration, is what makes
-- it true. If that mount ever became writable, the declaration would quietly
-- turn four ACTOR verbs into READERs. Naming the four read verbs here means
-- this agent does not depend on that declaration staying honest.

UPDATE agents
   SET allowed_tools = ARRAY[
         'mcp:nova-src/read_text_file',
         'mcp:nova-src/read_multiple_files',
         'mcp:nova-src/list_directory',
         'mcp:nova-src/directory_tree',
         'mcp:nova-src/search_files',
         'mcp:nova-src/get_file_info',
         'mcp:nova-src/list_allowed_directories',
         'search_memory', 'read_memory_item', 'list_memory'],
       updated_at = now()
 WHERE name = 'maintainer';
