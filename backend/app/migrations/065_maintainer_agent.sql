-- Phase 1 of docs/plans/capability-acquisition.md: the agent that owns
-- "change something about Nova herself", and therefore owns the read-only
-- source mount.
--
-- The mount and the `nova-src` MCP server were built and proven in
-- containment phase 3, then deliberately granted to NOTHING. The grant had
-- gone to `main`, which put seven filesystem tool definitions (~1,160 tokens)
-- on every conversational turn so Nova could browse Python she has no reason
-- to read. Jeremy's correction, recorded in capability-and-containment.md:
-- reading Nova's own source is for work that TARGETS Nova's own source, and
-- capability goes to the agent whose job needs it, never to `main` because
-- `main` is convenient.
--
-- So this creates that agent rather than re-granting to main. Dispatch pays
-- the token cost only on turns that need it, which is the same trade every
-- other specialist makes.
--
-- READ-ONLY BY CONSTRUCTION, three times over: the mount is `:ro`, the server
-- is declared read_only (so its tools classify as READERs under the phase-2
-- fence rather than ACTORs), and the grant list below contains no verb that
-- writes anything. Proposing a change is phase 2 and lands in the
-- recommendations inbox; nothing here can edit a file.

INSERT INTO agents (name, description, system_prompt, model,
                    allowed_tools, routing_keywords, is_system)
VALUES (
  'maintainer',
  'Reads Nova''s own source code to answer questions about how she works, why something behaves the way it does, and where a thing is implemented. Dispatch here for questions about Nova''s implementation, her codebase, a specific file or function, or why one of her own features does what it does. Read-only: it cannot change anything.',
  'You are the Maintainer. You read Nova''s own source and answer from it.

Your value is that you answer from CODE, not from memory. Recalled notes describe what was true when they were written; the repository is what is true now. When a journal and a file disagree, the file wins and you say so.

How you work:
1. Find the relevant file. `docs/` and ROADMAP.md explain intent; `backend/app/` and `frontend/src/` are the implementation.
2. Read it. Quote the lines that actually answer the question, with their path — `backend/app/agents/runner.py:1129` is checkable, "the runner handles this" is not.
3. Answer the question that was asked. Your reader is Nova, relaying to the operator: be dense, skip pleasantries.

What you must not do:
- Do not guess at code you have not opened. "I did not find it" is a complete answer, and a better one than a plausible file path that does not exist.
- Do not describe a change as made. You cannot write, edit, or run anything — you have read access and nothing else. If a change is warranted, describe it precisely enough for someone else to make it, and say that it has not been made.
- Some files are outside your mount by design (`.env`, `data/`, `.git`). If a question needs one of those, say which and stop.

You have a large file to read and a limited window. Prefer reading one file properly over skimming five.',
  (SELECT model FROM agents WHERE name = 'model-manager'),
  ARRAY['mcp:nova-src:*','search_memory','read_memory_item','list_memory'],
  ARRAY['code','codebase','source','implementation','function','file','repo',
        'runner','backend','frontend','how does she','why does she','module'],
  true)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  system_prompt = EXCLUDED.system_prompt,
  allowed_tools = EXCLUDED.allowed_tools,
  routing_keywords = EXCLUDED.routing_keywords,
  is_system = EXCLUDED.is_system,
  updated_at = now();

-- The `coder` row: deleted, not repurposed.
--
-- Verified live during the containment audit and again 2026-07-29:
-- enabled=false, allowed_tools={db:*} — which resolves to exactly two
-- http_call tools, get-weather and github-profile-fetch — while its system
-- prompt promises "File System Operations — Read, write, and edit files" and
-- a git commit loop. It is in main's dispatch index and dispatch_to_agent has
-- no target allowlist, so its only possible output was confident fiction
-- about work it never did: the exact failure the narration detector exists
-- for, seeded into the agent table.
--
-- The ACP lane (docs/plans/acp-coding-delegation.md) will introduce a real
-- one whose grants match its prompt. A placeholder that lies in the meantime
-- costs more than the row it saves.
DELETE FROM agents WHERE name = 'coder' AND is_system = false;
