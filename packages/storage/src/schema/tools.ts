// M3 tool calls and artifacts (migration 0006_tools.sql). SQL migrations are authoritative;
// test/schema.test.ts checks them.
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { message, thread, turn } from './chat.ts';

export const toolCall = sqliteTable(
  'tool_call',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    messageId: text('message_id').references(() => message.id),
    threadId: text('thread_id').references(() => thread.id),
    turnId: text('turn_id').references(() => turn.id),
    runStepId: text('run_step_id'),
    parentCallId: text('parent_call_id').references((): AnySQLiteColumn => toolCall.id),
    /** The id the model gave the call; results go back to the model under it. */
    modelCallId: text('model_call_id'),
    toolName: text('tool_name').notNull(),
    source: text('source', {
      enum: ['builtin', 'mcp', 'plugin', 'computer', 'browser', 'page', 'device'],
    }).notNull(),
    serverId: text('server_id'),
    pluginId: text('plugin_id'),
    // `script`: a nested call of script.run (M8, migration 0051).
    origin: text('origin', { enum: ['model', 'ui', 'hook', 'script', 'mcp_client'] })
      .notNull()
      .default('model'),
    /** Redacted arguments (FR-101). */
    argsJson: text('args_json').notNull(),
    /** Redacted, capped result content as the model saw it. */
    resultJson: text('result_json'),
    error: text('error'),
    status: text('status', {
      enum: [
        'pending',
        'awaiting_approval',
        'running',
        'ok',
        'error',
        'denied',
        'timeout',
        'cancelled',
      ],
    }).notNull(),
    decision: text('decision'),
    approvalId: text('approval_id'),
    tagsJson: text('tags_json'),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    durationMs: integer('duration_ms'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_tool_call_thread').on(t.threadId, t.createdAt),
    index('idx_tool_call_turn').on(t.turnId),
    index('idx_tool_call_message').on(t.messageId),
  ],
);

export const artifact = sqliteTable(
  'artifact',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    threadId: text('thread_id').references(() => thread.id),
    messageId: text('message_id').references(() => message.id),
    runId: text('run_id'),
    kind: text('kind', {
      enum: [
        'markdown',
        'code',
        'html',
        'image',
        'svg',
        'chart',
        'pdf',
        'docx',
        'pptx',
        'xlsx',
        'site',
        'canvas',
        'file',
      ],
    }).notNull(),
    title: text('title'),
    /** Relative to the data directory (docs/06 §3). */
    blobPath: text('blob_path'),
    mime: text('mime'),
    sha256: text('sha256'),
    version: integer('version').notNull().default(1),
    live: integer('live', { mode: 'boolean' }).notNull().default(false),
    metaJson: text('meta_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_artifact_thread').on(t.threadId, t.createdAt)],
);

export const artifactVersion = sqliteTable(
  'artifact_version',
  {
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifact.id),
    version: integer('version').notNull(),
    messageId: text('message_id'),
    blobPath: text('blob_path').notNull(),
    mime: text('mime').notNull(),
    sha256: text('sha256').notNull(),
    size: integer('size').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.version] })],
);
