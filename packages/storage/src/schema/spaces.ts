// M6 Spaces and Pages (FR-036) and Sites (FR-037) (migration 0026_spaces.sql). SQL migrations are
// authoritative; test/schema.test.ts checks them. A site names its source (a space or an artifact)
// and its data sources by plain TEXT ids: a site outlives what it was built from.
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { project } from './chat.ts';
import { account } from './core.ts';

const AUTHOR = ['user', 'agent'] as const;

/** A space of pages the user and agents co-edit (FR-036). */
export const space = sqliteTable(
  'space',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    projectId: text('project_id').references(() => project.id),
    name: text('name').notNull(),
    description: text('description'),
    agentEdits: text('agent_edits', { enum: ['propose', 'direct'] })
      .notNull()
      .default('propose'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [index('idx_space_account').on(t.accountId, t.updatedAt)],
);

/** A Markdown page; the row keeps the current version's text. */
export const spacePage = sqliteTable(
  'space_page',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    position: integer('position').notNull().default(0),
    version: integer('version').notNull().default(1),
    content: text('content').notNull(),
    updatedBy: text('updated_by', { enum: AUTHOR }).notNull().default('user'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    index('idx_space_page_space').on(t.spaceId, t.position),
    uniqueIndex('idx_space_page_slug').on(t.spaceId, t.slug),
  ],
);

/** Every version of a page (FR-036). */
export const spacePageVersion = sqliteTable(
  'space_page_version',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => spacePage.id),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    authorKind: text('author_kind', { enum: AUTHOR }).notNull(),
    authorRef: text('author_ref'),
    turnId: text('turn_id'),
    summary: text('summary'),
    restoredFrom: integer('restored_from'),
    proposalId: text('proposal_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.version] })],
);

/** A comment anchored to the page, a range or a block. */
export const spaceComment = sqliteTable(
  'space_comment',
  {
    id: text('id').primaryKey(),
    pageId: text('page_id')
      .notNull()
      .references(() => spacePage.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    parentId: text('parent_id'),
    authorKind: text('author_kind', { enum: AUTHOR }).notNull(),
    authorRef: text('author_ref'),
    body: text('body').notNull(),
    anchorJson: text('anchor_json').notNull(),
    version: integer('version').notNull(),
    detached: integer('detached', { mode: 'boolean' }).notNull().default(false),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [index('idx_space_comment_page').on(t.pageId, t.createdAt)],
);

/** An agent's edit (or new page) waiting for the user. */
export const spaceProposal = sqliteTable(
  'space_proposal',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id),
    pageId: text('page_id').references(() => spacePage.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    baseVersion: integer('base_version'),
    title: text('title').notNull(),
    content: text('content').notNull(),
    summary: text('summary'),
    authorRef: text('author_ref'),
    turnId: text('turn_id'),
    status: text('status', { enum: ['open', 'accepted', 'rejected'] })
      .notNull()
      .default('open'),
    decidedAt: text('decided_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_space_proposal_space').on(t.spaceId, t.status)],
);

/** A static site built from a space or an artifact (FR-037). */
export const site = sqliteTable(
  'site',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    name: text('name').notNull(),
    description: text('description'),
    sourceKind: text('source_kind', { enum: ['space', 'artifact'] }).notNull(),
    sourceRef: text('source_ref').notNull(),
    dataJson: text('data_json').notNull().default('[]'),
    latestVersion: integer('latest_version'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [index('idx_site_account').on(t.accountId, t.updatedAt)],
);

/** A built version: a zip blob and the one-document preview. */
export const siteVersion = sqliteTable(
  'site_version',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => site.id),
    version: integer('version').notNull(),
    note: text('note'),
    blobPath: text('blob_path').notNull(),
    sha256: text('sha256').notNull(),
    size: integer('size').notNull(),
    filesJson: text('files_json').notNull(),
    previewBlobPath: text('preview_blob_path').notNull(),
    scripts: integer('scripts', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.version] })],
);

/** A publish; the live one is the newest not reverted. */
export const sitePublish = sqliteTable(
  'site_publish',
  {
    id: text('id').primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => site.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    version: integer('version').notNull(),
    targetKind: text('target_kind', { enum: ['folder', 'zip'] }).notNull(),
    targetRef: text('target_ref'),
    revertedAt: text('reverted_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_site_publish_site').on(t.siteId, t.createdAt)],
);
