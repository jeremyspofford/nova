// Drizzle table definitions. They mirror the SQL in `migrations/`; the SQL is authoritative and
// a test checks that both agree (test/schema.test.ts).
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['local', 'oidc'] }).notNull(),
  displayName: text('display_name'),
  username: text('username'),
  avatarPath: text('avatar_path'),
  email: text('email'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const setting = sqliteTable(
  'setting',
  {
    key: text('key').notNull(),
    scopeKind: text('scope_kind', { enum: ['global', 'project', 'device'] })
      .notNull()
      .default('global'),
    scopeRef: text('scope_ref').notNull().default(''),
    valueJson: text('value_json').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.key, t.scopeKind, t.scopeRef] })],
);

export const event = sqliteTable(
  'event',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    ts: text('ts').notNull(),
    accountId: text('account_id'),
    actor: text('actor').notNull(),
    correlationJson: text('correlation_json'),
    payloadJson: text('payload_json').notNull(),
  },
  (t) => [index('idx_event_ts').on(t.ts), index('idx_event_name').on(t.name, t.ts)],
);

export const featureFlag = sqliteTable('feature_flag', {
  key: text('key').primaryKey(),
  stage: text('stage', {
    enum: ['experimental', 'beta', 'stable', 'deprecated', 'removed'],
  }).notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  updatedAt: text('updated_at').notNull(),
});

export const authToken = sqliteTable('auth_token', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['setup', 'session', 'device', 'mcp_client', 'app'] }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  accountId: text('account_id').references(() => account.id),
  label: text('label'),
  scopes: text('scopes'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at'),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
});

// ---- 0002 chat (M1) ------------------------------------------------------------------------

export const project = sqliteTable('project', {
  id: text('id').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => account.id),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['chat', 'code', 'work'] })
    .notNull()
    .default('chat'),
  instructions: text('instructions'),
  memoryScope: text('memory_scope', { enum: ['shared', 'project_only'] })
    .notNull()
    .default('shared'),
  upstreamProjectRef: text('upstream_project_ref'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const providerAccount = sqliteTable(
  'provider_account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    authKind: text('auth_kind', { enum: ['oauth', 'api_key', 'none'] }).notNull(),
    /** A `secret://` reference only; never the credential (FR-101). */
    secretRef: text('secret_ref'),
    baseUrl: text('base_url'),
    scopes: text('scopes'),
    entitlements: text('entitlements'),
    status: text('status', { enum: ['active', 'expired', 'revoked', 'error'] })
      .notNull()
      .default('active'),
    lastCheckAt: text('last_check_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [index('idx_provider_account_account').on(t.accountId)],
);

export const modelPref = sqliteTable(
  'model_pref',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    alias: text('alias'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    defaultParams: text('default_params'),
    /** Per 1M tokens, informational (docs/07 §11). */
    costIn: real('cost_in'),
    costOut: real('cost_out'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_model_pref_model').on(t.accountId, t.provider, t.modelId)],
);

export const thread = sqliteTable(
  'thread',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    projectId: text('project_id').references(() => project.id),
    mode: text('mode', { enum: ['chat', 'work', 'code', 'agent'] }).notNull(),
    title: text('title'),
    parentThreadId: text('parent_thread_id').references((): AnySQLiteColumn => thread.id),
    branchFromMessageId: text('branch_from_message_id'),
    temporary: integer('temporary', { mode: 'boolean' }).notNull().default(false),
    /** A model ref, `<providerAccountId>/<modelId>`. */
    modelId: text('model_id'),
    reasoningLevel: text('reasoning_level'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    unread: integer('unread', { mode: 'boolean' }).notNull().default(false),
    state: text('state', {
      enum: ['idle', 'streaming', 'waiting_approval', 'waiting_input', 'error'],
    })
      .notNull()
      .default('idle'),
    inputMode: text('input_mode', { enum: ['steer', 'queue'] })
      .notNull()
      .default('steer'),
    metadata: text('metadata'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    index('idx_thread_account_mode').on(t.accountId, t.mode, t.updatedAt),
    index('idx_thread_project').on(t.projectId),
  ],
);

export const turn = sqliteTable('turn', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => thread.id),
  idx: integer('idx').notNull(),
  status: text('status', { enum: ['in_progress', 'completed', 'interrupted', 'failed'] })
    .notNull()
    .default('in_progress'),
  trigger: text('trigger', { enum: ['user', 'schedule', 'goal', 'hook', 'event', 'channel'] })
    .notNull()
    .default('user'),
  triggerRef: text('trigger_ref'),
  // run and goal tables arrive in M4; plain columns until then.
  runId: text('run_id'),
  goalId: text('goal_id'),
  executionLocation: text('execution_location').notNull(),
  modelId: text('model_id'),
  reasoningLevel: text('reasoning_level'),
  stepCount: integer('step_count').notNull().default(0),
  stopReason: text('stop_reason', {
    enum: ['end', 'budget', 'backstop', 'cancelled', 'approval_timeout', 'location_lost', 'error'],
  }),
  usageJson: text('usage_json'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const message = sqliteTable(
  'message',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id),
    turnId: text('turn_id').references(() => turn.id),
    role: text('role', { enum: ['system', 'user', 'assistant', 'tool', 'summary'] }).notNull(),
    authorKind: text('author_kind'),
    provenance: text('provenance', {
      enum: ['typed', 'pasted', 'tool', 'channel', 'capture', 'import'],
    })
      .notNull()
      .default('typed'),
    status: text('status', { enum: ['streaming', 'complete', 'incomplete', 'error'] })
      .notNull()
      .default('complete'),
    modelId: text('model_id'),
    provider: text('provider'),
    usageJson: text('usage_json'),
    costUsd: real('cost_usd'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    index('idx_message_thread').on(t.threadId, t.createdAt),
    index('idx_message_turn').on(t.turnId),
  ],
);

export const messagePart = sqliteTable(
  'message_part',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => message.id),
    idx: integer('idx').notNull(),
    type: text('type').notNull(),
    content: text('content'),
    refId: text('ref_id'),
    mime: text('mime'),
    blobPath: text('blob_path'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_message_part_message').on(t.messageId, t.idx)],
);

export const attachment = sqliteTable(
  'attachment',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').references(() => message.id),
    threadId: text('thread_id').references(() => thread.id),
    name: text('name').notNull(),
    mime: text('mime'),
    size: integer('size'),
    sha256: text('sha256'),
    origin: text('origin', { enum: ['upload', 'window_capture', 'dictation', 'import'] })
      .notNull()
      .default('upload'),
    /** Relative to the data directory: `blobs/attachments/<sha256>` (docs/06 §3). */
    blobPath: text('blob_path').notNull(),
    extractedTextPath: text('extracted_text_path'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_attachment_message').on(t.messageId)],
);

export const usageEvent = sqliteTable(
  'usage_event',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    provider: text('provider'),
    model: text('model'),
    threadId: text('thread_id'),
    turnId: text('turn_id'),
    runId: text('run_id'),
    goalId: text('goal_id'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedTokens: integer('cached_tokens'),
    costUsd: real('cost_usd'),
    latencyMs: integer('latency_ms'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_usage_event_account').on(t.accountId, t.createdAt)],
);

/** Search rows behind the `message_fts` FTS5 index; maintained by triggers (0002_chat.sql). */
export const messageSearch = sqliteTable('message_search', {
  seq: integer('seq').primaryKey(),
  partId: text('part_id').notNull().unique(),
  messageId: text('message_id').notNull(),
  text: text('text').notNull(),
});
