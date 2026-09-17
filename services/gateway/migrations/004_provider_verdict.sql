-- S10-pre review fix: the save's verdict is its own state. `listing` /
-- `listing_note` describe what the LAST model listing learned and are
-- rewritten by every listing fetch; the verdict of verify-before-save —
-- was the key proven, and how — must not be, or the page ends up painting
-- "Verified" from a note that has since become "430 models listed".
--   key_proven  true  = the key was accepted (the listing required it, or a
--                       1-token completion answered with a completion)
--               false = a completion was attempted and refused for a reason
--                       other than auth (the key is NOT proven)
--               NULL  = never tested (no auth, no listing to probe, or a
--                       row saved before this column existed)
ALTER TABLE providers ADD COLUMN IF NOT EXISTS key_proven boolean;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS verify_note text;
