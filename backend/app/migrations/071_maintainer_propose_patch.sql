-- Phase 6a: the maintainer can now do something with what it reads.
--
-- It could read Nova's source since migration 065 and had no way to act on a
-- finding but describe it in prose. `propose_patch` turns a finding into a
-- unified diff on a recommendation card — applied by nobody, which is the
-- point. It is also the cheapest test of whether her code proposals are worth
-- reading, and that answer decides whether the expensive coding lane earns its
-- place.
--
-- Still read-only against the repository: the mount is `:ro`, the grant list
-- holds no write verb, and nothing in the backend applies a patch.
UPDATE agents
   SET allowed_tools = (
         SELECT array_agg(DISTINCT t)
           FROM unnest(allowed_tools || ARRAY['propose_patch']) AS t),
       system_prompt = system_prompt || E'\n\nWhen you find something in the source worth changing, you can propose it: call propose_patch with a unified diff and the reason. Read the file first and quote it exactly — a diff written from memory patches a file that is not there, and the tool will refuse it. Keep each one small enough to review in a sitting. Nothing you propose is applied; the operator reads it and decides, so never describe a change as made.',
       updated_at = now()
 WHERE name = 'maintainer'
   AND allowed_tools IS NOT NULL
   AND NOT ('propose_patch' = ANY(allowed_tools));
