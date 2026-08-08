-- Migration 125 (a_notification_lands_in_the_conversation) was EDITED AFTER
-- it was applied. The ledger holds the hash of the text that actually ran:
--
--     applied  3b6793c4a4710b7b9245d94e826cb864a57c8bf807960dce96834bcf023eeaed
--     on disk  4047cbfa9107306d47cd2df94b624435d5833a5234deb44052e0191d11721a75
--
-- and db.py has ERROR-logged the drift on every backend start since. Its own
-- instruction is "write a follow-up migration with the difference" — but the
-- difference here is UNVERIFIABLE: only the hash of the applied text
-- survives, nothing recorded the text itself, so no one can say what the
-- edit changed. The live schema matches the current file in every way that
-- can be checked (the notifications table, its constraints and indexes all
-- exist as 125 now writes them), which is consistent with a comment-level or
-- formatting edit, and with nothing worse being provable either way.
--
-- So this is the minimal honest close-out: re-bless the CURRENT file's hash,
-- conditioned on the drifted one, and leave this file as the permanent
-- record that the drift happened and could not be reconstructed. Conditioned,
-- so a fresh install — where 125 runs from the current text and its ledger
-- row already carries 4047cbfa… — updates nothing. Editing an applied
-- migration remains the disease; this cures the alarm, not the habit.

UPDATE schema_migrations
   SET checksum = '4047cbfa9107306d47cd2df94b624435d5833a5234deb44052e0191d11721a75'
 WHERE filename = '125_a_notification_lands_in_the_conversation.sql'
   AND checksum = '3b6793c4a4710b7b9245d94e826cb864a57c8bf807960dce96834bcf023eeaed';
