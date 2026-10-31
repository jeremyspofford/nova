-- Nova Computer hardening (the PR #236 review). A workspace's folder is known by more than its path:
-- the device, inode and birth time it had when the person approved it, checked before every
-- mount, copy, digest and reset (a path can be pointed somewhere else; these can't; the birth time
-- tells a new folder from an old one whose inode number it was given again). `git_writable`: the person
-- chose to let commands inside change the project's .git (otherwise it is mounted read-only).
-- A workspace made before this has no identity on record, and Nova won't touch its folder: it is
-- marked broken, saying so in plain words, so it never shows as ready. Deleting it still works.
ALTER TABLE computer_workspace ADD COLUMN folder_dev TEXT;
ALTER TABLE computer_workspace ADD COLUMN folder_ino TEXT;
ALTER TABLE computer_workspace ADD COLUMN folder_born TEXT;
ALTER TABLE computer_workspace ADD COLUMN git_writable INTEGER NOT NULL DEFAULT 0;
UPDATE computer_workspace SET state = 'broken', detail = 'This workspace was made before Nova checked which folder a workspace has; delete it and make it again.' WHERE state != 'destroyed';
