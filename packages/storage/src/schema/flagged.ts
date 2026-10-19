// M7 flagged features (migration 0038_flagged.sql): script runs (FR-202), external agent adapters
// and their delegations (FR-203). SQL migrations are authoritative; test/schema.test.ts checks them.
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { thread } from './chat.ts';

/** One `script.run` call; its id is the tool call's, and nested calls name it as their parent. */
export const scriptRun = sqliteTable(
  'script_run',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    threadId: text('thread_id').references(() => thread.id),
    turnId: text('turn_id'),
    codeSha256: text('code_sha256').notNull(),
    status: text('status', { enum: ['running', 'ok', 'error', 'cancelled'] }).notNull(),
    errorCode: text('error_code'),
    calls: integer('calls').notNull().default(0),
    cpuMs: integer('cpu_ms').notNull().default(0),
    createdAt: text('created_at').notNull(),
    endedAt: text('ended_at'),
  },
  (t) => [index('idx_script_run_thread').on(t.threadId, t.createdAt)],
);

/** An external coding agent speaking the Agent Client Protocol on stdio (FR-203). */
export const agentAdapter = sqliteTable(
  'agent_adapter',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    name: text('name').notNull(),
    command: text('command').notNull(),
    argsJson: text('args_json').notNull().default('[]'),
    /** `secret://` references only. */
    envJson: text('env_json').notNull().default('{}'),
    networkJson: text('network_json').notNull().default('[]'),
    permissionRouting: text('permission_routing', { enum: ['client'] }).notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastCheckJson: text('last_check_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  // One live adapter per name in an account; a deleted one frees its name.
  (t) => [
    uniqueIndex('idx_agent_adapter_name')
      .on(t.accountId, t.name)
      .where(sql`deleted_at IS NULL`),
  ],
);

/** One task a Code session delegated to an adapter. */
export const agentDelegation = sqliteTable(
  'agent_delegation',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id),
    adapterId: text('adapter_id')
      .notNull()
      .references(() => agentAdapter.id),
    status: text('status', {
      enum: ['starting', 'running', 'completed', 'failed', 'cancelled'],
    }).notNull(),
    prompt: text('prompt').notNull(),
    output: text('output'),
    stopReason: text('stop_reason'),
    error: text('error'),
    agentJson: text('agent_json'),
    permissionRequests: integer('permission_requests').notNull().default(0),
    operations: integer('operations').notNull().default(0),
    createdAt: text('created_at').notNull(),
    endedAt: text('ended_at'),
  },
  (t) => [index('idx_agent_delegation_thread').on(t.threadId, t.createdAt)],
);
