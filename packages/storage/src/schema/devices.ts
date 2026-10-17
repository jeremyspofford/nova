// M6 devices tables (0024_devices; docs/06 §7; FR-142, FR-144, FR-148, FR-150, FR-210, FR-081).
// SQL migrations are authoritative; test/schema.test.ts checks them. A novad device itself is a
// `device` row (schema/nodes.ts) with kind client|hub|wake-helper.
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { account } from './core.ts';
import { device } from './nodes.ts';
import { approval } from './policy.ts';

/** Per novad device: protocol, update channel, pushed overrides and policy, last reports. */
export const deviceManagement = sqliteTable('device_management', {
  deviceId: text('device_id')
    .primaryKey()
    .references(() => device.id),
  protocolVersion: integer('protocol_version').notNull(),
  updateChannel: text('update_channel', { enum: ['stable', 'beta', 'nightly'] })
    .notNull()
    .default('stable'),
  /** JSON, the FR-142 Advanced overrides. */
  capabilityOverrides: text('capability_overrides').notNull().default('{}'),
  /** JSON, the FR-150 policy. */
  policy: text('policy').notNull().default('{}'),
  configRevision: integer('config_revision').notNull().default(0),
  pushedRevision: integer('pushed_revision').notNull().default(0),
  /** JSON list of the last reported module states. */
  modules: text('modules').notNull().default('[]'),
  /** JSON, the last reported power status. */
  power: text('power'),
  updatedAt: text('updated_at').notNull(),
});

/** Folder and MCP grants per grantee, and the requests that lead to them (FR-210). */
export const deviceGrant = sqliteTable(
  'device_grant',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    granteeKind: text('grantee_kind', {
      enum: ['user', 'agent', 'session', 'run', 'thread'],
    }).notNull(),
    granteeRef: text('grantee_ref').notNull(),
    kind: text('kind', { enum: ['folder', 'mcp'] }).notNull(),
    target: text('target').notNull(),
    access: text('access', { enum: ['read', 'write', 'call'] }).notNull(),
    status: text('status', { enum: ['pending', 'granted', 'denied', 'revoked'] }).notNull(),
    deviceRequestId: text('device_request_id'),
    deviceGrantId: text('device_grant_id'),
    approvalId: text('approval_id').references(() => approval.id),
    reason: text('reason'),
    decidedBy: text('decided_by', { enum: ['device', 'hub'] }),
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at'),
  },
  (t) => [
    index('idx_device_grant_grantee').on(t.deviceId, t.granteeKind, t.granteeRef, t.status),
    index('idx_device_grant_approval').on(t.approvalId),
    uniqueIndex('idx_device_grant_request')
      .on(t.deviceId, t.deviceRequestId)
      .where(sql`device_request_id IS NOT NULL`),
  ],
);

/** Two-phase device writes (FR-210). */
export const stagedWrite = sqliteTable(
  'staged_write',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    deviceStageId: text('device_stage_id').notNull(),
    granteeKind: text('grantee_kind').notNull(),
    granteeRef: text('grantee_ref').notNull(),
    sessionRef: text('session_ref').notNull(),
    path: text('path').notNull(),
    baseSha256: text('base_sha256'),
    newSha256: text('new_sha256').notNull(),
    size: integer('size').notNull(),
    /** Where the content waits: novad's staging area. */
    blobPath: text('blob_path').notNull(),
    diff: text('diff').notNull(),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    binary: integer('binary', { mode: 'boolean' }).notNull().default(false),
    status: text('status', {
      enum: ['staged', 'committed', 'discarded', 'conflict', 'expired', 'failed'],
    })
      .notNull()
      .default('staged'),
    approvalId: text('approval_id').references(() => approval.id),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    committedAt: text('committed_at'),
  },
  (t) => [
    index('idx_staged_write_device').on(t.deviceId, t.status, t.createdAt),
    index('idx_staged_write_session').on(t.accountId, t.sessionRef, t.createdAt),
  ],
);

/** Wake-on-LAN requests, rate-limited and logged (FR-144). */
export const wakeRequest = sqliteTable(
  'wake_request',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    targetDeviceId: text('target_device_id')
      .notNull()
      .references(() => device.id),
    /** NULL: the Hub sent it (M6); a Wake Helper from M6.5 (FR-138). */
    helperDeviceId: text('helper_device_id').references(() => device.id),
    mac: text('mac').notNull(),
    status: text('status', { enum: ['sent', 'failed', 'rate_limited'] }).notNull(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_wake_request_target').on(t.targetDeviceId, t.createdAt)],
);

/** Signed updates pushed to a device (FR-148). */
export const deviceUpdate = sqliteTable(
  'device_update',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    target: text('target').notNull(),
    fromVersion: text('from_version'),
    toVersion: text('to_version').notNull(),
    channel: text('channel').notNull(),
    status: text('status', {
      enum: ['applied', 'rolled_back', 'staged', 'refused', 'failed'],
    }).notNull(),
    detail: text('detail'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('idx_device_update_device').on(t.deviceId, t.createdAt)],
);

/** An agent's connected computer (FR-081); `agentId` has no foreign key (agents area). */
export const agentDeviceConnection = sqliteTable(
  'agent_device_connection',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    agentId: text('agent_id').notNull(),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    /** JSON list of the capabilities granted with the connection. */
    capabilities: text('capabilities').notNull(),
    status: text('status', { enum: ['active', 'revoked'] }).notNull(),
    createdAt: text('created_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (t) => [
    uniqueIndex('idx_agent_device_connection_active')
      .on(t.agentId)
      .where(sql`status = 'active'`),
    index('idx_agent_device_connection_device').on(t.deviceId, t.status),
  ],
);
