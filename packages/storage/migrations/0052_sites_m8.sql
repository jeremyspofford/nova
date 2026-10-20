-- 0052 — M8 sites carry-ins (FR-037; ADR-097): remote hosting targets a site version can be
-- published to, besides the Hub's own folder and a zip download. A target's password or token
-- lives in the vault; the row keeps only its `secret://` reference. All timestamps UTC ISO-8601.

-- A WebDAV collection site folders are uploaded into (`<url><folder>/`), with the address
-- visitors use when it differs. Soft-deleted, so old publishes keep naming it.
CREATE TABLE site_target (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  kind TEXT NOT NULL CHECK (kind IN ('webdav')),
  -- The collection, ending in '/': https, or http only to this machine.
  url TEXT NOT NULL,
  -- Where visitors see the folders, ending in '/'; NULL when it is not known.
  public_url TEXT,
  auth TEXT NOT NULL CHECK (auth IN ('none', 'basic', 'bearer')),
  username TEXT,
  -- The vault entry of the password or token; NULL without one.
  secret_ref TEXT,
  -- The last connection check: when, whether it passed, and why not (a HostingProblem).
  checked_at TEXT,
  check_ok INTEGER,
  check_reason TEXT,
  check_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK ((auth = 'none') = (secret_ref IS NULL)),
  CHECK ((auth = 'basic') = (username IS NOT NULL))
);
CREATE INDEX idx_site_target_account ON site_target (account_id, created_at);

-- `site_publish` gains remote publishes: `target_kind` `remote` names the target (`target_id`)
-- and the folder on it (`target_ref`). SQLite cannot change a CHECK constraint, so the table is
-- rebuilt; nothing references it by foreign key. Rows keep their order (the live publish is the
-- newest by `created_at`, then `rowid`).
CREATE TABLE site_publish_new (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES site (id),
  account_id TEXT NOT NULL REFERENCES account (id),
  version INTEGER NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('folder', 'zip', 'remote')),
  -- The folder name under the publish root or on the remote target; NULL for a zip.
  target_ref TEXT,
  -- The remote target; NULL for a folder on the Hub or a zip.
  target_id TEXT REFERENCES site_target (id),
  reverted_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((target_kind = 'zip') = (target_ref IS NULL)),
  CHECK ((target_kind = 'remote') = (target_id IS NOT NULL))
);
INSERT INTO site_publish_new (id, site_id, account_id, version, target_kind, target_ref,
    reverted_at, created_at)
  SELECT id, site_id, account_id, version, target_kind, target_ref, reverted_at, created_at
  FROM site_publish ORDER BY rowid;
DROP TABLE site_publish;
ALTER TABLE site_publish_new RENAME TO site_publish;
CREATE INDEX idx_site_publish_site ON site_publish (site_id, created_at);
