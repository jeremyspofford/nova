// M3 policy and approvals (0007_policy; docs/06 §2): policy and command rules, permission
// profiles, approvals, grants and per-tool defaults. SQL migrations are authoritative;
// test/schema.test.ts checks them.
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';

/** Tool and resource rules (contracts/schemas/policy-rule.json); `actionMatch` is its `match`. */
export const policyRule = sqliteTable(
  'policy_rule',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    scopeKind: text('scope_kind', {
      enum: ['global', 'project', 'thread', 'run', 'session', 'agent', 'tool', 'plugin', 'site'],
    }).notNull(),
    scopeRef: text('scope_ref'),
    /** JSON matcher: tool globs, sources, resource, effect classes, readOnly. */
    actionMatch: text('action_match').notNull(),
    effect: text('effect', { enum: ['allow', 'ask', 'handoff', 'deny'] }).notNull(),
    label: text('label'),
    priority: integer('priority').notNull().default(100),
    source: text('source', { enum: ['user', 'managed', 'plugin'] })
      .notNull()
      .default('user'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_policy_rule_account').on(t.accountId, t.enabled)],
);

/** Command prefix rules (FR-191, contracts/schemas/command-rule.json). */
export const commandRule = sqliteTable(
  'command_rule',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    scopeKind: text('scope_kind', {
      enum: ['global', 'project', 'thread', 'session', 'agent'],
    }).notNull(),
    scopeRef: text('scope_ref'),
    /** JSON token prefix: each element a literal or a list of alternatives. */
    patternJson: text('pattern_json').notNull(),
    toolsJson: text('tools_json').notNull().default('["exec.run"]'),
    decision: text('decision', { enum: ['allow', 'ask', 'deny'] }).notNull(),
    priority: integer('priority').notNull().default(100),
    hostExecutablesJson: text('host_executables_json'),
    justification: text('justification'),
    matchExamplesJson: text('match_examples_json').notNull(),
    notMatchExamplesJson: text('not_match_examples_json').notNull(),
    source: text('source', { enum: ['user', 'managed', 'plugin'] }).notNull(),
    pluginId: text('plugin_id'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('idx_command_rule_account').on(t.accountId, t.enabled)],
);

/** User and managed permission profiles; the built-ins live in packages/policy (FR-190). */
export const permissionProfile = sqliteTable('permission_profile', {
  id: text('id').primaryKey(),
  accountId: text('account_id').references(() => account.id),
  name: text('name').notNull(),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  /** Id of the profile it extends (a built-in id or a row id). */
  extends: text('extends'),
  /** JSON `[{path, access}]`; paths may be tokens (:project, :tmp, :minimal, :home). */
  fsRulesJson: text('fs_rules_json').notNull(),
  networkJson: text('network_json').notNull(),
  requiresSubstrate: text('requires_substrate', { enum: ['vm_or_container'] }),
  source: text('source', { enum: ['builtin', 'user', 'managed'] })
    .notNull()
    .default('user'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const APPROVAL_STATUSES = ['pending', 'decided', 'expired', 'cancelled'] as const;
export const APPROVAL_DECISION_VALUES = [
  'allow_once',
  'allow_session',
  'allow_always',
  'deny_continue',
  'deny_stop',
  'handoff',
  'timeout',
] as const;

/**
 * An `ask` waiting for or answered by the user (FR-100). A handed-off approval stays `pending`
 * with decision 'handoff' until the step is marked done.
 */
export const approval = sqliteTable(
  'approval',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    toolCallId: text('tool_call_id'),
    threadId: text('thread_id'),
    turnId: text('turn_id'),
    runId: text('run_id'),
    agentId: text('agent_id'),
    toolName: text('tool_name'),
    requestedAction: text('requested_action').notNull(),
    /** Redacted, truncated arguments; the raw arguments are never stored here. */
    argsPreview: text('args_preview'),
    argsHash: text('args_hash'),
    reason: text('reason'),
    scope: text('scope'),
    risk: text('risk', { enum: ['low', 'medium', 'high'] }),
    tier: text('tier', { enum: ['handoff_required', 'confirm_at_action', 'pre_approvable'] }),
    userAsked: integer('user_asked', { mode: 'boolean' }).notNull().default(false),
    /** JSON list of the decisions the card offers. */
    optionsJson: text('options_json').notNull(),
    /** JSON list of suggested "Always allow" scopes. */
    alwaysScopesJson: text('always_scopes_json').notNull().default('[]'),
    reviewJson: text('review_json'),
    status: text('status', { enum: APPROVAL_STATUSES }).notNull().default('pending'),
    decision: text('decision', { enum: APPROVAL_DECISION_VALUES }),
    alwaysScope: text('always_scope', { enum: ['tool', 'prefix_rule', 'host'] }),
    /** Tool name, command_rule id or host. */
    alwaysRef: text('always_ref'),
    denyReason: text('deny_reason'),
    override: integer('override', { mode: 'boolean' }).notNull().default(false),
    decidedBy: text('decided_by'),
    decidedDeviceId: text('decided_device_id'),
    decidedAt: text('decided_at'),
    handoffNote: text('handoff_note'),
    handoffDoneAt: text('handoff_done_at'),
    expiresAt: text('expires_at'),
    ruleId: text('rule_id'),
    ruleLabel: text('rule_label'),
    /** Persistent grants were off when the card was made ("Always allow" shown disabled). */
    alwaysAllowManaged: integer('always_allow_managed', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * M7.5 (0040): `hub` = answered only by the signed-in user in a Nova client, never from a
     * channel or a hook (firmware, boot and out-of-band cards; docs/23 §6.3). Null: as the tier allows.
     */
    answerIn: text('answer_in', { enum: ['hub'] }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('idx_approval_open').on(t.expiresAt),
    index('idx_approval_account').on(t.accountId, t.createdAt),
    index('idx_approval_thread').on(t.threadId, t.createdAt),
    index('idx_approval_denied').on(t.threadId, t.toolName, t.argsHash),
  ],
);

/** Remembered approvals (docs/12 §4.2): session grants and "always" grants with their rule. */
export const permissionGrant = sqliteTable(
  'permission_grant',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    approvalId: text('approval_id').references(() => approval.id),
    ruleId: text('rule_id').references(() => policyRule.id, { onDelete: 'set null' }),
    commandRuleId: text('command_rule_id').references(() => commandRule.id, {
      onDelete: 'set null',
    }),
    duration: text('duration', { enum: ['session', 'always'] })
      .notNull()
      .default('always'),
    scopeKind: text('scope_kind'),
    scopeRef: text('scope_ref'),
    /** JSON `{tool, command?, argsHash?}`. */
    actionMatch: text('action_match'),
    host: text('host'),
    label: text('label').notNull(),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_permission_grant_active').on(t.accountId, t.scopeKind, t.scopeRef)],
);

/** Per-tool defaults the user set (FR-048). */
export const toolDefault = sqliteTable(
  'tool_default',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    tool: text('tool').notNull(),
    effect: text('effect', { enum: ['allow', 'ask', 'deny'] }).notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.tool] })],
);
