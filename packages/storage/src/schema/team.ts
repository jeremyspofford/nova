// M7 team tables (migration 0037_team.sql; FR-217, FR-091, FR-113, FR-045 per agent; decision 5
// of ADR-095). SQL migrations are authoritative; test/schema.test.ts checks them. The OIDC client
// secret and team agents' credentials live in the vault; rows hold only `secret://` references.
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { agent } from './agents.ts';
import { thread } from './chat.ts';
import { account } from './core.ts';

/** A person of the Hub: the owner's row and each member's. */
export const teamMember = sqliteTable(
  'team_member',
  {
    accountId: text('account_id')
      .primaryKey()
      .references(() => account.id),
    role: text('role', { enum: ['owner', 'member'] }).notNull(),
    invitationId: text('invitation_id'),
    invitedBy: text('invited_by').references(() => account.id),
    joinedAt: text('joined_at').notNull(),
    removedAt: text('removed_at'),
    removedBy: text('removed_by'),
  },
  (t) => [
    uniqueIndex('uq_team_member_owner')
      .on(t.role)
      .where(sql`role = 'owner'`),
  ],
);

/** A one-use invitation link; only the token's SHA-256 is stored. */
export const teamInvitation = sqliteTable(
  'team_invitation',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    role: text('role', { enum: ['member'] })
      .notNull()
      .default('member'),
    label: text('label'),
    createdBy: text('created_by')
      .notNull()
      .references(() => account.id),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    redeemedAt: text('redeemed_at'),
    redeemedBy: text('redeemed_by').references(() => account.id),
    revokedAt: text('revoked_at'),
  },
  (t) => [index('idx_team_invitation_created').on(t.createdAt)],
);

/** An OIDC provider the owner configured; the client secret is `secret://team/oidc/<id>`. */
export const oidcProvider = sqliteTable('oidc_provider', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  issuer: text('issuer').notNull().unique(),
  clientId: text('client_id').notNull(),
  clientSecretRef: text('client_secret_ref'),
  scopes: text('scopes').notNull().default('openid profile email'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdBy: text('created_by')
    .notNull()
    .references(() => account.id),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** An account linked to an OIDC identity (provider + subject). */
export const oidcIdentity = sqliteTable(
  'oidc_identity',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    providerId: text('provider_id')
      .notNull()
      .references(() => oidcProvider.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull(),
    email: text('email'),
    linkedAt: text('linked_at').notNull(),
    lastSignInAt: text('last_sign_in_at'),
  },
  (t) => [unique().on(t.providerId, t.subject), unique().on(t.accountId, t.providerId)],
);

/** The opt-in public profile card. */
export const profileCard = sqliteTable('profile_card', {
  accountId: text('account_id')
    .primaryKey()
    .references(() => account.id),
  handle: text('handle').notNull().unique(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  showAvatar: integer('show_avatar', { mode: 'boolean' }).notNull().default(true),
  updatedAt: text('updated_at').notNull(),
});

/** A participant of a shared thread (other than its owner). */
export const threadShare = sqliteTable(
  'thread_share',
  {
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    ownerAccountId: text('owner_account_id')
      .notNull()
      .references(() => account.id),
    sharedBy: text('shared_by')
      .notNull()
      .references(() => account.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.accountId] }),
    index('idx_thread_share_account').on(t.accountId, t.createdAt),
  ],
);

/** Who wrote a user message of a shared thread (a plain id: a queued message keeps its id). */
export const sharedMessage = sqliteTable(
  'shared_message',
  {
    messageId: text('message_id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => thread.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_shared_message_thread').on(t.threadId, t.createdAt)],
);

/** A specialist/team agent and the identity account it works under. */
export const teamAgent = sqliteTable('team_agent', {
  agentId: text('agent_id')
    .primaryKey()
    .references(() => agent.id, { onDelete: 'cascade' }),
  identityAccountId: text('identity_account_id')
    .notNull()
    .unique()
    .references(() => account.id),
  createdBy: text('created_by')
    .notNull()
    .references(() => account.id),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** A credential bound to a team agent: a provider account or an egress credential of its identity. */
export const teamAgentCredential = sqliteTable(
  'team_agent_credential',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => teamAgent.agentId, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['provider', 'egress'] }).notNull(),
    refId: text('ref_id').notNull(),
    label: text('label').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => account.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => [unique().on(t.agentId, t.kind, t.refId)],
);

/** A task a person gave a team agent. */
export const teamTask = sqliteTable(
  'team_task',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => teamAgent.agentId, { onDelete: 'cascade' }),
    requestedBy: text('requested_by')
      .notNull()
      .references(() => account.id),
    text: text('text').notNull(),
    threadId: text('thread_id'),
    turnId: text('turn_id'),
    status: text('status', {
      enum: ['queued', 'running', 'done', 'failed', 'cancelled'],
    }).notNull(),
    result: text('result'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
  },
  (t) => [
    index('idx_team_task_agent').on(t.agentId, t.createdAt),
    index('idx_team_task_requester').on(t.requestedBy, t.createdAt),
  ],
);

/** The plugins connected to an agent (JSON array of plugin ids). */
export const agentPluginScope = sqliteTable('agent_plugin_scope', {
  agentId: text('agent_id')
    .primaryKey()
    .references(() => agent.id, { onDelete: 'cascade' }),
  pluginIdsJson: text('plugin_ids_json').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** A member's own preferences (appearance, keyboard, onboarding). */
export const memberSetting = sqliteTable(
  'member_setting',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    key: text('key').notNull(),
    valueJson: text('value_json').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.key] })],
);
