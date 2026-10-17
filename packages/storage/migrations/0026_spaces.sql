-- 0026 — M6 Spaces and Pages (FR-036) and Sites (FR-037). All timestamps UTC ISO-8601, ids UUIDv7.
-- Every save of a page is a version; the page row keeps the current text so lists and reads need
-- no join. A site names its source (a space or an artifact) and its data sources by plain TEXT
-- ids: a site outlives what it was built from. Built versions are zip blobs (encrypted at rest,
-- ADR-090); the live publish is the newest `site_publish` row that is not reverted.

CREATE TABLE space (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  project_id TEXT REFERENCES project (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  -- How agent edits land: proposals the user accepts, or direct versions (FR-036).
  agent_edits TEXT NOT NULL DEFAULT 'propose' CHECK (agent_edits IN ('propose', 'direct')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_space_account ON space (account_id, updated_at);

CREATE TABLE space_page (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES space (id),
  account_id TEXT NOT NULL REFERENCES account (id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- The page's file name in a generated site.
  slug TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  -- The current version and its text (also stored in space_page_version).
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  content TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'user' CHECK (updated_by IN ('user', 'agent')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_space_page_space ON space_page (space_id, position);
CREATE UNIQUE INDEX idx_space_page_slug ON space_page (space_id, slug) WHERE deleted_at IS NULL;

-- Every version of a page; a restore or an accepted proposal is a new version that says so.
CREATE TABLE space_page_version (
  page_id TEXT NOT NULL REFERENCES space_page (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent')),
  -- An agent edit's thread and turn (its provenance); NULL for the user.
  author_ref TEXT,
  turn_id TEXT,
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 500),
  restored_from INTEGER,
  proposal_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (page_id, version)
);

-- Comments anchored to the page, a text range or a block; anchors move forward on every save and
-- a comment whose text is gone is marked detached.
CREATE TABLE space_comment (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES space_page (id),
  account_id TEXT NOT NULL REFERENCES account (id),
  parent_id TEXT REFERENCES space_comment (id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent')),
  author_ref TEXT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  -- {kind: page} | {kind: range, start, end, quote} | {kind: block, index, quote}
  anchor_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  detached INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_space_comment_page ON space_comment (page_id, created_at);

-- An agent's edit waiting for the user (the space's agent_edits is 'propose'). A NULL page_id
-- proposes a new page.
CREATE TABLE space_proposal (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES space (id),
  page_id TEXT REFERENCES space_page (id),
  account_id TEXT NOT NULL REFERENCES account (id),
  base_version INTEGER,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content TEXT NOT NULL,
  summary TEXT CHECK (summary IS NULL OR length(summary) <= 500),
  author_ref TEXT,
  turn_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  decided_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((page_id IS NULL) = (base_version IS NULL))
);
CREATE INDEX idx_space_proposal_space ON space_proposal (space_id, status);

CREATE TABLE site (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('space', 'artifact')),
  source_ref TEXT NOT NULL,
  -- JSON array of {sourceId, name}: project sources copied in as data/<name>.json.
  data_json TEXT NOT NULL DEFAULT '[]',
  latest_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_site_account ON site (account_id, updated_at);

-- A built version: the site's files as one zip blob, and the single-document preview.
CREATE TABLE site_version (
  site_id TEXT NOT NULL REFERENCES site (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  blob_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  -- JSON array of {path, size}.
  files_json TEXT NOT NULL,
  preview_blob_path TEXT NOT NULL,
  -- Whether the preview may run the page's own scripts (an HTML artifact's), never same-origin.
  scripts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, version)
);

-- Publishes, newest last; an unpublish reverts the live one and the previous one is live again.
CREATE TABLE site_publish (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES site (id),
  account_id TEXT NOT NULL REFERENCES account (id),
  version INTEGER NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('folder', 'zip')),
  -- The folder name under the publish root; NULL for a zip.
  target_ref TEXT,
  reverted_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((target_kind = 'folder') = (target_ref IS NOT NULL))
);
CREATE INDEX idx_site_publish_site ON site_publish (site_id, created_at);
