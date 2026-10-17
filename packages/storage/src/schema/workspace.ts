// M4 local project folders and their file index (migration 0014_workspace.sql; docs/06
// project_folder, FR-035). Terminals live only in memory. SQL migrations are authoritative;
// test/schema.test.ts checks them.
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { project } from './chat.ts';
import { source } from './conversation.ts';

/** A folder on the Hub bound to a project; `path` is its real path. */
export const projectFolder = sqliteTable(
  'project_folder',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    path: text('path').notNull(),
    /** What the user chose; the permission profile caps it (FR-190). */
    access: text('access', { enum: ['read', 'write'] })
      .notNull()
      .default('read'),
    includeGlobs: text('include_globs'),
    excludeGlobs: text('exclude_globs'),
    indexStatus: text('index_status', { enum: ['pending', 'indexing', 'ready', 'error'] })
      .notNull()
      .default('pending'),
    fileCount: integer('file_count').notNull().default(0),
    /** Why indexing failed, or a note about what it left out (caps). */
    error: text('error'),
    lastIndexedAt: text('last_indexed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_project_folder_path').on(t.projectId, t.path)],
);

/** One indexed file of a project folder and the file-backed source holding its chunks. */
export const projectFolderFile = sqliteTable(
  'project_folder_file',
  {
    folderId: text('folder_id')
      .notNull()
      .references(() => projectFolder.id, { onDelete: 'cascade' }),
    relPath: text('rel_path').notNull(),
    sourceId: text('source_id')
      .notNull()
      .references(() => source.id),
    size: integer('size').notNull(),
    mtimeMs: integer('mtime_ms').notNull(),
    sha256: text('sha256').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.folderId, t.relPath] }),
    index('idx_project_folder_file_source').on(t.sourceId),
  ],
);
