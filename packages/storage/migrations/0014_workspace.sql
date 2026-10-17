-- 0014 — M4 workspace: local project folders (FR-035) and the index of their files. Mirrors
-- docs/06 project_folder. Terminals (FR-006) live only in memory and die with the Hub, so they
-- have no table; opening and closing one is audited.

-- A folder on the Hub bound to a project. `path` is canonical (its real path). Its text files
-- are indexed into the project's sources, and it is a tool root for the project's chats with
-- `access` capped by the permission profile in force (FR-190). The globs are reserved for
-- per-folder include and exclude rules; the indexer skips ignored and protected paths itself.
CREATE TABLE project_folder (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project (id),
  path TEXT NOT NULL,
  access TEXT NOT NULL DEFAULT 'read' CHECK (access IN ('read', 'write')),
  include_globs TEXT,
  exclude_globs TEXT,
  index_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (index_status IN ('pending', 'indexing', 'ready', 'error')),
  file_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  last_indexed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_project_folder_path ON project_folder (project_id, path);

-- The file index: one row per indexed file, linking it to the file-backed source that holds its
-- chunks (the M2 source index, FR-040), so project chats retrieve folder files like uploaded
-- sources. Size and mtime let a re-index skip unchanged files; the hash detects real changes.
CREATE TABLE project_folder_file (
  folder_id TEXT NOT NULL REFERENCES project_folder (id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source (id),
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (folder_id, rel_path)
);
CREATE INDEX idx_project_folder_file_source ON project_folder_file (source_id);
