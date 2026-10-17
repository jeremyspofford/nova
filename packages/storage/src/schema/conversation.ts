// M2 conversation tables (0004_conversation): queued follow-ups, project sources and their
// chunks, citations and memory items. SQL migrations are authoritative; test/schema.test.ts
// checks them. The FTS5 tables (source_chunk_fts, memory_fts) are maintained by triggers.
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { message, project, thread } from './chat.ts';

/** Input sent in `queue` mode while a turn runs (FR-019); `id` becomes its user message id. */
export const queuedInput = sqliteTable(
  'queued_input',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    text: text('text').notNull(),
    /** JSON list of stored blobs: `{name, mime, size, sha256, blobPath}`. */
    attachments: text('attachments'),
    model: text('model'),
    reasoningLevel: text('reasoning_level'),
    status: text('status', { enum: ['pending', 'started', 'cancelled'] })
      .notNull()
      .default('pending'),
    /** The turn it started, once started. */
    turnId: text('turn_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_queued_input_pending').on(t.threadId, t.createdAt)],
);

/** A project source (FR-040); its content is a blob, its text is indexed into chunks. */
export const source = sqliteTable(
  'source',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    projectId: text('project_id')
      .notNull()
      .references(() => project.id),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    /** Relative to the data directory (docs/06 §3). */
    blobPath: text('blob_path').notNull(),
    status: text('status', { enum: ['pending', 'indexing', 'ready', 'error'] })
      .notNull()
      .default('pending'),
    error: text('error'),
    chunkCount: integer('chunk_count').notNull().default(0),
    indexedAt: text('indexed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [index('idx_source_project').on(t.projectId, t.status)],
);

/** Rows behind the `source_chunk_fts` FTS5 index. */
export const sourceChunk = sqliteTable(
  'source_chunk',
  {
    seq: integer('seq').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => source.id),
    idx: integer('idx').notNull(),
    text: text('text').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_source_chunk_source').on(t.sourceId, t.idx)],
);

/** A source used in an answer (docs/06 citation). */
export const citation = sqliteTable(
  'citation',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => message.id),
    idx: integer('idx'),
    url: text('url'),
    sourceId: text('source_id'),
    title: text('title'),
    snippet: text('snippet'),
    retrievedAt: text('retrieved_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_citation_message').on(t.messageId, t.idx)],
);

/** Canonical, reviewable memory (FR-032, ADR-069). */
export const memoryItem = sqliteTable(
  'memory_item',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    scopeKind: text('scope_kind', { enum: ['global', 'project', 'thread', 'agent'] }).notNull(),
    scopeRef: text('scope_ref'),
    content: text('content').notNull(),
    /** Normalized content; duplicates within a scope are skipped. */
    contentKey: text('content_key').notNull(),
    kind: text('kind'),
    category: text('category'),
    confidence: real('confidence'),
    asOf: text('as_of'),
    validUntil: text('valid_until'),
    sourceKind: text('source_kind', {
      enum: ['chat', 'consolidation', 'import', 'ambient', 'manual'],
    })
      .notNull()
      .default('chat'),
    sourceThreadId: text('source_thread_id'),
    sourceMessageId: text('source_message_id'),
    originAudience: text('origin_audience', { enum: ['private', 'shared'] })
      .notNull()
      .default('private'),
    consolidationRunId: text('consolidation_run_id'),
    supersedesId: text('supersedes_id').references((): AnySQLiteColumn => memoryItem.id),
    status: text('status', { enum: ['active', 'dismissed'] })
      .notNull()
      .default('active'),
    userEdited: integer('user_edited', { mode: 'boolean' }).notNull().default(false),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_memory_scope').on(t.accountId, t.scopeKind, t.scopeRef, t.status),
    index('idx_memory_key').on(t.accountId, t.scopeKind, t.scopeRef, t.contentKey),
  ],
);
