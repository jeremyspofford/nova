// M6 always-on agents (migration 0020_agents.sql; docs/06 "agents & computers", docs/09 §8,
// FR-079..FR-084, FR-089, FR-090, FR-194, FR-206). SQL migrations are authoritative;
// test/schema.test.ts checks them. `computer_id`, `binding_ref`, `run_id` and `schedule_id` are
// plain TEXT (later tables, or history that outlives what it names).
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { thread } from './chat.ts';
import { account } from './core.ts';
import { goal } from './runs.ts';

/** An always-on agent (FR-079); budgets cap each turn chain (FR-182). */
export const agent = sqliteTable(
  'agent',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    name: text('name').notNull(),
    avatarPath: text('avatar_path'),
    instructions: text('instructions').notNull().default(''),
    status: text('status', { enum: ['active', 'paused', 'stopped'] })
      .notNull()
      .default('active'),
    pauseReason: text('pause_reason', { enum: ['user', 'safety'] }),
    statusDetail: text('status_detail'),
    autonomy: text('autonomy', { enum: ['ask_first', 'standard', 'autonomous'] })
      .notNull()
      .default('standard'),
    model: text('model'),
    computerId: text('computer_id'),
    primaryThreadId: text('primary_thread_id').references(() => thread.id, {
      onDelete: 'set null',
    }),
    proactive: integer('proactive', { mode: 'boolean' }).notNull().default(true),
    memoryEnabled: integer('memory_enabled', { mode: 'boolean' }).notNull().default(true),
    timeBudgetS: integer('time_budget_s').notNull(),
    tokenBudget: integer('token_budget').notNull(),
    costBudgetUsd: real('cost_budget_usd'),
    timeUsedMs: integer('time_used_ms').notNull().default(0),
    tokensUsed: integer('tokens_used').notNull().default(0),
    costUsedUsd: real('cost_used_usd').notNull().default(0),
    lastProactiveAt: text('last_proactive_at'),
    lastActiveAt: text('last_active_at'),
    metadata: text('metadata'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_agent_account').on(t.accountId, t.createdAt)],
);

/** Every thread of an agent: main, proactive research, channel bindings, background runs. */
export const agentThread = sqliteTable(
  'agent_thread',
  {
    threadId: text('thread_id')
      .primaryKey()
      .references(() => thread.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    kind: text('kind', { enum: ['main', 'proactive', 'binding', 'background'] }).notNull(),
    bindingRef: text('binding_ref'),
    audience: text('audience', { enum: ['private', 'shared'] })
      .notNull()
      .default('private'),
    runId: text('run_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_agent_thread_agent').on(t.agentId, t.kind),
    uniqueIndex('uq_agent_thread_binding').on(t.agentId, t.bindingRef),
  ],
);

/** A responsibility, tracked separately; it may hold the agent's open goal (FR-079, FR-181). */
export const agentResponsibility = sqliteTable(
  'agent_responsibility',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    instructions: text('instructions'),
    status: text('status', { enum: ['active', 'paused', 'done'] })
      .notNull()
      .default('active'),
    goalId: text('goal_id').references(() => goal.id, { onDelete: 'set null' }),
    progressNote: text('progress_note'),
    position: integer('position').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_agent_responsibility_agent').on(t.agentId, t.position)],
);

/** A custom rule (FR-084): act, act on request, ask or hand off. */
export const agentRule = sqliteTable(
  'agent_rule',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    matcherJson: text('matcher_json').notNull(),
    commandJson: text('command_json'),
    effect: text('effect', { enum: ['act', 'act_on_request', 'ask', 'handoff'] }).notNull(),
    priority: integer('priority').notNull().default(100),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_agent_rule_agent').on(t.agentId, t.enabled)],
);

/** Notes and learned items (FR-089): visible, editable, forgettable; no hidden notes. */
export const agentMemory = sqliteTable(
  'agent_memory',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['note', 'fact', 'preference', 'observation'] }).notNull(),
    content: text('content').notNull(),
    author: text('author', { enum: ['user', 'agent'] }).notNull(),
    source: text('source', { enum: ['manual', 'tool', 'proactive', 'conversation'] }).notNull(),
    sourceThreadId: text('source_thread_id'),
    responsibilityId: text('responsibility_id').references(() => agentResponsibility.id, {
      onDelete: 'set null',
    }),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    originAudience: text('origin_audience', { enum: ['private', 'shared'] })
      .notNull()
      .default('private'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_agent_memory_agent').on(t.agentId, t.kind, t.updatedAt)],
);

/** A suggestion from proactive research (FR-082); never the user's intent (FR-189). */
export const agentSuggestion = sqliteTable(
  'agent_suggestion',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'cascade' }),
    noteId: text('note_id').references(() => agentMemory.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    status: text('status', { enum: ['open', 'accepted', 'dismissed'] })
      .notNull()
      .default('open'),
    threadId: text('thread_id'),
    turnId: text('turn_id'),
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at'),
  },
  (t) => [index('idx_agent_suggestion_agent').on(t.agentId, t.status, t.createdAt)],
);

/** A self-set wake the agent asked for (FR-206); kept for the per-day limit. */
export const agentWake = sqliteTable(
  'agent_wake',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'cascade' }),
    scheduleId: text('schedule_id'),
    at: text('at').notNull(),
    requestedAt: text('requested_at').notNull(),
    reason: text('reason').notNull(),
    movedByQuietHours: integer('moved_by_quiet_hours', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_agent_wake_agent').on(t.agentId, t.createdAt)],
);

/** An identity the user marked as an external AI agent (FR-194, docs/12 §6.2). */
export const externalAgent = sqliteTable(
  'external_agent',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    address: text('address').notNull(),
    label: text('label'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('external_agent_account_id_address_unique').on(t.accountId, t.address)],
);
