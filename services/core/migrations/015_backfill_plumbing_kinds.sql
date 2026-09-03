-- Back-fill the plumbing kinds for history that predates migration 014.
--
-- 014 added messages.kind and started marking approval choreography as
-- 'plumbing' so history_window can leave it out of what the model reads. It
-- marked nothing that already existed: every row written before it defaulted
-- to 'chat', and those are exactly the rows the owner's walk was drowning in.
-- A history window that is mostly "You're approved: …. Please go ahead now." /
-- "[waiting for your approval before continuing]" teaches a small model to
-- pattern-complete an approval it is waiting for instead of calling the tool.
--
-- Every row touched here is recognised by a DETERMINISTIC template the system
-- itself writes, matched whole:
--
--   * the web's continuation after an approve — apps/web/src/lib/consentCard.ts
--     continuationMessage(): `You're approved: ${summary}. Please go ahead now.`
--     The LIKE is anchored at BOTH ends, so only the full template shape
--     matches; an ordinary sentence that happens to start with those words
--     ("You're approved of my plan?") stays 'chat'.
--   * chat.py's PENDING_APPROVAL_NOTE, compared for equality, not matched.
--   * an assistant reply that is TOOL-CALL MARKUP (the 2026-09-03 11:57 walk: a
--     local model wrote `<atem:function_calls>…` as its reply text and it was
--     persisted). chat.py now strips that at the record boundary, but the rows
--     already in the database would keep feeding the model its own XML through
--     history_window until it imitates it again. The tag shape is what matches
--     — prose about "function calls" carries no angle bracket and stays 'chat'.
--
-- Nothing is guessed and nothing is deleted: these rows stay in the transcript
-- the operator reads, exactly as before. Idempotent by construction (each
-- UPDATE only touches kind = 'chat'), so re-running it changes nothing.
--
-- KNOWN AND ACCEPTED (review, 2026-09-03). The markup clause is deliberately
-- coarser than chat.py's live parser, which masks fenced code, inline code and
-- blockquotes: SQL cannot tell a real blob from a reply that EXPLAINED one, so
-- an assistant message quoting `</function_calls>` is marked plumbing here.
-- That costs one historical message its place in the model's context and
-- nothing else — the row is still in the transcript. It also MISSES variants
-- the parser would catch (a bare <invoke …> with no wrapper). Both are
-- one-time under/over-inclusion over rows that already exist; every message
-- written from now on is classified by the parser, not by this LIKE.
UPDATE messages
   SET kind = 'plumbing'
 WHERE role = 'user'
   AND kind = 'chat'
   AND content LIKE 'You''re approved: %. Please go ahead now.';

UPDATE messages
   SET kind = 'plumbing'
 WHERE role = 'assistant'
   AND kind = 'chat'
   AND content = '[waiting for your approval before continuing]';

UPDATE messages
   SET kind = 'plumbing'
 WHERE role = 'assistant'
   AND kind = 'chat'
   AND (content LIKE '%function_calls>%' OR content LIKE '%<tool_call>%');
