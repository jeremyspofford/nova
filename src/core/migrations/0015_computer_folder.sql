-- Nova Computer hardening (the PR #236 review). A workspace's folder is known by more than its path:
-- the device and inode it had when the person approved it, checked before every mount, copy,
-- digest and reset (a path can be pointed somewhere else; these can't). `git_writable`: the person
-- chose to let commands inside change the project's .git (otherwise it is mounted read-only).
-- A workspace made before this has no identity on record, and Nova won't touch its folder: make it
-- again.
ALTER TABLE computer_workspace ADD COLUMN folder_dev TEXT;
ALTER TABLE computer_workspace ADD COLUMN folder_ino TEXT;
ALTER TABLE computer_workspace ADD COLUMN git_writable INTEGER NOT NULL DEFAULT 0;
