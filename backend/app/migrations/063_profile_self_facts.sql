-- What an assistant obviously needs to know about the person it serves, and
-- has nowhere to put today. `user_profiles` carries a name and a free-text
-- persona_notes, so "call me Jer" and "they/them" can only ever be prose that
-- nothing can query and nothing can notice the absence of.
--
-- Both columns are NULLABLE on purpose, and that is the load-bearing part.
-- NULL is the signal `_identity_block` reads to say "you do not know this"
-- out loud, and it is the same NULL the fill-blanks write refuses to
-- overwrite. A default would erase the very gap the capture path exists to
-- notice, and a gap she is not told about is one she fills with invention.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS preferred_name text;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS pronouns text;
