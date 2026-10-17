// M5 Code sessions (migration 0018_code.sql; docs/06 "code sessions", FR-061..FR-066, FR-069,
// FR-073). SQL migrations are authoritative; test/schema.test.ts checks them. The Hub's code
// area reads and writes these tables with prepared statements; the symbol index lives in memory.
import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { thread } from './chat.ts';
import { account } from './core.ts';
import { device } from './nodes.ts';
import { projectFolder } from './workspace.ts';

/** Where sessions run; M5 has one built-in `local` environment per account (FR-062). */
export const environment = sqliteTable(
  'environment',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', {
      enum: ['local', 'cloud', 'ssh', 'wsl', 'container', 'vm', 'device'],
    }).notNull(),
    deviceId: text('device_id').references(() => device.id),
    label: text('label').notNull(),
    configJson: text('config_json'),
    repoUrls: text('repo_urls'),
    setupScript: text('setup_script'),
    status: text('status', { enum: ['ok', 'degraded', 'down', 'unknown'] })
      .notNull()
      .default('unknown'),
    statusDetail: text('status_detail'),
    lastCheckAt: text('last_check_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_environment_local').on(t.accountId)],
);

/** A Code session: a `code` thread bound to an environment, a folder and a mode (FR-061). */
export const codeSession = sqliteTable(
  'code_session',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    threadId: text('thread_id')
      .notNull()
      .unique()
      .references(() => thread.id),
    environmentId: text('environment_id').references(() => environment.id),
    folderPath: text('folder_path').notNull(),
    projectFolderId: text('project_folder_id').references(() => projectFolder.id),
    worktreeId: text('worktree_id').references((): AnySQLiteColumn => worktree.id),
    branch: text('branch'),
    permissionMode: text('permission_mode', {
      enum: ['manual', 'accept_edits', 'plan', 'auto', 'bypass'],
    })
      .notNull()
      .default('manual'),
    /** Reserved for a custom profile; built-in profiles follow from the mode. */
    permissionProfileId: text('permission_profile_id'),
    status: text('status', { enum: ['active', 'archived'] })
      .notNull()
      .default('active'),
    pullRequestUrl: text('pull_request_url'),
    ciStatus: text('ci_status'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_code_session_account').on(t.accountId, t.updatedAt)],
);

/** The worktree registry (FR-073): at most 15 active per repository. */
export const worktree = sqliteTable(
  'worktree',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    /** Where the repository lives; NULL is the Hub. */
    deviceId: text('device_id').references(() => device.id),
    name: text('name').notNull(),
    repoPath: text('repo_path').notNull(),
    path: text('path').notNull(),
    branch: text('branch').notNull(),
    sourceBranch: text('source_branch').notNull(),
    leaseSessionId: text('lease_session_id').references((): AnySQLiteColumn => codeSession.id),
    leaseExpiresAt: text('lease_expires_at'),
    status: text('status', { enum: ['active', 'released', 'removed'] })
      .notNull()
      .default('active'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    unique().on(t.deviceId, t.path),
    index('idx_worktree_repo').on(t.deviceId, t.repoPath, t.status),
    uniqueIndex('idx_worktree_hub_path').on(t.path),
  ],
);

/** One changed file of a session in its current review round (FR-064, FR-065). */
export const codeChange = sqliteTable(
  'code_change',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => codeSession.id),
    path: text('path').notNull(),
    changeKind: text('change_kind', { enum: ['add', 'modify', 'delete', 'rename'] }).notNull(),
    oldPath: text('old_path'),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    binary: integer('binary', { mode: 'boolean' }).notNull().default(false),
    /** The file differs from the session's baseline (a pending patch exists). */
    pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
    patchBlobPath: text('patch_blob_path'),
    patchSha256: text('patch_sha256'),
    /** `{hunks, file}`: the round's decided hunks and any whole-file decision. */
    decidedJson: text('decided_json').notNull().default('{"hunks":[],"file":null}'),
    state: text('state', { enum: ['pending', 'accepted', 'rejected', 'partial'] })
      .notNull()
      .default('pending'),
    callId: text('call_id'),
    /** Committed. */
    applied: integer('applied', { mode: 'boolean' }).notNull().default(false),
    reviewedAt: text('reviewed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('idx_code_change_path').on(t.sessionId, t.path)],
);

/** A structured review of a session's diff (FR-069). */
export const codeReview = sqliteTable(
  'code_review',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => codeSession.id),
    status: text('status', { enum: ['running', 'done', 'failed'] })
      .notNull()
      .default('running'),
    modelId: text('model_id'),
    findingsJson: text('findings_json').notNull().default('[]'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => [index('idx_code_review_session').on(t.sessionId, t.createdAt)],
);

/** A comment on a diff line, by the user or from a review finding (FR-065, FR-069). */
export const diffComment = sqliteTable(
  'diff_comment',
  {
    id: text('id').primaryKey(),
    changeId: text('change_id')
      .notNull()
      .references(() => codeChange.id),
    sessionId: text('session_id')
      .notNull()
      .references(() => codeSession.id),
    path: text('path'),
    line: integer('line'),
    side: text('side', { enum: ['old', 'new'] }),
    body: text('body').notNull(),
    author: text('author', { enum: ['user', 'review'] })
      .notNull()
      .default('user'),
    reviewId: text('review_id').references(() => codeReview.id),
    /** When the batch was sent to the agent. */
    submittedAt: text('submitted_at'),
    resolved: integer('resolved', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_diff_comment_session').on(t.sessionId, t.createdAt)],
);
